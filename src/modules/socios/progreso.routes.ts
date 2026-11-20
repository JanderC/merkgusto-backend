/**
 * Progreso del cliente (medidas), su rutina, su entrenador y su acceso a la app.
 *   /api/socios/:id/progreso …   (equipo con sesión)
 *   /api/portal/:token           (público: el enlace personal del cliente, solo lectura)
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { ah, badRequest, HttpError, notFound, parse } from '../../lib/http.js';
import { hoy } from '../../lib/util.js';
import { usuarioActual } from '../../middleware/auth.js';
import { crearRutina, datosCliente, editarRutina, entrenos, generarEnlace, hash, mediciones, medicionSchema, rutinas, rutinaSchema, socioExiste } from './progreso.service.js';

export const progresoRouter = Router();

progresoRouter.get(
  '/:id/progreso',
  ah(async (req, res) => {
    const s = await socioExiste(req.params.id!);
    const [m, r, ent, entrenadores] = await Promise.all([
      mediciones(s.id),
      rutinas(s.id),
      entrenos(s.id),
      db.selectFrom('entrenadores').select(['id', 'nombre', 'apellido', 'especialidad']).where('activo', '=', true).orderBy('nombre').execute(),
    ]);
    res.json({
      mediciones: m,
      rutinas: r,
      entrenos: { racha: ent.racha, estaSemana: ent.estaSemana, ultimo: ent.lista[0]?.fecha ?? null },
      portal: { activo: !!s.portalTokenHash, creadoEn: s.portalCreadoEn },
      app: { clave: !!s.claveHash, ultimoAcceso: s.appUltimoAcceso },
      entrenadorId: s.entrenadorId,
      entrenadores,
    });
  }),
);

progresoRouter.post(
  '/:id/mediciones',
  ah(async (req, res) => {
    const s = await socioExiste(req.params.id!);
    const b = parse(medicionSchema, req.body);
    if (b.fecha && b.fecha > hoy()) throw badRequest('La fecha no puede ser futura');
    const r = await db
      .insertInto('socioMediciones')
      .values({ ...b, fecha: b.fecha ?? hoy(), socioId: s.id, registradoPor: usuarioActual(req).id, autor: 'equipo' })
      .returning('id')
      .executeTakeFirstOrThrow();
    res.status(201).json(r);
  }),
);

progresoRouter.delete(
  '/:id/mediciones/:mid',
  ah(async (req, res) => {
    const r = await db.deleteFrom('socioMediciones').where('id', '=', Number(req.params.mid)).where('socioId', '=', req.params.id!).executeTakeFirst();
    if (!Number(r.numDeletedRows)) throw notFound('Medición no encontrada');
    res.json({ ok: true });
  }),
);

progresoRouter.post(
  '/:id/rutinas',
  ah(async (req, res) => {
    const s = await socioExiste(req.params.id!);
    res.status(201).json(await crearRutina(s.id, parse(rutinaSchema, req.body), 'equipo', usuarioActual(req).id));
  }),
);

progresoRouter.put(
  '/:id/rutinas/:rid',
  ah(async (req, res) => {
    const b = parse(rutinaSchema.partial().extend({ activa: z.boolean().optional() }), req.body);
    res.json(await editarRutina(req.params.id!, Number(req.params.rid), b));
  }),
);

/** Entrenador que atiende al cliente (lo ve en su app). */
progresoRouter.put(
  '/:id/entrenador',
  ah(async (req, res) => {
    const s = await socioExiste(req.params.id!);
    const { entrenadorId } = parse(z.object({ entrenadorId: z.string().uuid().nullable() }), req.body);
    if (entrenadorId) {
      const e = await db.selectFrom('entrenadores').select('id').where('id', '=', entrenadorId).where('activo', '=', true).executeTakeFirst();
      if (!e) throw badRequest('Entrenador no encontrado');
    }
    await db.updateTable('socios').set({ entrenadorId }).where('id', '=', s.id).execute();
    await db.insertInto('auditoria').values({ usuarioId: usuarioActual(req).id, accion: 'socio.entrenador', detalle: JSON.stringify({ socioId: s.id, entrenadorId }) }).execute();
    res.json({ ok: true });
  }),
);

/** El cliente olvidó su clave: se quita (vuelve a entrar con su cédula) y se cierran sus sesiones. */
progresoRouter.delete(
  '/:id/app-clave',
  ah(async (req, res) => {
    const s = await socioExiste(req.params.id!);
    await db.updateTable('socios').set({ claveHash: null, claveCreadaEn: null, appSesion: s.appSesion + 1 }).where('id', '=', s.id).execute();
    await db.insertInto('auditoria').values({ usuarioId: usuarioActual(req).id, accion: 'socio.app_clave_quitada', detalle: JSON.stringify({ socioId: s.id }) }).execute();
    res.json({ ok: true });
  }),
);

const baseUrlSchema = z.string().url().max(200).refine((u) => /^https?:\/\//.test(u), 'URL inválida');

/** Genera (o regenera) el enlace personal del cliente y opcionalmente se lo envía por WhatsApp. */
progresoRouter.post(
  '/:id/portal',
  ah(async (req, res) => {
    const b = parse(z.object({ baseUrl: baseUrlSchema, enviar: z.boolean().default(false) }), req.body);
    res.json(await generarEnlace(req.params.id!, b.baseUrl, b.enviar, { usuarioId: usuarioActual(req).id }));
  }),
);

progresoRouter.delete(
  '/:id/portal',
  ah(async (req, res) => {
    await socioExiste(req.params.id!);
    await db.updateTable('socios').set({ portalTokenHash: null, portalCreadoEn: null }).where('id', '=', req.params.id!).execute();
    res.json({ ok: true });
  }),
);

// ═════════════ Portal público del cliente (compatibilidad: la web ahora abre la app) ═════════════

export const portalRouter = Router();
// Freno a adivinar enlaces: 60 consultas por IP cada 10 minutos
const visitas = new Map<string, number[]>();
export function frenoPorIp(ip: string, max: number, mapa = visitas, ventanaMs = 10 * 60_000) {
  const recientes = (mapa.get(ip) ?? []).filter((t) => Date.now() - t < ventanaMs);
  if (recientes.length >= max) throw new HttpError(429, 'Demasiados intentos. Espera unos minutos.');
  mapa.set(ip, [...recientes, Date.now()]);
  if (mapa.size > 5000) mapa.clear();
}

export async function socioPorEnlace(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw notFound('Enlace no válido');
  const s = await db.selectFrom('socios').select(['id', 'appSesion']).where('portalTokenHash', '=', hash(token)).executeTakeFirst();
  if (!s) throw notFound('Este enlace ya no es válido. Pide uno nuevo a tu entrenador o en recepción.');
  return s;
}

portalRouter.get(
  '/:token',
  ah(async (req, res) => {
    frenoPorIp(req.ip ?? 'x', 60);
    const s = await socioPorEnlace(String(req.params.token ?? ''));
    res.json(await datosCliente(s.id));
  }),
);
