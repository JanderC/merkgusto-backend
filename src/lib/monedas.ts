/**
 * Multimoneda del gimnasio: USD · VES (bolívares) · COP (pesos colombianos).
 *
 * Tablero en PESOS, como en velozalcambio (casa de cambio de frontera):
 *   Dólar  = pesos por $1     (3.200)  → usdCop
 *   Bs     = pesos por Bs 1   (3)      → vesCop
 * Todo pasa por el peso (regla de tres):
 *   COP 4.500 ÷ 3     = Bs 1.500      ·  Bs 1.500 × 3     = COP 4.500
 *   COP 4.500 ÷ 3.200 = $1,41         ·  $1 × 3.200       = COP 3.200
 *   $1 → Bs = 3.200 ÷ 3 = Bs 1.066,67 (se deriva, nunca se escribe aparte)
 * Así un precio en pesos da lo mismo pagado en Bs o en $ sin descuadres.
 */
import { env } from '../config/env.js';
import type { Moneda } from '../db/types.js';

export const MONEDAS: Moneda[] = ['USD', 'VES', 'COP'];

export const INFO: Record<Moneda, { nombre: string; simbolo: string; decimales: number }> = {
  USD: { nombre: 'Dólares', simbolo: '$', decimales: 2 },
  VES: { nombre: 'Bolívares', simbolo: 'Bs', decimales: 2 },
  COP: { nombre: 'Pesos colombianos', simbolo: 'COP', decimales: 0 },
};

export interface Tasas {
  /** Bs por $ (derivado: usdCop / vesCop) */
  usdVes: number;
  /** "Dólar" del tablero: COP por $ */
  usdCop: number;
  /** "Bs" del tablero: COP por Bs */
  vesCop: number;
}

/** Arma las tasas a partir del tablero en pesos. */
export function tasasDesdeTablero(dolar: number, bs: number): Tasas {
  return { usdCop: dolar, vesCop: bs, usdVes: dolar / bs };
}

/** Moneda en la que se suman los reportes (se fija en el .env antes de empezar a vender). */
export const MONEDA_REF: Moneda = env.MONEDA_REFERENCIA;

/** Factor para pasar de `de` a `a` (USD↔Bs siempre a través del peso). */
export function factor(de: Moneda, a: Moneda, t: Tasas): number {
  if (de === a) return 1;
  switch (`${de}>${a}`) {
    case 'USD>VES':
      return t.usdCop / t.vesCop;
    case 'VES>USD':
      return t.vesCop / t.usdCop;
    case 'USD>COP':
      return t.usdCop;
    case 'COP>USD':
      return 1 / t.usdCop;
    case 'VES>COP':
      return t.vesCop;
    case 'COP>VES':
      return 1 / t.vesCop;
  }
  throw new Error(`Par de monedas no soportado: ${de}→${a}`);
}

export const convertir = (monto: number, de: Moneda, a: Moneda, t: Tasas) => monto * factor(de, a, t);

export const redondear = (n: number, m: Moneda) => {
  const f = 10 ** INFO[m].decimales;
  return Math.round((n + Number.EPSILON) * f) / f;
};
/** Lo que se le cobra al cliente nunca queda corto por redondeo. */
export const redondearArriba = (n: number, m: Moneda) => {
  const f = 10 ** INFO[m].decimales;
  return Math.ceil(n * f - 1e-7) / f;
};

export function fmt(n: number, m: Moneda): string {
  const { simbolo, decimales } = INFO[m];
  const num = Number(n).toLocaleString('es-VE', { minimumFractionDigits: decimales, maximumFractionDigits: decimales });
  return m === 'USD' ? `$${num}` : `${simbolo} ${num}`;
}

/** "$25,00 · Bs 1.000,00 · COP 100.000" a partir de un monto en cualquier moneda. */
export const fmtTodas = (monto: number, de: Moneda, t: Tasas) => MONEDAS.map((m) => fmt(redondearArriba(convertir(monto, de, m, t), m), m)).join(' · ');

/** Total de varias líneas (cada una en su moneda) expresado en cada moneda. */
export function totalesPorMoneda(lineas: Array<{ monto: number; moneda: Moneda }>, t: Tasas): Record<Moneda, number> {
  const out = { USD: 0, VES: 0, COP: 0 } as Record<Moneda, number>;
  for (const m of MONEDAS) out[m] = redondearArriba(lineas.reduce((s, l) => s + convertir(l.monto, l.moneda, m, t), 0), m);
  return out;
}
