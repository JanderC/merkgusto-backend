import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { Rol } from '../db/types.js';
import { db } from '../db/index.js';
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
    const p = jwt.verify(token, env.JWT_SECRET) as AuthUser & jwt.JwtPayload & { tipo?: string };
    // Los tokens de la app de entrenadores y de clientes nunca abren rutas del equipo
    if (p.tipo) return next(unauthorized('Sesión inválida o expirada'));
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

// ═════════════ App de entrenadores y app de clientes ═════════════

export interface EntrenadorSesion {
  id: string;
  nombre: string;
}
export type ViaCliente = 'cedula' | 'clave' | 'enlace';
export interface SocioSesion {
  id: string;
  via: ViaCliente;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      entrenador?: EntrenadorSesion;
      socioApp?: SocioSesion;
    }
  }
}

export function tokenEntrenador(e: { id: string; nombre: string; sesionVersion: number }) {
  return jwt.sign({ tipo: 'entrenador', id: e.id, nombre: e.nombre, v: e.sesionVersion }, env.JWT_SECRET, { expiresIn: '30d' });
}

export function tokenSocio(s: { id: string; appSesion: number }, via: ViaCliente) {
  return jwt.sign({ tipo: 'socio', id: s.id, via, v: s.appSesion }, env.JWT_SECRET, { expiresIn: '60d' });
}

const bearer = (req: Request) => {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
};

/** Token del equipo o de un entrenador (fotos por query). Los clientes no. */
export function tokenEquipoOEntrenador(t: string) {
  try {
    const p = jwt.verify(t, env.JWT_SECRET) as jwt.JwtPayload & { tipo?: string };
    return !p.tipo || p.tipo === 'entrenador';
  } catch {
    return false;
  }
}

/** Sesión de la app de entrenadores: se comprueba en cada petición que siga activo. */
export async function requireEntrenador(req: Request, _res: Response, next: NextFunction) {
  try {
    const t = bearer(req);
    if (!t) throw unauthorized('Debes iniciar sesión');
    let p: jwt.JwtPayload & { tipo?: string; id?: string; v?: number };
    try {
      p = jwt.verify(t, env.JWT_SECRET) as typeof p;
    } catch {
      throw unauthorized('Sesión inválida o expirada');
    }
    if (p.tipo !== 'entrenador' || !p.id) throw unauthorized('Sesión inválida o expirada');
    const e = await db.selectFrom('entrenadores').select(['id', 'nombre', 'activo', 'sesionVersion', 'passwordHash']).where('id', '=', p.id).executeTakeFirst();
    if (!e || !e.activo || !e.passwordHash || e.sesionVersion !== p.v) throw unauthorized('Tu acceso cambió: vuelve a entrar');
    req.entrenador = { id: e.id, nombre: e.nombre };
    next();
  } catch (err) {
    next(err);
  }
}

/** Sesión de la app de clientes. Cambiar o quitar la clave cierra las demás sesiones. */
export async function requireSocio(req: Request, _res: Response, next: NextFunction) {
  try {
    const t = bearer(req);
    if (!t) throw unauthorized('Entra con tu cédula');
    let p: jwt.JwtPayload & { tipo?: string; id?: string; v?: number; via?: ViaCliente };
    try {
      p = jwt.verify(t, env.JWT_SECRET) as typeof p;
    } catch {
      throw unauthorized('Tu sesión venció: entra de nuevo');
    }
    if (p.tipo !== 'socio' || !p.id) throw unauthorized('Entra con tu cédula');
    const s = await db.selectFrom('socios').select(['id', 'appSesion']).where('id', '=', p.id).executeTakeFirst();
    if (!s || s.appSesion !== p.v) throw unauthorized('Tu sesión se cerró: entra de nuevo');
    req.socioApp = { id: s.id, via: p.via ?? 'cedula' };
    next();
  } catch (err) {
    next(err);
  }
}

export const entrenadorActual = (req: Request): EntrenadorSesion => {
  if (!req.entrenador) throw unauthorized();
  return req.entrenador;
};
export const socioActual = (req: Request): SocioSesion => {
  if (!req.socioApp) throw unauthorized();
  return req.socioApp;
};
