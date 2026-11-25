import { sql } from 'kysely';
import { db } from '../../db/index.js';
import type { Moneda } from '../../db/types.js';
import { MONEDA_REF, redondear } from '../../lib/monedas.js';
import { resumenAsistencia } from '../asistencia/asistencia.service.js';
import { resumenTurnos } from '../caja/caja.service.js';

const r = (n: unknown) => redondear(Number(n ?? 0), MONEDA_REF);

/** Resumen completo de un día: lo usan el panel, finanzas y el reporte de WhatsApp. */
export async function resumenDia(fecha: string) {
  const [ventas, porMetodo, porTipo, nuevos, asistencia, turnosIds, movs, deudas] = await Promise.all([
    db
      .selectFrom('ventas')
      .select([
        sql<number>`coalesce(sum(total_ref) filter (where estado = 'pagada'), 0)`.as('total'),
        sql<number>`coalesce(sum(pagado_ref) filter (where estado = 'pagada'), 0)`.as('cobrado'),
        sql<number>`count(*) filter (where estado = 'pagada')`.as('operaciones'),
        sql<number>`count(*) filter (where estado = 'anulada')`.as('anuladas'),
      ])
      .where(sql`creado_en::date`, '=', fecha)
      .executeTakeFirstOrThrow(),
    // Neto por método y moneda (los vueltos restan)
    db
      .selectFrom('ventaPagos as p')
      .innerJoin('ventas as v', 'v.id', 'p.ventaId')
      .innerJoin('metodosPago as m', 'm.codigo', 'p.metodo')
      .select(['m.nombre', 'p.moneda', sql<number>`sum(p.monto_moneda)`.as('montoMoneda'), sql<number>`sum(p.monto_ref)`.as('monto')])
      .where('v.estado', '=', 'pagada')
      .where(sql`v.creado_en::date`, '=', fecha)
      .groupBy(['m.nombre', 'm.orden', 'p.moneda'])
      .orderBy('m.orden')
      .execute(),
    db
      .selectFrom('ventaItems as i')
      .innerJoin('ventas as v', 'v.id', 'i.ventaId')
      .select(['i.tipo', sql<number>`sum(i.subtotal_ref)`.as('monto'), sql<number>`sum(i.cantidad)`.as('cantidad')])
      .where('v.estado', '=', 'pagada')
      .where(sql`v.creado_en::date`, '=', fecha)
      .groupBy('i.tipo')
      .execute(),
    db
      .selectFrom('socios')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where(sql`creado_en::date`, '=', fecha)
      .executeTakeFirstOrThrow(),
    resumenAsistencia(fecha),
    db
      .selectFrom('turnos')
      .select('id')
      .where((eb) => eb.or([eb(sql`cerrado_en::date`, '=', fecha), eb.and([eb('estado', '=', 'abierto'), eb(sql`abierto_en::date`, '<=', fecha)])]))
      .execute(),
    db
      .selectFrom('cajaMovimientos')
      .select([
        sql<number>`coalesce(sum(monto_ref) filter (where tipo = 'ingreso'), 0)`.as('ingresos'),
        sql<number>`coalesce(sum(monto_ref) filter (where tipo = 'egreso'), 0)`.as('egresos'),
        sql<number>`count(*)`.as('n'),
      ])
      .where('anulado', '=', false)
      .where(sql`creado_en::date`, '=', fecha)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('deudas')
      .select([sql<number>`coalesce(sum(saldo), 0)`.as('saldo'), sql<number>`count(*)`.as('n')])
      .where('estado', '=', 'pendiente')
      .executeTakeFirstOrThrow(),
  ]);
  const turnos = await resumenTurnos({ ids: turnosIds.map((t) => t.id) });
  const tipo = (t: string) => porTipo.find((x) => x.tipo === t);
  return {
    fecha,
    monedaRef: MONEDA_REF,
    ventas: {
      total: r(ventas.total),
      cobrado: r(ventas.cobrado),
      fiado: r(Number(ventas.total) - Number(ventas.cobrado)),
      operaciones: Number(ventas.operaciones),
      anuladas: Number(ventas.anuladas),
      membresias: { cantidad: Number(tipo('membresia')?.cantidad ?? 0), monto: r(tipo('membresia')?.monto) },
      productos: { cantidad: Number(tipo('producto')?.cantidad ?? 0), monto: r(tipo('producto')?.monto) },
      abonos: { cantidad: Number(tipo('abono')?.cantidad ?? 0), monto: r(tipo('abono')?.monto) },
      personalizados: { cantidad: Number(tipo('personalizado')?.cantidad ?? 0), monto: r(tipo('personalizado')?.monto) },
      porMetodo: porMetodo
        .map((m) => ({ nombre: m.nombre, moneda: m.moneda as Moneda, montoMoneda: Number(m.montoMoneda), monto: r(m.monto) }))
        .filter((m) => m.montoMoneda !== 0),
    },
    caja: { ingresos: r(movs.ingresos), egresos: r(movs.egresos), movimientos: Number(movs.n) },
    deudas: { saldo: r(deudas.saldo), cantidad: Number(deudas.n) },
    sociosNuevos: Number(nuevos.n),
    asistencia,
    turnos: turnos.sort((a, b) => +a.abiertoEn - +b.abiertoEn),
  };
}
