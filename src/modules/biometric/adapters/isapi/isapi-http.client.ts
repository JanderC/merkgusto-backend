/**
 * Cliente HTTP para ISAPI con:
 *   • HTTP Digest Authentication obligatoria
 *   • Timeout estricto por petición (AbortSignal)
 *   • Reintentos con backoff SOLO para errores transitorios (red / 5xx)
 *   • Circuit breaker compartido por todas las llamadas al lector
 *   • Interpretación del ResponseStatus de Hikvision (JSON o XML)
 */
import { AccessControlError } from '../../contracts/errors.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { DigestAuthenticator, parseDigestChallenge } from './digest-auth.js';

export interface IsapiClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
  retries: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
}

export interface IsapiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string; // incluye query, ej. /ISAPI/AccessControl/UserInfo/Record?format=json
  json?: unknown;
  body?: Buffer | string;
  contentType?: string;
  timeoutMs?: number;
  /** Algunas operaciones (borrar) no deben reintentarse a ciegas. */
  retry?: boolean;
}

export interface IsapiResponse {
  status: number;
  contentType: string;
  text: string;
  /** Cuerpo crudo (para imágenes y multipart) */
  buffer: Buffer;
  json: Record<string, unknown> | null;
}

/** ResponseStatus de Hikvision: statusCode 1 = OK. */
interface HikResponseStatus {
  statusCode?: number;
  statusString?: string;
  subStatusCode?: string;
  errorCode?: number;
  errorMsg?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class IsapiHttpClient {
  private readonly digest: DigestAuthenticator;
  readonly breaker: CircuitBreaker;
  private readonly base: string;

  constructor(private readonly opts: IsapiClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.digest = new DigestAuthenticator(opts.username, opts.password);
    this.breaker = new CircuitBreaker(opts.breakerThreshold, opts.breakerCooldownMs);
  }

  async request(req: IsapiRequest): Promise<IsapiResponse> {
    const attempts = req.retry === false ? 1 : this.opts.retries + 1;
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.breaker.exec(
          () => this.once(req),
          (e) => e instanceof AccessControlError && ['TIMEOUT', 'UNREACHABLE', 'DEVICE_ERROR'].includes(e.code),
        );
      } catch (e) {
        lastErr = e;
        const retryable = e instanceof AccessControlError && e.retryable && e.code !== 'CIRCUIT_OPEN';
        if (!retryable || i === attempts - 1) break;
        await sleep(300 * 2 ** i + Math.random() * 200); // 300ms, 600ms, 1.2s… + jitter
      }
    }
    if (lastErr instanceof AccessControlError && lastErr.code === 'AUTH') {
      // Hikvision bloquea el usuario tras varios intentos fallidos: dejamos de insistir 10 min
      this.breaker.trip(10 * 60_000);
    }
    throw lastErr;
  }

  /** Lanza si el ResponseStatus del lector no es OK. */
  static assertOk(res: IsapiResponse, accion: string): void {
    const st = IsapiHttpClient.status(res);
    if (res.status >= 200 && res.status < 300 && (st.statusCode === undefined || st.statusCode === 1)) return;
    const detalle = st.subStatusCode || st.statusString || st.errorMsg || `HTTP ${res.status}`;
    throw new AccessControlError('DEVICE_REJECTED', `El lector rechazó "${accion}": ${detalle}`, {
      httpStatus: res.status,
      subStatusCode: st.subStatusCode,
      statusString: st.statusString,
    });
  }

  static status(res: IsapiResponse): HikResponseStatus {
    if (res.json) {
      const j = res.json as HikResponseStatus & { ResponseStatus?: HikResponseStatus };
      return j.ResponseStatus ?? j;
    }
    // Respuesta XML: <ResponseStatus><statusCode>1</statusCode><subStatusCode>ok</subStatusCode>…
    const tag = (t: string) => res.text.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];
    const code = tag('statusCode');
    return {
      statusCode: code ? Number(code) : undefined,
      statusString: tag('statusString'),
      subStatusCode: tag('subStatusCode'),
    };
  }

  private async once(req: IsapiRequest): Promise<IsapiResponse> {
    let body: Buffer | string | undefined = req.body;
    let contentType = req.contentType;
    if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      contentType = 'application/json';
    }

    const send = (authorization: string | null) => {
      const headers: Record<string, string> = { Accept: 'application/json, application/xml;q=0.9, */*;q=0.5' };
      if (contentType) headers['Content-Type'] = contentType;
      if (authorization) headers.Authorization = authorization;
      return this.fetchWithTimeout(`${this.base}${req.path}`, {
        method: req.method,
        headers,
        body: body as BodyInit | undefined,
        timeoutMs: req.timeoutMs ?? this.opts.timeoutMs,
      });
    };

    // Si ya tenemos un nonce válido lo reutilizamos (un solo viaje)
    let res = await send(this.digest.authorize(req.method, req.path));
    if (res.status === 401) {
      const ch = parseDigestChallenge(res.headers.get('www-authenticate'));
      if (!ch) throw new AccessControlError('AUTH', 'El lector no ofreció autenticación Digest', { httpStatus: 401 });
      const hadChallenge = this.digest.hasChallenge;
      this.digest.setChallenge(ch);
      res = await send(this.digest.authorize(req.method, req.path));
      if (res.status === 401) {
        const ch2 = parseDigestChallenge(res.headers.get('www-authenticate'));
        // Nonce vencido (stale): un reintento más con el nonce nuevo
        if (ch2?.stale && hadChallenge) {
          this.digest.setChallenge(ch2);
          res = await send(this.digest.authorize(req.method, req.path));
        }
      }
      if (res.status === 401) {
        this.digest.reset();
        throw new AccessControlError('AUTH', 'Usuario o contraseña del lector incorrectos (Digest)', { httpStatus: 401 });
      }
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const text = buffer.toString('utf8');
    const ct = res.headers.get('content-type') ?? '';
    let json: Record<string, unknown> | null = null;
    if (ct.includes('json') || text.trimStart().startsWith('{')) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    const out: IsapiResponse = { status: res.status, contentType: ct, text, buffer, json };
    if (res.status >= 500) {
      throw new AccessControlError('DEVICE_ERROR', `El lector respondió HTTP ${res.status}`, { httpStatus: res.status });
    }
    if (res.status === 403) {
      throw new AccessControlError('AUTH', 'El usuario del lector no tiene permisos para esta operación', { httpStatus: 403 });
    }
    return out;
  }

  private async fetchWithTimeout(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: BodyInit; timeoutMs: number },
  ): Promise<Response> {
    try {
      return await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: AbortSignal.timeout(init.timeoutMs),
        redirect: 'manual',
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new AccessControlError('TIMEOUT', `El lector no respondió en ${init.timeoutMs} ms`);
      }
      const code = err.cause?.code ?? '';
      throw new AccessControlError('UNREACHABLE', `No se pudo conectar con el lector${code ? ` (${code})` : ''}`);
    }
  }
}

/** Extrae la primera imagen JPEG de una respuesta multipart (o el cuerpo si ya es JPEG). */
export function extraerJpeg(res: IsapiResponse): Buffer | null {
  const b = res.buffer;
  if (b.length > 2 && b[0] === 0xff && b[1] === 0xd8) return b;
  const m = res.contentType.match(/boundary="?([^";]+)"?/i);
  if (!m) return null;
  const sep = Buffer.from(`--${m[1]}`);
  let i = b.indexOf(sep);
  while (i !== -1) {
    const sig = b.indexOf(sep, i + sep.length);
    const parte = b.subarray(i + sep.length, sig === -1 ? b.length : sig);
    const cab = parte.indexOf('\r\n\r\n');
    if (cab !== -1 && /content-type:\s*image\/jpe?g/i.test(parte.subarray(0, cab).toString('latin1'))) {
      let cuerpo = parte.subarray(cab + 4);
      if (cuerpo.subarray(-2).toString('latin1') === '\r\n') cuerpo = cuerpo.subarray(0, -2);
      return cuerpo;
    }
    i = sig;
  }
  return null;
}

/** Arma un multipart/form-data reutilizable (Buffer) — necesario para reenviarlo tras el 401 de Digest. */
export function buildMultipart(parts: Array<{ name: string; contentType: string; data: Buffer | string; filename?: string }>) {
  const boundary = `----MerkgustoBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disp = `form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ''}`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disp}\r\nContent-Type: ${p.contentType}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
