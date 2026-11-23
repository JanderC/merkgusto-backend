// Piezas comunes del kit del lector. Sin dependencias: basta Node (o el node.exe que viene en la carpeta).
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

export const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
export const tag = (xml, t) => xml.match(new RegExp(`<${t}(?:\\s[^>]*)?>([^<]*)</${t}>`))?.[1] ?? null;
const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

// ───────── Cliente ISAPI con Digest ─────────
export function crearLector({ ip, puerto = 80, usuario = 'admin', clave }) {
  const base = `http://${ip}:${puerto}`;
  let desafio = null;
  let nc = 0;
  let pausadoHasta = 0; // contraseña mala: el lector bloquea la cuenta, no se insiste

  function autorizar(metodo, uri) {
    if (!desafio) return null;
    const { realm, nonce, qop, opaque, algorithm = 'MD5' } = desafio;
    const H = (s) => crypto.createHash(/sha-256/i.test(algorithm) ? 'sha256' : 'md5').update(s).digest('hex');
    const cuenta = (++nc).toString(16).padStart(8, '0');
    const cnonce = crypto.randomBytes(8).toString('hex');
    let a1 = H(`${usuario}:${realm}:${clave}`);
    if (/-sess$/i.test(algorithm)) a1 = H(`${a1}:${nonce}:${cnonce}`);
    const a2 = H(`${metodo}:${uri}`);
    const auth = qop?.split(',').map((q) => q.trim()).includes('auth');
    const partes = [
      `username="${usuario}"`,
      `realm="${realm}"`,
      `nonce="${nonce}"`,
      `uri="${uri}"`,
      `algorithm=${algorithm}`,
      `response="${auth ? H(`${a1}:${nonce}:${cuenta}:${cnonce}:auth:${a2}`) : H(`${a1}:${nonce}:${a2}`)}"`,
    ];
    if (opaque) partes.push(`opaque="${opaque}"`);
    if (auth) partes.push('qop=auth', `nc=${cuenta}`, `cnonce="${cnonce}"`);
    return `Digest ${partes.join(', ')}`;
  }

  async function pedir(metodo, ruta, { json, body, tipo, timeout = 5000 } = {}) {
    const cuerpo = json === undefined ? body : JSON.stringify(json);
    const ct = json === undefined ? tipo : 'application/json';
    if (Date.now() < pausadoHasta) return { status: 401, tipo: '', buffer: Buffer.alloc(0), texto: 'en pausa por contraseña rechazada', json: null };
    const enviar = () => {
      const a = autorizar(metodo, ruta);
      return fetch(base + ruta, {
        method: metodo,
        headers: { ...(ct && { 'Content-Type': ct }), ...(a && { Authorization: a }) },
        body: cuerpo,
        signal: AbortSignal.timeout(timeout),
        redirect: 'manual',
      });
    };
    let r = await enviar();
    for (let i = 0; i < 2 && r.status === 401; i++) {
      const h = r.headers.get('www-authenticate') ?? '';
      const en = h.search(/digest\s/i);
      if (en === -1) break;
      const p = {};
      for (const m of h.slice(en + 7).matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g)) p[m[1].toLowerCase()] = m[2] ?? m[3];
      // La segunda vuelta solo si el nonce venció: cada clave mala cuenta para el bloqueo
      if (i === 1 && p.stale?.toLowerCase() !== 'true') break;
      await r.arrayBuffer();
      desafio = p;
      nc = 0;
      r = await enviar();
    }
    const buffer = Buffer.from(await r.arrayBuffer());
    if (r.status === 401) {
      desafio = null;
      pausadoHasta = Date.now() + 10 * 60_000;
    }
    const texto = buffer.toString('utf8');
    let j = null;
    try {
      j = JSON.parse(texto);
    } catch {
      /* XML o binario */
    }
    return { status: r.status, tipo: r.headers.get('content-type') ?? '', buffer, texto, json: j };
  }

  return { ip, puerto, pedir };
}

export function resultado(r) {
  const s = r.json?.ResponseStatus ?? r.json ?? {};
  const codigo = s.statusCode ?? tag(r.texto, 'statusCode');
  const sub = s.subStatusCode ?? tag(r.texto, 'subStatusCode') ?? '';
  const detalle = [`HTTP ${r.status}`, sub, s.errorMsg ?? tag(r.texto, 'errorMsg')].filter(Boolean).join(' · ');
  return { ok: r.status >= 200 && r.status < 300 && (codigo == null || Number(codigo) === 1), sub: String(sub).toLowerCase(), detalle };
}

/** Con qué IP ve el lector a esta PC (una PC suele tener varias: Wi-Fi, VirtualBox, VPN…). */
export function ipHacia(ip, puerto = 80) {
  return new Promise((ok, mal) => {
    const s = net.connect({ host: ip, port: puerto });
    s.setTimeout(4000, () => s.destroy(new Error('sin respuesta')));
    s.once('error', mal);
    s.once('connect', () => {
      ok(s.localAddress.replace(/^::ffff:/, ''));
      s.destroy();
    });
  });
}

// ───────── Reloj (Venezuela, UTC-4 todo el año) ─────────
export const horaGym = (d = new Date()) => new Date(d.getTime() - 4 * 3600_000).toISOString().slice(0, 19);

export async function revisarReloj(lector, { corregir = false } = {}) {
  const r = await lector.pedir('GET', '/ISAPI/System/time');
  const local = tag(r.texto, 'localTime');
  if (!resultado(r).ok || !local) return { ok: false, detalle: `no se pudo leer (${resultado(r).detalle})` };
  const zona = local.match(/(Z|[+-]\d\d:\d\d)$/)?.[1];
  const desfase = Date.parse(zona ? local : `${local}-04:00`) - Date.now();
  const bien = (!zona || zona === '-04:00') && Math.abs(desfase) <= 60_000;
  if (bien) return { ok: true, local, detalle: `en hora (${local})` };
  if (!corregir) return { ok: false, local, detalle: `MAL: marca ${local} y aquí son las ${horaGym()}` };
  if (new Date().getUTCFullYear() < 2026) return { ok: false, local, detalle: 'la hora de ESTA PC está mal: corrígela primero' };
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Time version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><timeMode>manual</timeMode><localTime>${horaGym()}-04:00</localTime><timeZone>CST+4:00:00</timeZone></Time>`;
  const p = resultado(await lector.pedir('PUT', '/ISAPI/System/time', { body: xml, tipo: 'application/xml' }));
  if (!p.ok) return { ok: false, local, detalle: `no aceptó la hora (${p.detalle})` };
  const despues = await revisarReloj(lector);
  return { ...despues, corregido: despues.ok, detalle: despues.ok ? `corregido (marcaba ${local})` : despues.detalle };
}

// ───────── Aviso de eventos (HTTP Listening) ─────────
export async function leerAviso(lector) {
  const r = await lector.pedir('GET', '/ISAPI/Event/notification/httpHosts');
  return { ok: resultado(r).ok, xml: r.texto };
}

export async function ponerAviso(lector, { ip, puerto, ruta }) {
  const uno = `<HttpHostNotification version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><id>1</id><url>${esc(ruta)}</url><protocolType>HTTP</protocolType><parameterFormatType>JSON</parameterFormatType><addressingFormatType>ipaddress</addressingFormatType><ipAddress>${esc(ip)}</ipAddress><portNo>${puerto}</portNo><httpAuthenticationMethod>none</httpAuthenticationMethod></HttpHostNotification>`;
  const a = resultado(await lector.pedir('PUT', '/ISAPI/Event/notification/httpHosts/1', { body: uno, tipo: 'application/xml' }));
  if (a.ok) return a;
  const lista = `<HttpHostNotificationList version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">${uno}</HttpHostNotificationList>`;
  return resultado(await lector.pedir('PUT', '/ISAPI/Event/notification/httpHosts', { body: lista, tipo: 'application/xml' }));
}

export async function restaurarAviso(lector, xml) {
  return resultado(await lector.pedir('PUT', '/ISAPI/Event/notification/httpHosts', { body: xml, tipo: 'application/xml' }));
}

// ───────── Eventos: llegan como multipart (texto o archivo) o como JSON ─────────
export function leerEvento(buffer, tipo = '') {
  const textos = [];
  const limite = tipo.match(/boundary="?([^";]+)"?/i)?.[1];
  if (limite) {
    for (const parte of buffer.toString('latin1').split(`--${limite}`)) {
      const i = parte.indexOf('\r\n\r\n');
      if (i !== -1) textos.push(Buffer.from(parte.slice(i + 4).trim(), 'latin1').toString('utf8'));
    }
  } else {
    textos.push(buffer.toString('utf8').trim());
  }
  for (const t of textos) {
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t);
      if (typeof j.eventType === 'string') return j;
    } catch {
      /* otra parte */
    }
  }
  return null;
}

/** Servidor que recibe al lector. Responde 200 DESPUÉS de que alRecibir guardó el evento. */
export function escuchar({ puerto, ruta, ipLector, alRecibir, alRechazar = () => {} }) {
  const srv = http.createServer(async (req, res) => {
    const de = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (req.method !== 'POST' || req.url !== ruta || de !== ipLector) {
      alRechazar(`${req.method} desde ${de}`);
      res.writeHead(404);
      return res.end();
    }
    try {
      const trozos = [];
      let n = 0;
      for await (const c of req) {
        n += c.length;
        if (n > 6 * 1024 * 1024) throw new Error('evento demasiado grande');
        trozos.push(c);
      }
      const ev = leerEvento(Buffer.concat(trozos), req.headers['content-type']);
      if (ev) await alRecibir(ev);
      else if (n) alRechazar(`cuerpo no reconocido (${req.headers['content-type']}, ${n} bytes)`);
      res.writeHead(200);
    } catch (e) {
      alRechazar(e.message);
      res.writeHead(503); // no se pudo guardar: que lo reenvíe
    }
    res.end();
  });
  return new Promise((ok, mal) => {
    srv.once('error', mal);
    srv.listen(puerto, '0.0.0.0', () => ok(srv));
  });
}

// ───────── Personas y rostros ─────────
export const ficha = (employeeNo, name, beginTime, endTime) => ({
  UserInfo: {
    employeeNo,
    name,
    userType: 'normal',
    Valid: { enable: true, beginTime, endTime, timeType: 'local' },
    doorRight: '1',
    RightPlan: [{ doorNo: 1, planTemplateNo: '1' }],
  },
});

export async function subirRostro(lector, employeeNo, jpeg) {
  let ultimo;
  for (const campo of ['img', 'FaceImage']) {
    const b = `----Lector${crypto.randomBytes(8).toString('hex')}`;
    const body = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="FaceDataRecord"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ faceLibType: 'blackFD', FDID: '1', FPID: employeeNo })}\r\n`),
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${campo}"; filename="rostro.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      jpeg,
      Buffer.from(`\r\n--${b}--\r\n`),
    ]);
    ultimo = resultado(await lector.pedir('POST', '/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json', { body, tipo: `multipart/form-data; boundary=${b}`, timeout: 15000 }));
    if (ultimo.ok || !/badparameters|badjsoncontent|parameterslack/.test(ultimo.sub)) break;
  }
  return ultimo;
}

export async function capturarRostro(lector) {
  const body = '<?xml version="1.0" encoding="UTF-8"?><CaptureFaceDataCond version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><captureInfrared>false</captureInfrared><dataType>binary</dataType></CaptureFaceDataCond>';
  const hasta = Date.now() + 30_000;
  while (Date.now() < hasta) {
    const r = await lector.pedir('POST', '/ISAPI/AccessControl/CaptureFaceData', { body, tipo: 'application/xml', timeout: 25000 });
    if (r.status >= 400) return { error: resultado(r).detalle };
    let fuente = r.buffer;
    const url = tag(r.texto, 'faceDataUrl');
    if (url) {
      const u = new URL(url, 'http://lector');
      fuente = (await lector.pedir('GET', u.pathname + u.search, { timeout: 10000 })).buffer;
    }
    const a = fuente.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    const z = fuente.lastIndexOf(Buffer.from([0xff, 0xd9]));
    if (a !== -1 && z > a) return { jpeg: fuente.subarray(a, z + 2) };
    if (Number(tag(r.texto, 'captureProgress') ?? 100) >= 100) return { error: 'respondió, pero sin foto' };
    await dormir(800);
  }
  return { error: 'pasaron 30 segundos sin foto' };
}
