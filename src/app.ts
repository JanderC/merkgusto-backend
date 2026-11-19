import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import cors from 'cors';
import express, { Router } from 'express';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { env } from './config/env.js';
import { checkDatabase } from './db/index.js';
import { errorHandler, notFound, unauthorized } from './lib/http.js';
import { gestionCaja, requireAuth, soloDueno } from './middleware/auth.js';
import { verArchivo } from './modules/archivos/archivos.routes.js';
import { entrenadorFotoHandler, entrenadoresRouter } from './modules/entrenadores/entrenadores.routes.js';
import { finanzasRouter } from './modules/finanzas/finanzas.routes.js';
import { tasasRouter } from './modules/tasas/tasas.routes.js';
import { asistenciaRouter } from './modules/asistencia/asistencia.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { biometricAdminRouter, biometricWebhookRouter, lectorRouter } from './modules/biometric/biometric.routes.js';
import { cajaDuenoRouter, posRouter } from './modules/caja/caja.routes.js';
import { configRouter } from './modules/configuracion/config.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { planesRouter, productosRouter } from './modules/planes/planes.routes.js';
import { clasesRouter } from './modules/clases/clases.routes.js';
import { membresiasRouter } from './modules/membresias/membresias.routes.js';
import { socioFotoHandler, sociosRouter } from './modules/socios/socios.routes.js';
import { usuariosRouter } from './modules/usuarios/usuarios.routes.js';
import { whatsappRouter } from './modules/whatsapp/whatsapp.routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.resolve(here, '../../frontend/dist');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(compression());

  const api = Router();

  // ── Webhook del lector: ANTES de CORS/JSON, tiene su propia seguridad ──
  api.use('/biometric', express.json({ limit: '512kb' }), biometricWebhookRouter);

  const origins = env.CORS_ORIGIN.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  api.use(cors({ origin: origins }));
  // Fotos de rostro (≤200 KB) y comprobantes/soportes (≤4 MB) en base64
  api.use(express.json({ limit: '7mb' }));

  api.get('/health', async (_req, res) => {
    res.json({ ok: true, db: await checkDatabase(), gym: env.GYM_NOMBRE, biometrico: env.BIOMETRIC_MODE, hora: new Date().toISOString() });
  });

  api.use('/auth', authRouter);

  // <img src> no puede enviar cabeceras: la foto acepta el token por query
  api.get('/socios/:id/foto', (req, _res, next) => {
    try {
      jwt.verify(String(req.query.t ?? ''), env.JWT_SECRET);
      next();
    } catch {
      next(unauthorized());
    }
  }, socioFotoHandler);

  api.get('/archivos/:id', ...verArchivo);
  api.get('/entrenadores/:id/foto', (req, _res, next) => {
    try {
      jwt.verify(String(req.query.t ?? ''), env.JWT_SECRET);
      next();
    } catch {
      next(unauthorized());
    }
  }, entrenadorFotoHandler);

  // ── Con sesión (todo el equipo) ──
  api.use(requireAuth);
  api.use('/tasas', tasasRouter);
  api.use('/lector', lectorRouter);
  api.use('/entrenadores', entrenadoresRouter);
  api.use('/config', configRouter);
  api.use('/pos', posRouter);
  api.use('/socios', sociosRouter);
  api.use('/membresias', membresiasRouter);
  api.use('/clases', clasesRouter);
  api.use('/planes', planesRouter);
  api.use('/productos', productosRouter);
  api.use('/asistencia', asistenciaRouter);

  // ── Dueño y administrador de caja: dinero, cierres, finanzas ──
  api.use('/caja', gestionCaja, cajaDuenoRouter);
  api.use('/dashboard', gestionCaja, dashboardRouter);
  api.use('/finanzas', gestionCaja, finanzasRouter);

  // ── Solo dueño: equipo e integraciones ──
  api.use('/usuarios', soloDueno, usuariosRouter);
  api.use('/whatsapp', soloDueno, whatsappRouter);
  api.use('/biometric', soloDueno, biometricAdminRouter);

  api.use((_req, _res, next) => next(notFound('Ruta de API no encontrada')));
  app.use('/api', api);

  // En producción el backend sirve la web compilada
  if (fs.existsSync(FRONTEND_DIST)) {
    app.use(express.static(FRONTEND_DIST, { maxAge: '7d', index: false }));
    app.get('*', (_req, res) => res.sendFile(path.join(FRONTEND_DIST, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
