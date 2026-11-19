import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const notFound = (msg = 'Recurso no encontrado') => new HttpError(404, msg);
export const unauthorized = (msg = 'No autorizado') => new HttpError(401, msg);
export const forbidden = (msg = 'No tienes permisos para esta acción') => new HttpError(403, msg);
export const conflict = (msg: string) => new HttpError(409, msg);

/** Envuelve handlers async para que los errores lleguen al middleware de errores. */
export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    // Los mensajes propios ya están en español; los genéricos de zod llevan el campo
    const generico = first && /^(Required|Expected|Invalid|String|Number|Array)/.test(first.message);
    throw badRequest(first ? (generico ? `${first.path.join('.') || 'dato'}: ${first.message}` : first.message) : 'Datos inválidos', result.error.issues);
  }
  return result.data;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    if (err.status === 401) console.warn(`🔒 401 ${req.method} ${req.originalUrl.split('?')[0]} · ${err.message}`);
    return res.status(err.status).json({ ok: false, message: err.message, details: err.details });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ ok: false, message: 'Datos inválidos', details: err.issues });
  }
  const pgErr = err as { code?: string; detail?: string; constraint?: string; type?: string };
  if (pgErr?.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, message: 'La foto o el archivo es demasiado grande' });
  }
  if (pgErr?.code === '23505') {
    return res.status(409).json({ ok: false, message: 'Ya existe un registro con esos datos', details: pgErr.detail });
  }
  if (pgErr?.code === '23503') {
    return res.status(409).json({ ok: false, message: 'El registro está relacionado con otros datos', details: pgErr.detail });
  }
  if (pgErr?.code === '23514') {
    return res.status(400).json({ ok: false, message: `Valor no permitido (${pgErr.constraint})` });
  }
  console.error('✗ Error no controlado:', err);
  return res.status(500).json({ ok: false, message: 'Error interno del servidor' });
}
