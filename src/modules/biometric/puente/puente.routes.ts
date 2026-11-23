/** /api/puente — solo lo usa el programa puente de la PC del gimnasio (backend/lector). */
import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { ah, notFound, parse, unauthorized } from '../../../lib/http.js';
import { registrarEventoAcceso } from '../../asistencia/asistencia.service.js';
import { anotarEvento } from '../biometric.routes.js';
import { parseHikEvent } from '../webhook/webhook.parser.js';
import { isKnownDevice } from '../webhook/webhook.security.js';
import { entregarRespuesta, tomarPedidos } from './puente.service.js';

export const puenteRouter = Router();
const sha = (s: string) => crypto.createHash('sha256').update(s).digest();

puenteRouter.use((req, _res, next) => {
  if (env.BIOMETRIC_MODE !== 'puente') return next(notFound('El puente del lector no está activado en este servidor (BIOMETRIC_MODE=puente)'));
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ') || !crypto.timingSafeEqual(sha(h.slice(7)), sha(env.BIOMETRIC_PUENTE_TOKEN))) {
    return next(unauthorized('Clave del puente incorrecta'));
  }
  next();
});

puenteRouter.get(
  '/pedidos',
  ah(async (_req, res) => {
    const cerrada = new AbortController();
    res.on('close', () => cerrada.abort());
    const pedidos = await tomarPedidos(cerrada.signal);
    if (!cerrada.signal.aborted) res.json({ pedidos });
  }),
);

puenteRouter.post(
  '/respuestas/:id',
  ah(async (req, res) => {
    const r = parse(
      z.object({ status: z.number().int().min(100).max(599).optional(), contentType: z.string().max(300).optional(), body: z.string().optional(), error: z.string().max(300).optional() }),
      req.body,
    );
    res.json({ ok: entregarRespuesta(req.params.id!, r) });
  }),
);

puenteRouter.post(
  '/evento',
  ah(async (req, res) => {
    const b = parse(z.object({ recibidoEn: z.string().datetime(), evento: z.record(z.unknown()) }), req.body);
    const r = parseHikEvent(b.evento, { recibidoEn: new Date(b.recibidoEn) });
    if (r.kind !== 'event') return void res.json({ ok: true, guardado: false });
    const conocido = isKnownDevice(r.envelope.macAddress ?? null, r.envelope.ipAddress ?? null);
    if (!conocido.ok) {
      // 403 y no 200: el puente lo conserva mientras se corrige la configuración
      return void res.status(403).json({ ok: false, message: conocido.reason });
    }
    const out = await registrarEventoAcceso(r.event);
    anotarEvento('puente del gimnasio', out.resultado);
    res.json({ ok: true, guardado: out.registrado, duplicado: out.duplicado, resultado: out.resultado });
  }),
);
