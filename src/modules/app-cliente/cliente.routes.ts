/**
 * App del cliente (web y móvil).
 *
 *  Entrar:
 *   • Con su cédula. Si el cliente activó "información privada" se pide también su clave.
 *   • Con su enlace personal (lo envía el entrenador o la recepción por WhatsApp):
 *     sirve aunque haya olvidado la clave, y desde ahí puede ponerse una nueva.
 *
 *  Adentro: días que le quedan, entradas, clases (puede reservar), progreso (anota su
 *  peso y medidas), su rutina (la del entrenador o una propia) y marca los días hechos.
 */
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { ah, badRequest, conflict, HttpError, notFound, parse, unauthorized } from '../../lib/http.js';
import { hoy, sumarDias } from '../../lib/util.js';
import { socioActual, tokenSocio } from '../../middleware/auth.js';
import { baseClases, cargarClase, coberturas, diaLocal, inscribirEnClase } from '../clases/clases.routes.js';
import { getConfig } from '../configuracion/config.service.js';
import { frenoPorIp, socioPorEnlace } from '../socios/progreso.routes.js';
import { crearRutina, datosCliente, diasSchema, editarRutina, medicionSchema, rutinas, socioExiste } from '../socios/progreso.service.js';

// ═════════════ Entrar (sin sesión) ═════════════
export const clienteAuthRouter = Router();

const intentosIp = new Map<string, number[]>();
const fallosClave = new Map<string, { n: number; t: number }>();
const claveSchema = z.string().min(4, 'La clave debe tener al menos 4 caracteres').max(30, 'Máximo 30 caracteres');

/** Busca al cliente por su cédula: acepta "V-12.345.678", "v12345678" o "12345678". */
async function socioPorCedula(texto: string) {
  const limpia = texto.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  const digitos = limpia.replace(/\D/g, '');
  if (digitos.length < 5) throw badRequest('Escribe tu cédula completa');
  const filas = await db
    .selectFrom('socios')
    .select(['id', 'cedula', 'nombre', 'activo', 'claveHash', 'appSesion'])
    .where(sql`regexp_replace(coalesce(cedula, ''), '[^0-9]', '', 'g')`, '=', digitos)
    .execute();
  const exactas = filas.filter((f) => f.cedula === limpia);
  const s = filas.length === 1 ? filas[0] : exactas.length === 1 ? exactas[0] : null;
  if (!filas.length) throw notFound('No encontramos esa cédula. Si ya eres cliente, pide en recepción que la registren.');
  if (!s) throw conflict('Escribe tu cédula con la letra (V o E) delante');
  return s;
}

clienteAuthRouter.get(
  '/gym',
  ah(async (_req, res) => {
    const g = await getConfig('gym');
    res.json({ nombre: g.nombre, slogan: g.slogan });
  }),
);

clienteAuthRouter.post(
  '/entrar',
  ah(async (req, res) => {
    frenoPorIp(req.ip ?? 'x', 20, intentosIp, 10 * 60_000);
    const b = parse(z.object({ cedula: z.string().trim().min(1, 'Escribe tu cédula').max(30), clave: z.string().max(30).optional() }), req.body);
    const s = await socioPorCedula(b.cedula);
    if (s.claveHash) {
      if (!b.clave) throw new HttpError(401, 'Tu información es privada: escribe tu clave', { requiereClave: true, nombre: s.nombre });
      const f = fallosClave.get(s.id);
      if (f && f.n >= 6 && Date.now() - f.t < 15 * 60_000) throw new HttpError(429, 'Demasiados intentos. Espera 15 minutos o entra con tu enlace personal.');
      if (!(await bcrypt.compare(b.clave, s.claveHash))) {
        fallosClave.set(s.id, { n: (f && Date.now() - f.t < 15 * 60_000 ? f.n : 0) + 1, t: Date.now() });
        throw new HttpError(401, 'Clave incorrecta', { requiereClave: true, nombre: s.nombre });
      }
      fallosClave.delete(s.id);
    }
    await db.updateTable('socios').set({ appUltimoAcceso: new Date() }).where('id', '=', s.id).execute();
    res.json({ token: tokenSocio(s, s.claveHash ? 'clave' : 'cedula'), nombre: s.nombre, privado: !!s.claveHash });
  }),
);

/** El enlace personal abre la app sin clave (y permite ponerse una nueva si la olvidó). */
clienteAuthRouter.post(
  '/enlace',
  ah(async (req, res) => {
    frenoPorIp(req.ip ?? 'x', 60);
    const { token } = parse(z.object({ token: z.string().max(80) }), req.body);
    const s = await socioPorEnlace(token);
    const d = await db.selectFrom('socios').select(['nombre', 'claveHash']).where('id', '=', s.id).executeTakeFirstOrThrow();
    await db.updateTable('socios').set({ appUltimoAcceso: new Date() }).where('id', '=', s.id).execute();
    res.json({ token: tokenSocio(s, 'enlace'), nombre: d.nombre, privado: !!d.claveHash });
  }),
);

// ═════════════ Con sesión ═════════════
export const clienteRouter = Router();

clienteRouter.get(
  '/yo',
  ah(async (req, res) => {
    const yo = socioActual(req);
    res.json({ ...(await datosCliente(yo.id)), via: yo.via });
  }),
);

// ── Progreso: el cliente anota su peso y medidas ──
clienteRouter.post(
  '/mediciones',
  ah(async (req, res) => {
    const yo = socioActual(req);
    const b = parse(medicionSchema, req.body);
    if (b.fecha && b.fecha > hoy()) throw badRequest('La fecha no puede ser futura');
    const r = await db
      .insertInto('socioMediciones')
      .values({ ...b, fecha: b.fecha ?? hoy(), socioId: yo.id, registradoPor: null, autor: 'cliente' })
      .returning('id')
      .executeTakeFirstOrThrow();
    res.status(201).json(r);
  }),
);

clienteRouter.delete(
  '/mediciones/:mid',
  ah(async (req, res) => {
    const r = await db.deleteFrom('socioMediciones').where('id', '=', Number(req.params.mid)).where('socioId', '=', socioActual(req).id).where('autor', '=', 'cliente').executeTakeFirst();
    if (!Number(r.numDeletedRows)) throw notFound('Solo puedes borrar las medidas que anotaste tú');
    res.json({ ok: true });
  }),
);

// ── Rutinas: la del entrenador o una propia ──
clienteRouter.get(
  '/rutinas',
  ah(async (req, res) => {
    res.json(await rutinas(socioActual(req).id));
  }),
);

const rutinaCliente = z.object({
  titulo: z.string().trim().min(2, 'Ponle un nombre a tu rutina').max(100),
  objetivo: z.string().trim().max(150).nullish().transform((v) => v || null),
  dias: diasSchema,
});

clienteRouter.post(
  '/rutinas',
  ah(async (req, res) => {
    const b = parse(rutinaCliente, req.body);
    res.status(201).json(await crearRutina(socioActual(req).id, { ...b, entrenadorId: null }, 'cliente', null));
  }),
);

clienteRouter.put(
  '/rutinas/:rid',
  ah(async (req, res) => {
    const b = parse(rutinaCliente.partial(), req.body);
    res.json(await editarRutina(socioActual(req).id, Number(req.params.rid), b, 'cliente'));
  }),
);

/** Volver a usar una rutina del historial. */
clienteRouter.post(
  '/rutinas/:rid/activar',
  ah(async (req, res) => {
    res.json(await editarRutina(socioActual(req).id, Number(req.params.rid), { activa: true }));
  }),
);

// ── Entrenos: marca el día de rutina que hizo hoy ──
clienteRouter.post(
  '/entrenos',
  ah(async (req, res) => {
    const yo = socioActual(req);
    const b = parse(z.object({ dia: z.string().trim().min(1).max(80), rutinaId: z.number().int().positive().nullish(), nota: z.string().trim().max(200).nullish() }), req.body);
    if (b.rutinaId) {
      const r = await db.selectFrom('socioRutinas').select('id').where('id', '=', b.rutinaId).where('socioId', '=', yo.id).executeTakeFirst();
      if (!r) throw notFound('Rutina no encontrada');
    }
    const r = await db
      .insertInto('socioEntrenos')
      .values({ socioId: yo.id, fecha: hoy(), dia: b.dia, rutinaId: b.rutinaId ?? null, nota: b.nota || null })
      .onConflict((oc) => oc.columns(['socioId', 'fecha', 'dia']).doNothing())
      .returning('id')
      .executeTakeFirst();
    res.status(201).json({ ok: true, id: r?.id ?? null });
  }),
);

clienteRouter.delete(
  '/entrenos',
  ah(async (req, res) => {
    const { dia } = parse(z.object({ dia: z.string().max(80) }), req.query);
    await db.deleteFrom('socioEntrenos').where('socioId', '=', socioActual(req).id).where('fecha', '=', hoy()).where('dia', '=', dia).execute();
    res.json({ ok: true });
  }),
);

// ── Clases: ver la semana y reservar ──
clienteRouter.get(
  '/clases',
  ah(async (req, res) => {
    const yo = socioActual(req);
    const desde = hoy();
    const lista = await baseClases()
      .where(diaLocal, '>=', desde)
      .where(diaLocal, '<=', sumarDias(desde, 7))
      .where('c.estado', '=', 'programada')
      .where('c.inicio', '>', sql<Date>`now() - interval '30 minutes'`)
      .orderBy('c.inicio')
      .limit(60)
      .execute();
    const mias = lista.length
      ? await db.selectFrom('claseInscritos').select(['claseId', 'reservadoPorSocio', 'asistioEn']).where('socioId', '=', yo.id).where('claseId', 'in', lista.map((c) => c.id)).execute()
      : [];
    const m = new Map(mias.map((x) => [x.claseId, x]));
    res.json(
      lista.map((c) => ({
        id: c.id,
        nombre: c.nombre,
        descripcion: c.descripcion,
        dia: c.dia,
        hora: c.hora,
        inicio: c.inicio,
        duracionMin: c.duracionMin,
        color: c.color,
        nivel: c.nivel,
        caracteristicas: c.caracteristicas,
        entrenador: c.entrenador,
        cupo: c.cupo,
        inscritos: c.inscritos,
        libres: c.cupo ? Math.max(0, c.cupo - c.inscritos) : null,
        inscrito: m.has(c.id),
        reservadoPorMi: !!m.get(c.id)?.reservadoPorSocio,
        asistio: !!m.get(c.id)?.asistioEn,
      })),
    );
  }),
);

clienteRouter.post(
  '/clases/:id/reservar',
  ah(async (req, res) => {
    const yo = socioActual(req);
    const c = await cargarClase(Number(req.params.id));
    if (c.dia > sumarDias(hoy(), 7)) throw badRequest('Puedes reservar hasta con 7 días de anticipación');
    const cob = (await coberturas([yo.id], c.planId, c.dia)).get(yo.id)!;
    if (cob.acceso === 'sin_mensualidad') throw conflict('Para reservar necesitas un plan vigente ese día. Renueva en recepción.');
    const r = await inscribirEnClase(c.id, [yo.id], { socio: true });
    if (!r.agregados) throw conflict('Ya estás inscrito en esta clase');
    res.status(201).json({ ok: true });
  }),
);

clienteRouter.delete(
  '/clases/:id/reservar',
  ah(async (req, res) => {
    const yo = socioActual(req);
    const c = await cargarClase(Number(req.params.id));
    if (new Date(c.inicio).getTime() < Date.now()) throw badRequest('La clase ya empezó');
    const r = await db
      .deleteFrom('claseInscritos')
      .where('claseId', '=', c.id)
      .where('socioId', '=', yo.id)
      .where('reservadoPorSocio', '=', true)
      .where('asistioEn', 'is', null)
      .executeTakeFirst();
    if (!Number(r.numDeletedRows)) throw badRequest('Esta inscripción la hizo tu entrenador o la recepción: pídeles que te quiten');
    res.json({ ok: true });
  }),
);

// ── Privacidad: clave de acceso ──
clienteRouter.post(
  '/clave',
  ah(async (req, res) => {
    const yo = socioActual(req);
    const b = parse(z.object({ nueva: claveSchema, actual: z.string().max(30).optional() }), req.body);
    const s = await socioExiste(yo.id);
    // Con el enlace personal puede ponerse una nueva aunque haya olvidado la anterior
    if (s.claveHash && yo.via !== 'enlace' && !(b.actual && (await bcrypt.compare(b.actual, s.claveHash)))) throw unauthorized('Tu clave actual no es correcta');
    const v = s.appSesion + 1;
    await db.updateTable('socios').set({ claveHash: await bcrypt.hash(b.nueva, 10), claveCreadaEn: new Date(), appSesion: v }).where('id', '=', s.id).execute();
    await db.insertInto('auditoria').values({ usuarioId: null, accion: 'socio.app_clave', detalle: JSON.stringify({ socioId: s.id, via: yo.via }) }).execute();
    res.json({ ok: true, token: tokenSocio({ id: s.id, appSesion: v }, yo.via === 'enlace' ? 'enlace' : 'clave') });
  }),
);

/** Quitar la clave: vuelve a entrar solo con su cédula. */
clienteRouter.delete(
  '/clave',
  ah(async (req, res) => {
    const yo = socioActual(req);
    const b = parse(z.object({ actual: z.string().max(30).optional() }), req.body ?? {});
    const s = await socioExiste(yo.id);
    if (!s.claveHash) return void res.json({ ok: true, token: null });
    if (yo.via !== 'enlace' && !(b.actual && (await bcrypt.compare(b.actual, s.claveHash)))) throw unauthorized('Tu clave actual no es correcta');
    const v = s.appSesion + 1;
    await db.updateTable('socios').set({ claveHash: null, claveCreadaEn: null, appSesion: v }).where('id', '=', s.id).execute();
    res.json({ ok: true, token: tokenSocio({ id: s.id, appSesion: v }, yo.via === 'enlace' ? 'enlace' : 'cedula') });
  }),
);

/** Cerrar la sesión en todos los teléfonos y computadoras. */
clienteRouter.post(
  '/salir-de-todo',
  ah(async (req, res) => {
    const s = await socioExiste(socioActual(req).id);
    await db.updateTable('socios').set({ appSesion: s.appSesion + 1 }).where('id', '=', s.id).execute();
    res.json({ ok: true });
  }),
);
