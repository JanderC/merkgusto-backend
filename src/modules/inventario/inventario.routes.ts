/** Inventario (dueño y administrador de caja): compras, proveedores, conteos y kardex.   /api/inventario */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { ah, notFound, parse } from '../../lib/http.js';
import { usuarioActual } from '../../middleware/auth.js';
import { guardarArchivo } from '../archivos/archivos.service.js';
import {
  abrirConteo,
  anotarConteo,
  anularCompra,
  cancelarConteo,
  cerrarConteo,
  conteoActual,
  detalleCompra,
  detalleConteo,
  kardex,
  listarCompras,
  listarConteos,
  pagarCompra,
  registrarCompra,
  resumenInventario,
} from './inventario.service.js';

export const inventarioRouter = Router();
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const moneda = z.enum(['USD', 'VES', 'COP']);
const id = (v: unknown) => Number(v);
const opcional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

inventarioRouter.get('/resumen', ah(async (_req, res) => res.json(await resumenInventario())));

// ── Proveedores ──
const proveedorSchema = z.object({
  nombre: z.string().trim().min(2, 'Escribe el nombre del proveedor').max(100),
  documento: opcional(30),
  telefono: opcional(30),
  contacto: opcional(80),
  notas: opcional(300),
  activo: z.boolean().optional(),
});

inventarioRouter.get(
  '/proveedores',
  ah(async (_req, res) => {
    const rows = await db
      .selectFrom('proveedores as p')
      .select((eb) => [
        'p.id',
        'p.nombre',
        'p.documento',
        'p.telefono',
        'p.contacto',
        'p.notas',
        'p.activo',
        eb.selectFrom('compras as c').select((e) => e.fn.countAll<number>().as('n')).whereRef('c.proveedorId', '=', 'p.id').where('c.estado', '!=', 'anulada').as('compras'),
        eb.selectFrom('compras as c').select((e) => e.fn.max('c.fecha').as('f')).whereRef('c.proveedorId', '=', 'p.id').where('c.estado', '!=', 'anulada').as('ultimaCompra'),
      ])
      .orderBy('p.activo', 'desc')
      .orderBy('p.nombre')
      .execute();
    res.json(rows.map((r) => ({ ...r, compras: Number(r.compras ?? 0) })));
  }),
);

inventarioRouter.post(
  '/proveedores',
  ah(async (req, res) => {
    const b = parse(proveedorSchema, req.body);
    res.status(201).json(await db.insertInto('proveedores').values(b).returningAll().executeTakeFirstOrThrow());
  }),
);

inventarioRouter.put(
  '/proveedores/:id',
  ah(async (req, res) => {
    const b = parse(proveedorSchema.partial(), req.body);
    const p = await db.updateTable('proveedores').set(b).where('id', '=', id(req.params.id)).returningAll().executeTakeFirst();
    if (!p) throw notFound('Proveedor no encontrado');
    res.json(p);
  }),
);

// ── Compras ──
inventarioRouter.get(
  '/compras',
  ah(async (req, res) => {
    const q = parse(z.object({ desde: fecha.optional(), hasta: fecha.optional(), proveedorId: z.coerce.number().int().optional(), pendientes: z.enum(['1', 'true']).optional() }), req.query);
    res.json(await listarCompras({ ...q, pendientes: !!q.pendientes }));
  }),
);

inventarioRouter.get('/compras/:id', ah(async (req, res) => res.json(await detalleCompra(id(req.params.id)))));

inventarioRouter.post(
  '/compras',
  ah(async (req, res) => {
    const b = parse(
      z.object({
        proveedorId: z.number().int().positive().nullable().default(null),
        factura: z.string().trim().max(40).nullish(),
        fecha: fecha.optional(),
        moneda,
        items: z
          .array(z.object({ productoId: z.number().int().positive(), cantidad: z.number().int().min(1).max(100_000), costoUnitario: z.number().min(0).max(1e12) }))
          .min(1, 'Agrega al menos un producto')
          .max(100),
        pago: z.object({ metodo: z.string().max(20), monto: z.number().positive().max(1e13).nullish() }).nullable(),
        nota: z.string().trim().max(300).nullish(),
        soporte: z.string().max(6_000_000).nullish(),
      }),
      req.body,
    );
    const u = usuarioActual(req);
    const soporteId = b.soporte ? await guardarArchivo(b.soporte, 'inventario/facturas', u.id) : null;
    res.status(201).json(await registrarCompra(u.id, { ...b, soporteId }));
  }),
);

inventarioRouter.post(
  '/compras/:id/pagos',
  ah(async (req, res) => {
    const b = parse(z.object({ metodo: z.string().max(20), monto: z.number().positive().max(1e13) }), req.body);
    res.status(201).json(await pagarCompra(usuarioActual(req).id, id(req.params.id), b));
  }),
);

inventarioRouter.post(
  '/compras/:id/anular',
  ah(async (req, res) => {
    const { motivo } = parse(z.object({ motivo: z.string().trim().min(4, 'Escribe el motivo').max(200) }), req.body);
    res.json(await anularCompra(usuarioActual(req).id, id(req.params.id), motivo));
  }),
);

// ── Conteo físico ──
inventarioRouter.get('/conteos', ah(async (_req, res) => res.json(await listarConteos())));
inventarioRouter.get('/conteos/actual', ah(async (_req, res) => res.json(await conteoActual())));
inventarioRouter.get('/conteos/:id', ah(async (req, res) => res.json(await detalleConteo(id(req.params.id)))));

inventarioRouter.post(
  '/conteos',
  ah(async (req, res) => {
    const { nota } = parse(z.object({ nota: z.string().trim().max(300).nullish() }), req.body ?? {});
    res.status(201).json(await abrirConteo(usuarioActual(req).id, nota || null));
  }),
);

inventarioRouter.put(
  '/conteos/:id/items',
  ah(async (req, res) => {
    const b = parse(z.object({ productoId: z.number().int().positive(), contado: z.number().int().min(0).max(1_000_000).optional(), sumar: z.number().int().min(-1000).max(1000).optional() }), req.body);
    res.json(await anotarConteo(id(req.params.id), usuarioActual(req).id, b));
  }),
);

inventarioRouter.post(
  '/conteos/:id/cerrar',
  ah(async (req, res) => {
    const { nota } = parse(z.object({ nota: z.string().trim().max(300).nullish() }), req.body ?? {});
    res.json(await cerrarConteo(id(req.params.id), usuarioActual(req).id, nota || null));
  }),
);

inventarioRouter.post('/conteos/:id/cancelar', ah(async (req, res) => res.json(await cancelarConteo(id(req.params.id), usuarioActual(req).id))));

// ── Kardex ──
inventarioRouter.get(
  '/movimientos',
  ah(async (req, res) => {
    const q = parse(z.object({ productoId: z.coerce.number().int().optional(), tipo: z.string().max(20).optional(), desde: fecha.optional(), hasta: fecha.optional() }), req.query);
    res.json(await kardex(q));
  }),
);
