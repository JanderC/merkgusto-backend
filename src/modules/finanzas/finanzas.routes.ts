/**
 * Finanzas (dueño y administrador de caja).
 * Todo se suma en la moneda de referencia (MONEDA_REFERENCIA) y además se
 * muestra el flujo REAL de cada moneda: cuántos dólares, bolívares y pesos
 * entraron y salieron.
 */
import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../db/index.js';
import type { Moneda } from '../../db/types.js';
import { ah, parse } from '../../lib/http.js';
import { convertir, MONEDA_REF, MONEDAS, redondear, type Tasas } from '../../lib/monedas.js';
import { listarMovimientos } from '../caja/caja.routes.js';
import { resumenTurnos } from '../caja/caja.service.js';
import { resumenDia } from '../dashboard/resumen.service.js';
import { CATEGORIA_COMPRAS } from '../inventario/inventario.service.js';
import { getTasas } from '../tasas/tasas.service.js';

export const finanzasRouter = Router();
const f = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const r = (n: unknown) => redondear(Number(n ?? 0), MONEDA_REF);

finanzasRouter.get(
  '/resumen',
  ah(async (req, res) => {
    const { desde, hasta } = parse(z.object({ desde: f, hasta: f }), req.query);
    const enRango = (col: string) => sql<boolean>`${sql.ref(col)}::date between ${desde}::date and ${hasta}::date`;

    const [ventas, flujoVentas, flujoMovs, porMetodo, categorias, serie, costos, deudas, abonos] = await Promise.all([
      db
        .selectFrom('ventas')
        .select([
          sql<number>`coalesce(sum(total_ref), 0)`.as('vendido'),
          sql<number>`coalesce(sum(pagado_ref), 0)`.as('cobrado'),
          sql<number>`count(*)`.as('n'),
        ])
        .where('estado', '=', 'pagada')
        .where(enRango('creado_en'))
        .executeTakeFirstOrThrow(),
      // Flujo real por moneda de las ventas (vueltos restan)
      db
        .selectFrom('ventaPagos as p')
        .innerJoin('ventas as v', 'v.id', 'p.ventaId')
        .select(['p.moneda', sql<number>`sum(p.monto_moneda)`.as('monto')])
        .where('v.estado', '=', 'pagada')
        .where(enRango('v.creado_en'))
        .groupBy('p.moneda')
        .execute(),
      db
        .selectFrom('cajaMovimientos')
        .select(['moneda', 'tipo', sql<number>`sum(monto)`.as('monto')])
        .where('anulado', '=', false)
        .where(enRango('creado_en'))
        .groupBy(['moneda', 'tipo'])
        .execute(),
      db
        .selectFrom('ventaPagos as p')
        .innerJoin('ventas as v', 'v.id', 'p.ventaId')
        .innerJoin('metodosPago as m', 'm.codigo', 'p.metodo')
        .select(['m.nombre', 'p.moneda', sql<number>`sum(p.monto_moneda)`.as('montoMoneda'), sql<number>`sum(p.monto_ref)`.as('montoRef'), sql<number>`count(*) filter (where not p.es_vuelto)`.as('n')])
        .where('v.estado', '=', 'pagada')
        .where(enRango('v.creado_en'))
        .groupBy(['m.nombre', 'm.orden', 'p.moneda'])
        .orderBy('m.orden')
        .execute(),
      db
        .selectFrom('cajaMovimientos')
        .select(['tipo', 'categoria', sql<number>`sum(monto_ref)`.as('montoRef'), sql<number>`count(*)`.as('n')])
        .where('anulado', '=', false)
        .where(enRango('creado_en'))
        .groupBy(['tipo', 'categoria'])
        .orderBy(sql`sum(monto_ref)`, 'desc')
        .execute(),
      db
        .selectFrom(sql<{ g: string }>`generate_series(${desde}::date, ${hasta}::date, '1 day')`.as('g'))
        .select([
          sql<string>`to_char(g, 'YYYY-MM-DD')`.as('fecha'),
          sql<number>`coalesce((select sum(v.pagado_ref) from ventas v where v.estado = 'pagada' and v.creado_en::date = g::date), 0)`.as('cobrado'),
          sql<number>`coalesce((select sum(c.monto_ref) from caja_movimientos c where not c.anulado and c.tipo = 'ingreso' and c.creado_en::date = g::date), 0)`.as('otrosIngresos'),
          sql<number>`coalesce((select sum(c.monto_ref) from caja_movimientos c where not c.anulado and c.tipo = 'egreso' and c.creado_en::date = g::date), 0)`.as('egresos'),
        ])
        .orderBy('fecha')
        .execute(),
      // Costo de lo vendido (productos) convertido con la tasa de cada venta
      db
        .selectFrom('ventaItems as i')
        .innerJoin('ventas as v', 'v.id', 'i.ventaId')
        .innerJoin('productos as p', 'p.id', 'i.referenciaId')
        .select(['i.cantidad', 'p.costo', 'p.moneda', 'v.tasas'])
        .where('i.tipo', '=', 'producto')
        .where('v.estado', '=', 'pagada')
        .where(enRango('v.creado_en'))
        .execute(),
      db
        .selectFrom('deudas')
        .select([sql<number>`coalesce(sum(saldo), 0)`.as('saldo'), sql<number>`count(distinct socio_id)`.as('clientes')])
        .where('estado', '=', 'pendiente')
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('ventaItems as i')
        .innerJoin('ventas as v', 'v.id', 'i.ventaId')
        .select(sql<number>`coalesce(sum(i.subtotal_ref), 0)`.as('monto'))
        .where('i.tipo', '=', 'abono')
        .where('v.estado', '=', 'pagada')
        .where(enRango('v.creado_en'))
        .executeTakeFirstOrThrow(),
    ]);

    const tasasHoy = await getTasas();
    const costoVendido = r(
      costos.reduce((s, c) => s + convertir(Number(c.costo) * c.cantidad, c.moneda as Moneda, MONEDA_REF, ((c.tasas as Tasas | null) ?? tasasHoy)), 0),
    );
    const otrosIngresos = r(categorias.filter((c) => c.tipo === 'ingreso').reduce((s, c) => s + Number(c.montoRef), 0));
    const egresos = r(categorias.filter((c) => c.tipo === 'egreso').reduce((s, c) => s + Number(c.montoRef), 0));
    // Comprar mercancía no es gasto: es inventario. Entra a la utilidad como costo cuando se vende.
    const comprasInventario = r(categorias.filter((c) => c.tipo === 'egreso' && c.categoria === CATEGORIA_COMPRAS).reduce((s, c) => s + Number(c.montoRef), 0));
    const cobrado = r(ventas.cobrado);

    // Flujo neto real por moneda: ventas + ingresos − egresos
    const flujo = MONEDAS.map((m) => {
      const ventasM = Number(flujoVentas.find((x) => x.moneda === m)?.monto ?? 0);
      const ing = Number(flujoMovs.find((x) => x.moneda === m && x.tipo === 'ingreso')?.monto ?? 0);
      const egr = Number(flujoMovs.find((x) => x.moneda === m && x.tipo === 'egreso')?.monto ?? 0);
      return { moneda: m, ventas: redondear(ventasM, m), ingresos: redondear(ing, m), egresos: redondear(egr, m), neto: redondear(ventasM + ing - egr, m) };
    });

    const turnos = await resumenTurnos({ desde, hasta });
    const cerrados = turnos.filter((t) => t.estado !== 'abierto');

    res.json({
      desde,
      hasta,
      monedaRef: MONEDA_REF,
      totales: {
        vendido: r(ventas.vendido),
        cobrado,
        fiado: r(Number(ventas.vendido) - Number(ventas.cobrado)),
        abonosCobrados: r(abonos.monto),
        otrosIngresos,
        egresos,
        costoVendido,
        comprasInventario,
        utilidad: r(cobrado + otrosIngresos - (egresos - comprasInventario) - costoVendido),
        operaciones: Number(ventas.n),
      },
      flujo,
      porMetodo: porMetodo.map((m) => ({ nombre: m.nombre, moneda: m.moneda, montoMoneda: Number(m.montoMoneda), montoRef: r(m.montoRef), n: Number(m.n) })).filter((m) => m.montoMoneda !== 0),
      categorias: categorias.map((c) => ({ tipo: c.tipo, categoria: c.categoria, montoRef: r(c.montoRef), n: Number(c.n) })),
      serie: serie.map((s) => ({ fecha: s.fecha, cobrado: r(s.cobrado), otrosIngresos: r(s.otrosIngresos), egresos: r(s.egresos), neto: r(Number(s.cobrado) + Number(s.otrosIngresos) - Number(s.egresos)) })),
      porCobrar: { saldo: r(deudas.saldo), clientes: Number(deudas.clientes) },
      cierres: {
        cantidad: cerrados.length,
        abiertos: turnos.length - cerrados.length,
        faltantes: r(cerrados.filter((t) => t.diferencia < 0).reduce((s, t) => s + t.diferencia, 0)),
        sobrantes: r(cerrados.filter((t) => t.diferencia > 0).reduce((s, t) => s + t.diferencia, 0)),
        sinDeclarar: cerrados.filter((t) => !t.declaro).length,
      },
    });
  }),
);

/** El día completo para el administrador de caja: resumen, cierres y movimientos. */
finanzasRouter.get(
  '/dia',
  ah(async (req, res) => {
    const { fecha } = parse(z.object({ fecha: f }), req.query);
    const [resumen, movimientos] = await Promise.all([resumenDia(fecha), listarMovimientos({ desde: fecha, hasta: fecha })]);
    res.json({ ...resumen, movimientos });
  }),
);
