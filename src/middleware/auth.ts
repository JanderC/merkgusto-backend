import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { Rol } from '../db/types.js';
import { forbidden, unauthorized } from '../lib/http.js';

export interface AuthUser {
  id: string;
  usuario: string;
  nombre: string;
  rol: Rol;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signToken(user: AuthUser): string {
  return jwt.sign(user, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] });
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) return next(unauthorized('Debes iniciar sesión'));
  try {
    const p = jwt.verify(token, env.JWT_SECRET) as AuthUser & jwt.JwtPayload;
    req.user = { id: p.id, usuario: p.usuario, nombre: p.nombre, rol: p.rol };
    next();
  } catch {
    next(unauthorized('Sesión inválida o expirada'));
  }
}

/** Solo el dueño. Las cajeras nunca llegan a rutas financieras. */
export function soloDueno(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (req.user.rol !== 'dueno') return next(forbidden('Solo el dueño puede ver esta información'));
  next();
}

/** Permite solo los roles indicados. */
export const requireRol =
  (...roles: Rol[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.rol)) return next(forbidden('No tienes permisos para esta sección'));
    next();
  };

/** Dueño o administrador de caja: dinero, cierres, finanzas. */
export const gestionCaja = requireRol('dueno', 'admin_caja');

export const usuarioActual = (req: Request): AuthUser => {
  if (!req.user) throw unauthorized();
  return req.user;
};
