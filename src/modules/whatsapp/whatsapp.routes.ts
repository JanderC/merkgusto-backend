import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import { ah, badRequest, parse } from '../../lib/http.js';
import { hoy } from '../../lib/util.js';
import { enviarReporteDiario, textoReporteDiario } from './reportes.service.js';
import { whatsapp } from './whatsapp.service.js';

/** Administración de WhatsApp (solo dueño). */
export const whatsappRouter = Router();

whatsappRouter.get(
  '/estado',
  ah(async (_req, res) => {
    res.json({ ...whatsapp.getEstado(), habilitado: env.WHATSAPP_ENABLED, ia: Boolean(env.GROQ_API_KEY) });
  }),
);

whatsappRouter.post(
  '/conectar',
  ah(async (_req, res) => {
    if (!env.WHATSAPP_ENABLED) throw badRequest('WhatsApp está deshabilitado en el .env (WHATSAPP_ENABLED)');
    void whatsapp.iniciar();
    res.json({ ok: true });
  }),
);

whatsappRouter.post(
  '/desconectar',
  ah(async (_req, res) => {
    await whatsapp.desconectar();
    res.json({ ok: true });
  }),
);

whatsappRouter.get(
  '/mensajes',
  ah(async (_req, res) => {
    res.json(await db.selectFrom('waMensajes').selectAll().orderBy('id', 'desc').limit(150).execute());
  }),
);

whatsappRouter.get(
  '/reporte/preview',
  ah(async (req, res) => {
    const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).catch(hoy()).parse(req.query.fecha);
    res.json({ texto: await textoReporteDiario(fecha) });
  }),
);

whatsappRouter.post(
  '/reporte/enviar',
  ah(async (_req, res) => {
    if (!whatsapp.conectado) throw badRequest('Conecta WhatsApp primero');
    try {
      await enviarReporteDiario(hoy(), true);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    res.json({ ok: true });
  }),
);

whatsappRouter.post(
  '/prueba',
  ah(async (req, res) => {
    const { numero, texto } = parse(z.object({ numero: z.string().min(7).max(30), texto: z.string().min(1).max(1000) }), req.body);
    if (!whatsapp.conectado) throw badRequest('Conecta WhatsApp primero');
    try {
      await whatsapp.enviar(numero, texto, 'manual');
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    res.json({ ok: true });
  }),
);
