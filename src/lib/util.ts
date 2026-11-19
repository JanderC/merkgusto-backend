import { env } from '../config/env.js';

/** Redondeo monetario a 2 decimales sin errores de coma flotante. */
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const pad = (n: number) => String(n).padStart(2, '0');

/** Fecha local del gimnasio en formato YYYY-MM-DD. */
export function hoy(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Suma días a una fecha YYYY-MM-DD (sin problemas de horario de verano). */
export function sumarDias(fecha: string, dias: number): string {
  const [y, m, d] = fecha.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return dt.toISOString().slice(0, 10);
}

export function diasEntre(desde: string, hasta: string): number {
  const a = Date.parse(`${desde}T00:00:00Z`);
  const b = Date.parse(`${hasta}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function fechaLarga(fecha: string): string {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long' });
}

export function horaCorta(d: Date): string {
  return d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', hour12: true });
}

/**
 * Normaliza un teléfono a formato internacional sin "+".
 * 0414-1234567 → 584141234567 (con WHATSAPP_CODIGO_PAIS=58)
 */
export function normalizarTelefono(tel: string | null | undefined): string | null {
  if (!tel) return null;
  let n = tel.replace(/\D/g, '');
  if (!n) return null;
  const cc = env.WHATSAPP_CODIGO_PAIS;
  if (n.startsWith('00')) n = n.slice(2);
  else if (n.startsWith('0')) n = cc + n.slice(1);
  else if (n.length <= 10) n = cc + n;
  return n;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
