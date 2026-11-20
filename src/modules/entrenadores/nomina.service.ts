/**
 * Pago a entrenadores: el sistema calcula lo que corresponde por periodo según
 * cómo se le paga a cada uno (fijo, por hora marcada o por clase dictada).
 * Al pagar queda un egreso "Entrenadores" en finanzas (sin tocar los cierres de caja).
 */
import { sql } from 'kysely';
import { db } from '../../db/index.js';
import type { Moneda, PagoTipo } from '../../db/types.js';
import { badRequest, conflict, notFound } from '../../lib/http.js';
import { fmt, redondear } from '../../lib/monedas.js';
import { egresoAdministracion } from '../caja/caja.service.js';
import { reportePeriodo } from './entrenadores.service.js';

export const CATEGORIA_NOMINA = 'Entrenadores';
export const TIPOS_PAGO: Record<PagoTipo, string> = { ninguno: 'Sin pago configurado', fijo: 'Monto fijo por periodo', por_hora: 'Por hora trabajada', por_clase: 'Por clase dictada' };

async function clasesDictadas(desde: string, hasta: string) {
  const rows = await db
    .selectFrom('clases')
    .select(['entrenadorId', sql<number>`count(*)::int`.as('n')])
    .where('estado', '=', 'programada')
    .where('entrenadorId', 'is not', null)
    .where(sql`inicio::date`, '>=', desde)
    .where(sql`inicio::date`, '<=', hasta)
    .where('inicio', '<=', new Date())
    .groupBy('entrenadorId')
    .execute();
  return new Map(rows.map((r) => [r.entrenadorId!, Number(r.n)]));
}

/** Lo que corresponde pagarle a cada entrenador en el periodo (y si ya se le pagó). */
export async function nomina(desde: string, hasta: string) {
  if (hasta < desde) throw badRequest('El periodo está al revés');
  const [lista, reporte, clases, pagos] = await Promise.all([
    db.selectFrom('entrenadores').select(['id', 'nombre', 'apellido', 'activo', 'pagoTipo', 'pagoTarifa', 'pagoMoneda']).orderBy('nombre').execute(),
    reportePeriodo(desde, hasta),
    clasesDictadas(desde, hasta),
    db
      .selectFrom('entrenadorPagos')
      .select(['id', 'entrenadorId', 'desde', 'hasta', 'total', 'moneda', 'creadoEn'])
      .where('anulado', '=', false)
      .where('hasta', '>=', desde)
      .where('desde', '<=', hasta)
      .execute(),
  ]);
  return lista
    .filter((e) => e.activo || pagos.some((p) => p.entrenadorId === e.id))
    .map((e) => {
      const rep = reporte.find((r) => r.id === e.id);
      const horas = rep?.horas ?? 0;
      const nClases = clases.get(e.id) ?? 0;
      const tarifa = Number(e.pagoTarifa);
      const base = e.pagoTipo === 'fijo' ? tarifa : e.pagoTipo === 'por_hora' ? tarifa * horas : e.pagoTipo === 'por_clase' ? tarifa * nClases : 0;
      const pagado = pagos.filter((p) => p.entrenadorId === e.id);
      return {
        id: e.id,
        nombre: `${e.nombre} ${e.apellido}`.trim(),
        pagoTipo: e.pagoTipo,
        tipoTexto: TIPOS_PAGO[e.pagoTipo],
        tarifa,
        moneda: e.pagoMoneda,
        tarifaTexto: fmt(tarifa, e.pagoMoneda),
        horas,
        clases: nClases,
        diasTrabajados: rep?.diasTrabajados ?? 0,
        tardanzas: rep?.tardanzas ?? 0,
        ausencias: rep?.ausencias ?? 0,
        montoBase: redondear(base, e.pagoMoneda),
        montoTexto: fmt(redondear(base, e.pagoMoneda), e.pagoMoneda),
        pagos: pagado.map((p) => ({ id: p.id, desde: p.desde, hasta: p.hasta, totalTexto: fmt(Number(p.total), p.moneda), creadoEn: p.creadoEn })),
      };
    });
}

export async function registrarPago(
  usuarioId: string,
  input: { entrenadorId: string; desde: string; hasta: string; bonos: number; descuentos: number; metodo: string; nota?: string | null },
) {
  const fila = (await nomina(input.desde, input.hasta)).find((n) => n.id === input.entrenadorId);
  if (!fila) throw notFound('Entrenador no encontrado');
  if (fila.pagoTipo === 'ninguno') throw badRequest('Primero configura cómo se le paga a este entrenador');
  if (fila.pagos.length) throw conflict(`Ya tiene un pago registrado que cubre parte de ese periodo (${fila.pagos.map((p) => `${p.desde} → ${p.hasta}`).join(', ')})`);
  const m: Moneda = fila.moneda;
  const bonos = redondear(input.bonos, m);
  const descuentos = redondear(input.descuentos, m);
  const total = redondear(fila.montoBase + bonos - descuentos, m);
  if (total < 0) throw badRequest('Los descuentos no pueden superar lo que le corresponde');

  return db.transaction().execute(async (trx) => {
    const mov =
      total > 0
        ? await egresoAdministracion(trx, { usuarioId, categoria: CATEGORIA_NOMINA, concepto: `Pago a ${fila.nombre} (${input.desde} → ${input.hasta})`, metodo: input.metodo, moneda: m, monto: total })
        : null;
    const p = await trx
      .insertInto('entrenadorPagos')
      .values({
        entrenadorId: input.entrenadorId,
        desde: input.desde,
        hasta: input.hasta,
        pagoTipo: fila.pagoTipo,
        tarifa: fila.tarifa,
        horas: fila.horas,
        clases: fila.clases,
        montoBase: fila.montoBase,
        bonos,
        descuentos,
        total,
        moneda: m,
        metodo: input.metodo,
        movimientoId: mov?.id ?? null,
        nota: input.nota?.trim() || null,
        registradoPor: usuarioId,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    await trx.insertInto('auditoria').values({ usuarioId, accion: 'entrenador.pago', detalle: JSON.stringify({ pagoId: p.id, entrenadorId: input.entrenadorId, total, moneda: m }) }).execute();
    return { id: p.id, total, totalTexto: fmt(total, m) };
  });
}

export async function anularPago(id: number, usuarioId: string, motivo: string) {
  return db.transaction().execute(async (trx) => {
    const p = await trx.selectFrom('entrenadorPagos').select(['id', 'anulado', 'movimientoId']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!p) throw notFound('Pago no encontrado');
    if (p.anulado) throw conflict('El pago ya estaba anulado');
    await trx.updateTable('entrenadorPagos').set({ anulado: true }).where('id', '=', id).execute();
    if (p.movimientoId) await trx.updateTable('cajaMovimientos').set({ anulado: true, anuladoPor: usuarioId, motivoAnulacion: `Pago a entrenador anulado: ${motivo}` }).where('id', '=', p.movimientoId).execute();
    await trx.insertInto('auditoria').values({ usuarioId, accion: 'entrenador.pago_anulado', detalle: JSON.stringify({ pagoId: id, motivo }) }).execute();
    return { ok: true };
  });
}

export async function historialPagos(f: { entrenadorId?: string; desde?: string; hasta?: string }) {
  let q = db
    .selectFrom('entrenadorPagos as p')
    .innerJoin('entrenadores as e', 'e.id', 'p.entrenadorId')
    .innerJoin('usuarios as u', 'u.id', 'p.registradoPor')
    .innerJoin('metodosPago as m', 'm.codigo', 'p.metodo')
    .select([
      'p.id',
      'p.desde',
      'p.hasta',
      'p.pagoTipo',
      'p.tarifa',
      'p.horas',
      'p.clases',
      'p.montoBase',
      'p.bonos',
      'p.descuentos',
      'p.total',
      'p.moneda',
      'p.nota',
      'p.creadoEn',
      'p.anulado',
      'm.nombre as metodo',
      'u.nombre as registro',
      'e.id as entrenadorId',
      sql<string>`trim(e.nombre || ' ' || e.apellido)`.as('entrenador'),
    ])
    .orderBy('p.creadoEn', 'desc')
    .limit(300);
  if (f.entrenadorId) q = q.where('p.entrenadorId', '=', f.entrenadorId);
  if (f.desde) q = q.where('p.hasta', '>=', f.desde);
  if (f.hasta) q = q.where('p.desde', '<=', f.hasta);
  const rows = await q.execute();
  return rows.map((p) => ({ ...p, totalTexto: fmt(Number(p.total), p.moneda), baseTexto: fmt(Number(p.montoBase), p.moneda), bonosTexto: fmt(Number(p.bonos), p.moneda), descuentosTexto: fmt(Number(p.descuentos), p.moneda), horas: Number(p.horas) }));
}
