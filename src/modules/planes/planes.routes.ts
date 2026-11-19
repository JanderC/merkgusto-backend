import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { ah, badRequest, conflict, notFound, parse } from '../../lib/http.js';
import { diasEntre, hoy } from '../../lib/util.js';
import { soloDueno, usuarioActual } from '../../middleware/auth.js';
import { encolarSocio } from '../biometric/biometric-sync.service.js';
import { describirDuracion, diasAproximados } from '../membresias/membresias.service.js';

export const planesRouter = Router();
export const productosRouter = Router();

// ── Planes ──
const moneda = z.enum(['USD', 'VES', 'COP']);

const planSchema = z.object({
  nombre: z.string().trim().min(2).max(80),
  descripcion: z.string().trim().max(250).nullish(),
  /** Mes a mes: tipoDuracion "meses" + cantidad 1 */
  tipoDuracion: z.enum(['dias', 'semanas', 'meses', 'anios']).default('meses'),
  cantidad: z.number().int().min(1).max(366).default(1),
  precio: z.number().min(0).max(1e12),
  moneda: moneda.default('USD'),
  personas: z.number().int().min(1).max(10).default(1),
  congelable: z.boolean().default(true),
  maxDiasCongelado: z.number().int().min(0).max(365).default(30),
  /** Si no se indica: semanas/meses/años sí; días (pase diario, rutinas) no */
  accesoLector: z.boolean().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#FF8A10'),
  activo: z.boolean().default(true),
  orden: z.number().int().min(0).max(999).default(0),
});

planesRouter.get(
  '/',
  ah(async (req, res) => {
    const eliminados = req.query.eliminados === '1';
    res.json(
      await db
        .selectFrom('planes as p')
        .selectAll('p')
        .where('p.eliminadoEn', eliminados ? 'is not' : 'is', null)
        .select((eb) =>
          eb
            .selectFrom('membresias as m')
            .select(eb.fn.countAll<number>().as('n'))
            .whereRef('m.planId', '=', 'p.id')
            .where('m.estado', '=', 'activa')
            .where('m.fechaFin', '>=', hoy())
            .as('activos'),
        )
        .select((eb) =>
          eb
            .selectFrom('membresias as m')
            .select(sql<number>`count(distinct m.socio_id)::int`.as('n'))
            .whereRef('m.planId', '=', 'p.id')
            .where('m.estado', '!=', 'anulada')
            .as('historicos'),
        )
        .orderBy('p.orden')
        .orderBy('p.precio')
        .execute()
        .then((rows) => rows.map((r) => ({ ...r, duracion: describirDuracion(r) }))),
    );
  }),
);

planesRouter.post(
  '/',
  soloDueno,
  ah(async (req, res) => {
    const b = parse(planSchema, req.body);
    res
      .status(201)
      .json(
        await db
          .insertInto('planes')
          .values({ ...b, descripcion: b.descripcion || null, duracionDias: diasAproximados(b), accesoLector: b.accesoLector ?? b.tipoDuracion !== 'dias' })
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
  }),
);

planesRouter.put(
  '/:id',
  soloDueno,
  ah(async (req, res) => {
    const b = parse(planSchema.partial(), req.body);
    const actual = await db.selectFrom('planes').select(['tipoDuracion', 'cantidad']).where('id', '=', Number(req.params.id)).executeTakeFirst();
    if (!actual) throw notFound('Plan no encontrado');
    const dur = { tipoDuracion: b.tipoDuracion ?? actual.tipoDuracion, cantidad: b.cantidad ?? actual.cantidad };
    const p = await db
      .updateTable('planes')
      .set({ ...b, duracionDias: diasAproximados(dur) })
      .where('id', '=', Number(req.params.id))
      .returningAll()
      .executeTakeFirst();
    if (!p) throw notFound('Plan no encontrado');
    res.json(p);
  }),
);

/** Membresías vigentes o por empezar (las congeladas cuentan aunque estén pausadas). */
const vigentesDelPlan = (planId: number) =>
  db
    .selectFrom('membresias as m')
    .innerJoin('socios as s', 's.id', 'm.socioId')
    .select(['m.id', 'm.socioId', 'm.fechaInicio', 'm.fechaFin', 'm.estado', 'm.congeladaDesde', 's.nombre', 's.apellido', 's.cedula', 's.telefono'])
    .where('m.planId', '=', planId)
    .where((eb) => eb.or([eb('m.estado', '=', 'congelada'), eb.and([eb('m.estado', '=', 'activa'), eb('m.fechaFin', '>=', hoy())])]))
    .orderBy('m.fechaFin')
    .execute();

interface ClienteVigente {
  socioId: string;
  nombre: string;
  apellido: string;
  cedula: string | null;
  telefono: string | null;
  desde: string;
  hasta: string;
  renovaciones: number;
  congelada: boolean;
  congeladaDesde: string | null;
}

/**
 * Quién usa el plan antes de eliminarlo: clientes vigentes (con sus fechas de
 * mensualidad) y quiénes lo tuvieron antes (historial).
 */
planesRouter.get(
  '/:id/uso',
  soloDueno,
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const plan = await db.selectFrom('planes').select(['id', 'nombre', 'tipoDuracion', 'cantidad', 'eliminadoEn']).where('id', '=', id).executeTakeFirst();
    if (!plan) throw notFound('Plan no encontrado');
    const h = hoy();
    const filas = await vigentesDelPlan(id);
    // Una fila por cliente: las renovaciones ya pagadas se encadenan
    const porSocio = new Map<string, ClienteVigente>();
    for (const f of filas) {
      const x = porSocio.get(f.socioId);
      if (!x) {
        porSocio.set(f.socioId, {
          socioId: f.socioId,
          nombre: f.nombre,
          apellido: f.apellido,
          cedula: f.cedula,
          telefono: f.telefono,
          desde: f.fechaInicio,
          hasta: f.fechaFin,
          renovaciones: 0,
          congelada: f.estado === 'congelada',
          congeladaDesde: f.congeladaDesde,
        });
        continue;
      }
      if (f.fechaInicio < x.desde) x.desde = f.fechaInicio;
      if (f.fechaFin > x.hasta) x.hasta = f.fechaFin;
      x.renovaciones++;
      if (f.estado === 'congelada') {
        x.congelada = true;
        x.congeladaDesde = f.congeladaDesde;
      }
    }
    const vigentes = [...porSocio.values()]
      .map((x) => ({ ...x, porEmpezar: x.desde > h, diasRestantes: x.congelada ? null : diasEntre(x.desde > h ? x.desde : h, x.hasta) + 1 }))
      .sort((a, b) => a.hasta.localeCompare(b.hasta));
    const anteriores = await db
      .selectFrom('membresias as m')
      .innerJoin('socios as s', 's.id', 'm.socioId')
      .select((eb) => ['s.id as socioId', 's.nombre', 's.apellido', 's.cedula', 's.telefono', eb.fn.max('m.fechaFin').as('ultimaFin')])
      .where('m.planId', '=', id)
      .where('m.estado', '!=', 'anulada')
      .groupBy(['s.id', 's.nombre', 's.apellido', 's.cedula', 's.telefono'])
      .orderBy('ultimaFin', 'desc')
      .limit(300)
      .execute();
    res.json({
      plan: { ...plan, duracion: describirDuracion(plan) },
      vigentes,
      anteriores: anteriores.filter((a) => !porSocio.has(a.socioId)),
      tieneHistorial: anteriores.length > 0 || filas.length > 0,
    });
  }),
);

/**
 * Eliminar plan.
 *  • Nunca se vendió → se borra.
 *  • Tiene historial → se archiva (no se ve ni se vende; el historial queda).
 *  • Tiene clientes vigentes → hay que decidir: "dejar" (siguen con sus fechas
 *    hasta vencer) o "mover" sus membresías a otro plan (mismas fechas, sin cobrar).
 */
planesRouter.delete(
  '/:id',
  soloDueno,
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const b = parse(z.object({ modo: z.enum(['dejar', 'mover']).optional(), destinoId: z.number().int().positive().optional() }), req.body ?? {});
    const plan = await db.selectFrom('planes').select(['id', 'nombre', 'eliminadoEn']).where('id', '=', id).executeTakeFirst();
    if (!plan || plan.eliminadoEn) throw notFound('Plan no encontrado');
    const vigentes = await vigentesDelPlan(id);
    const socios = [...new Set(vigentes.map((v) => v.socioId))];
    if (socios.length && !b.modo) throw conflict(`El plan tiene ${socios.length} cliente(s) vigente(s): elige si siguen hasta vencer o pasan a otro plan`);
    let destino: { id: number; nombre: string } | undefined;
    if (socios.length && b.modo === 'mover') {
      if (!b.destinoId || b.destinoId === id) throw badRequest('Elige el plan al que pasan los clientes');
      destino = await db.selectFrom('planes').select(['id', 'nombre']).where('id', '=', b.destinoId).where('eliminadoEn', 'is', null).executeTakeFirst();
      if (!destino) throw badRequest('El plan destino no existe');
    }
    const u = usuarioActual(req);
    const { resultado, movidos } = await db.transaction().execute(async (trx) => {
      let movidos = 0;
      if (destino) {
        const r = await trx
          .updateTable('membresias')
          .set({ planId: destino.id })
          .where('id', 'in', vigentes.map((v) => v.id))
          .executeTakeFirst();
        movidos = Number(r.numUpdatedRows);
      }
      const usado = await trx.selectFrom('membresias').select('id').where('planId', '=', id).limit(1).executeTakeFirst();
      if (usado) await trx.updateTable('planes').set({ activo: false, eliminadoEn: new Date() }).where('id', '=', id).execute();
      else await trx.deleteFrom('planes').where('id', '=', id).execute();
      const resultado = usado ? ('archivado' as const) : ('borrado' as const);
      await trx
        .insertInto('auditoria')
        .values({
          usuarioId: u.id,
          accion: 'plan.eliminado',
          detalle: JSON.stringify({ planId: id, nombre: plan.nombre, modo: b.modo ?? null, destino: destino?.nombre ?? null, clientes: socios.length, movidos, resultado }),
        })
        .execute();
      return { resultado, movidos };
    });
    // El otro plan puede dar o no acceso por el lector: refrescar a los movidos
    if (destino) for (const sid of socios) await encolarSocio(sid).catch(() => undefined);
    res.json({ ok: true, resultado, movidos, clientes: socios.length, destino: destino?.nombre ?? null });
  }),
);

/** Recuperar un plan eliminado con historial (vuelve oculto en caja hasta activarlo). */
planesRouter.post(
  '/:id/restaurar',
  soloDueno,
  ah(async (req, res) => {
    const p = await db.updateTable('planes').set({ eliminadoEn: null }).where('id', '=', Number(req.params.id)).returningAll().executeTakeFirst();
    if (!p) throw notFound('Plan no encontrado');
    res.json(p);
  }),
);

// ── Productos / inventario ──
const productoSchema = z.object({
  nombre: z.string().trim().min(2).max(100),
  categoria: z.string().trim().min(2).max(40).default('General'),
  precio: z.number().min(0).max(1e12),
  /** Ej. agua: 4.500 COP */
  moneda: moneda.default('COP'),
  costo: z.number().min(0).max(1e12).default(0),
  stock: z.number().int().min(0).max(1_000_000).default(0),
  stockMinimo: z.number().int().min(0).max(100_000).default(5),
  controlaStock: z.boolean().default(true),
  activo: z.boolean().default(true),
});

productosRouter.get(
  '/',
  ah(async (_req, res) => {
    res.json(await db.selectFrom('productos').selectAll().orderBy('categoria').orderBy('nombre').execute());
  }),
);

productosRouter.post(
  '/',
  soloDueno,
  ah(async (req, res) => {
    const b = parse(productoSchema, req.body);
    res.status(201).json(await db.insertInto('productos').values(b).returningAll().executeTakeFirstOrThrow());
  }),
);

productosRouter.put(
  '/:id',
  soloDueno,
  ah(async (req, res) => {
    const b = parse(productoSchema.partial(), req.body);
    const p = await db.updateTable('productos').set(b).where('id', '=', Number(req.params.id)).returningAll().executeTakeFirst();
    if (!p) throw notFound('Producto no encontrado');
    res.json(p);
  }),
);

/** Entrada de mercancía: suma unidades al stock. */
productosRouter.post(
  '/:id/entrada',
  soloDueno,
  ah(async (req, res) => {
    const { cantidad } = parse(z.object({ cantidad: z.number().int().min(-100_000).max(100_000) }), req.body);
    const p = await db
      .updateTable('productos')
      .set((eb) => ({ stock: eb('stock', '+', cantidad) }))
      .where('id', '=', Number(req.params.id))
      .returningAll()
      .executeTakeFirst();
    if (!p) throw notFound('Producto no encontrado');
    res.json(p);
  }),
);
