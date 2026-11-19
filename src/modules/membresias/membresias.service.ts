/**
 * Membresías (lógica traída de Power Fitness y mejorada).
 *
 *  Duración por unidades:
 *   • días     → 1 de nov + 1 día   = vigente solo el 1 de nov
 *   • semanas  → 1 de nov + 1 sem   = hasta el 7 de nov
 *   • meses    → MES A MES: 15 de ene + 1 mes = hasta el 14 de feb (renueva el 15 de feb).
 *                Si el mes no tiene ese día (31) se usa el último día del mes.
 *   • años     → 12 meses
 *
 *  Renovación:
 *   • "continuar" (por defecto): si aún está vigente, la nueva empieza al día siguiente
 *     del vencimiento → no pierde días y conserva su día de corte.
 *   • "hoy": la vigente se marca como reemplazada y la nueva arranca hoy.
 *
 *  Congelar: la membresía deja de dar acceso; al reanudar se le devuelven los días
 *  congelados (con tope por plan) y se corren también las renovaciones ya pagadas.
 */
import crypto from 'node:crypto';
import { sql } from 'kysely';
import { db, type Db } from '../../db/index.js';
import type { Moneda, TipoDuracion } from '../../db/types.js';
import { badRequest, conflict, notFound } from '../../lib/http.js';
import { diasEntre, hoy, sumarDias } from '../../lib/util.js';

export interface PlanDuracion {
  tipoDuracion: TipoDuracion;
  cantidad: number;
}

/** Suma meses respetando el día (31 → último día del mes). */
export function sumarMeses(fecha: string, meses: number): string {
  const [y, m, d] = fecha.split('-').map(Number);
  const total = y! * 12 + (m! - 1) + meses;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const ultimo = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d!, ultimo)).padStart(2, '0')}`;
}

/** Último día de vigencia (inclusive). */
export function calcularFin(inicio: string, p: PlanDuracion): string {
  switch (p.tipoDuracion) {
    case 'meses':
      return sumarDias(sumarMeses(inicio, p.cantidad), -1);
    case 'anios':
      return sumarDias(sumarMeses(inicio, p.cantidad * 12), -1);
    case 'semanas':
      return sumarDias(inicio, p.cantidad * 7 - 1);
    default:
      return sumarDias(inicio, p.cantidad - 1);
  }
}

export function describirDuracion(p: PlanDuracion): string {
  const n = p.cantidad;
  const u = { dias: ['día', 'días'], semanas: ['semana', 'semanas'], meses: ['mes', 'meses'], anios: ['año', 'años'] }[p.tipoDuracion];
  return `${n} ${n === 1 ? u[0] : u[1]}`;
}

/** Días aproximados (para ordenar y para el campo histórico duracion_dias). */
export const diasAproximados = (p: PlanDuracion) => ({ dias: 1, semanas: 7, meses: 30, anios: 365 })[p.tipoDuracion] * p.cantidad;

export interface Vigencia {
  vigente: boolean;
  /** Primer día del bloque continuo de días pagados */
  desde: string | null;
  /** Último día cubierto (las renovaciones se encadenan) */
  hasta: string | null;
  ultimaFin: string | null;
  plan: string | null;
  diasRestantes: number;
  congelada: { membresiaId: string; desde: string; dias: number } | null;
}

/**
 * Vigencia del socio con sus membresías activas (las congeladas no dan acceso).
 * soloLector: cuenta solo los planes que dan acceso por el lector facial
 * (semanales/mensuales/anuales); los pases diarios entran por recepción.
 */
export async function vigenciaSocio(socioId: string, dbx: Db = db, opts: { soloLector?: boolean } = {}): Promise<Vigencia> {
  const h = hoy();
  let q = dbx
    .selectFrom('membresias as m')
    .innerJoin('planes as p', 'p.id', 'm.planId')
    .select(['m.id', 'm.fechaInicio', 'm.fechaFin', 'm.estado', 'm.congeladaDesde', 'p.nombre'])
    .where('m.socioId', '=', socioId)
    .where('m.estado', 'in', ['activa', 'congelada'])
    .orderBy('m.fechaFin', 'desc');
  if (opts.soloLector) q = q.where('p.accesoLector', '=', true);
  return vigenciaDesdeFilas(await q.execute(), h);
}

/** Fila mínima de membresía para calcular vigencia (ordenadas por fechaFin desc). */
export interface FilaVigencia {
  id: string;
  fechaInicio: string;
  fechaFin: string;
  estado: string;
  congeladaDesde: string | null;
  nombre: string;
}

/** Vigencia a partir de las membresías activas/congeladas del socio (ordenadas por fechaFin desc). */
export function vigenciaDesdeFilas<R extends FilaVigencia>(rows: R[], h: string): Vigencia & { actual: R | null } {
  const cong = rows.find((r) => r.estado === 'congelada');
  const congelada = cong ? { membresiaId: cong.id, desde: cong.congeladaDesde ?? h, dias: Math.max(0, diasEntre(cong.congeladaDesde ?? h, h)) } : null;
  const activas = rows.filter((r) => r.estado === 'activa');
  const ultimaFin = activas[0]?.fechaFin ?? rows[0]?.fechaFin ?? null;
  const futuras = activas.filter((r) => r.fechaFin >= h);
  if (!futuras.length || congelada) {
    const ref = cong ?? activas[0] ?? null;
    return { vigente: false, desde: null, hasta: null, ultimaFin, plan: ref?.nombre ?? null, diasRestantes: 0, congelada, actual: ref };
  }
  // Bloque continuo de días pagados desde el primero que cubre hoy (o el próximo)
  const asc = [...futuras].sort((a, b) => a.fechaInicio.localeCompare(b.fechaInicio));
  const desde = asc[0]!.fechaInicio;
  let hasta = asc[0]!.fechaFin;
  for (const r of asc.slice(1)) {
    if (r.fechaInicio <= sumarDias(hasta, 1)) {
      if (r.fechaFin > hasta) hasta = r.fechaFin;
    } else break;
  }
  const vigente = desde <= h;
  const actual = asc.find((r) => r.fechaInicio <= h && r.fechaFin >= h) ?? asc[0]!;
  return { vigente, desde, hasta, ultimaFin, plan: actual.nombre, diasRestantes: vigente ? diasEntre(h, hasta) + 1 : 0, congelada: null, actual };
}

export type DesdeRenovacion = 'continuar' | 'hoy';

/**
 * Crea la(s) membresía(s) de una venta. Para planes grupales se crea una por
 * persona con las mismas fechas y un grupo en común.
 */
export async function crearMembresias(
  trx: Db,
  args: { socioIds: string[]; planId: number; ventaId: string | null; precio: number; moneda: Moneda; desde?: DesdeRenovacion; fechaInicio?: string; nota?: string | null },
) {
  const plan = await trx.selectFrom('planes').selectAll().where('id', '=', args.planId).executeTakeFirst();
  if (!plan) throw notFound('Plan no encontrado');
  if (!plan.activo && !args.fechaInicio) throw badRequest(`El plan "${plan.nombre}" no está activo`);
  if (args.socioIds.length !== plan.personas) throw badRequest(`El plan ${plan.nombre} es para ${plan.personas} persona(s)`);
  if (new Set(args.socioIds).size !== args.socioIds.length) throw badRequest('No se puede repetir la misma persona en el plan');

  const h = hoy();
  const desde = args.desde ?? 'continuar';
  // Inicio común: el más tardío de los integrantes si se continúa (nadie pierde días)
  let inicio = args.fechaInicio ?? h;
  if (!args.fechaInicio) {
    for (const socioId of args.socioIds) {
      if (desde === 'hoy') {
        await trx
          .updateTable('membresias')
          .set({ estado: 'reemplazada', notas: sql`coalesce(notas || ' · ', '') || ${`Reemplazada por renovación desde hoy (${h})`}` as never })
          .where('socioId', '=', socioId)
          .where('estado', '=', 'activa')
          .where('fechaFin', '>=', h)
          .execute();
      } else {
        const ult = await trx
          .selectFrom('membresias')
          .select(sql<string>`max(fecha_fin)`.as('fin'))
          .where('socioId', '=', socioId)
          .where('estado', 'in', ['activa', 'congelada'])
          .executeTakeFirst();
        if (ult?.fin && ult.fin >= h) {
          const sig = sumarDias(ult.fin, 1);
          if (sig > inicio) inicio = sig;
        }
      }
    }
  }
  const fin = calcularFin(inicio, plan);
  const grupoId = args.socioIds.length > 1 ? crypto.randomUUID() : null;
  const precioPorPersona = Math.round((args.precio / args.socioIds.length) * 100) / 100;
  const creadas = [];
  for (const socioId of args.socioIds) {
    creadas.push(
      await trx
        .insertInto('membresias')
        .values({ socioId, planId: plan.id, ventaId: args.ventaId, fechaInicio: inicio, fechaFin: fin, precio: precioPorPersona, moneda: args.moneda, grupoId, notas: args.nota ?? null })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }
  return { plan, membresias: creadas, inicio, fin };
}

/** Congela la membresía vigente del socio. */
export async function congelarMembresia(membresiaId: string, motivo: string | null) {
  const m = await db
    .selectFrom('membresias as m')
    .innerJoin('planes as p', 'p.id', 'm.planId')
    .select(['m.id', 'm.socioId', 'm.estado', 'm.fechaInicio', 'm.fechaFin', 'p.congelable', 'p.nombre'])
    .where('m.id', '=', membresiaId)
    .executeTakeFirst();
  if (!m) throw notFound('Membresía no encontrada');
  if (m.estado !== 'activa') throw conflict('Solo se puede congelar una membresía activa');
  if (!m.congelable) throw badRequest(`El plan ${m.nombre} no permite congelar`);
  const h = hoy();
  if (m.fechaFin < h) throw badRequest('La membresía ya venció');
  const otra = await db.selectFrom('membresias').select('id').where('socioId', '=', m.socioId).where('estado', '=', 'congelada').executeTakeFirst();
  if (otra) throw conflict('El cliente ya tiene una membresía congelada');
  await db
    .updateTable('membresias')
    .set({ estado: 'congelada', congeladaDesde: h, notas: sql`coalesce(notas || ' · ', '') || ${`Congelada el ${h}${motivo ? `: ${motivo}` : ''}`}` as never })
    .where('id', '=', m.id)
    .execute();
  return { socioId: m.socioId };
}

/**
 * Reanuda: devuelve los días congelados (máx. por plan) al vencimiento y corre
 * las renovaciones posteriores ya pagadas para que no se solapen.
 */
export async function reanudarMembresia(membresiaId: string, porTope = false) {
  return db.transaction().execute(async (trx) => {
    const m = await trx
      .selectFrom('membresias as m')
      .innerJoin('planes as p', 'p.id', 'm.planId')
      .select(['m.id', 'm.socioId', 'm.estado', 'm.fechaInicio', 'm.fechaFin', 'm.congeladaDesde', 'm.diasCongelados', 'p.maxDiasCongelado'])
      .where('m.id', '=', membresiaId)
      .forUpdate()
      .executeTakeFirst();
    if (!m) throw notFound('Membresía no encontrada');
    if (m.estado !== 'congelada') throw conflict('La membresía no está congelada');
    const h = hoy();
    const transcurridos = Math.max(0, diasEntre(m.congeladaDesde ?? h, h));
    const disponibles = Math.max(0, m.maxDiasCongelado - m.diasCongelados);
    const dias = Math.min(transcurridos, disponibles);
    const nuevoFin = sumarDias(m.fechaFin, dias);
    await trx
      .updateTable('membresias')
      .set({
        estado: 'activa',
        fechaFin: nuevoFin,
        congeladaDesde: null,
        diasCongelados: m.diasCongelados + dias,
        notas: sql`coalesce(notas || ' · ', '') || ${`Reanudada el ${h}${porTope ? ' (tope de congelación)' : ''}: +${dias} día(s)`}` as never,
      })
      .where('id', '=', m.id)
      .execute();
    if (dias > 0) {
      // Las renovaciones que ya estaban pagadas después de esta se corren igual
      await trx
        .updateTable('membresias')
        .set({ fechaInicio: sql`fecha_inicio + ${dias}::int` as never, fechaFin: sql`fecha_fin + ${dias}::int` as never })
        .where('socioId', '=', m.socioId)
        .where('estado', '=', 'activa')
        .where('id', '!=', m.id)
        .where('fechaInicio', '>', m.fechaFin)
        .execute();
    }
    return { socioId: m.socioId, dias, nuevoFin };
  });
}

/** Job nocturno: reanuda las congeladas que llegaron al tope de días del plan. */
export async function reanudarCongeladasVencidas(): Promise<string[]> {
  const h = hoy();
  const rows = await db
    .selectFrom('membresias as m')
    .innerJoin('planes as p', 'p.id', 'm.planId')
    .select(['m.id', 'm.socioId'])
    .where('m.estado', '=', 'congelada')
    .where(sql<boolean>`(${h}::date - m.congelada_desde) + m.dias_congelados >= p.max_dias_congelado`)
    .execute();
  const out: string[] = [];
  for (const r of rows) {
    await reanudarMembresia(r.id, true);
    out.push(r.socioId);
  }
  return out;
}
