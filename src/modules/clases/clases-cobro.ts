/**
 * CLASES CON PRECIO (bailoterapia, funcional…)
 *
 *  • Cada clase puede tener precio. Quien no tiene mensualidad (ni el plan de la clase)
 *    la paga en caja como un renglón del ticket y queda inscrito con su pago.
 *  • Quien tiene mensualidad o el plan de la clase no paga: la caja lo avisa y no cobra doble.
 *  • Al darle entrada, si pagó, queda "pagó su pase" con su ticket. Si la clase tiene precio,
 *    "pagó su pase" ya no se puede marcar sin cobro real: se cobra en caja o es cortesía.
 *  • Anular el ticket deja la inscripción sin pago.
 */
import { sql } from 'kysely';
import type { Db } from '../../db/index.js';
import { badRequest, conflict, notFound } from '../../lib/http.js';
import { hoy } from '../../lib/util.js';
import { baseClases, coberturas } from './clases.routes.js';

/** Revisa la clase y arma el renglón del ticket (dentro de la transacción de la venta). */
export async function prepararClase(trx: Db, socioId: string, claseId: number) {
  const c = await baseClases().where('c.id', '=', claseId).executeTakeFirst();
  if (!c) throw notFound('Clase no encontrada');
  if (c.estado === 'cancelada') throw badRequest(`La clase ${c.nombre} está cancelada`);
  if (c.dia < hoy()) throw badRequest(`La clase ${c.nombre} ya pasó`);
  const fila = await trx.selectFrom('clases').select(['precio', 'moneda', 'cupo']).where('id', '=', c.id).forUpdate().executeTakeFirstOrThrow();
  const precio = Number(fila.precio ?? 0);
  if (!(precio > 0)) throw badRequest(`La clase ${c.nombre} no tiene precio: ponle precio en Clases › editar, o déjalo pasar desde la clase`);
  const cob = (await coberturas([socioId], c.planId, c.dia)).get(socioId)!;
  if (cob.acceso !== 'sin_mensualidad') {
    throw conflict(`Tiene ${cob.acceso === 'plan' ? 'el plan de la clase' : 'mensualidad'} vigente (${cob.plan}): la clase le sale incluida. Inscríbelo desde Clases, sin cobrar.`);
  }
  const ins = await trx.selectFrom('claseInscritos').select(['id', 'ventaId']).where('claseId', '=', c.id).where('socioId', '=', socioId).executeTakeFirst();
  if (ins?.ventaId) throw conflict(`Ya pagó la clase ${c.nombre}`);
  if (!ins && fila.cupo) {
    const n = await trx.selectFrom('claseInscritos').select(sql<number>`count(*)::int`.as('n')).where('claseId', '=', c.id).executeTakeFirstOrThrow();
    if (n.n >= fila.cupo) throw conflict(`Cupo lleno en ${c.nombre}: ${n.n} de ${fila.cupo}`);
  }
  const dia = c.dia.split('-').reverse().slice(0, 2).join('/');
  return { clase: c, precio, moneda: fila.moneda, descripcion: `Clase ${c.nombre} (${dia} ${c.hora})`, inscripcionId: ins?.id ?? null };
}

/** Lo inscribe (o marca su inscripción) como pagado con este ticket. */
export async function inscribirPagado(trx: Db, a: { claseId: number; socioId: string; ventaId: string; usuarioId: string; inscripcionId: number | null }) {
  if (a.inscripcionId) {
    await trx.updateTable('claseInscritos').set({ ventaId: a.ventaId }).where('id', '=', a.inscripcionId).execute();
  } else {
    await trx.insertInto('claseInscritos').values({ claseId: a.claseId, socioId: a.socioId, inscritoPor: a.usuarioId, ventaId: a.ventaId }).execute();
  }
}

/** Al anular el ticket: la inscripción queda sin pago (si ya entró como "pagó su pase", pasa a cortesía para no inventar dinero). */
export async function anularClasesDeVenta(trx: Db, ventaId: string) {
  await trx
    .updateTable('claseInscritos')
    .set({ cobertura: sql`case when cobertura = 'pase' then 'cortesia' else cobertura end` as never, ventaId: null })
    .where('ventaId', '=', ventaId)
    .execute();
}
