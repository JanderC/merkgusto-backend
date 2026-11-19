/**
 * Tablero de tasas del día, en PESOS (como velozalcambio). Cada guardado es
 * una versión nueva; la vigente es la última y se compara con la anterior
 * (sube / baja).
 *
 *   dolar  COP por $   → manual o TRM (co.dolarapi.com)
 *   bs     COP por Bs  → manual, o sugerida por BCV/paralelo: dolar ÷ (Bs por $)
 *   Bs por $ = dolar ÷ bs (derivada, se guarda en usd_ves solo como registro)
 *
 * Con "actualización automática" el sistema revisa las fuentes cada 30 min y
 * guarda una versión nueva solo si el valor cambió.
 */
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import { tasasDesdeTablero, type Tasas } from '../../lib/monedas.js';
import { getConfig } from '../configuracion/config.service.js';

export interface TasaVigente extends Tasas {
  id: number;
  /** COP por $ */
  dolar: number;
  /** COP por Bs */
  bs: number;
  fuenteUsdVes: 'manual' | 'bcv' | 'paralelo';
  fuenteUsdCop: 'manual' | 'trm';
  nota: string | null;
  creadoEn: Date;
  creadoPor: string | null;
}

let cacheVigente: { t: number; v: TasaVigente } | null = null;

type Fila = { id: number; usdCop: unknown; vesCop: unknown; fuenteUsdVes: TasaVigente['fuenteUsdVes']; fuenteUsdCop: TasaVigente['fuenteUsdCop']; nota: string | null; creadoEn: Date; creadoPor: string | null };
/** La fila de la base → tablero (Bs por $ siempre derivado del peso). */
const aTablero = (r: Fila): TasaVigente => {
  const dolar = Number(r.usdCop);
  const bs = Number(r.vesCop);
  return { ...r, dolar, bs, ...tasasDesdeTablero(dolar, bs) };
};

async function ultimas(limite: number) {
  const filas = await db
    .selectFrom('tasas as t')
    .leftJoin('usuarios as u', 'u.id', 't.creadoPor')
    .select(['t.id', 't.usdCop', 't.vesCop', 't.fuenteUsdVes', 't.fuenteUsdCop', 't.nota', 't.creadoEn', 'u.nombre as creadoPor'])
    .orderBy('t.id', 'desc')
    .limit(limite)
    .execute();
  return filas.map((f) => aTablero(f as Fila));
}

export async function tasaVigente(): Promise<TasaVigente> {
  if (cacheVigente && Date.now() - cacheVigente.t < 10_000) return cacheVigente.v;
  const [r] = await ultimas(1);
  const v: TasaVigente = r ?? { id: 0, dolar: 3200, bs: 3, ...tasasDesdeTablero(3200, 3), fuenteUsdVes: 'manual', fuenteUsdCop: 'manual', nota: null, creadoEn: new Date(0), creadoPor: null };
  cacheVigente = { t: Date.now(), v };
  return v;
}

export async function getTasas(): Promise<Tasas> {
  const v = await tasaVigente();
  return tasasDesdeTablero(v.dolar, v.bs);
}

export const nuevaTasaSchema = z.object({
  dolar: z.number().positive('El dólar (pesos por $1) debe ser mayor a 0').max(1e7),
  bs: z.number().positive('Los bolívares (pesos por Bs 1) deben ser mayor a 0').max(1e7),
  fuenteDolar: z.enum(['manual', 'trm']).default('manual'),
  fuenteBs: z.enum(['manual', 'bcv', 'paralelo']).default('manual'),
  nota: z.string().max(200).nullish(),
});

export async function guardarTasa(input: z.infer<typeof nuevaTasaSchema>, usuarioId: string | null) {
  await db
    .insertInto('tasas')
    .values({
      usdCop: input.dolar,
      vesCop: input.bs,
      usdVes: Math.round((input.dolar / input.bs) * 1e6) / 1e6,
      fuenteUsdCop: input.fuenteDolar,
      fuenteUsdVes: input.fuenteBs,
      nota: input.nota ?? null,
      creadoPor: usuarioId,
    })
    .execute();
  cacheVigente = null;
  return tasaVigente();
}

/** Versiones más recientes primero, cada una con su tendencia frente a la anterior. */
export async function historialTasas(limite = 40) {
  const filas = await ultimas(limite + 1);
  const tend = (a: number, b: number | undefined) => (b === undefined || Math.abs(a - b) < 1e-9 ? null : a > b ? 'sube' : 'baja');
  return filas.slice(0, limite).map((f, i) => ({ ...f, tendencia: { dolar: tend(f.dolar, filas[i + 1]?.dolar), bs: tend(f.bs, filas[i + 1]?.bs) } }));
}

// ── Fuentes externas ────────────────────────────────────────────────
export interface FuentesExternas {
  bcv: { valor: number; fecha: string | null } | null;
  paralelo: { valor: number; fecha: string | null } | null;
  trm: { valor: number; fecha: string | null } | null;
  consultadoEn: string;
  errores: string[];
}

let cacheFuentes: { t: number; v: FuentesExternas } | null = null;

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function fuentesExternas(forzar = false): Promise<FuentesExternas> {
  if (!forzar && cacheFuentes && Date.now() - cacheFuentes.t < 5 * 60_000) return cacheFuentes.v;
  const errores: string[] = [];
  const out: FuentesExternas = { bcv: null, paralelo: null, trm: null, consultadoEn: new Date().toISOString(), errores };
  await Promise.all([
    getJson(`${env.DOLARAPI_VE_URL}/v1/dolares`)
      .then((d) => {
        const lista = Array.isArray(d) ? (d as Array<{ fuente?: string; promedio?: number; venta?: number; fechaActualizacion?: string }>) : [];
        const tomar = (f: string) => {
          const x = lista.find((i) => i.fuente === f);
          const v = x?.promedio ?? x?.venta;
          return typeof v === 'number' && v > 0 ? { valor: v, fecha: x?.fechaActualizacion ?? null } : null;
        };
        out.bcv = tomar('oficial');
        out.paralelo = tomar('paralelo');
      })
      .catch((e) => errores.push(`BCV/paralelo: ${(e as Error).message}`)),
    getJson(`${env.DOLARAPI_CO_URL}/v1/trm`)
      .then((d) => {
        const x = d as { valor?: number; fechaActualizacion?: string };
        if (typeof x.valor === 'number' && x.valor > 0) out.trm = { valor: x.valor, fecha: x.fechaActualizacion ?? null };
      })
      .catch((e) => errores.push(`TRM: ${(e as Error).message}`)),
  ]);
  cacheFuentes = { t: Date.now(), v: out };
  return out;
}

// ── Actualización automática ────────────────────────────────────────
/**
 * usdCop → el "Dólar" (COP por $) se toma de la TRM.
 * usdVes → el "Bs" (COP por Bs) se calcula: Dólar ÷ (Bs por $ del BCV o paralelo).
 * (Los nombres de las claves se conservan por compatibilidad con la configuración guardada.)
 */
export const autoSchema = z.object({
  usdVes: z.enum(['manual', 'bcv', 'paralelo']).default('manual'),
  usdCop: z.enum(['manual', 'trm']).default('manual'),
});

/** Pesos por Bs 1 sugeridos por una tasa en Bs por $ (2 decimales, como se publica). */
export const bsDesdeBolivaresPorDolar = (dolar: number, bsPorDolar: number) => Math.round((dolar / bsPorDolar) * 100) / 100;

export async function tickTasasAutomaticas(): Promise<boolean> {
  const auto = await getConfig('tasasAuto');
  if (auto.usdVes === 'manual' && auto.usdCop === 'manual') return false;
  const [actual, f] = await Promise.all([tasaVigente(), fuentesExternas(true)]);
  const trm = auto.usdCop === 'trm' ? f.trm?.valor : undefined;
  const dolar = trm ? Math.round(trm) : actual.dolar;
  const bsPorDolar = auto.usdVes === 'bcv' ? f.bcv?.valor : auto.usdVes === 'paralelo' ? f.paralelo?.valor : undefined;
  const bs = bsPorDolar ? bsDesdeBolivaresPorDolar(dolar, bsPorDolar) : actual.bs;
  const cambio = Math.abs(dolar - actual.dolar) > 1e-6 || Math.abs(bs - actual.bs) > 1e-6;
  if (!cambio) return false;
  await guardarTasa(
    {
      dolar,
      bs,
      fuenteDolar: trm ? 'trm' : actual.fuenteUsdCop,
      fuenteBs: bsPorDolar ? (auto.usdVes as 'bcv' | 'paralelo') : actual.fuenteUsdVes,
      nota: 'Actualización automática',
    },
    null,
  );
  console.log(`💱 [Tasas] Actualizadas: Dólar COP ${dolar} · Bs COP ${bs}`);
  return true;
}

