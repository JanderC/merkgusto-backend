import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { ah, badRequest, notFound, parse } from '../../lib/http.js';
import { usuarioActual } from '../../middleware/auth.js';

/** Equipo de trabajo (solo dueño). */
export const usuariosRouter = Router();

const cols = ['id', 'nombre', 'usuario', 'rol', 'telefono', 'activo', 'creadoEn', 'ultimoAcceso'] as const;

usuariosRouter.get(
  '/',
  ah(async (_req, res) => {
    res.json(await db.selectFrom('usuarios').select(cols).orderBy('rol', 'desc').orderBy('nombre').execute());
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
    const u = await db
      .updateTable('usuarios')
      .set({ ...rest, ...(rest.telefono !== undefined && { telefono: rest.telefono || null }), ...(password && { passwordHash: await bcrypt.hash(password, 10) }) })
      .where('id', '=', id)
      .returning(cols)
      .executeTakeFirst();
    if (!u) throw notFound('Usuario no encontrado');
    res.json(u);
  }),
);
