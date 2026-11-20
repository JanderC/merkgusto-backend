/** Respaldos de la base de datos (solo dueño).   /api/respaldos */
import { Router } from 'express';
import { ah, notFound } from '../../lib/http.js';
import { usuarioActual } from '../../middleware/auth.js';
import { db } from '../../db/index.js';
import { hacerRespaldo, listarRespaldos, rutaRespaldo } from './respaldos.service.js';

export const respaldosRouter = Router();

respaldosRouter.get('/', ah(async (_req, res) => res.json(listarRespaldos())));

respaldosRouter.post(
  '/',
  ah(async (req, res) => {
    const r = await hacerRespaldo('manual');
    await db.insertInto('auditoria').values({ usuarioId: usuarioActual(req).id, accion: 'respaldo.creado', detalle: JSON.stringify({ nombre: r.nombre }) }).execute();
    res.status(201).json(r);
  }),
);

respaldosRouter.get(
  '/:nombre',
  ah(async (req, res) => {
    const ruta = rutaRespaldo(String(req.params.nombre));
    if (!ruta) throw notFound('Respaldo no encontrado');
    await db.insertInto('auditoria').values({ usuarioId: usuarioActual(req).id, accion: 'respaldo.descargado', detalle: JSON.stringify({ nombre: req.params.nombre }) }).execute();
    res.download(ruta, String(req.params.nombre));
  }),
);
