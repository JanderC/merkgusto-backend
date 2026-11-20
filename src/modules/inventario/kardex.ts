/**
 * Kardex: TODA entrada o salida de mercancía pasa por aquí y queda registrada
 * (qué producto, cuántas unidades, por qué, quién y con cuánto quedó el stock).
 */
import type { Db } from '../../db/index.js';
import type { TipoMovInventario } from '../../db/types.js';

export async function moverStock(
  dbx: Db,
  m: { productoId: number; cantidad: number; tipo: TipoMovInventario; referencia?: string | null; usuarioId?: string | null },
) {
  if (!m.cantidad) return null;
  const p = await dbx
    .updateTable('productos')
    .set((eb) => ({ stock: eb('stock', '+', m.cantidad) }))
    .where('id', '=', m.productoId)
    .where('controlaStock', '=', true)
    .returning('stock')
    .executeTakeFirst();
  if (!p) return null; // producto sin control de inventario
  await dbx
    .insertInto('inventarioMovimientos')
    .values({ productoId: m.productoId, tipo: m.tipo, cantidad: m.cantidad, stockResultante: p.stock, referencia: m.referencia?.slice(0, 150) ?? null, usuarioId: m.usuarioId ?? null })
    .execute();
  return p.stock;
}
