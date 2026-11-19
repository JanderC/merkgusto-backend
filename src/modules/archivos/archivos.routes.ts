import fs from 'node:fs';
import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { ah, unauthorized } from '../../lib/http.js';
import { abrirArchivo } from './archivos.service.js';

/**
 * GET /api/archivos/:id?t=<token>
 * Se monta antes del requireAuth global porque <img src> no envía cabeceras:
 * valida el JWT por query. El archivo sale del disco del servidor.
 */
export const verArchivo: RequestHandler[] = [
  (req, _res, next) => {
    try {
      jwt.verify(String(req.query.t ?? ''), env.JWT_SECRET);
      next();
    } catch {
      next(unauthorized());
    }
  },
  ah(async (req, res) => {
    const a = await abrirArchivo(Number(req.params.id));
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(a.ruta).pipe(res);
  }),
];
