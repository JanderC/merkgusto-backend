/**
 * Progreso del cliente (medidas), su rutina y su portal personal.
 *   /api/socios/:id/progreso …   (equipo con sesión)
 *   /api/portal/:token           (público: el enlace personal del cliente, solo lectura)
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../db/index.js';
import type { DiaRutina } from '../../db/types.js';
import { ah, badRequest, HttpError, notFound, parse } from '../../lib/http.js';
import { fmt } from '../../lib/monedas.js';
import { hoy } from '../../lib/util.js';
import { usuarioActual } from '../../middleware/auth.js';
import { getConfig } from '../configuracion/config.service.js';
import { vigenciaSocio } from '../membresias/membresias.service.js';
import { whatsapp } from '../whatsapp/whatsapp.service.js';

export const progresoRouter = Router();
const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const medida = (max: number) => z.number().min(0).max(max).nullish().transform((v) => v ?? null);

async function socioExiste(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Cliente no encontrado');
  const s = await db.selectFrom('socios').select(['id', 'nombre', 'apellido', 'telefono', 'portalTokenHash', 'portalCreadoEn']).where('id', '=', id).executeTakeFirst();
  if (!s) throw notFound('Cliente no encontrado');
  return s;
}

async function mediciones(socioId: string) {
  const rows = await db.selectFrom('socioMediciones').selectAll().where('socioId', '=', socioId).orderBy('fecha', 'desc').orderBy('id', 'desc').limit(60).execute();
  const n = (v: unknown) => (v == null ? null : Number(v));
  return rows.map((m) => ({
    id: m.id,
    fecha: m.fecha,
    peso: n(m.peso),
    grasa: n(m.grasa),
    musculo: n(m.musculo),
    cintura: n(m.cintura),
    cadera: n(m.cadera),
    pecho: n(m.pecho),
    brazo: n(m.brazo),
    pierna: n(m.pierna),
    nota: m.nota,
  }));
}

async function rutinas(socioId: string, soloActiva = false) {
  let q = db
    .selectFrom('socioRutinas as r')
    .leftJoin('entrenadores as e', 'e.id', 'r.entrenadorId')
    .select(['r.id', 'r.titulo', 'r.objetivo', 'r.dias', 'r.activa', 'r.entrenadorId', 'r.actualizadoEn', sql<string | null>`nullif(trim(e.nombre || ' ' || e.apellido), '')`.as('entrenador')])
    .where('r.socioId', '=', socioId)
    .orderBy('r.activa', 'desc')
    .orderBy('r.actualizadoEn', 'desc')
    .limit(20);
  if (soloActiva) q = q.where('r.activa', '=', true);
  return q.execute();
}

progresoRouter.get(
  '/:id/progreso',
  ah(async (req, res) => {
    const s = await socioExiste(req.params.id!);
    const [m, r] = await Promise.all([mediciones(s.id), rutinas(s.id)]);
    res.json({ mediciones: m, rutinas: r, portal: { activo: !!s.portalTokenHash, creadoEn: s.portalCreadoEn } });
  }),
);

const medicionSchema = z
  .object({
    fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    peso: medida(400),
    grasa: medida(80),
    musculo: medida(80),
    cintura: medida(300),
    cadera: medida(300),
    pecho: medida(300),
    brazo: medida(150),
    pierna: medida(200),
    nota: z.string().trim().max(300).nullish().transform((v) => v || null),
  })
  .refine((m) => [m.peso, m.grasa, m.musculo, m.cintura, m.cadera, m.pecho, m.brazo, m.pierna].some((v) => v != null), 'Anota al menos una medida');

progresoRouter.post(
  '/:id/mediciones',
  ah(async (req, res) => {
    const s = await socioExiste(req.params.id!);
    const b = parse(medicionSchema, req.body);
    if (b.fecha && b.fecha > hoy()) throw badRequest('La fecha no puede ser futura');
    const r = await db
      .insertInto('socioMediciones')
      .values({ ...b, fecha: b.fecha ?? hoy(), socioId: s.id, registradoPor: usuarioActual(req).id })
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

const texto = (max: number) => z.string().trim().max(max).default('');
const rutinaSchema = z.object({
  titulo: z.string().trim().min(2, 'Ponle un nombre a la rutina').max(100),
  objetivo: z.string().trim().max(150).nullish().transform((v) => v || null),
  entrenadorId: z.string().uuid().nullish().transform((v) => v ?? null),
  dias: z
    .array(
      z.object({
        nombre: z.string().trim().min(1, 'Cada día necesita un nombre').max(80),
        ejercicios: z.array(z.object({ nombre: z.string().trim().min(1).max(80), series: texto(10), reps: texto(20), nota: texto(120) })).max(30),
      }),
    )
    .min(1, 'Agrega al menos un día')
    .max(7),
});

progresoRouter.post(
  '/:id/rutinas',
  ah(async (req, res) => {
    const s = await socioExiste(req.params.id!);
    const b = parse(rutinaSchema, req.body);
    const r = await db.transaction().execute(async (trx) => {
      // Una sola rutina activa: la nueva reemplaza a la anterior (queda en el historial)
      await trx.updateTable('socioRutinas').set({ activa: false }).where('socioId', '=', s.id).where('activa', '=', true).execute();
      return trx
        .insertInto('socioRutinas')
        .values({ socioId: s.id, titulo: b.titulo, objetivo: b.objetivo, entrenadorId: b.entrenadorId, dias: JSON.stringify(b.dias satisfies DiaRutina[]), creadoPor: usuarioActual(req).id, actualizadoEn: new Date() })
        .returning('id')
        .executeTakeFirstOrThrow();
    });
    res.status(201).json(r);
  }),
);

progresoRouter.put(
  '/:id/rutinas/:rid',
  ah(async (req, res) => {
    const b = parse(rutinaSchema.partial().extend({ activa: z.boolean().optional() }), req.body);
    const { dias, ...rest } = b;
    const id = Number(req.params.rid);
    const r = await db.transaction().execute(async (trx) => {
      if (b.activa) await trx.updateTable('socioRutinas').set({ activa: false }).where('socioId', '=', req.params.id!).where('id', '!=', id).execute();
      return trx
        .updateTable('socioRutinas')
        .set({ ...rest, ...(dias && { dias: JSON.stringify(dias) }), actualizadoEn: new Date() })
        .where('id', '=', id)
        .where('socioId', '=', req.params.id!)
        .returning('id')
        .executeTakeFirst();
    });
    if (!r) throw notFound('Rutina no encontrada');
    res.json({ ok: true });
  }),
);

/** Genera (o regenera) el enlace personal del cliente y opcionalmente se lo envía por WhatsApp. */
progresoRouter.post(
  '/:id/portal',
  ah(async (req, res) => {
    const s = await socioExiste(req.params.id!);
    const b = parse(z.object({ baseUrl: z.string().url().max(200).refine((u) => /^https?:\/\//.test(u), 'URL inválida'), enviar: z.boolean().default(false) }), req.body);
    const token = crypto.randomBytes(24).toString('base64url');
    await db.updateTable('socios').set({ portalTokenHash: hash(token), portalCreadoEn: new Date() }).where('id', '=', s.id).execute();
    const url = `${b.baseUrl.replace(/\/+$/, '')}/socio/${token}`;
    let enviado = false;
    let error: string | null = null;
    if (b.enviar) {
      try {
        if (!s.telefono) throw new Error('El cliente no tiene teléfono');
        const gym = await getConfig('gym');
        await whatsapp.enviar(s.telefono, `Hola ${s.nombre} 💪\nEste es tu enlace personal de ${gym.nombre}: ahí ves tu plan, tus asistencias, tu progreso y tu rutina.\n\n${url}\n\nNo lo compartas: es solo para ti.`, 'manual');
        enviado = true;
      } catch (e) {
        error = (e as Error).message;
      }
    }
    await db.insertInto('auditoria').values({ usuarioId: usuarioActual(req).id, accion: 'socio.portal_enlace', detalle: JSON.stringify({ socioId: s.id, enviado }) }).execute();
    res.json({ url, enviado, error });
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

// ═════════════ Portal público del cliente ═════════════

export const portalRouter = Router();
// Freno a adivinar enlaces: 60 consultas por IP cada 10 minutos
const visitas = new Map<string, number[]>();

portalRouter.get(
  '/:token',
  ah(async (req, res) => {
    const ip = req.ip ?? 'x';
    const recientes = (visitas.get(ip) ?? []).filter((t) => Date.now() - t < 10 * 60_000);
    if (recientes.length >= 60) throw new HttpError(429, 'Demasiadas consultas. Intenta en unos minutos.');
    visitas.set(ip, [...recientes, Date.now()]);
    if (visitas.size > 5000) visitas.clear();

    const token = String(req.params.token ?? '');
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw notFound('Enlace no válido');
    const s = await db.selectFrom('socios').select(['id', 'codigo', 'nombre', 'apellido', 'activo']).where('portalTokenHash', '=', hash(token)).executeTakeFirst();
    if (!s) throw notFound('Este enlace ya no es válido. Pide uno nuevo en recepción.');

    const [vigencia, membresias, asistencias, clases, med, rut, deudas, gym] = await Promise.all([
      vigenciaSocio(s.id),
      db
        .selectFrom('membresias as m')
        .innerJoin('planes as p', 'p.id', 'm.planId')
        .select(['m.id', 'p.nombre as plan', 'p.color', 'm.fechaInicio', 'm.fechaFin', 'm.estado'])
        .where('m.socioId', '=', s.id)
        .where('m.estado', '!=', 'anulada')
        .orderBy('m.fechaFin', 'desc')
        .limit(6)
        .execute(),
      db
        .selectFrom('asistencias')
        .select(['fechaHora', 'resultado'])
        .where('socioId', '=', s.id)
        .where('resultado', '=', 'permitido')
        .orderBy('fechaHora', 'desc')
        .limit(60)
        .execute(),
      db
        .selectFrom('claseInscritos as i')
        .innerJoin('clases as c', 'c.id', 'i.claseId')
        .leftJoin('entrenadores as e', 'e.id', 'c.entrenadorId')
        .select(['c.id', 'c.nombre', 'c.inicio', 'c.duracionMin', 'c.color', sql<string | null>`nullif(trim(e.nombre || ' ' || e.apellido), '')`.as('entrenador')])
        .where('i.socioId', '=', s.id)
        .where('c.estado', '=', 'programada')
        .where('c.inicio', '>=', new Date())
        .orderBy('c.inicio')
        .limit(10)
        .execute(),
      mediciones(s.id),
      rutinas(s.id, true),
      db.selectFrom('deudas').select(['moneda', 'saldo']).where('socioId', '=', s.id).where('estado', '=', 'pendiente').execute(),
      getConfig('gym'),
    ]);
    const mes = hoy().slice(0, 7);
    res.json({
      socio: { nombre: s.nombre, apellido: s.apellido, codigo: s.codigo, activo: s.activo },
      gym: { nombre: gym.nombre, slogan: gym.slogan, horario: gym.horario, telefono: gym.telefono, instagram: gym.instagram, direccion: gym.direccion },
      vigencia,
      membresias,
      asistencias: { ultimas: asistencias.slice(0, 15).map((a) => a.fechaHora), esteMes: asistencias.filter((a) => new Date(a.fechaHora).toISOString().slice(0, 7) === mes).length, total: asistencias.length },
      clases,
      mediciones: med,
      rutina: rut[0] ?? null,
      deuda: deudas.length ? deudas.map((d) => fmt(Number(d.saldo), d.moneda)).join(' · ') : null,
    });
  }),
);
