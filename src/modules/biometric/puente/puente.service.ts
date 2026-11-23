/**
 * Puente hacia un lector que está en la red del gimnasio.
 *
 * Railway no puede entrar a 192.168.x.x. La PC del gimnasio pregunta "¿hay algo para
 * el lector?" (conexión saliente, sin abrir puertos en el router), lo ejecuta y devuelve
 * la respuesta. La contraseña del lector nunca sale de esa PC.
 *
 * Los pedidos viven en memoria (una sola instancia del backend): si se reinicia,
 * bio_cola los vuelve a generar.
 */
import crypto from 'node:crypto';
import type { Transporte } from '../adapters/isapi/isapi-http.client.js';
import { AccessControlError } from '../contracts/errors.js';

export interface Pedido {
  id: string;
  method: string;
  path: string;
  contentType?: string;
  body?: string; // base64
  venceEnMs: number;
}
export interface Respuesta {
  status?: number;
  contentType?: string;
  body?: string; // base64
  error?: string;
}

const SIN_SENALES_MS = 40_000;
const ESPERA_MS = 20_000;

let ultimaSenal = 0;
const porEnviar: Pedido[] = [];
const esperando = new Map<string, (r: Respuesta) => void>();
let despertar: (() => void) | null = null;

export const estadoPuente = () => ({
  conectado: Date.now() - ultimaSenal < SIN_SENALES_MS,
  ultimaSenal: ultimaSenal ? new Date(ultimaSenal).toISOString() : null,
});

export const transportePuente: Transporte = (req) => {
  if (!estadoPuente().conectado) {
    return Promise.reject(new AccessControlError('UNREACHABLE', 'El puente del gimnasio no está conectado (PC apagada, programa cerrado o sin internet)'));
  }
  return new Promise((resolve, reject) => {
    const pedido: Pedido = {
      id: crypto.randomUUID(),
      method: req.method,
      path: req.path,
      contentType: req.contentType,
      body: req.body?.toString('base64'),
      venceEnMs: req.timeoutMs,
    };
    const reloj = setTimeout(() => {
      esperando.delete(pedido.id);
      const i = porEnviar.indexOf(pedido);
      if (i !== -1) porEnviar.splice(i, 1); // una orden vencida (p. ej. abrir la puerta) no se ejecuta tarde
      reject(new AccessControlError('TIMEOUT', 'El lector no respondió a través del puente'));
    }, req.timeoutMs + 3000); // margen de internet

    esperando.set(pedido.id, (r) => {
      clearTimeout(reloj);
      if (r.error || !r.status) reject(new AccessControlError('UNREACHABLE', `El puente no llegó al lector: ${r.error ?? 'sin respuesta'}`));
      else resolve({ status: r.status, contentType: r.contentType ?? '', buffer: Buffer.from(r.body ?? '', 'base64') });
    });
    porEnviar.push(pedido);
    despertar?.();
  });
};

/** El puente se queda esperando hasta 20 s a que haya trabajo. */
export async function tomarPedidos(cerrada: AbortSignal): Promise<Pedido[]> {
  ultimaSenal = Date.now();
  if (!porEnviar.length) {
    await new Promise<void>((resolve) => {
      const fin = () => {
        clearTimeout(reloj);
        if (despertar === fin) despertar = null;
        resolve();
      };
      const reloj = setTimeout(fin, ESPERA_MS);
      despertar?.(); // solo una espera a la vez
      despertar = fin;
      cerrada.addEventListener('abort', fin, { once: true });
    });
  }
  if (cerrada.aborted) return [];
  ultimaSenal = Date.now();
  return porEnviar.splice(0, 5);
}

export function entregarRespuesta(id: string, r: Respuesta): boolean {
  ultimaSenal = Date.now();
  const f = esperando.get(id);
  if (!f) return false;
  esperando.delete(id);
  f(r);
  return true;
}
