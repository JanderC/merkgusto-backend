import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { ah, parse } from '../../lib/http.js';
import { hoy, round2, sumarDias } from '../../lib/util.js';
import { resumenTurnos } from '../caja/caja.service.js';
import { resumenDia } from './resumen.service.js';

/** Panel y reportes: solo dueño (se monta con soloDueno). */
export const dashboardRouter = Router();

const finVigente = sql<string | null>`(select max(m.fecha_fin) from membresias m where m.socio_id = s.id and m.estado = 'activa')`;

dashboardRouter.get(
  '/',
  ah(async (_req, res) => {
    const h = hoy();
    const desde = sumarDias(h, -13);
    const [dia, socios, serie, porHora, stockBajo, pendientesRevision, bioErrores] = await Promise.all([
      resumenDia(h),
      db
        .selectFrom('socios as s')
        .select([
          sql<number>`count(*) filter (where s.activo)`.as('total'),
          sql<number>`count(*) filter (where s.activo and ${finVigente} >= ${h})`.as('vigentes'),
          sql<number>`count(*) filter (where s.activo and ${finVigente} between ${h} and ${sumarDias(h, 5)})`.as('porVencer'),
          sql<number>`count(*) filter (where s.activo and ${finVigente} between ${sumarDias(h, -15)} and ${sumarDias(h, -1)})`.as('vencidosRecientes'),
          sql<number>`count(*) filter (where s.activo and s.bio_estado <> 'sincronizado')`.as('sinRostro'),
        ])
        .executeTakeFirstOrThrow(),
      db
        .selectFrom(sql<{ d: string }>`generate_series(${desde}::date, ${h}::date, '1 day')`.as('g'))
        .select([
          sql<string>`to_char(g, 'YYYY-MM-DD')`.as('fecha'),
          sql<number>`coalesce((select sum(v.total_ref) from ventas v where v.estado = 'pagada' and v.creado_en::date = g::date), 0)`.as('ingresos'),
          sql<number>`(select count(distinct a.socio_id) from asistencias a where a.resultado = 'permitido' and a.fecha_hora::date = g::date)`.as('personas'),
        ])
        .orderBy('fecha')
        .execute(),
      db
        .selectFrom('asistencias')
        .select([sql<number>`extract(hour from fecha_hora)::int`.as('hora'), sql<number>`count(*)`.as('n')])
        .where('resultado', '=', 'permitido')
        .where(sql`fecha_hora::date`, '>=', sumarDias(h, -29))
        .groupBy(sql`1`)
        .orderBy(sql`1`)
        .execute(),
      db
        .selectFrom('productos')
        .select(['id', 'nombre', 'stock', 'stockMinimo'])
        .where('activo', '=', true)
        .where('controlaStock', '=', true)
        .whereRef('stock', '<=', 'stockMinimo')
        .orderBy('stock')
        .limit(8)
        .execute(),
      db.selectFrom('turnos').select('id').where('estado', '=', 'cerrado').execute(),
      db
        .selectFrom('bioCola')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('estado', 'in', ['error', 'descartado'])
        .where('creadoEn', '>', sql<Date>`now() - interval '7 days'`)
        .executeTakeFirstOrThrow(),
    ]);
    const porRevisar = await resumenTurnos({ ids: pendientesRevision.map((t) => t.id) });
    res.json({
      hoy: dia,
      socios: Object.fromEntries(Object.entries(socios).map(([k, v]) => [k, Number(v)])),
      serie: serie.map((s) => ({ ...s, ingresos: round2(Number(s.ingresos)), personas: Number(s.personas) })),
      // Promedio diario de entradas por hora en los últimos 30 días
      porHora: Array.from({ length: 24 }, (_, hora) => ({ hora, promedio: round2(Number(porHora.find((p) => p.hora === hora)?.n ?? 0) / 30) })),
      stockBajo,
      porRevisar: porRevisar.map((t) => ({ id: t.id, numero: t.numero, cajero: t.cajero, cerradoEn: t.cerradoEn, diferencia: t.diferencia, totalVendido: t.totalVendidoRef })),
      bioErrores: Number(bioErrores.n),
    });
  }),
);

dashboardRouter.get(
  '/reporte',
  ah(async (req, res) => {
    const f = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    const q = parse(z.object({ desde: f, hasta: f }), req.query);
    const [serie, metodos, top, cajeros, turnos] = await Promise.all([
      db
        .selectFrom(sql<{ d: string }>`generate_series(${q.desde}::date, ${q.hasta}::date, '1 day')`.as('g'))
        .select([
          sql<string>`to_char(g, 'YYYY-MM-DD')`.as('fecha'),
          sql<number>`coalesce((select sum(v.total_ref) from ventas v where v.estado = 'pagada' and v.creado_en::date = g::date), 0)`.as('ingresos'),
          sql<number>`(select count(distinct a.socio_id) from asistencias a where a.resultado = 'permitido' and a.fecha_hora::date = g::date)`.as('personas'),
        ])
        .orderBy('fecha')
        .execute(),
      db
        .selectFrom('ventaPagos as p')
        .innerJoin('ventas as v', 'v.id', 'p.ventaId')
        .innerJoin('metodosPago as m', 'm.codigo', 'p.metodo')
        .select(['m.nombre', 'p.moneda', sql<number>`sum(p.monto_moneda)`.as('montoMoneda'), sql<number>`sum(p.monto_ref)`.as('monto'), sql<number>`count(*) filter (where not p.es_vuelto)`.as('n')])
        .where('v.estado', '=', 'pagada')
        .where(sql`v.creado_en::date`, '>=', q.desde)
        .where(sql`v.creado_en::date`, '<=', q.hasta)
        .groupBy(['m.nombre', 'm.orden', 'p.moneda'])
        .orderBy('m.orden')
        .execute(),
      db
        .selectFrom('ventaItems as i')
        .innerJoin('ventas as v', 'v.id', 'i.ventaId')
        .select(['i.descripcion', 'i.tipo', sql<number>`sum(i.cantidad)`.as('cantidad'), sql<number>`sum(i.subtotal_ref)`.as('monto')])
        .where('v.estado', '=', 'pagada')
        .where(sql`v.creado_en::date`, '>=', q.desde)
        .where(sql`v.creado_en::date`, '<=', q.hasta)
        .groupBy(['i.descripcion', 'i.tipo'])
        .orderBy(sql`sum(i.subtotal_ref)`, 'desc')
        .limit(12)
        .execute(),
      db
        .selectFrom('ventas as v')
        .innerJoin('usuarios as u', 'u.id', 'v.cajeroId')
        .select(['u.nombre', sql<number>`sum(v.total_ref)`.as('monto'), sql<number>`count(*)`.as('n')])
        .where('v.estado', '=', 'pagada')
        .where(sql`v.creado_en::date`, '>=', q.desde)
        .where(sql`v.creado_en::date`, '<=', q.hasta)
        .groupBy('u.nombre')
        .orderBy(sql`sum(v.total_ref)`, 'desc')
        .execute(),
      resumenTurnos({ desde: q.desde, hasta: q.hasta }),
    ]);
    const cerrados = turnos.filter((t) => t.estado !== 'abierto');
    res.json({
      serie: serie.map((s) => ({ ...s, ingresos: round2(Number(s.ingresos)), personas: Number(s.personas) })),
      metodos: metodos.map((m) => ({ nombre: m.nombre, moneda: m.moneda, montoMoneda: Number(m.montoMoneda), monto: round2(Number(m.monto)), n: Number(m.n) })),
      top: top.map((t) => ({ ...t, cantidad: Number(t.cantidad), monto: round2(Number(t.monto)) })),
      cajeros: cajeros.map((c) => ({ nombre: c.nombre, monto: round2(Number(c.monto)), n: Number(c.n) })),
      cierres: {
        cantidad: cerrados.length,
        faltantes: round2(cerrados.filter((t) => t.diferencia < 0).reduce((s, t) => s + t.diferencia, 0)),
        sobrantes: round2(cerrados.filter((t) => t.diferencia > 0).reduce((s, t) => s + t.diferencia, 0)),
      },
    });
  }),
);
