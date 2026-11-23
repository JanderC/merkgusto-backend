/**
 * HTTP Digest Authentication (RFC 7616 / RFC 2617) para ISAPI.
 *
 * Los equipos Hikvision NO aceptan Bearer y (por defecto) tampoco Basic.
 * Flujo:
 *   1. Petición sin credenciales → 401 + `WWW-Authenticate: Digest realm=…, nonce=…, qop="auth"`
 *   2. Se calcula `response = H(H(A1):nonce:nc:cnonce:qop:H(A2))`
 *   3. Se reenvía con `Authorization: Digest …`
 *
 * El desafío se reutiliza (incrementando `nc`) para no pagar dos viajes en
 * cada llamada. Si el lector responde `stale=true` se renueva el nonce.
 */
import crypto from 'node:crypto';

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm: 'MD5' | 'MD5-sess' | 'SHA-256' | 'SHA-256-sess';
  stale: boolean;
}

/** Extrae el desafío Digest de la cabecera WWW-Authenticate (puede traer varios esquemas). */
export function parseDigestChallenge(header: string | null): DigestChallenge | null {
  if (!header) return null;
  const idx = header.search(/digest\s/i);
  if (idx === -1) return null;
  const params: Record<string, string> = {};
  const re = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/gi;
  let m: RegExpExecArray | null;
  const body = header.slice(idx + 7);
  while ((m = re.exec(body))) {
    params[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
  }
  if (!params.realm || !params.nonce) return null;
  const alg = (params.algorithm ?? 'MD5').toUpperCase();
  const algorithm = (['MD5', 'MD5-SESS', 'SHA-256', 'SHA-256-SESS'].includes(alg) ? alg : 'MD5')
    .replace('-SESS', '-sess') as DigestChallenge['algorithm'];
  return {
    realm: params.realm,
    nonce: params.nonce,
    qop: params.qop,
    opaque: params.opaque,
    algorithm,
    stale: (params.stale ?? '').toLowerCase() === 'true',
  };
}

export class DigestAuthenticator {
  private challenge: DigestChallenge | null = null;
  private nc = 0;

  constructor(
    private readonly username: string,
    private readonly password: string,
  ) {}

  get hasChallenge() {
    return this.challenge !== null;
  }

  setChallenge(ch: DigestChallenge) {
    this.challenge = ch;
    this.nc = 0;
  }

  reset() {
    this.challenge = null;
    this.nc = 0;
  }

  /** Construye la cabecera Authorization para `method` + `uri` (path + query exactos). */
  authorize(method: string, uri: string): string | null {
    const ch = this.challenge;
    if (!ch) return null;
    const hashName = ch.algorithm.startsWith('SHA-256') ? 'sha256' : 'md5';
    const H = (s: string) => crypto.createHash(hashName).update(s).digest('hex');

    this.nc += 1;
    const nc = this.nc.toString(16).padStart(8, '0');
    const cnonce = crypto.randomBytes(8).toString('hex');
    // Si el lector ofrece varias qop ("auth,auth-int") usamos "auth"
    const qop = ch.qop ? (ch.qop.split(',').map((q) => q.trim()).includes('auth') ? 'auth' : undefined) : undefined;

    let ha1 = H(`${this.username}:${ch.realm}:${this.password}`);
    if (ch.algorithm.endsWith('-sess')) ha1 = H(`${ha1}:${ch.nonce}:${cnonce}`);
    const ha2 = H(`${method.toUpperCase()}:${uri}`);
    const response = qop ? H(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${ch.nonce}:${ha2}`);

    const parts = [
      `username="${this.username.replace(/"/g, '\\"')}"`,
      `realm="${ch.realm}"`,
      `nonce="${ch.nonce}"`,
      `uri="${uri}"`,
      `algorithm=${ch.algorithm}`,
      `response="${response}"`,
    ];
    if (ch.opaque !== undefined) parts.push(`opaque="${ch.opaque}"`);
    if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    return `Digest ${parts.join(', ')}`;
  }
}
