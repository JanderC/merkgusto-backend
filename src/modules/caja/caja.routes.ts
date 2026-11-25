import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { ah, badRequest, notFound, parse } from '../../lib/http.js';
import { fmt, MONEDA_REF } from '../../lib/monedas.js';
import { usuarioActual } from '../../middleware/auth.js';
import { guardarArchivo } from '../archivos/archivos.service.js';
import { getConfig } from '../configuracion/config.service.js';
import { describirDuracion } from '../membresias/membresias.service.js';
import { tasaVigente } from '../tasas/tasas.service.js';
import { abrirTurno, anularMovimiento, anularVenta, cerrarTurno, registrarMovimiento, registrarVenta, resumenTurnos, vistaCiegaTurno } from './caja.service.js';
import { listarDevoluciones, registrarDevolucion, ticketParaDevolucion } from './devoluciones.service.js';
import { cajaEnVivo } from './caja-vivo.js';
import { excelCierres, excelMovimientos } from './exportar.js';

const moneda = z.enum(['USD', 'VES', 'COP']);

// ═════════════════════════════════════════════════════════════════════
//  POS — cajera (y dueño/admin si atienden)   /api/pos
//  Ninguna respuesta de este router incluye totales acumulados.
// ═════════════════════════════════════════════════════════════════════
export const posRouter = Router();

posRouter.get(
  '/catalogo',
  ah(async (_req, res) => {
    const [planes, productos, metodos, tasa, categorias, masVendidos, entrenadores] = await Promise.all([
      db
        .selectFrom('planes')
        .select(['id', 'nombre', 'descripcion', 'precio', 'moneda', 'tipoDuracion', 'cantidad', 'personas', 'congelable', 'accesoLector', 'color'])
        .where('activo', '=', true)
        .orderBy('orden')
        .orderBy('precio')
        .execute(),
      db
        .selectFrom('productos')
        .select(['id', 'nombre', 'categoria', 'precio', 'moneda', 'stock', 'controlaStock', 'codigoBarras'])
        .where('activo', '=', true)
        .orderBy('categoria')
        .orderBy('nombre')
        .execute(),
      db.selectFrom('metodosPago').select(['codigo', 'nombre', 'pideReferencia', 'monedas']).where('activo', '=', true).orderBy('orden').execute(),
      tasaVigente(),
      getConfig('categorias'),
      // Venta rápida: los productos más vendidos de los últimos 30 días
      db
        .selectFrom('ventaItems as i')
        .innerJoin('ventas as v', 'v.id', 'i.ventaId')
        .select(['i.referenciaId as id', sql<number>`sum(i.cantidad)::int`.as('n')])
        .where('i.tipo', '=', 'producto')
        .where('v.estado', '=', 'pagada')
        .where('v.creadoEn', '>', sql<Date>`now() - interval '30 days'`)
        .groupBy('i.referenciaId')
        .orderBy('n', 'desc')
        .limit(8)
        .execute(),
      // Entrenamiento personalizado: entrenadores con tarifa
      db
        .selectFrom('entrenadores')
        .select(['id', 'nombre', 'apellido', 'especialidad', 'personalizadoPrecio', 'personalizadoSemanal', 'personalizadoMoneda', sql<boolean>`foto is not null`.as('tieneFoto')])
        .where('activo', '=', true)
        .where('personalizadoPrecio', '>', 0 as never)
        .orderBy('nombre')
        .execute(),
    ]);
    res.json({
      planes: planes.map((p) => ({ ...p, duracion: describirDuracion(p) })),
      masVendidos: masVendidos.map((m) => m.id).filter((id) => productos.some((p) => p.id === id)),
      productos,
      entrenadores: entrenadores.map((e) => ({
        id: e.id,
        nombre: `${e.nombre} ${e.apellido}`.trim(),
        especialidad: e.especialidad,
        tieneFoto: e.tieneFoto,
        moneda: e.personalizadoMoneda,
        mensual: Number(e.personalizadoPrecio),
        semanal: e.personalizadoSemanal !== null && Number(e.personalizadoSemanal) > 0 ? Number(e.personalizadoSemanal) : null,
      })),
      metodos,
      tasas: { usdVes: tasa.usdVes, usdCop: tasa.usdCop, vesCop: tasa.vesCop },
      tasasActualizadas: tasa.creadoEn,
      monedaRef: MONEDA_REF,
      categorias,
    });
  }),
);

posRouter.get(
  '/turno',
  ah(async (req, res) => {
    res.json(await vistaCiegaTurno(usuarioActual(req).id));
  }),
);

posRouter.post(
  '/turno/abrir',
  ah(async (req, res) => {
    await abrirTurno(usuarioActual(req).id);
    res.status(201).json(await vistaCiegaTurno(usuarioActual(req).id));
  }),
);

const itemSchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('membresia'), id: z.number().int().positive(), acompanantes: z.array(z.string().uuid()).max(9).optional(), desde: z.enum(['continuar', 'hoy']).optional(), inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
  z.object({ tipo: z.literal('producto'), id: z.number().int().positive(), cantidad: z.number().int().min(1).max(500) }),
  z.object({ tipo: z.literal('abono'), deudaId: z.number().int().positive(), monto: z.number().positive().max(1e12) }),
  z.object({ tipo: z.literal('personalizado'), entrenadorId: z.string().uuid(), periodo: z.enum(['meses', 'semanas']), cantidad: z.number().int().min(1).max(12), desde: z.enum(['continuar', 'hoy']).optional() }),
]);

const ventaSchema = z.object({
  socioId: z.string().uuid().nullable().default(null),
  items: z.array(itemSchema).min(1).max(50),
  pagos: z.array(z.object({ metodo: z.string().max(20), moneda, monto: z.number().min(0).max(1e12), referencia: z.string().max(60).nullish() })).max(8),
  vuelto: z.object({ metodo: z.string().max(20), moneda, monto: z.number().positive().max(1e12) }).nullish(),
  pagoParcial: z.boolean().optional(),
  nota: z.string().max(250).nullish(),
});

posRouter.post(
  '/ventas',
  ah(async (req, res) => {
    const body = parse(ventaSchema, req.body);
    res.status(201).json(await registrarVenta(usuarioActual(req).id, body));
  }),
);

/** Deudas pendientes del cliente (para cobrar abonos). */
posRouter.get(
  '/deudas/:socioId',
  ah(async (req, res) => {
    const rows = await db
      .selectFrom('deudas')
      .select(['id', 'concepto', 'moneda', 'montoTotal', 'saldo', 'creadoEn'])
      .where('socioId', '=', req.params.socioId!)
      .where('estado', '=', 'pendiente')
      .orderBy('creadoEn')
      .execute();
    res.json(rows.map((d) => ({ ...d, saldoTexto: fmt(Number(d.saldo), d.moneda) })));
  }),
);

const movimientoSchema = z.object({
  tipo: z.enum(['ingreso', 'egreso']),
  categoria: z.string().trim().min(2).max(40),
  concepto: z.string().trim().min(3, 'Describe el movimiento').max(200),
  metodo: z.string().max(20),
  moneda,
  monto: z.number().positive().max(1e12),
  referencia: z.string().max(80).nullish(),
  comprobante: z.string().max(6_000_000).nullish(),
  sinTurno: z.boolean().optional(),
});

/** La cajera registra pagos/gastos hechos con dinero de la caja (entran al cierre ciego). */
posRouter.post(
  '/movimientos',
  ah(async (req, res) => {
    const b = parse(movimientoSchema, req.body);
    const u = usuarioActual(req);
    const comprobanteId = b.comprobante ? await guardarArchivo(b.comprobante, 'caja/comprobantes', u.id) : null;
    res.status(201).json(await registrarMovimiento(u, { ...b, comprobanteId, sinTurno: false }));
  }),
);

// ── Devoluciones: solo con el código de un supervisor ──
posRouter.get(
  '/devoluciones/ticket/:numero',
  ah(async (req, res) => {
    const numero = Number(String(req.params.numero).replace(/\D/g, ''));
    if (!numero) throw badRequest('Escribe el número del ticket');
    res.json(await ticketParaDevolucion(numero, usuarioActual(req)));
  }),
);

posRouter.post(
  '/devoluciones',
  ah(async (req, res) => {
    const b = parse(
      z.object({
        ventaId: z.string().uuid(),
        items: z.array(z.object({ ventaItemId: z.number().int().positive(), cantidad: z.number().int().min(0).max(500) })).min(1).max(50),
        metodo: z.string().max(20),
        moneda,
        motivo: z.string().trim().min(4, 'Escribe el motivo de la devolución').max(200),
        reingresaStock: z.boolean().default(true),
        pin: z.string().trim().min(1, 'Falta el código del supervisor').max(12),
      }),
      req.body,
    );
    res.status(201).json(await registrarDevolucion(usuarioActual(req), b));
  }),
);

const cierreSchema = z.object({
  declaraciones: z.array(z.object({ metodo: z.string().max(20), moneda, monto: z.number().min(0).max(1e12) })).max(40),
  nota: z.string().max(500).nullish(),
});

posRouter.post(
  '/turno/cerrar',
  ah(async (req, res) => {
    const body = parse(cierreSchema, req.body);
    const u = usuarioActual(req);
    res.json(await cerrarTurno({ cajeroId: u.id, cerradoPor: u.id, declaraciones: body.declaraciones, nota: body.nota }));
  }),
);

// ═════════════════════════════════════════════════════════════════════
//  Caja — dueño y administrador de caja   /api/caja
// ═════════════════════════════════════════════════════════════════════
export const cajaDuenoRouter = Router();
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

cajaDuenoRouter.get(
  '/turnos',
  ah(async (req, res) => {
    const q = parse(z.object({ desde: fecha, hasta: fecha, cajeroId: z.string().uuid().optional(), estado: z.enum(['abierto', 'cerrado', 'revisado']).optional() }), req.query);
    res.json(await resumenTurnos(q));
  }),
);

cajaDuenoRouter.get(
  '/turnos/:id',
  ah(async (req, res) => {
    const [t] = await resumenTurnos({ ids: [req.params.id!] });
    if (!t) throw notFound('Turno no encontrado');
    const [ventas, movimientos] = await Promise.all([
      db
        .selectFrom('ventas as v')
        .leftJoin('socios as s', 's.id', 'v.socioId')
        .select([
          'v.id',
          'v.numero',
          'v.creadoEn',
          'v.totalRef',
          'v.pagadoRef',
          'v.totales',
          'v.estado',
          'v.motivoAnulacion',
          sql<string | null>`nullif(trim(s.nombre || ' ' || s.apellido), '')`.as('socio'),
          sql<Array<{ descripcion: string; cantidad: number; subtotal: number; moneda: string }>>`(select json_agg(json_build_object('descripcion', i.descripcion, 'cantidad', i.cantidad, 'subtotal', i.subtotal, 'moneda', i.moneda) order by i.id) from venta_items i where i.venta_id = v.id)`.as('items'),
          sql<Array<{ metodo: string; moneda: string; montoMoneda: number; montoRef: number; vuelto: boolean; referencia: string | null }>>`(select json_agg(json_build_object('metodo', m.nombre, 'moneda', p.moneda, 'montoMoneda', p.monto_moneda, 'montoRef', p.monto_ref, 'vuelto', p.es_vuelto, 'referencia', p.referencia) order by p.id) from venta_pagos p join metodos_pago m on m.codigo = p.metodo where p.venta_id = v.id)`.as('pagos'),
        ])
        .where('v.turnoId', '=', t.id)
        .orderBy('v.creadoEn', 'desc')
        .execute(),
      listarMovimientos({ turnoId: t.id }),
    ]);
    res.json({ ...t, ventas, movimientos });
  }),
);

cajaDuenoRouter.post(
  '/turnos/:id/revisar',
  ah(async (req, res) => {
    const { nota } = parse(z.object({ nota: z.string().max(500).nullish() }), req.body);
    const r = await db
      .updateTable('turnos')
      .set({ estado: 'revisado', revisadoPor: usuarioActual(req).id, revisadoEn: sql`now()` as never, notaDueno: nota?.trim() || null })
      .where('id', '=', req.params.id!)
      .where('estado', '=', 'cerrado')
      .executeTakeFirst();
    if (!r.numUpdatedRows) throw notFound('Turno no encontrado o aún abierto');
    res.json({ ok: true });
  }),
);

cajaDuenoRouter.post(
  '/turnos/:id/cerrar',
  ah(async (req, res) => {
    const body = parse(cierreSchema, req.body);
    res.json(await cerrarTurno({ turnoId: req.params.id!, cerradoPor: usuarioActual(req).id, declaraciones: body.declaraciones, nota: body.nota, forzadoPorDueno: true }));
  }),
);

cajaDuenoRouter.get(
  '/devoluciones',
  ah(async (req, res) => {
    res.json(await listarDevoluciones(parse(z.object({ desde: fecha, hasta: fecha }), req.query)));
  }),
);

cajaDuenoRouter.get(
  '/ventas',
  ah(async (req, res) => {
    const q = parse(z.object({ desde: fecha, hasta: fecha, estado: z.enum(['pagada', 'anulada']).optional(), buscar: z.string().max(60).optional() }), req.query);
    let query = db
      .selectFrom('ventas as v')
      .innerJoin('usuarios as u', 'u.id', 'v.cajeroId')
      .innerJoin('turnos as t', 't.id', 'v.turnoId')
      .leftJoin('socios as s', 's.id', 'v.socioId')
      .select([
        'v.id',
        'v.numero',
        'v.creadoEn',
        'v.totalRef',
        'v.pagadoRef',
        'v.monedaRef',
        'v.estado',
        'v.motivoAnulacion',
        'u.nombre as cajero',
        't.numero as turno',
        sql<string | null>`nullif(trim(s.nombre || ' ' || s.apellido), '')`.as('socio'),
        sql<string>`(select string_agg(i.descripcion || case when i.cantidad > 1 then ' ×' || i.cantidad else '' end, ', ' order by i.id) from venta_items i where i.venta_id = v.id)`.as('detalle'),
        sql<string>`(select string_agg(case when p.es_vuelto then 'vuelto ' else '' end || m.nombre || ' ' || case p.moneda when 'VES' then 'Bs' when 'COP' then 'COP' else '$' end || ' ' || to_char(abs(p.monto_moneda), 'FM999G999G999G990D00'), ' · ' order by p.id) from venta_pagos p join metodos_pago m on m.codigo = p.metodo where p.venta_id = v.id)`.as('pagos'),
      ])
      .orderBy('v.creadoEn', 'desc')
      .limit(500);
    if (q.desde) query = query.where(sql`v.creado_en::date`, '>=', q.desde);
    if (q.hasta) query = query.where(sql`v.creado_en::date`, '<=', q.hasta);
    if (q.estado) query = query.where('v.estado', '=', q.estado);
    if (q.buscar) {
      const like = `%${q.buscar.toLowerCase()}%`;
      query = query.where((eb) =>
        eb.or([
          eb(sql`lower(s.nombre || ' ' || s.apellido)`, 'like', like),
          eb(sql`v.numero::text`, '=', q.buscar!),
          eb(sql`exists (select 1 from venta_items i where i.venta_id = v.id and lower(i.descripcion) like ${like})`, '=', true),
        ]),
      );
    }
    res.json(await query.execute());
  }),
);

cajaDuenoRouter.post(
  '/ventas/:id/anular',
  ah(async (req, res) => {
    const { motivo } = parse(z.object({ motivo: z.string().trim().min(3, 'Escribe el motivo').max(250) }), req.body);
    res.json(await anularVenta(req.params.id!, usuarioActual(req).id, motivo));
  }),
);

export async function listarMovimientos(f: { turnoId?: string; desde?: string; hasta?: string; tipo?: 'ingreso' | 'egreso'; limite?: number }) {
  let q = db
    .selectFrom('cajaMovimientos as c')
    .innerJoin('usuarios as u', 'u.id', 'c.usuarioId')
    .innerJoin('metodosPago as m', 'm.codigo', 'c.metodo')
    .leftJoin('turnos as t', 't.id', 'c.turnoId')
    .select([
      'c.id',
      'c.tipo',
      'c.categoria',
      'c.concepto',
      'c.metodo',
      'm.nombre as metodoNombre',
      'c.moneda',
      'c.monto',
      'c.montoRef',
      'c.referencia',
      'c.comprobanteId',
      'c.anulado',
      'c.motivoAnulacion',
      'c.creadoEn',
      'u.nombre as usuario',
      't.numero as turno',
    ])
    .orderBy('c.creadoEn', 'desc')
    .limit(f.limite ?? 500);
  if (f.turnoId) q = q.where('c.turnoId', '=', f.turnoId);
  if (f.desde) q = q.where(sql`c.creado_en::date`, '>=', f.desde);
  if (f.hasta) q = q.where(sql`c.creado_en::date`, '<=', f.hasta);
  if (f.tipo) q = q.where('c.tipo', '=', f.tipo);
  return q.execute();
}

cajaDuenoRouter.get(
  '/movimientos',
  ah(async (req, res) => {
    const q = parse(z.object({ desde: fecha, hasta: fecha, tipo: z.enum(['ingreso', 'egreso']).optional() }), req.query);
    res.json(await listarMovimientos(q));
  }),
);

/** Movimiento de administración (sin turno: alquiler por banco, pago a entrenadores, etc.). */
cajaDuenoRouter.post(
  '/movimientos',
  ah(async (req, res) => {
    const b = parse(movimientoSchema, req.body);
    const u = usuarioActual(req);
    const comprobanteId = b.comprobante ? await guardarArchivo(b.comprobante, 'caja/comprobantes', u.id) : null;
    res.status(201).json(await registrarMovimiento(u, { ...b, comprobanteId, sinTurno: b.sinTurno ?? true }));
  }),
);

/** Caja en vivo: todas las cajas abiertas, lo que tienen y lo que va pasando. */
cajaDuenoRouter.get(
  '/en-vivo',
  ah(async (_req, res) => {
    res.json(await cajaEnVivo());
  }),
);

/** Registrar en la caja de una cajera (retiro de efectivo, sencillo, gasto pagado con su caja). */
cajaDuenoRouter.post(
  '/turnos/:id/movimientos',
  ah(async (req, res) => {
    const b = parse(movimientoSchema, req.body);
    const u = usuarioActual(req);
    const comprobanteId = b.comprobante ? await guardarArchivo(b.comprobante, 'caja/comprobantes', u.id) : null;
    res.status(201).json(await registrarMovimiento(u, { ...b, comprobanteId, enTurnoId: req.params.id! }));
  }),
);

cajaDuenoRouter.post(
  '/movimientos/:id/anular',
  ah(async (req, res) => {
    const { motivo } = parse(z.object({ motivo: z.string().trim().min(3).max(200) }), req.body);
    res.json(await anularMovimiento(Number(req.params.id), usuarioActual(req).id, motivo));
  }),
);

// ── Excel para la administradora ──
cajaDuenoRouter.get(
  '/exportar/cierres',
  ah(async (req, res) => {
    const q = parse(z.object({ desde: fecha, hasta: fecha, cajeroId: z.string().uuid().optional(), estado: z.enum(['abierto', 'cerrado', 'revisado']).optional() }), req.query);
    await excelCierres(res, q, usuarioActual(req).nombre);
  }),
);

cajaDuenoRouter.get(
  '/exportar/turno/:id',
  ah(async (req, res) => {
    const [t] = await resumenTurnos({ ids: [req.params.id!] });
    if (!t) throw notFound('Turno no encontrado');
    await excelCierres(res, { ids: [t.id] }, usuarioActual(req).nombre);
  }),
);

cajaDuenoRouter.get(
  '/exportar/movimientos',
  ah(async (req, res) => {
    const q = parse(z.object({ desde: fecha, hasta: fecha, tipo: z.enum(['ingreso', 'egreso']).optional() }), req.query);
    await excelMovimientos(res, q, usuarioActual(req).nombre);
  }),
);

/** Cuentas por cobrar. */
cajaDuenoRouter.get(
  '/deudas',
  ah(async (req, res) => {
    const estado = z.enum(['pendiente', 'pagada', 'anulada']).catch('pendiente').parse(req.query.estado);
    res.json(
      await db
        .selectFrom('deudas as d')
        .innerJoin('socios as s', 's.id', 'd.socioId')
        .select(['d.id', 'd.concepto', 'd.moneda', 'd.montoTotal', 'd.saldo', 'd.estado', 'd.creadoEn', 's.id as socioId', sql<string>`s.nombre || ' ' || s.apellido`.as('socio'), 's.telefono'])
        .where('d.estado', '=', estado)
        .orderBy('d.creadoEn', 'desc')
        .limit(300)
        .execute(),
    );
  }),
);
