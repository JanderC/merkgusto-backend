import { Router } from 'express';
import multer from 'multer';
import { sql } from 'kysely';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import { ah, badRequest, notFound, parse } from '../../lib/http.js';
import { registrarEventoAcceso } from '../asistencia/asistencia.service.js';
import { accessControl, mockDevice } from './biometric.factory.js';
import { EMPLEADO_PREFIJO, encolarEntrenador, encolarSocio, procesarCola, resumenCola } from './biometric-sync.service.js';
import { isAccessControlError } from './contracts/errors.js';
import { parseHikEvent } from './webhook/webhook.parser.js';
import { isKnownDevice, webhookGuard, webhookStats } from './webhook/webhook.security.js';

// ═════════════════════════════════════════════════════════════════════
//  Webhook público (Listening Host del lector)
//  POST /api/biometric/events/:token
// ═════════════════════════════════════════════════════════════════════
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, fieldSize: 256 * 1024, fields: 10, files: 3 },
});

let ultimoEvento: { at: string; ip: string; resultado: string } | null = null;

export const biometricWebhookRouter = Router();

biometricWebhookRouter.post(
  '/events/:token',
  webhookGuard,
  upload.any(), // la foto "Picture" se recibe en memoria y se descarta
  ah(async (req, res) => {
    const ip = (req as typeof req & { sourceIp?: string }).sourceIp ?? '';
    const r = parseHikEvent(req.body);
    if (r.kind === 'invalid') {
      console.warn(`⚠ [Webhook biométrico] Evento inválido desde ${ip}: ${r.reason}`);
      return res.status(400).json({ ok: false });
    }
    if (r.kind === 'ignored') return res.json({ ok: true }); // heartBeat y demás

    const known = isKnownDevice(r.envelope.macAddress ?? null, r.envelope.ipAddress ?? null);
    if (!known.ok) {
      console.warn(`🛡  [Webhook biométrico] Dispositivo desconocido desde ${ip}: ${known.reason}`);
      return res.status(403).json({ ok: false });
    }

    try {
      const out = await registrarEventoAcceso(r.event);
      ultimoEvento = { at: new Date().toISOString(), ip, resultado: out.resultado };
      // 200 rápido: si no, el lector reintenta (la idempotencia evita duplicados)
      res.json({ ok: true });
    } catch (e) {
      console.error('✗ [Webhook biométrico] No se pudo guardar el evento:', (e as Error).message);
      // 503 → el lector conserva el evento y lo reenvía más tarde
      res.status(503).json({ ok: false });
    }
  }),
);

// ═════════════════════════════════════════════════════════════════════
//  Lector para la recepción (cualquier usuario con sesión)  /api/lector/*
// ═════════════════════════════════════════════════════════════════════
export const lectorRouter = Router();
let capturando = false;

/** Pide al lector que tome la foto del rostro de quien está frente a él. */
lectorRouter.post(
  '/capturar-rostro',
  ah(async (_req, res) => {
    if (accessControl.mode === 'disabled') throw badRequest('El lector está desactivado (BIOMETRIC_MODE=disabled)');
    if (capturando) throw badRequest('El lector está tomando otra foto. Espera unos segundos.');
    capturando = true;
    try {
      const foto = await accessControl.captureFace();
      res.json({ foto, origen: accessControl.mode === 'mock' ? 'simulado' : 'lector' });
    } catch (e) {
      if (isAccessControlError(e)) throw badRequest(e.code === 'TIMEOUT' || e.code === 'UNREACHABLE' || e.code === 'CIRCUIT_OPEN' ? `No hay conexión con el lector: ${e.message}` : e.message);
      throw e;
    } finally {
      capturando = false;
    }
  }),
);

// ═════════════════════════════════════════════════════════════════════
//  Administración (solo dueño)  /api/biometric/*
// ═════════════════════════════════════════════════════════════════════
export const biometricAdminRouter = Router();

biometricAdminRouter.get(
  '/status',
  ah(async (_req, res) => {
    const status = await accessControl.getStatus();
    const mock = mockDevice();
    res.json({
      ...status,
      webhook: {
        path: '/api/biometric/events/<token>',
        publicUrlConfigurada: Boolean(env.BIOMETRIC_PUBLIC_URL),
        ipsPermitidas: env.BIOMETRIC_ALLOWED_IPS.length ? env.BIOMETRIC_ALLOWED_IPS : ['LAN privada (por defecto)'],
        macsPermitidas: env.BIOMETRIC_DEVICE_MACS,
        rechazos: webhookStats.rechazos,
        ultimoEvento,
      },
      cola: await resumenCola(),
      decision: env.BIOMETRIC_DECISION,
      simulador: mock ? { desconectado: mock.isOffline, usuarios: mock.listUsers().length, verificacionRemota: mock.verificacionRemota } : null,
    });
  }),
);

biometricAdminRouter.get(
  '/cola',
  ah(async (req, res) => {
    const estado = z.enum(['pendiente', 'error', 'descartado', 'ok', 'todos']).catch('todos').parse(req.query.estado);
    let q = db
      .selectFrom('bioCola as c')
      .leftJoin('socios as s', 's.id', 'c.socioId')
      .select([
        'c.id',
        'c.operacion',
        'c.estado',
        'c.intentos',
        'c.proximoIntento',
        'c.ultimoError',
        'c.creadoEn',
        'c.actualizadoEn',
        's.id as socioId',
        's.codigo',
        sql<string>`s.nombre || ' ' || s.apellido`.as('socio'),
      ])
      .orderBy('c.id', 'desc')
      .limit(100);
    if (estado !== 'todos') q = q.where('c.estado', '=', estado);
    res.json(await q.execute());
  }),
);

biometricAdminRouter.post(
  '/cola/reintentar',
  ah(async (_req, res) => {
    const r = await db
      .updateTable('bioCola')
      .set({ estado: 'pendiente', intentos: 0, proximoIntento: sql`now()` as never })
      .where('estado', 'in', ['error', 'descartado'])
      .where('creadoEn', '>', sql<Date>`now() - interval '7 days'`)
      .executeTakeFirst();
    const out = await procesarCola();
    res.json({ reencoladas: Number(r.numUpdatedRows), ...out });
  }),
);

biometricAdminRouter.post(
  '/socios/:id/sync',
  ah(async (req, res) => {
    const s = await db.selectFrom('socios').select(['id']).where('id', '=', req.params.id!).executeTakeFirst();
    if (!s) throw notFound('Cliente no encontrado');
    await db.updateTable('socios').set({ bioEstado: sql`case when foto is null then 'sin_rostro' else 'pendiente' end` as never }).where('id', '=', s.id).execute();
    await encolarSocio(s.id);
    res.json({ ok: true });
  }),
);

/** Re-sincroniza a TODOS los socios activos (p. ej. al instalar el lector real). */
biometricAdminRouter.post(
  '/sync-total',
  ah(async (_req, res) => {
    const socios = await db.selectFrom('socios').select(['id']).where('activo', '=', true).execute();
    await db.updateTable('socios').set({ bioEstado: sql`case when foto is null then 'sin_rostro' else 'pendiente' end` as never }).where('activo', '=', true).execute();
    for (const s of socios) await encolarSocio(s.id);
    const ents = await db.selectFrom('entrenadores').select('id').execute();
    await db.updateTable('entrenadores').set({ bioEstado: sql`case when foto is null then 'sin_rostro' else 'pendiente' end` as never }).where('activo', '=', true).execute();
    for (const e of ents) await encolarEntrenador(e.id);
    res.json({ encolados: socios.length + ents.length });
  }),
);

/** Configura en el lector el Listening Host que apunta a nuestro webhook. */
biometricAdminRouter.post(
  '/listener',
  ah(async (_req, res) => {
    if (!env.BIOMETRIC_PUBLIC_URL) throw badRequest('Configura BIOMETRIC_PUBLIC_URL (ej. http://192.168.1.10:5050) en el .env');
    const url = `${env.BIOMETRIC_PUBLIC_URL.replace(/\/+$/, '')}/api/biometric/events/${env.BIOMETRIC_WEBHOOK_TOKEN}`;
    try {
      await accessControl.configureEventListener(url);
    } catch (e) {
      if (isAccessControlError(e)) throw badRequest(e.message);
      throw e;
    }
    res.json({ ok: true, url: url.replace(env.BIOMETRIC_WEBHOOK_TOKEN, '••••••') });
  }),
);

/** Activa en el lector la verificación remota (el sistema decide quién entra). */
biometricAdminRouter.post(
  '/verificacion-remota',
  ah(async (req, res) => {
    const { activar } = parse(z.object({ activar: z.boolean() }), req.body);
    try {
      await accessControl.configureRemoteVerification(activar);
    } catch (e) {
      if (isAccessControlError(e)) throw badRequest(e.message);
      throw e;
    }
    res.json({ ok: true, activar });
  }),
);

// ── Herramientas del simulador (solo BIOMETRIC_MODE=mock) ──
const soloMock = () => {
  const m = mockDevice();
  if (!m) throw badRequest('Disponible solo con BIOMETRIC_MODE=mock');
  return m;
};

biometricAdminRouter.get(
  '/simulador/usuarios',
  ah(async (_req, res) => {
    res.json(soloMock().listUsers());
  }),
);

biometricAdminRouter.post(
  '/simulador/conexion',
  ah(async (req, res) => {
    const { desconectado } = parse(z.object({ desconectado: z.boolean() }), req.body);
    const m = soloMock();
    m.setOffline(desconectado);
    if (!desconectado) {
      await m.getStatus();
      void procesarCola();
    }
    res.json({ desconectado: m.isOffline });
  }),
);

/**
 * Simula a un socio frente al lector: genera el payload REAL de Hikvision y lo
 * pasa por el mismo parser + procesador del webhook.
 */
biometricAdminRouter.post(
  '/simulador/escanear',
  ah(async (req, res) => {
    const { socioId, entrenadorId, desconocido } = parse(
      z.object({ socioId: z.string().uuid().optional(), entrenadorId: z.string().uuid().optional(), desconocido: z.boolean().optional() }),
      req.body,
    );
    const m = soloMock();
    let employeeNo: string | null = null;
    if (!desconocido) {
      if (entrenadorId) {
        const e = await db.selectFrom('entrenadores').select('codigo').where('id', '=', entrenadorId).executeTakeFirst();
        if (!e) throw notFound('Entrenador no encontrado');
        employeeNo = `${EMPLEADO_PREFIJO}${e.codigo}`;
      } else {
        if (!socioId) throw badRequest('Elige un cliente o entrenador');
        const s = await db.selectFrom('socios').select('codigo').where('id', '=', socioId).executeTakeFirst();
        if (!s) throw notFound('Cliente no encontrado');
        employeeNo = String(s.codigo);
      }
    }
    let payload: Record<string, unknown>;
    try {
      payload = m.simulateScan(employeeNo);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    // Igual que el multipart real: el JSON llega como texto en "event_log"
    const r = parseHikEvent({ event_log: JSON.stringify(payload) }, { simulated: true });
    if (r.kind !== 'event') throw badRequest(`Evento no procesable: ${r.reason}`);
    const out = await registrarEventoAcceso(r.event);
    // Qué hizo la puerta: con verificación remota, lo que respondió el sistema; si no, lo que decidió el lector
    const serial = r.event.serialNo ?? -1;
    const decision = m.decisiones.get(serial);
    const puerta = r.event.remoteCheck ? (decision?.allowed ? 'abierta' : 'cerrada') : r.event.verdict === 'granted' ? 'abierta' : 'cerrada';
    res.json({ payload, resultado: out, puerta, pantallaLector: decision?.info ?? null, verificacionRemota: r.event.remoteCheck });
  }),
);
