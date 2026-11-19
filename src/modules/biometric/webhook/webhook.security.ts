/**
 * Validación de que el webhook viene REALMENTE del lector.
 *
 * El DS-K1T344 no puede firmar sus peticiones ni agregar cabeceras propias,
 * así que se combinan varias capas:
 *   1. Token secreto en la ruta (/api/biometric/events/<token>), comparado en
 *      tiempo constante. Se configura en el Listening Host del lector.
 *   2. Lista de IPs/redes autorizadas (BIOMETRIC_ALLOWED_IPS, CIDR). Por defecto
 *      solo localhost y redes privadas (LAN del gimnasio).
 *   3. Identidad del equipo dentro del payload: MAC/IP declaradas deben estar en
 *      BIOMETRIC_DEVICE_MACS / BIOMETRIC_DEVICE_IPS (si se configuran).
 *   4. Límite de peticiones por IP y de tamaño del cuerpo.
 *
 * Importante: no se confía en X-Forwarded-For (lo puede falsificar cualquiera);
 * se usa la IP del socket.
 */
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../../../config/env.js';

const PRIVATE_DEFAULTS = ['127.0.0.1/32', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255 || p === '') return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

/** Normaliza "::ffff:192.168.1.5" → "192.168.1.5" y "::1" → "127.0.0.1". */
export function normalizeIp(ip: string | undefined): string {
  if (!ip) return '';
  if (ip === '::1') return '127.0.0.1';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  const bits = bitsStr === undefined ? 32 : Number(bitsStr);
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(range ?? '');
  if (a === null || b === null || !(bits >= 0 && bits <= 32)) return ip === range; // IPv6 exacta
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

export function isIpAllowed(ip: string): boolean {
  const list = env.BIOMETRIC_ALLOWED_IPS.length ? env.BIOMETRIC_ALLOWED_IPS : PRIVATE_DEFAULTS;
  return list.some((c) => ipInCidr(ip, c));
}

export function tokenMatches(received: string | undefined): boolean {
  if (!received) return false;
  const a = crypto.createHash('sha256').update(received).digest();
  const b = crypto.createHash('sha256').update(env.BIOMETRIC_WEBHOOK_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

const normMac = (m: string) => m.toLowerCase().replace(/[^0-9a-f]/g, '');

/** Valida la identidad que el lector declara en el evento. */
export function isKnownDevice(mac: string | null, ip: string | null): { ok: boolean; reason?: string } {
  if (env.BIOMETRIC_DEVICE_MACS.length) {
    if (!mac || !env.BIOMETRIC_DEVICE_MACS.map(normMac).includes(normMac(mac))) {
      return { ok: false, reason: `MAC no autorizada (${mac ?? 'sin MAC'})` };
    }
  }
  if (env.BIOMETRIC_DEVICE_IPS.length) {
    if (!ip || !env.BIOMETRIC_DEVICE_IPS.includes(ip)) return { ok: false, reason: `IP declarada no autorizada (${ip ?? 'sin IP'})` };
  }
  return { ok: true };
}

// Límite simple en memoria: 120 eventos/minuto por IP (un lector real envía muchos menos)
const hits = new Map<string, { n: number; t: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.t > 60_000) {
    hits.set(ip, { n: 1, t: now });
    return false;
  }
  h.n += 1;
  return h.n > 120;
}

let rechazos = 0;
export const webhookStats = { get rechazos() { return rechazos; } };

export function webhookGuard(req: Request, res: Response, next: NextFunction) {
  const ip = normalizeIp(req.socket.remoteAddress);
  const deny = (status: number, motivo: string) => {
    rechazos++;
    console.warn(`🛡  [Webhook biométrico] Rechazado ${ip}: ${motivo}`);
    res.status(status).json({ ok: false });
  };
  if (!isIpAllowed(ip)) return deny(403, 'IP fuera de la red autorizada');
  if (!tokenMatches(req.params.token)) return deny(401, 'token inválido');
  if (rateLimited(ip)) return deny(429, 'demasiadas peticiones');
  (req as Request & { sourceIp?: string }).sourceIp = ip;
  next();
}
