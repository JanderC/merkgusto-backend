/**
 * Caja en vivo (administración): lo que tiene cada caja abierta en este momento,
 * por método y moneda, lo que va vendiendo y cada movimiento a medida que pasa.
 */
import { sql } from 'kysely';
import { db } from '../../db/index.js';
import type { Moneda } from '../../db/types.js';
import { convertir, fmt, MONEDA_REF, MONEDAS, redondear } from '../../lib/monedas.js';
import { hoy } from '../../lib/util.js';
import { getTasas } from '../configuracion/config.service.js';
import { resumenTurnos } from './caja.service.js';

export interface EventoCaja {
  id: string;
  tipo: 'venta' | 'anulada' | 'ingreso' | 'egreso';
  hora: Date;
  turnoId: string | null;
  cajero: string;
  titulo: string;
  detalle: string | null;
  montoRef: number;
  montoTexto: string;
}

export async function cajaEnVivo() {
  const h = hoy();
  const [abiertos, delDia, tasas, ventas, movs, porHora, top] = await Promise.all([
    resumenTurnos({ estado: 'abierto' }),
    resumenTurnos({ desde: h, hasta: h }),
    getTasas(),
    db
      .selectFrom('ventas as v')
      .innerJoin('usuarios as u', 'u.id', 'v.cajeroId')
      .leftJoin('socios as s', 's.id', 'v.socioId')
      .select([
        'v.id',
        'v.numero',
        'v.creadoEn',
        'v.turnoId',
        'v.estado',
        'v.totalRef',
        'u.nombre as cajero',
        sql<string | null>`nullif(trim(s.nombre || ' ' || s.apellido), '')`.as('socio'),
        sql<string>`(select string_agg(i.descripcion || case when i.cantidad > 1 then ' ×' || i.cantidad else '' end, ', ' order by i.id) from venta_items i where i.venta_id = v.id)`.as('items'),
        sql<string>`(select string_agg(case when p.es_vuelto then 'vuelto ' else '' end || m.nombre || ' ' || case p.moneda when 'VES' then 'Bs' when 'COP' then 'COP' else '$' end || ' ' || to_char(abs(p.monto_moneda), 'FM999G999G999G990D00'), ' · ' order by p.id) from venta_pagos p join metodos_pago m on m.codigo = p.metodo where p.venta_id = v.id)`.as('pagos'),
      ])
      .where(sql`v.creado_en::date`, '=', h)
      .orderBy('v.creadoEn', 'desc')
      .limit(60)
      .execute(),
    db
      .selectFrom('cajaMovimientos as c')
      .innerJoin('usuarios as u', 'u.id', 'c.usuarioId')
      .innerJoin('metodosPago as m', 'm.codigo', 'c.metodo')
      .select(['c.id', 'c.tipo', 'c.categoria', 'c.concepto', 'c.moneda', 'c.monto', 'c.montoRef', 'c.anulado', 'c.creadoEn', 'c.turnoId', 'u.nombre as usuario', 'm.nombre as metodo'])
      .where(sql`c.creado_en::date`, '=', h)
      .orderBy('c.creadoEn', 'desc')
      .limit(60)
      .execute(),
    db
      .selectFrom('ventas')
      .select([sql<number>`extract(hour from creado_en)::int`.as('hora'), sql<number>`count(*)::int`.as('ventas'), sql<number>`coalesce(sum(total_ref), 0)`.as('totalRef')])
      .where(sql`creado_en::date`, '=', h)
      .where('estado', '=', 'pagada')
      .groupBy(sql`extract(hour from creado_en)`)
      .execute(),
    db
      .selectFrom('ventaItems as i')
      .innerJoin('ventas as v', 'v.id', 'i.ventaId')
      .select(['i.tipo', 'i.descripcion', sql<number>`sum(i.cantidad)::int`.as('cantidad')])
      .where(sql`v.creado_en::date`, '=', h)
      .where('v.estado', '=', 'pagada')
      .where('i.tipo', '!=', 'abono')
      .groupBy(['i.tipo', 'i.descripcion'])
      .orderBy('cantidad', 'desc')
      .limit(8)
      .execute(),
  ]);

  // Lo que hay en todas las cajas abiertas, por método y moneda
  const enCajas = new Map<string, { metodo: string; nombre: string; moneda: Moneda; esperado: number; cobrado: number; egresos: number }>();
  for (const t of abiertos)
    for (const m of t.metodos) {
      const k = `${m.metodo}|${m.moneda}`;
      const x = enCajas.get(k) ?? { metodo: m.metodo, nombre: m.nombre, moneda: m.moneda, esperado: 0, cobrado: 0, egresos: 0 };
      x.esperado += m.esperado;
      x.cobrado += m.cobrado;
      x.egresos += m.egresos;
      enCajas.set(k, x);
    }
  const efectivo = MONEDAS.map((mon) => ({ moneda: mon, monto: redondear([...enCajas.values()].filter((x) => x.metodo === 'efectivo' && x.moneda === mon).reduce((s, x) => s + x.esperado, 0), mon) }));
  const totalEnCajasRef = redondear([...enCajas.values()].reduce((s, x) => s + convertir(x.esperado, x.moneda, MONEDA_REF, tasas), 0), MONEDA_REF);

  const eventos: EventoCaja[] = [
    ...ventas.map((v) => ({
      id: `v${v.id}`,
      tipo: (v.estado === 'anulada' ? 'anulada' : 'venta') as EventoCaja['tipo'],
      hora: v.creadoEn,
      turnoId: v.turnoId,
      cajero: v.cajero,
      titulo: `#${v.numero} · ${v.items ?? 'Venta'}`,
      detalle: [v.socio ?? 'Cliente ocasional', v.pagos].filter(Boolean).join(' · '),
      montoRef: Number(v.totalRef),
      montoTexto: fmt(Number(v.totalRef), MONEDA_REF),
    })),
    ...movs.map((m) => ({
      id: `m${m.id}`,
      tipo: m.tipo as 'ingreso' | 'egreso',
      hora: m.creadoEn,
      turnoId: m.turnoId,
      cajero: m.usuario,
      titulo: `${m.tipo === 'egreso' ? 'Gasto' : 'Ingreso'}: ${m.concepto}${m.anulado ? ' (anulado)' : ''}`,
      detalle: `${m.categoria} · ${m.metodo}`,
      montoRef: Number(m.montoRef) * (m.tipo === 'egreso' ? -1 : 1),
      montoTexto: `${m.tipo === 'egreso' ? '−' : '+'}${fmt(Number(m.monto), m.moneda as Moneda)}`,
    })),
  ]
    .sort((a, b) => b.hora.getTime() - a.hora.getTime())
    .slice(0, 60);

  const sum = (k: 'totalVendidoRef' | 'cobradoRef' | 'fiadoRef' | 'ingresosRef' | 'egresosRef' | 'operaciones' | 'anuladas') => redondear(delDia.reduce((s, t) => s + Number(t[k]), 0), MONEDA_REF);
  const ultimaPorTurno = new Map<string, Date>();
  for (const v of ventas) if (v.turnoId && !ultimaPorTurno.has(v.turnoId)) ultimaPorTurno.set(v.turnoId, v.creadoEn);

  return {
    ahora: new Date(),
    monedaRef: MONEDA_REF,
    tasas,
    dia: {
      vendido: sum('totalVendidoRef'),
      cobrado: sum('cobradoRef'),
      fiado: sum('fiadoRef'),
      ingresos: sum('ingresosRef'),
      egresos: sum('egresosRef'),
      ventas: sum('operaciones'),
      anuladas: sum('anuladas'),
      turnos: delDia.length,
      cerrados: delDia.filter((t) => t.estado !== 'abierto').length,
      balanceCierres: redondear(delDia.filter((t) => t.estado !== 'abierto').reduce((s, t) => s + t.diferencia, 0), MONEDA_REF),
    },
    enCajas: {
      totalRef: totalEnCajasRef,
      efectivo,
      metodos: [...enCajas.values()].filter((x) => x.esperado || x.cobrado || x.egresos).map((x) => ({ ...x, esperado: redondear(x.esperado, x.moneda), ref: redondear(convertir(x.esperado, x.moneda, MONEDA_REF, tasas), MONEDA_REF) })),
    },
    cajas: abiertos.map((t) => ({
      ...t,
      enCajaRef: redondear(t.metodos.reduce((s, m) => s + convertir(m.esperado, m.moneda, MONEDA_REF, tasas), 0), MONEDA_REF),
      ultimaVenta: ultimaPorTurno.get(t.id) ?? null,
    })),
    porHora: Array.from({ length: 24 }, (_, i) => {
      const x = porHora.find((p) => Number(p.hora) === i);
      return { hora: i, ventas: Number(x?.ventas ?? 0), totalRef: Number(x?.totalRef ?? 0) };
    }),
    top: top.map((t) => ({ ...t, cantidad: Number(t.cantidad) })),
    eventos,
  };
}
