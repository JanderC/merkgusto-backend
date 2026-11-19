import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { ah, badRequest, parse, unauthorized } from '../../lib/http.js';
import { requireAuth, signToken, usuarioActual } from '../../middleware/auth.js';

export const authRouter = Router();

// Freno simple a fuerza bruta: 8 intentos fallidos por usuario cada 10 min
const fallos = new Map<string, { n: number; t: number }>();

authRouter.post(
  '/login',
  ah(async (req, res) => {
    const { usuario, password } = parse(z.object({ usuario: z.string().trim().min(1).max(60), password: z.string().min(1).max(100) }), req.body);
    const key = usuario.toLowerCase();
    const f = fallos.get(key);
    if (f && f.n >= 8 && Date.now() - f.t < 10 * 60_000) throw unauthorized('Demasiados intentos. Espera unos minutos.');

    const u = await db.selectFrom('usuarios').selectAll().where(sql`lower(usuario)`, '=', key).executeTakeFirst();
    if (!u || !u.activo || !(await bcrypt.compare(password, u.passwordHash))) {
      fallos.set(key, { n: (f && Date.now() - f.t < 10 * 60_000 ? f.n : 0) + 1, t: Date.now() });
      throw unauthorized('Usuario o contraseña incorrectos');
    }
    fallos.delete(key);
    await db.updateTable('usuarios').set({ ultimoAcceso: sql`now()` as never }).where('id', '=', u.id).execute();
    const user = { id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol };
    res.json({ token: signToken(user), user });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    res.json(usuarioActual(req));
  }),
);

authRouter.post(
  '/cambiar-password',
  requireAuth,
  ah(async (req, res) => {
    const { actual, nueva } = parse(z.object({ actual: z.string().min(1), nueva: z.string().min(6, 'Mínimo 6 caracteres').max(100) }), req.body);
    const u = await db.selectFrom('usuarios').selectAll().where('id', '=', usuarioActual(req).id).executeTakeFirstOrThrow();
    if (!(await bcrypt.compare(actual, u.passwordHash))) throw badRequest('La contraseña actual no es correcta');
    await db.updateTable('usuarios').set({ passwordHash: await bcrypt.hash(nueva, 10) }).where('id', '=', u.id).execute();
    res.json({ ok: true });
  }),
);
