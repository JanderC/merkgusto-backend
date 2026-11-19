import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../db/index.js';

export const gymSchema = z.object({
  nombre: z.string().min(2).max(80),
  slogan: z.string().max(120).default(''),
  direccion: z.string().max(200).default(''),
  telefono: z.string().max(40).default(''),
  horario: z.string().max(300).default(''),
  instagram: z.string().max(80).default(''),
  moneda: z.string().min(1).max(5).default('$'),
});

export const whatsappSchema = z.object({
  botActivo: z.boolean().default(true),
  numeroDueno: z.string().max(30).default(''),
  horaReporte: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Formato HH:MM')
    .default('21:00'),
  reporteDiario: z.boolean().default(true),
  avisoCierre: z.boolean().default(true),
  recordatorioVencimiento: z.boolean().default(false),
  diasRecordatorio: z.number().int().min(0).max(10).default(2),
  /** Recordatorio de clase a los inscritos */
  recordatorioClases: z.boolean().default(true),
  horasAntesClase: z.number().int().min(1).max(24).default(3),
  infoExtra: z.string().max(2000).default(''),
});

const montoMoneda = z.number().min(0).max(1_000_000_000);

export const cajaSchema = z.object({
  /** Sencillo que el dueño entrega a la cajera al abrir, por moneda; se suma a lo esperado en efectivo. */
  fondo: z.object({ USD: montoMoneda.default(0), VES: montoMoneda.default(0), COP: montoMoneda.default(0) }).default({}),
});

/** De dónde se actualiza solo cada tasa. */
export const tasasAutoSchema = z.object({
  usdVes: z.enum(['manual', 'bcv', 'paralelo']).default('manual'),
  usdCop: z.enum(['manual', 'trm']).default('manual'),
});

/** Categorías de ingresos y egresos de caja. */
export const categoriasSchema = z.object({
  egreso: z.array(z.string().min(2).max(40)).default(['Proveedores', 'Servicios (luz, agua, internet)', 'Nómina', 'Entrenadores', 'Mantenimiento', 'Limpieza', 'Alquiler', 'Retiro del dueño', 'Otros']),
  ingreso: z.array(z.string().min(2).max(40)).default(['Aporte del dueño', 'Cambio / sencillo', 'Alquiler de espacio', 'Otros']),
});

export type GymConfig = z.infer<typeof gymSchema>;
export type WhatsappConfig = z.infer<typeof whatsappSchema>;

const DEFAULTS = {
  gym: gymSchema.parse({
    nombre: 'MERKGUSTO GYM',
    slogan: 'Entrena con gusto',
    horario: 'Lunes a Viernes 5:00 AM – 10:00 PM · Sábados 7:00 AM – 4:00 PM',
  }),
  whatsapp: whatsappSchema.parse({}),
  caja: cajaSchema.parse({}),
  tasasAuto: tasasAutoSchema.parse({}),
  categorias: categoriasSchema.parse({}),
};

type Claves = typeof DEFAULTS;
const schemas = { gym: gymSchema, whatsapp: whatsappSchema, caja: cajaSchema, tasasAuto: tasasAutoSchema, categorias: categoriasSchema } as const;

const cache = new Map<string, unknown>();

export async function getConfig<K extends keyof Claves>(clave: K): Promise<Claves[K]> {
  if (cache.has(clave)) return cache.get(clave) as Claves[K];
  const row = await db.selectFrom('configuracion').select('valor').where('clave', '=', clave).executeTakeFirst();
  // Se mezclan con los valores por defecto para tolerar claves nuevas
  const value = schemas[clave].parse({ ...DEFAULTS[clave], ...((row?.valor as object) ?? {}) }) as Claves[K];
  cache.set(clave, value);
  return value;
}

export async function setConfig<K extends keyof Claves>(clave: K, parcial: Partial<Claves[K]>): Promise<Claves[K]> {
  const actual = await getConfig(clave);
  const value = schemas[clave].parse({ ...actual, ...parcial }) as Claves[K];
  await db
    .insertInto('configuracion')
    .values({ clave, valor: JSON.stringify(value), actualizadoEn: sql`now()` as never })
    .onConflict((oc) => oc.column('clave').doUpdateSet({ valor: JSON.stringify(value), actualizadoEn: sql`now()` as never }))
    .execute();
  cache.set(clave, value);
  return value;
}

export function formatoMoneda(moneda: string) {
  return (n: number) =>
    `${moneda}${Number(n).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Tasas vigentes (atajo para módulos que ya las pedían aquí). */
export { getTasas } from '../tasas/tasas.service.js';
