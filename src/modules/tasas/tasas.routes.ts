import { Router } from 'express';

import { db } from '../../db/index.js';
import { ah, parse } from '../../lib/http.js';
import { gestionCaja, usuarioActual } from '../../middleware/auth.js';
import { getConfig, setConfig } from '../configuracion/config.service.js';
import { autoSchema, fuentesExternas, guardarTasa, historialTasas, nuevaTasaSchema, tasaVigente, tickTasasAutomaticas } from './tasas.service.js';

/** Tasas del día. Ver: todos · Cambiar: dueño y administrador de caja. */
export const tasasRouter = Router();

tasasRouter.get(
  '/',
  ah(async (_req, res) => {
    const [vigente, historial, auto] = await Promise.all([tasaVigente(), historialTasas(30), getConfig('tasasAuto')]);
    res.json({ vigente, historial, auto });
  }),
);

/** BCV oficial, paralelo y TRM en vivo (cache 5 min). */
tasasRouter.get(
  '/externas',
  ah(async (req, res) => {
    res.json(await fuentesExternas(req.query.forzar === '1'));
  }),
);

tasasRouter.post(
  '/',
  gestionCaja,
  ah(async (req, res) => {
    const b = parse(nuevaTasaSchema, req.body);
    const u = usuarioActual(req);
    const antes = await tasaVigente();
    const v = await guardarTasa(b, u.id);
    await db
      .insertInto('auditoria')
      .values({ usuarioId: u.id, accion: 'tasas.actualizadas', detalle: JSON.stringify({ antes: { dolar: antes.dolar, bs: antes.bs }, despues: b }) })
      .execute();
    res.status(201).json(v);
  }),
);

tasasRouter.put(
  '/auto',
  gestionCaja,
  ah(async (req, res) => {
    const auto = await setConfig('tasasAuto', parse(autoSchema.partial(), req.body));
    // Aplica de una vez si se activó
    await tickTasasAutomaticas().catch(() => false);
    res.json({ auto, vigente: await tasaVigente() });
  }),
);

