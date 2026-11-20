/**
 * DEVOLUCIONES CON AUTORIZACIÓN DE SUPERVISOR
 *
 *  Cajera: busca el ticket → marca qué productos y cuántos devuelve → escribe el
 *  motivo → el supervisor (dueño o administrador de caja) escribe SU código.
 *  Sin código válido no sale ni mercancía ni dinero.
 *
 *  • El dinero sale de la caja abierta de la cajera como egreso "Devolución",
 *    así su cierre ciego lo descuenta de lo esperado.
 *  • La mercancía vuelve al inventario solo si está en buen estado.
 *  • Nunca se devuelve más de lo vendido en ese ticket (suma de devoluciones previas).
 *  • Quedan en auditoría la devolución y cada código equivocado.
 */
import bcrypt from 'bcryptjs';
import { sql } from 'kysely';
import { db } from '../../db/index.js';
import type { Moneda } from '../../db/types.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/http.js';
import { convertir, fmt, INFO, MONEDA_REF, redondear } from '../../lib/monedas.js';
import { moverStock } from '../inventario/kardex.js';
import { getTasas } from '../tasas/tasas.service.js';
import { turnoAbierto } from './caja.service.js';

export const METODOS_DEVOLUCION = ['efectivo', 'pago_movil', 'nequi', 'bancolombia'];
export const PIN_REGEX = /^\d{4,8}$/;

// Freno a adivinar códigos: 5 fallos por cajera cada 10 minutos
const fallos = new Map<string, { n: number; t: number }>();
const VENTANA = 10 * 60_000;

/** Devuelve el supervisor dueño de ese código, o lanza error. */
export async function validarSupervisor(pin: string, solicitante: { id: string; rol: string }) {
  const f = fallos.get(solicitante.id);
  if (f && f.n >= 5 && Date.now() - f.t < VENTANA) throw forbidden('Demasiados códigos equivocados. Espera unos minutos y llama al supervisor.');
  const supervisores = await db
    .selectFrom('usuarios')
    .select(['id', 'nombre', 'rol', 'pinHash'])
    .where('rol', 'in', ['dueno', 'admin_caja'])
    .where('activo', '=', true)
    .where('pinHash', 'is not', null)
    .execute();
  if (!supervisores.length) throw conflict('Ningún supervisor tiene código de autorización. El dueño lo configura en Equipo.');
  for (const s of supervisores) {
    if (PIN_REGEX.test(pin) && (await bcrypt.compare(pin, s.pinHash!))) {
      // Quien pide no se autoriza a sí mismo (salvo el dueño)
      if (s.id === solicitante.id && s.rol !== 'dueno') throw forbidden('No puedes autorizar tu propia devolución: pide el código a otro supervisor');
      fallos.delete(solicitante.id);
      return { id: s.id, nombre: s.nombre };
    }
  }
  fallos.set(solicitante.id, { n: (f && Date.now() - f.t < VENTANA ? f.n : 0) + 1, t: Date.now() });
  await db.insertInto('auditoria').values({ usuarioId: solicitante.id, accion: 'devolucion.codigo_incorrecto', detalle: JSON.stringify({}) }).execute();
  throw forbidden('Código de autorización incorrecto');
}

/** ¿Ese PIN ya lo usa otro supervisor? (el código identifica a quien autoriza) */
export async function pinEnUso(pin: string, exceptoId: string) {
  const otros = await db.selectFrom('usuarios').select(['id', 'pinHash']).where('pinHash', 'is not', null).where('id', '!=', exceptoId).execute();
  for (const o of otros) if (await bcrypt.compare(pin, o.pinHash!)) return true;
  return false;
}

// Caja ciega: buscar tickets no puede servir para revisar lo vendido.
// Una cajera puede consultar pocos tickets seguidos y cada consulta queda registrada.
const consultas = new Map<string, number[]>();
const MAX_CONSULTAS = 8;

/** Ticket con lo que todavía se puede devolver de cada producto. */
export async function ticketParaDevolucion(numero: number, solicitante: { id: string; rol: string }) {
  if (solicitante.rol === 'cajero') {
    const recientes = (consultas.get(solicitante.id) ?? []).filter((t) => Date.now() - t < VENTANA);
    if (recientes.length >= MAX_CONSULTAS) throw forbidden('Consultaste muchos tickets seguidos. Espera unos minutos o pide ayuda al supervisor.');
    consultas.set(solicitante.id, [...recientes, Date.now()]);
    await db.insertInto('auditoria').values({ usuarioId: solicitante.id, accion: 'devolucion.consulta_ticket', detalle: JSON.stringify({ numero }) }).execute();
  }
  const v = await db
    .selectFrom('ventas as v')
    .innerJoin('usuarios as u', 'u.id', 'v.cajeroId')
    .leftJoin('socios as s', 's.id', 'v.socioId')
    .select(['v.id', 'v.numero', 'v.creadoEn', 'v.estado', 'u.nombre as cajero', sql<string | null>`nullif(trim(s.nombre || ' ' || s.apellido), '')`.as('socio')])
    .where('v.numero', '=', numero)
    .executeTakeFirst();
  if (!v) throw notFound(`No existe el ticket #${numero}`);
  if (v.estado !== 'pagada') throw conflict(`El ticket #${numero} está anulado`);
  const items = await db
    .selectFrom('ventaItems as i')
    .select([
      'i.id',
      'i.referenciaId as productoId',
      'i.descripcion',
      'i.cantidad',
      'i.moneda',
      'i.precioUnitario',
      sql<number>`coalesce((select sum(d.cantidad) from devolucion_items d where d.venta_item_id = i.id), 0)::int`.as('devuelto'),
    ])
    .where('i.ventaId', '=', v.id)
    .where('i.tipo', '=', 'producto')
    .orderBy('i.id')
    .execute();
  const debe = await db.selectFrom('deudas').select('id').where('ventaId', '=', v.id).where('estado', '=', 'pendiente').executeTakeFirst();
  return {
    ...v,
    conDeuda: !!debe,
    items: items.map((i) => ({
      ventaItemId: Number(i.id),
      productoId: i.productoId,
      descripcion: i.descripcion,
      cantidad: i.cantidad,
      devuelto: Number(i.devuelto),
      disponible: i.cantidad - Number(i.devuelto),
      moneda: i.moneda,
      precioUnitario: Number(i.precioUnitario),
      precioTexto: fmt(Number(i.precioUnitario), i.moneda),
    })),
  };
}

export async function registrarDevolucion(
  usuario: { id: string; rol: string },
  input: { ventaId: string; items: Array<{ ventaItemId: number; cantidad: number }>; metodo: string; moneda: Moneda; motivo: string; reingresaStock: boolean; pin: string },
) {
  const items = input.items.filter((i) => i.cantidad > 0);
  if (!items.length) throw badRequest('Marca al menos un producto para devolver');
  if (new Set(items.map((i) => i.ventaItemId)).size !== items.length) throw badRequest('Producto repetido en la devolución');
  if (!METODOS_DEVOLUCION.includes(input.metodo)) throw badRequest('La devolución se entrega en efectivo o por transferencia');
  const turno = await turnoAbierto(usuario.id);
  if (!turno) throw conflict('Abre tu turno para hacer devoluciones: el dinero sale de tu caja');
  const met = await db.selectFrom('metodosPago').select(['nombre', 'monedas']).where('codigo', '=', input.metodo).where('activo', '=', true).executeTakeFirst();
  if (!met || !met.monedas.includes(input.moneda)) throw badRequest(`Ese método no entrega ${INFO[input.moneda].nombre.toLowerCase()}`);

  const supervisor = await validarSupervisor(input.pin, usuario);
  const t = await getTasas();

  const r = await db.transaction().execute(async (trx) => {
    const v = await trx.selectFrom('ventas').select(['id', 'numero', 'estado']).where('id', '=', input.ventaId).forUpdate().executeTakeFirst();
    if (!v) throw notFound('Ticket no encontrado');
    if (v.estado !== 'pagada') throw conflict('Ese ticket está anulado');
    const deuda = await trx.selectFrom('deudas').select('id').where('ventaId', '=', v.id).where('estado', '=', 'pendiente').executeTakeFirst();
    if (deuda) throw conflict('Ese ticket tiene saldo pendiente del cliente: la administración debe anularlo o cobrarlo primero');

    const lineas: Array<{ ventaItemId: number; productoId: number; descripcion: string; cantidad: number; moneda: Moneda; subtotal: number }> = [];
    for (const it of items) {
      const vi = await trx.selectFrom('ventaItems').selectAll().where('id', '=', it.ventaItemId).where('ventaId', '=', v.id).forUpdate().executeTakeFirst();
      if (!vi || vi.tipo !== 'producto') throw badRequest('Solo se devuelven productos de la tienda (los planes los anula la administración)');
      const { n } = await trx
        .selectFrom('devolucionItems')
        .select(sql<number>`coalesce(sum(cantidad), 0)::int`.as('n'))
        .where('ventaItemId', '=', vi.id)
        .executeTakeFirstOrThrow();
      const disponible = vi.cantidad - Number(n);
      if (it.cantidad > disponible) throw badRequest(`De "${vi.descripcion}" solo se pueden devolver ${disponible}`);
      lineas.push({
        ventaItemId: Number(vi.id),
        productoId: vi.referenciaId,
        descripcion: vi.descripcion,
        cantidad: it.cantidad,
        moneda: vi.moneda,
        subtotal: redondear(Number(vi.precioUnitario) * it.cantidad, vi.moneda),
      });
    }

    // Se devuelve el precio de cada producto en su moneda, llevado a la moneda en que se entrega
    const monto = redondear(lineas.reduce((s, l) => s + convertir(l.subtotal, l.moneda, input.moneda, t), 0), input.moneda);
    const montoRef = redondear(convertir(monto, input.moneda, MONEDA_REF, t), MONEDA_REF);
    const detalle = lineas.map((l) => `${l.descripcion}${l.cantidad > 1 ? ` ×${l.cantidad}` : ''}`).join(', ');

    const mov = await trx
      .insertInto('cajaMovimientos')
      .values({
        turnoId: turno.id,
        usuarioId: usuario.id,
        tipo: 'egreso',
        categoria: 'Devolución',
        concepto: `Devolución ticket #${v.numero}: ${detalle} · autorizó ${supervisor.nombre}`.slice(0, 200),
        metodo: input.metodo,
        moneda: input.moneda,
        monto,
        montoRef,
        tasas: JSON.stringify(t),
        referencia: `ticket ${v.numero}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const dev = await trx
      .insertInto('devoluciones')
      .values({
        ventaId: v.id,
        turnoId: turno.id,
        cajeroId: usuario.id,
        autorizadoPor: supervisor.id,
        motivo: input.motivo.trim(),
        reingresaStock: input.reingresaStock,
        metodo: input.metodo,
        moneda: input.moneda,
        monto,
        montoRef,
        movimientoId: Number(mov.id),
      })
      .returning(['id', 'creadoEn'])
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('devolucionItems')
      .values(lineas.map((l) => ({ devolucionId: dev.id, ventaItemId: l.ventaItemId, productoId: l.productoId, descripcion: l.descripcion.slice(0, 150), cantidad: l.cantidad, moneda: l.moneda, subtotal: l.subtotal })))
      .execute();

    if (input.reingresaStock) {
      for (const l of lineas) {
        await moverStock(trx, { productoId: l.productoId, cantidad: l.cantidad, tipo: 'devolucion', referencia: `Devolución ticket #${v.numero}: ${input.motivo}`, usuarioId: usuario.id });
      }
    }
    await trx
      .insertInto('auditoria')
      .values({
        usuarioId: usuario.id,
        accion: 'devolucion.registrada',
        detalle: JSON.stringify({ devolucionId: dev.id, ticket: v.numero, autorizadoPor: supervisor.id, monto, moneda: input.moneda, motivo: input.motivo, reingresaStock: input.reingresaStock }),
      })
      .execute();
    return { id: dev.id, creadoEn: dev.creadoEn, ticket: v.numero, monto, lineas };
  });

  return {
    id: r.id,
    ticket: r.ticket,
    fecha: r.creadoEn,
    autorizadoPor: supervisor.nombre,
    metodo: met.nombre,
    montoTexto: fmt(r.monto, input.moneda),
    items: r.lineas.map((l) => ({ descripcion: l.descripcion, cantidad: l.cantidad, subtotal: fmt(l.subtotal, l.moneda) })),
    reingresaStock: input.reingresaStock,
  };
}

/** Historial para la administración: quién devolvió, quién autorizó, cuánto y por qué. */
export async function listarDevoluciones(f: { desde?: string; hasta?: string }) {
  let q = db
    .selectFrom('devoluciones as d')
    .innerJoin('ventas as v', 'v.id', 'd.ventaId')
    .innerJoin('usuarios as c', 'c.id', 'd.cajeroId')
    .innerJoin('usuarios as a', 'a.id', 'd.autorizadoPor')
    .innerJoin('metodosPago as m', 'm.codigo', 'd.metodo')
    .select([
      'd.id',
      'd.creadoEn',
      'd.motivo',
      'd.reingresaStock',
      'd.moneda',
      'd.monto',
      'd.montoRef',
      'v.numero as ticket',
      'c.nombre as cajero',
      'a.nombre as autorizo',
      'm.nombre as metodo',
      sql<string>`(select string_agg(i.descripcion || case when i.cantidad > 1 then ' ×' || i.cantidad else '' end, ', ' order by i.id) from devolucion_items i where i.devolucion_id = d.id)`.as('items'),
    ])
    .orderBy('d.creadoEn', 'desc');
  if (f.desde) q = q.where(sql`d.creado_en::date`, '>=', f.desde);
  if (f.hasta) q = q.where(sql`d.creado_en::date`, '<=', f.hasta);
  const rows = await q.limit(500).execute();
  return rows.map((d) => ({ ...d, monto: Number(d.monto), montoRef: Number(d.montoRef), montoTexto: fmt(Number(d.monto), d.moneda) }));
}
