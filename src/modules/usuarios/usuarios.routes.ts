import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { ah, badRequest, notFound, parse } from '../../lib/http.js';
import { usuarioActual } from '../../middleware/auth.js';
import { pinEnUso, PIN_REGEX } from '../caja/devoluciones.service.js';

/** Equipo de trabajo (solo dueño). */
export const usuariosRouter = Router();

const cols = ['id', 'nombre', 'usuario', 'rol', 'telefono', 'activo', 'creadoEn', 'ultimoAcceso'] as const;

usuariosRouter.get(
  '/',
  ah(async (_req, res) => {
    res.json(
      await db
        .selectFrom('usuarios')
        .select([...cols, sql<boolean>`pin_hash is not null`.as('tienePin')])
        .orderBy('rol', 'desc')
        .orderBy('nombre')
        .execute(),
    );
  }),
);

/** Código de autorización de un supervisor (dueño o admin de caja) para devoluciones. Vacío = quitarlo. */
usuariosRouter.put(
  '/:id/pin',
  ah(async (req, res) => {
    const { pin } = parse(z.object({ pin: z.union([z.literal(''), z.string().regex(PIN_REGEX, 'El código debe tener de 4 a 8 números')]) }), req.body);
    const u = await db.selectFrom('usuarios').select(['id', 'rol']).where('id', '=', req.params.id!).executeTakeFirst();
    if (!u) throw notFound('Usuario no encontrado');
    if (pin && u.rol === 'cajero') throw badRequest('Solo el dueño y los administradores de caja pueden autorizar devoluciones');
    if (pin && (await pinEnUso(pin, u.id))) throw badRequest('Ese código ya lo usa otro supervisor: elige otro');
    await db.updateTable('usuarios').set({ pinHash: pin ? await bcrypt.hash(pin, 10) : null }).where('id', '=', u.id).execute();
    await db.insertInto('auditoria').values({ usuarioId: usuarioActual(req).id, accion: pin ? 'usuario.pin_asignado' : 'usuario.pin_quitado', detalle: JSON.stringify({ usuarioId: u.id }) }).execute();
    res.json({ ok: true, tienePin: !!pin });
  }),
);

const base = z.object({
  nombre: z.string().trim().min(2).max(120),
  usuario: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._-]{3,60}$/, 'Usuario: 3 a 60 letras, números, punto o guion'),
  telefono: z.string().trim().max(30).nullish(),
  rol: z.enum(['dueno', 'admin_caja', 'cajero']).default('cajero'),
});

usuariosRouter.post(
  '/',
  ah(async (req, res) => {
    const body = parse(base.extend({ password: z.string().min(4, 'Mínimo 4 caracteres').max(100) }), req.body);
    const u = await db
      .insertInto('usuarios')
      .values({ nombre: body.nombre, usuario: body.usuario, telefono: body.telefono || null, rol: body.rol, passwordHash: await bcrypt.hash(body.password, 10) })
      .returning(cols)
      .executeTakeFirstOrThrow();
    res.status(201).json(u);
  }),
);

usuariosRouter.put(
  '/:id',
  ah(async (req, res) => {
    const body = parse(base.partial().extend({ activo: z.boolean().optional(), password: z.string().min(4).max(100).optional() }), req.body);
    const id = req.params.id!;
    if (id === usuarioActual(req).id && (body.activo === false || body.rol === 'cajero')) {
      throw badRequest('No puedes desactivarte ni quitarte el rol de dueño');
    }
    const { password, ...rest } = body;
    const sinPin = rest.rol === 'cajero' ? { pinHash: null } : {};
    const u = await db
      .updateTable('usuarios')
      .set({ ...rest, ...sinPin, ...(rest.telefono !== undefined && { telefono: rest.telefono || null }), ...(password && { passwordHash: await bcrypt.hash(password, 10) }) })
      .where('id', '=', id)
      .returning(cols)
      .executeTakeFirst();
    if (!u) throw notFound('Usuario no encontrado');
    res.json(u);
  }),
);
