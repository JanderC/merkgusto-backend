import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { ah, badRequest, notFound, parse, unauthorized } from '../../lib/http.js';
import { hoy, sumarDias } from '../../lib/util.js';
import { gestionCaja, usuarioActual } from '../../middleware/auth.js';
import { encolarEntrenador } from '../biometric/biometric-sync.service.js';
import { FACE_MAX_BYTES } from '../biometric/dto/access-control.dto.js';
import { marcar, reportePeriodo, solicitarPermiso, tableroHoy, verificarPin } from './entrenadores.service.js';

export const entrenadoresRouter = Router();

const fotoRostro = z
  .string()
  .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, 'La foto debe ser JPEG')
  .refine((s) => Math.floor(((s.length - 23) * 3) / 4) <= FACE_MAX_BYTES, `La foto debe pesar menos de ${FACE_MAX_BYTES / 1024} KB`);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const horarioSchema = z.record(z.enum(['1', '2', '3', '4', '5', '6', '7']), z.object({ entrada: hhmm, salida: hhmm }));

// Freno a fuerza bruta de PIN: 5 fallos por entrenador → 5 min
const fallos = new Map<string, { n: number; t: number }>();
async function pinValido(entrenadorId: string, pin: string) {
  const f = fallos.get(entrenadorId);
  if (f && f.n >= 5 && Date.now() - f.t < 5 * 60_000) throw unauthorized('Demasiados intentos. Espera 5 minutos.');
  try {
    const e = await verificarPin(entrenadorId, pin);
    fallos.delete(entrenadorId);
    return e;
  } catch (err) {
    fallos.set(entrenadorId, { n: (f && Date.now() - f.t < 5 * 60_000 ? f.n : 0) + 1, t: Date.now() });
    throw err;
  }
}

// ═════════════ Kiosko de recepción (cualquier usuario con sesión + PIN del entrenador) ═════════════

/** Tablero de hoy: estado de cada entrenador (lo ve la recepción y el kiosko). */
entrenadoresRouter.get(
  '/hoy',
  ah(async (_req, res) => {
    res.json(await tableroHoy());
  }),
);

entrenadoresRouter.post(
  '/marcar',
  ah(async (req, res) => {
    const b = parse(
      z.object({
        entrenadorId: z.string().uuid(),
        pin: z.string().regex(/^\d{4,6}$/, 'PIN de 4 a 6 dígitos'),
        tipo: z.enum(['entrada', 'salida', 'retiro', 'regreso']),
        foto: z.string().max(6_000_000),
        nota: z.string().max(250).nullish(),
      }),
      req.body,
    );
    await pinValido(b.entrenadorId, b.pin);
    res.status(201).json(await marcar({ ...b, origen: 'kiosko', usuarioId: usuarioActual(req).id }));
  }),
);

entrenadoresRouter.post(
  '/permisos/solicitar',
  ah(async (req, res) => {
    const b = parse(
      z.object({
        entrenadorId: z.string().uuid(),
        pin: z.string().regex(/^\d{4,6}$/),
        tipo: z.enum(['permiso', 'vacaciones', 'reposo', 'diligencia', 'otro']),
        desde: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)),
        hasta: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)),
        motivo: z.string().trim().min(5, 'Explica el motivo').max(300),
        soporte: z.string().max(6_000_000).nullish(),
      }),
      req.body,
    );
    await pinValido(b.entrenadorId, b.pin);
    res.status(201).json(await solicitarPermiso({ ...b, usuarioId: usuarioActual(req).id }));
  }),
);

// ═════════════ Administración (dueño y admin de caja) ═════════════
const admin = Router();
entrenadoresRouter.use(gestionCaja, admin);

admin.get(
  '/',
  ah(async (_req, res) => {
    res.json(
      await db
        .selectFrom('entrenadores')
        .select(['id', 'codigo', 'nombre', 'apellido', 'cedula', 'telefono', 'especialidad', 'horario', 'activo', 'bioEstado', 'bioError', 'creadoEn', sql<boolean>`foto is not null`.as('tieneFoto')])
        .orderBy('activo', 'desc')
        .orderBy('nombre')
        .execute(),
    );
  }),
);

const entrenadorSchema = z.object({
  nombre: z.string().trim().min(2).max(80),
  apellido: z.string().trim().max(80).default(''),
  cedula: z.string().trim().max(20).nullish(),
  telefono: z.string().trim().max(30).nullish(),
  especialidad: z.string().trim().max(80).nullish(),
  horario: horarioSchema.default({}),
  foto: fotoRostro.nullish(),
  activo: z.boolean().default(true),
});

admin.post(
  '/',
  ah(async (req, res) => {
    const b = parse(entrenadorSchema.extend({ pin: z.string().regex(/^\d{4,6}$/, 'PIN de 4 a 6 dígitos') }), req.body);
    const e = await db
      .insertInto('entrenadores')
      .values({
        nombre: b.nombre,
        apellido: b.apellido,
        cedula: b.cedula || null,
        telefono: b.telefono || null,
        especialidad: b.especialidad || null,
        horario: JSON.stringify(b.horario),
        foto: b.foto ?? null,
        bioEstado: b.foto ? 'pendiente' : 'sin_rostro',
        pinHash: await bcrypt.hash(b.pin, 10),
      })
      .returning(['id', 'codigo', 'nombre'])
      .executeTakeFirstOrThrow();
    await encolarEntrenador(e.id);
    res.status(201).json(e);
  }),
);

admin.put(
  '/:id',
  ah(async (req, res) => {
    const b = parse(entrenadorSchema.partial().extend({ pin: z.string().regex(/^\d{4,6}$/).optional() }), req.body);
    const prev = await db.selectFrom('entrenadores').select(['id', 'foto']).where('id', '=', req.params.id!).executeTakeFirst();
    if (!prev) throw notFound('Entrenador no encontrado');
    const { pin, horario, ...rest } = b;
    const fotoCambio = b.foto !== undefined && b.foto !== prev.foto;
    await db
      .updateTable('entrenadores')
      .set({
        ...rest,
        ...(horario && { horario: JSON.stringify(horario) }),
        ...(pin && { pinHash: await bcrypt.hash(pin, 10) }),
        ...(fotoCambio && { bioEstado: b.foto ? 'pendiente' : 'sin_rostro', bioError: null }),
      })
      .where('id', '=', prev.id)
      .execute();
    if (fotoCambio || b.activo !== undefined || b.nombre) await encolarEntrenador(prev.id);
    res.json({ ok: true });
  }),
);

admin.get(
  '/marcaciones',
  ah(async (req, res) => {
    const f = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    const q = parse(z.object({ desde: f.default(sumarDias(hoy(), -6)), hasta: f.default(hoy()), entrenadorId: z.string().uuid().optional() }), req.query);
    let query = db
      .selectFrom('entrenadorMarcaciones as m')
      .innerJoin('entrenadores as e', 'e.id', 'm.entrenadorId')
      .leftJoin('usuarios as u', 'u.id', 'm.registradoPor')
      .select(['m.id', 'm.tipo', 'm.fechaHora', 'm.origen', 'm.fotoId', 'm.nota', 'm.minutosTarde', 'm.anulada', 'e.id as entrenadorId', sql<string>`e.nombre || ' ' || e.apellido`.as('entrenador'), 'u.nombre as registradoPor'])
      .where(sql`m.fecha_hora::date`, '>=', q.desde)
      .where(sql`m.fecha_hora::date`, '<=', q.hasta)
      .orderBy('m.fechaHora', 'desc')
      .limit(500);
    if (q.entrenadorId) query = query.where('m.entrenadorId', '=', q.entrenadorId);
    res.json(await query.execute());
  }),
);

/** Marcación manual (olvidó marcar, lector dañado). Queda auditada. */
admin.post(
  '/marcaciones',
  ah(async (req, res) => {
    const b = parse(
      z.object({ entrenadorId: z.string().uuid(), tipo: z.enum(['entrada', 'salida', 'retiro', 'regreso']), nota: z.string().trim().min(3, 'Explica por qué es manual').max(250) }),
      req.body,
    );
    res.status(201).json(await marcar({ ...b, origen: 'manual', usuarioId: usuarioActual(req).id }));
  }),
);

admin.post(
  '/marcaciones/:id/anular',
  ah(async (req, res) => {
    const r = await db.updateTable('entrenadorMarcaciones').set({ anulada: true }).where('id', '=', Number(req.params.id)).returning('id').executeTakeFirst();
    if (!r) throw notFound('Marcación no encontrada');
    await db.insertInto('auditoria').values({ usuarioId: usuarioActual(req).id, accion: 'entrenador.marcacion.anulada', detalle: JSON.stringify({ id: r.id }) }).execute();
    res.json({ ok: true });
  }),
);

admin.get(
  '/permisos',
  ah(async (req, res) => {
    const estado = z.enum(['pendiente', 'aprobado', 'rechazado', 'todos']).catch('todos').parse(req.query.estado);
    const entrenadorId = z.string().uuid().optional().catch(undefined).parse(req.query.entrenadorId);
    let q = db
      .selectFrom('entrenadorPermisos as p')
      .innerJoin('entrenadores as e', 'e.id', 'p.entrenadorId')
      .leftJoin('usuarios as u', 'u.id', 'p.resueltoPor')
      .select(['p.id', 'p.entrenadorId', 'p.tipo', 'p.desde', 'p.hasta', 'p.motivo', 'p.soporteId', 'p.estado', 'p.resueltoEn', 'p.notaResolucion', 'p.creadoEn', sql<string>`e.nombre || ' ' || e.apellido`.as('entrenador'), 'u.nombre as resueltoPor'])
      .orderBy('p.creadoEn', 'desc')
      .limit(200);
    if (estado !== 'todos') q = q.where('p.estado', '=', estado);
    if (entrenadorId) q = q.where('p.entrenadorId', '=', entrenadorId);
    res.json(await q.execute());
  }),
);

/** El administrador registra un permiso directamente (sin PIN del entrenador); por defecto queda aprobado. */
admin.post(
  '/permisos',
  ah(async (req, res) => {
    const b = parse(
      z.object({
        entrenadorId: z.string().uuid(),
        tipo: z.enum(['permiso', 'vacaciones', 'reposo', 'diligencia', 'otro']),
        desde: z.string().min(10),
        hasta: z.string().min(10),
        motivo: z.string().trim().min(3, 'Escribe el motivo').max(300),
        soporte: z.string().max(7_000_000).nullish(),
        aprobado: z.boolean().default(true),
      }),
      req.body,
    );
    const u = usuarioActual(req);
    const p = await solicitarPermiso({ ...b, usuarioId: u.id });
    if (b.aprobado) {
      await db
        .updateTable('entrenadorPermisos')
        .set({ estado: 'aprobado', resueltoPor: u.id, resueltoEn: sql`now()` as never, notaResolucion: 'Registrado por administración' })
        .where('id', '=', p.id)
        .execute();
    }
    res.status(201).json({ ...p, estado: b.aprobado ? 'aprobado' : 'pendiente' });
  }),
);

/** Reenvía al entrenador al lector facial (rostro, nombre, si está activo). */
admin.post(
  '/:id/sincronizar',
  ah(async (req, res) => {
    const e = await db.selectFrom('entrenadores').select(['id', 'foto']).where('id', '=', req.params.id!).executeTakeFirst();
    if (!e) throw notFound('Entrenador no encontrado');
    if (e.foto) await db.updateTable('entrenadores').set({ bioEstado: 'pendiente', bioError: null }).where('id', '=', e.id).execute();
    await encolarEntrenador(e.id);
    res.json({ ok: true });
  }),
);

admin.post(
  '/permisos/:id/resolver',
  ah(async (req, res) => {
    const b = parse(z.object({ estado: z.enum(['aprobado', 'rechazado']), nota: z.string().max(250).nullish() }), req.body);
    const r = await db
      .updateTable('entrenadorPermisos')
      .set({ estado: b.estado, notaResolucion: b.nota ?? null, resueltoPor: usuarioActual(req).id, resueltoEn: sql`now()` as never })
      .where('id', '=', Number(req.params.id))
      .where('estado', '=', 'pendiente')
      .returning('id')
      .executeTakeFirst();
    if (!r) throw badRequest('El permiso ya fue resuelto o no existe');
    res.json({ ok: true });
  }),
);

admin.get(
  '/reporte',
  ah(async (req, res) => {
    const f = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    const q = parse(z.object({ desde: f, hasta: f }), req.query);
    res.json(await reportePeriodo(q.desde, q.hasta));
  }),
);

/** Foto del rostro del entrenador (para el lector). */
export const entrenadorFotoHandler = ah(async (req, res) => {
  const e = await db.selectFrom('entrenadores').select('foto').where('id', '=', req.params.id!).executeTakeFirst();
  if (!e?.foto) throw notFound('Sin foto');
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.end(Buffer.from(e.foto.replace(/^data:image\/jpeg;base64,/, ''), 'base64'));
});
