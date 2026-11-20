/**
 * Inventario: compras a proveedores (con costo promedio), pagos a proveedores,
 * conteo físico ciego y kardex.
 */
import { sql } from 'kysely';
import { db, type Db } from '../../db/index.js';
import type { Moneda } from '../../db/types.js';
import { badRequest, conflict, notFound } from '../../lib/http.js';
import { convertir, fmt, MONEDA_REF, redondear, type Tasas } from '../../lib/monedas.js';
import { egresoAdministracion } from '../caja/caja.service.js';
import { getTasas } from '../tasas/tasas.service.js';
import { moverStock } from './kardex.js';

export const CATEGORIA_COMPRAS = 'Compra de mercancía';
const r2 = (n: number) => Math.round(n * 100) / 100;

// ═════════════════ Compras ═════════════════

export async function registrarCompra(
  usuarioId: string,
  input: {
    proveedorId: number | null;
    factura?: string | null;
    fecha?: string;
    moneda: Moneda;
    items: Array<{ productoId: number; cantidad: number; costoUnitario: number }>;
    pago: { metodo: string; monto?: number | null } | null;
    nota?: string | null;
    soporteId?: number | null;
  },
) {
  if (!input.items.length) throw badRequest('Agrega al menos un producto');
  const ids = input.items.map((i) => i.productoId);
  if (new Set(ids).size !== ids.length) throw badRequest('Hay un producto repetido en la compra: súmalo en una sola línea');
  const t = await getTasas();
  const total = redondear(input.items.reduce((s, i) => s + i.cantidad * i.costoUnitario, 0), input.moneda);
  const pagado = input.pago ? redondear(Math.min(input.pago.monto ?? total, total), input.moneda) : 0;
  if (input.pago && pagado <= 0 && total > 0) throw badRequest('El monto pagado debe ser mayor a cero');
  const saldo = redondear(total - pagado, input.moneda);

  return db.transaction().execute(async (trx) => {
    const proveedor = input.proveedorId ? await trx.selectFrom('proveedores').select(['id', 'nombre']).where('id', '=', input.proveedorId).executeTakeFirst() : null;
    if (input.proveedorId && !proveedor) throw badRequest('Proveedor no encontrado');
    const compra = await trx
      .insertInto('compras')
      .values({
        proveedorId: proveedor?.id ?? null,
        factura: input.factura?.trim() || null,
        fecha: input.fecha ?? sql<string>`current_date` as never,
        moneda: input.moneda,
        total,
        totalRef: redondear(convertir(total, input.moneda, MONEDA_REF, t), MONEDA_REF),
        saldo,
        tasas: JSON.stringify(t),
        estado: saldo > 0 ? 'pendiente' : 'pagada',
        nota: input.nota?.trim() || null,
        soporteId: input.soporteId ?? null,
        registradoPor: usuarioId,
      })
      .returning(['id', 'creadoEn'])
      .executeTakeFirstOrThrow();
    const ref = `Compra #${compra.id}${proveedor ? ` · ${proveedor.nombre}` : ''}`;

    for (const it of input.items) {
      const p = await trx.selectFrom('productos').select(['id', 'nombre', 'stock', 'costo', 'moneda', 'controlaStock']).where('id', '=', it.productoId).forUpdate().executeTakeFirst();
      if (!p) throw badRequest(`Producto ${it.productoId} no encontrado`);
      // Costo promedio ponderado en la moneda del producto
      const costoNuevo = convertir(it.costoUnitario, input.moneda, p.moneda, t);
      const previo = Math.max(p.stock, 0);
      const promedio = p.controlaStock && previo > 0 && Number(p.costo) > 0 ? (previo * Number(p.costo) + it.cantidad * costoNuevo) / (previo + it.cantidad) : costoNuevo;
      await trx.updateTable('productos').set({ costo: r2(promedio) }).where('id', '=', p.id).execute();
      await trx.insertInto('compraItems').values({ compraId: compra.id, productoId: p.id, cantidad: it.cantidad, costoUnitario: it.costoUnitario, subtotal: redondear(it.cantidad * it.costoUnitario, input.moneda) }).execute();
      await moverStock(trx, { productoId: p.id, cantidad: it.cantidad, tipo: 'compra', referencia: ref, usuarioId });
    }

    if (input.pago && pagado > 0) await pagarCompraTrx(trx, { compraId: compra.id, usuarioId, metodo: input.pago.metodo, moneda: input.moneda, monto: pagado, concepto: ref, tasas: t, ajustarSaldo: false });
    await trx.insertInto('auditoria').values({ usuarioId, accion: 'compra.registrada', detalle: JSON.stringify({ compraId: compra.id, total, moneda: input.moneda, pagado, items: input.items.length }) }).execute();
    return { id: compra.id, total, totalTexto: fmt(total, input.moneda), saldo, saldoTexto: fmt(saldo, input.moneda) };
  });
}

async function pagarCompraTrx(trx: Db, a: { compraId: number; usuarioId: string; metodo: string; moneda: Moneda; monto: number; concepto: string; tasas?: Tasas; ajustarSaldo: boolean }) {
  const mov = await egresoAdministracion(trx, { usuarioId: a.usuarioId, categoria: CATEGORIA_COMPRAS, concepto: a.concepto, metodo: a.metodo, moneda: a.moneda, monto: a.monto, tasas: a.tasas });
  await trx.insertInto('compraPagos').values({ compraId: a.compraId, movimientoId: mov.id, metodo: a.metodo, moneda: a.moneda, monto: a.monto, registradoPor: a.usuarioId }).execute();
  if (a.ajustarSaldo) {
    await trx
      .updateTable('compras')
      .set({ saldo: sql`greatest(saldo - ${a.monto}, 0)` as never, estado: sql`case when saldo - ${a.monto} <= 0 then 'pagada' else 'pendiente' end` as never })
      .where('id', '=', a.compraId)
      .execute();
  }
}

/** Abono / pago del saldo pendiente con el proveedor. */
export async function pagarCompra(usuarioId: string, compraId: number, p: { metodo: string; monto: number }) {
  return db.transaction().execute(async (trx) => {
    const c = await trx.selectFrom('compras').select(['id', 'estado', 'saldo', 'moneda', 'proveedorId']).where('id', '=', compraId).forUpdate().executeTakeFirst();
    if (!c) throw notFound('Compra no encontrada');
    const prov = c.proveedorId ? await trx.selectFrom('proveedores').select('nombre').where('id', '=', c.proveedorId).executeTakeFirst() : null;
    if (c.estado !== 'pendiente') throw conflict(c.estado === 'anulada' ? 'La compra está anulada' : 'La compra ya está pagada');
    const monto = redondear(Math.min(p.monto, Number(c.saldo)), c.moneda);
    if (monto <= 0) throw badRequest('Monto inválido');
    await pagarCompraTrx(trx, { compraId, usuarioId, metodo: p.metodo, moneda: c.moneda, monto, concepto: `Pago compra #${c.id}${prov ? ` · ${prov.nombre}` : ''}`, ajustarSaldo: true });
    await trx.insertInto('auditoria').values({ usuarioId, accion: 'compra.pago', detalle: JSON.stringify({ compraId, monto }) }).execute();
    return { ok: true, pagado: fmt(monto, c.moneda) };
  });
}

/** Anula la compra: saca la mercancía del inventario y anula sus pagos. */
export async function anularCompra(usuarioId: string, compraId: number, motivo: string) {
  return db.transaction().execute(async (trx) => {
    const c = await trx.selectFrom('compras').select(['id', 'estado']).where('id', '=', compraId).forUpdate().executeTakeFirst();
    if (!c) throw notFound('Compra no encontrada');
    if (c.estado === 'anulada') throw conflict('La compra ya estaba anulada');
    const items = await trx
      .selectFrom('compraItems as i')
      .innerJoin('productos as p', 'p.id', 'i.productoId')
      .select(['i.productoId', 'i.cantidad', 'p.nombre', 'p.stock', 'p.controlaStock'])
      .where('i.compraId', '=', compraId)
      .execute();
    const faltan = items.filter((i) => i.controlaStock && i.stock < i.cantidad);
    if (faltan.length) throw conflict(`Ya se vendieron unidades de: ${faltan.map((f) => f.nombre).join(', ')}. Corrige con un ajuste o un conteo en lugar de anular.`);
    for (const i of items) await moverStock(trx, { productoId: i.productoId, cantidad: -i.cantidad, tipo: 'compra_anulada', referencia: `Compra #${compraId} anulada: ${motivo}`, usuarioId });
    const pagos = await trx.selectFrom('compraPagos').select('movimientoId').where('compraId', '=', compraId).execute();
    const movs = pagos.map((p) => p.movimientoId).filter((x): x is number => x != null);
    if (movs.length) await trx.updateTable('cajaMovimientos').set({ anulado: true, anuladoPor: usuarioId, motivoAnulacion: `Compra #${compraId} anulada` }).where('id', 'in', movs).execute();
    await trx.updateTable('compras').set({ estado: 'anulada', anuladaPor: usuarioId, anuladaEn: new Date(), motivoAnulacion: motivo }).where('id', '=', compraId).execute();
    await trx.insertInto('auditoria').values({ usuarioId, accion: 'compra.anulada', detalle: JSON.stringify({ compraId, motivo }) }).execute();
    return { ok: true };
  });
}

export async function listarCompras(f: { desde?: string; hasta?: string; proveedorId?: number; pendientes?: boolean }) {
  let q = db
    .selectFrom('compras as c')
    .leftJoin('proveedores as pr', 'pr.id', 'c.proveedorId')
    .innerJoin('usuarios as u', 'u.id', 'c.registradoPor')
    .select([
      'c.id',
      'c.fecha',
      'c.factura',
      'c.moneda',
      'c.total',
      'c.totalRef',
      'c.saldo',
      'c.estado',
      'c.nota',
      'c.soporteId',
      'c.creadoEn',
      'c.motivoAnulacion',
      'pr.id as proveedorId',
      'pr.nombre as proveedor',
      'u.nombre as registro',
      sql<string[]>`(select array_agg(p.nombre || ' ×' || i.cantidad order by i.id) from compra_items i join productos p on p.id = i.producto_id where i.compra_id = c.id)`.as('items'),
    ])
    .orderBy('c.fecha', 'desc')
    .orderBy('c.id', 'desc')
    .limit(500);
  if (f.desde) q = q.where('c.fecha', '>=', f.desde);
  if (f.hasta) q = q.where('c.fecha', '<=', f.hasta);
  if (f.proveedorId) q = q.where('c.proveedorId', '=', f.proveedorId);
  if (f.pendientes) q = q.where('c.estado', '=', 'pendiente');
  const rows = await q.execute();
  return rows.map((c) => ({ ...c, total: Number(c.total), totalRef: Number(c.totalRef), saldo: Number(c.saldo), totalTexto: fmt(Number(c.total), c.moneda), saldoTexto: fmt(Number(c.saldo), c.moneda), items: c.items ?? [] }));
}

export async function detalleCompra(id: number) {
  const [c] = await db.selectFrom('compras').select('id').where('id', '=', id).execute();
  if (!c) throw notFound('Compra no encontrada');
  const [items, pagos] = await Promise.all([
    db
      .selectFrom('compraItems as i')
      .innerJoin('productos as p', 'p.id', 'i.productoId')
      .select(['i.id', 'i.productoId', 'p.nombre', 'i.cantidad', 'i.costoUnitario', 'i.subtotal'])
      .where('i.compraId', '=', id)
      .orderBy('i.id')
      .execute(),
    db
      .selectFrom('compraPagos as p')
      .innerJoin('metodosPago as m', 'm.codigo', 'p.metodo')
      .innerJoin('usuarios as u', 'u.id', 'p.registradoPor')
      .select(['p.id', 'm.nombre as metodo', 'p.moneda', 'p.monto', 'p.creadoEn', 'u.nombre as registro'])
      .where('p.compraId', '=', id)
      .orderBy('p.creadoEn')
      .execute(),
  ]);
  return {
    items: items.map((i) => ({ ...i, costoUnitario: Number(i.costoUnitario), subtotal: Number(i.subtotal) })),
    pagos: pagos.map((p) => ({ ...p, montoTexto: fmt(Number(p.monto), p.moneda) })),
  };
}

// ═════════════════ Conteo físico (ciego) ═════════════════

export async function abrirConteo(usuarioId: string, nota: string | null) {
  const abierto = await db.selectFrom('conteos').select('id').where('estado', '=', 'abierto').executeTakeFirst();
  if (abierto) throw conflict(`Ya hay un conteo abierto (#${abierto.id}): termínalo o cancélalo primero`);
  return db.insertInto('conteos').values({ creadoPor: usuarioId, nota }).returning(['id', 'creadoEn']).executeTakeFirstOrThrow();
}

/** Lo que ve quien cuenta: los productos y lo que lleva contado. NUNCA lo que dice el sistema. */
export async function conteoActual() {
  const c = await db
    .selectFrom('conteos as c')
    .innerJoin('usuarios as u', 'u.id', 'c.creadoPor')
    .select(['c.id', 'c.creadoEn', 'c.nota', 'u.nombre as abrio'])
    .where('c.estado', '=', 'abierto')
    .executeTakeFirst();
  if (!c) return null;
  const productos = await db
    .selectFrom('productos as p')
    .leftJoin('conteoItems as i', (j) => j.onRef('i.productoId', '=', 'p.id').on('i.conteoId', '=', c.id))
    .select(['p.id', 'p.nombre', 'p.categoria', 'p.codigoBarras', 'i.contado', 'i.actualizadoEn'])
    .where('p.controlaStock', '=', true)
    .where('p.activo', '=', true)
    .orderBy('p.categoria')
    .orderBy('p.nombre')
    .execute();
  return { ...c, productos, contados: productos.filter((p) => p.contado != null).length };
}

export async function anotarConteo(conteoId: number, usuarioId: string, a: { productoId: number; contado?: number; sumar?: number }) {
  const c = await db.selectFrom('conteos').select(['id', 'estado']).where('id', '=', conteoId).executeTakeFirst();
  if (!c || c.estado !== 'abierto') throw conflict('Ese conteo ya no está abierto');
  const p = await db.selectFrom('productos').select(['id', 'controlaStock']).where('id', '=', a.productoId).executeTakeFirst();
  if (!p?.controlaStock) throw badRequest('Ese producto no lleva control de inventario');
  if (a.contado == null && a.sumar == null) throw badRequest('Indica la cantidad contada');
  const fila = await db
    .insertInto('conteoItems')
    .values({ conteoId, productoId: a.productoId, contado: Math.max(0, a.contado ?? a.sumar ?? 0), contadoPor: usuarioId, actualizadoEn: new Date() })
    .onConflict((oc) =>
      oc.columns(['conteoId', 'productoId']).doUpdateSet({
        contado: a.contado != null ? a.contado : sql<number>`greatest(conteo_items.contado + ${a.sumar ?? 0}, 0)`,
        contadoPor: usuarioId,
        actualizadoEn: new Date(),
      }),
    )
    .returning(['productoId', 'contado'])
    .executeTakeFirstOrThrow();
  return fila;
}

export async function cerrarConteo(conteoId: number, usuarioId: string, nota: string | null) {
  const t = await getTasas();
  return db.transaction().execute(async (trx) => {
    const c = await trx.selectFrom('conteos').select(['id', 'estado', 'nota']).where('id', '=', conteoId).forUpdate().executeTakeFirst();
    if (!c || c.estado !== 'abierto') throw conflict('Ese conteo ya no está abierto');
    const items = await trx.selectFrom('conteoItems').select(['id', 'productoId', 'contado']).where('conteoId', '=', conteoId).execute();
    if (!items.length) throw badRequest('No has contado ningún producto');
    let faltante = 0;
    let sobrante = 0;
    for (const it of items) {
      const p = await trx.selectFrom('productos').select(['stock', 'costo', 'moneda']).where('id', '=', it.productoId).forUpdate().executeTakeFirstOrThrow();
      const diferencia = it.contado - p.stock;
      const valor = convertir(Math.abs(diferencia) * Number(p.costo), p.moneda, MONEDA_REF, t);
      if (diferencia < 0) faltante += valor;
      if (diferencia > 0) sobrante += valor;
      await trx.updateTable('conteoItems').set({ esperado: p.stock, diferencia, costo: Number(p.costo), moneda: p.moneda }).where('id', '=', it.id).execute();
      await moverStock(trx, { productoId: it.productoId, cantidad: diferencia, tipo: 'conteo', referencia: `Conteo físico #${conteoId}`, usuarioId });
    }
    await trx
      .updateTable('conteos')
      .set({ estado: 'cerrado', cerradoPor: usuarioId, cerradoEn: new Date(), nota: [c.nota, nota].filter(Boolean).join(' · ') || null, faltanteRef: redondear(faltante, MONEDA_REF), sobranteRef: redondear(sobrante, MONEDA_REF) })
      .where('id', '=', conteoId)
      .execute();
    await trx.insertInto('auditoria').values({ usuarioId, accion: 'conteo.cerrado', detalle: JSON.stringify({ conteoId, productos: items.length, faltanteRef: faltante, sobranteRef: sobrante }) }).execute();
    return { ok: true, id: conteoId };
  });
}

export async function cancelarConteo(conteoId: number, usuarioId: string) {
  const r = await db.updateTable('conteos').set({ estado: 'cancelado', cerradoPor: usuarioId, cerradoEn: new Date() }).where('id', '=', conteoId).where('estado', '=', 'abierto').returning('id').executeTakeFirst();
  if (!r) throw conflict('Ese conteo ya no está abierto');
  return { ok: true };
}

export async function listarConteos() {
  const rows = await db
    .selectFrom('conteos as c')
    .innerJoin('usuarios as u', 'u.id', 'c.creadoPor')
    .leftJoin('usuarios as v', 'v.id', 'c.cerradoPor')
    .select([
      'c.id',
      'c.estado',
      'c.nota',
      'c.creadoEn',
      'c.cerradoEn',
      'c.faltanteRef',
      'c.sobranteRef',
      'u.nombre as abrio',
      'v.nombre as cerro',
      sql<number>`(select count(*)::int from conteo_items i where i.conteo_id = c.id)`.as('productos'),
      sql<number>`(select count(*)::int from conteo_items i where i.conteo_id = c.id and i.diferencia <> 0)`.as('conDiferencia'),
    ])
    .orderBy('c.id', 'desc')
    .limit(100)
    .execute();
  return rows.map((r) => ({ ...r, faltanteRef: Number(r.faltanteRef), sobranteRef: Number(r.sobranteRef) }));
}

export async function detalleConteo(id: number) {
  const c = await db.selectFrom('conteos').select(['id', 'estado']).where('id', '=', id).executeTakeFirst();
  if (!c) throw notFound('Conteo no encontrado');
  if (c.estado === 'abierto') throw conflict('El conteo sigue abierto: las diferencias se ven al cerrarlo');
  const items = await db
    .selectFrom('conteoItems as i')
    .innerJoin('productos as p', 'p.id', 'i.productoId')
    .leftJoin('usuarios as u', 'u.id', 'i.contadoPor')
    .select(['i.productoId', 'p.nombre', 'p.categoria', 'i.esperado', 'i.contado', 'i.diferencia', 'i.costo', 'i.moneda', 'u.nombre as conto'])
    .where('i.conteoId', '=', id)
    .orderBy(sql`abs(coalesce(i.diferencia, 0))`, 'desc')
    .orderBy('p.nombre')
    .execute();
  return items.map((i) => ({ ...i, valorTexto: i.diferencia && i.costo != null && i.moneda ? fmt(Math.abs(i.diferencia) * Number(i.costo), i.moneda) : null }));
}

// ═════════════════ Kardex y resumen ═════════════════

export async function kardex(f: { productoId?: number; tipo?: string; desde?: string; hasta?: string }) {
  let q = db
    .selectFrom('inventarioMovimientos as k')
    .innerJoin('productos as p', 'p.id', 'k.productoId')
    .leftJoin('usuarios as u', 'u.id', 'k.usuarioId')
    .select(['k.id', 'k.creadoEn', 'k.tipo', 'k.cantidad', 'k.stockResultante', 'k.referencia', 'p.id as productoId', 'p.nombre as producto', 'u.nombre as usuario'])
    .orderBy('k.id', 'desc')
    .limit(500);
  if (f.productoId) q = q.where('k.productoId', '=', f.productoId);
  if (f.tipo) q = q.where('k.tipo', '=', f.tipo as never);
  if (f.desde) q = q.where(sql`k.creado_en::date`, '>=', f.desde);
  if (f.hasta) q = q.where(sql`k.creado_en::date`, '<=', f.hasta);
  return q.execute();
}

export async function resumenInventario() {
  const t = await getTasas();
  const [productos, porPagar] = await Promise.all([
    db.selectFrom('productos').select(['id', 'nombre', 'stock', 'stockMinimo', 'costo', 'precio', 'moneda']).where('controlaStock', '=', true).where('activo', '=', true).execute(),
    db.selectFrom('compras').select(['moneda', sql<number>`sum(saldo)`.as('saldo'), sql<number>`count(*)::int`.as('n')]).where('estado', '=', 'pendiente').groupBy('moneda').execute(),
  ]);
  const ref = (n: number, m: Moneda) => convertir(n, m, MONEDA_REF, t);
  return {
    monedaRef: MONEDA_REF,
    productos: productos.length,
    unidades: productos.reduce((s, p) => s + Math.max(p.stock, 0), 0),
    valorCosto: redondear(productos.reduce((s, p) => s + ref(Math.max(p.stock, 0) * Number(p.costo), p.moneda), 0), MONEDA_REF),
    valorVenta: redondear(productos.reduce((s, p) => s + ref(Math.max(p.stock, 0) * Number(p.precio), p.moneda), 0), MONEDA_REF),
    sinCosto: productos.filter((p) => Number(p.costo) <= 0).length,
    bajoMinimo: productos.filter((p) => p.stock <= p.stockMinimo).map((p) => ({ id: p.id, nombre: p.nombre, stock: p.stock, minimo: p.stockMinimo })),
    porPagar: {
      compras: porPagar.reduce((s, x) => s + Number(x.n), 0),
      ref: redondear(porPagar.reduce((s, x) => s + ref(Number(x.saldo), x.moneda), 0), MONEDA_REF),
      texto: porPagar.map((x) => fmt(Number(x.saldo), x.moneda)).join(' · '),
    },
  };
}
