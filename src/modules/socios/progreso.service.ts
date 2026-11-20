/**
 * Progreso del cliente (medidas, rutinas, entrenos) y su enlace personal.
 * Lo usan el equipo (ficha del cliente), la app de entrenadores y la app del cliente.
 */
import crypto from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { notFound } from '../../lib/http.js';
import { fmt } from '../../lib/monedas.js';
import { hoy, sumarDias } from '../../lib/util.js';
import { getConfig } from '../configuracion/config.service.js';
import { vigenciaSocio } from '../membresias/membresias.service.js';
import { whatsapp } from '../whatsapp/whatsapp.service.js';

export const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const medida = (max: number) => z.number().min(0).max(max).nullish().transform((v) => v ?? null);

export const medicionSchema = z
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

const texto = (max: number) => z.string().trim().max(max).default('');
export const diasSchema = z
  .array(
    z.object({
      nombre: z.string().trim().min(1, 'Cada día necesita un nombre').max(80),
      ejercicios: z.array(z.object({ nombre: z.string().trim().min(1).max(80), series: texto(10), reps: texto(20), nota: texto(120) })).max(30),
    }),
  )
  .min(1, 'Agrega al menos un día')
  .max(7);
export const rutinaSchema = z.object({
  titulo: z.string().trim().min(2, 'Ponle un nombre a la rutina').max(100),
  objetivo: z.string().trim().max(150).nullish().transform((v) => v || null),
  entrenadorId: z.string().uuid().nullish().transform((v) => v ?? null),
  dias: diasSchema,
});

export async function socioExiste(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Cliente no encontrado');
  const s = await db
    .selectFrom('socios')
    .select(['id', 'codigo', 'nombre', 'apellido', 'telefono', 'activo', 'portalTokenHash', 'portalCreadoEn', 'entrenadorId', 'claveHash', 'appUltimoAcceso', 'appSesion'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!s) throw notFound('Cliente no encontrado');
  return s;
}

const n = (v: unknown) => (v == null ? null : Number(v));

export async function mediciones(socioId: string) {
  const rows = await db
    .selectFrom('socioMediciones as m')
    .leftJoin('entrenadores as e', 'e.id', 'm.entrenadorId')
    .selectAll('m')
    .select(sql<string | null>`nullif(trim(e.nombre || ' ' || e.apellido), '')`.as('entrenador'))
    .where('m.socioId', '=', socioId)
    .orderBy('m.fecha', 'desc')
    .orderBy('m.id', 'desc')
    .limit(80)
    .execute();
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
    autor: m.autor,
    entrenador: m.entrenador,
  }));
}

export async function rutinas(socioId: string, soloActiva = false) {
  let q = db
    .selectFrom('socioRutinas as r')
    .leftJoin('entrenadores as e', 'e.id', 'r.entrenadorId')
    .select(['r.id', 'r.titulo', 'r.objetivo', 'r.dias', 'r.activa', 'r.entrenadorId', 'r.actualizadoEn', 'r.autor', sql<string | null>`nullif(trim(e.nombre || ' ' || e.apellido), '')`.as('entrenador')])
    .where('r.socioId', '=', socioId)
    .orderBy('r.activa', 'desc')
    .orderBy('r.actualizadoEn', 'desc')
    .limit(20);
  if (soloActiva) q = q.where('r.activa', '=', true);
  return q.execute();
}

/** Nueva rutina: reemplaza a la activa (que queda en el historial). */
export async function crearRutina(socioId: string, b: z.infer<typeof rutinaSchema>, autor: 'equipo' | 'entrenador' | 'cliente', creadoPor: string | null) {
  return db.transaction().execute(async (trx) => {
    await trx.updateTable('socioRutinas').set({ activa: false }).where('socioId', '=', socioId).where('activa', '=', true).execute();
    return trx
      .insertInto('socioRutinas')
      .values({ socioId, titulo: b.titulo, objetivo: b.objetivo, entrenadorId: b.entrenadorId, dias: JSON.stringify(b.dias), creadoPor, autor, actualizadoEn: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow();
  });
}

export async function editarRutina(socioId: string, id: number, b: Partial<z.infer<typeof rutinaSchema>> & { activa?: boolean }, soloAutor?: 'entrenador' | 'cliente', entrenadorId?: string) {
  const { dias, ...rest } = b;
  return db.transaction().execute(async (trx) => {
    let q = trx.selectFrom('socioRutinas').select(['id', 'autor', 'entrenadorId']).where('id', '=', id).where('socioId', '=', socioId);
    if (soloAutor === 'cliente') q = q.where('autor', '=', 'cliente');
    if (soloAutor === 'entrenador') q = q.where((eb) => eb.or([eb('entrenadorId', '=', entrenadorId!), eb('entrenadorId', 'is', null)]));
    const r = await q.executeTakeFirst();
    if (!r) throw notFound('Rutina no encontrada');
    if (b.activa) await trx.updateTable('socioRutinas').set({ activa: false }).where('socioId', '=', socioId).where('id', '!=', id).execute();
    await trx
      .updateTable('socioRutinas')
      .set({ ...rest, ...(dias && { dias: JSON.stringify(dias) }), actualizadoEn: new Date() })
      .where('id', '=', id)
      .execute();
    return { ok: true };
  });
}

/** Días de rutina marcados como hechos y la racha de semanas seguidas entrenando. */
export async function entrenos(socioId: string) {
  const rows = await db.selectFrom('socioEntrenos').select(['id', 'fecha', 'dia', 'rutinaId', 'nota']).where('socioId', '=', socioId).orderBy('fecha', 'desc').orderBy('id', 'desc').limit(120).execute();
  const h = hoy();
  const semana = (f: string) => {
    const d = new Date(`${f}T12:00:00`);
    const lunes = new Date(d);
    lunes.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return lunes.toISOString().slice(0, 10);
  };
  const semanas = new Set(rows.map((r) => semana(r.fecha)));
  let racha = 0;
  let s = semana(h);
  if (!semanas.has(s)) s = sumarDias(s, -7); // la semana actual aún puede completarse
  while (semanas.has(s)) {
    racha++;
    s = sumarDias(s, -7);
  }
  return {
    lista: rows.slice(0, 40),
    hoy: rows.filter((r) => r.fecha === h).map((r) => r.dia),
    estaSemana: rows.filter((r) => semana(r.fecha) === semana(h)).length,
    racha,
  };
}

/** Genera (o regenera) el enlace personal del cliente y opcionalmente se lo envía por WhatsApp. */
export async function generarEnlace(socioId: string, baseUrl: string, enviar: boolean, quien: { usuarioId?: string | null; entrenador?: { id: string; nombre: string } }) {
  const s = await socioExiste(socioId);
  const token = crypto.randomBytes(24).toString('base64url');
  await db.updateTable('socios').set({ portalTokenHash: hash(token), portalCreadoEn: new Date() }).where('id', '=', s.id).execute();
  const url = `${baseUrl.replace(/\/+$/, '')}/socio/${token}`;
  let enviado = false;
  let error: string | null = null;
  if (enviar) {
    try {
      if (!s.telefono) throw new Error('El cliente no tiene teléfono');
      const gym = await getConfig('gym');
      const de = quien.entrenador ? `Soy ${quien.entrenador.nombre}, tu entrenador en ${gym.nombre}.` : `Este es tu enlace personal de ${gym.nombre}.`;
      await whatsapp.enviar(
        s.telefono,
        `Hola ${s.nombre} 💪\n${de}\nAquí ves tu plan, los días que te quedan, tu progreso y tu rutina, y puedes anotar tu peso:\n\n${url}\n\nTambién puedes entrar desde la web con tu cédula. No compartas este enlace: es solo para ti.`,
        'manual',
      );
      enviado = true;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  await db
    .insertInto('auditoria')
    .values({ usuarioId: quien.usuarioId ?? null, accion: 'socio.portal_enlace', detalle: JSON.stringify({ socioId: s.id, enviado, entrenadorId: quien.entrenador?.id ?? null }) })
    .execute();
  return { url, enviado, error };
}

/** Todo lo que el cliente ve de sí mismo (enlace y app). */
export async function datosCliente(socioId: string) {
  const s = await db
    .selectFrom('socios as s')
    .leftJoin('entrenadores as e', 'e.id', 's.entrenadorId')
    .select([
      's.id',
      's.codigo',
      's.nombre',
      's.apellido',
      's.activo',
      's.claveHash',
      's.cedula',
      'e.id as entrenadorId',
      sql<string | null>`nullif(trim(e.nombre || ' ' || e.apellido), '')`.as('entrenador'),
      'e.especialidad as entrenadorEspecialidad',
      'e.telefono as entrenadorTelefono',
    ])
    .where('s.id', '=', socioId)
    .executeTakeFirst();
  if (!s) throw notFound('Cliente no encontrado');

  const [vigencia, membresias, asistencias, clases, med, rut, deudas, gym, ent] = await Promise.all([
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
    db.selectFrom('asistencias').select(['fechaHora']).where('socioId', '=', s.id).where('resultado', '=', 'permitido').orderBy('fechaHora', 'desc').limit(120).execute(),
    db
      .selectFrom('claseInscritos as i')
      .innerJoin('clases as c', 'c.id', 'i.claseId')
      .leftJoin('entrenadores as e', 'e.id', 'c.entrenadorId')
      .select(['c.id', 'c.nombre', 'c.inicio', 'c.duracionMin', 'c.color', 'i.reservadoPorSocio', sql<string | null>`nullif(trim(e.nombre || ' ' || e.apellido), '')`.as('entrenador')])
      .where('i.socioId', '=', s.id)
      .where('c.estado', '=', 'programada')
      .where('c.inicio', '>=', sql<Date>`now() - interval '1 hour'`)
      .orderBy('c.inicio')
      .limit(10)
      .execute(),
    mediciones(s.id),
    rutinas(s.id, true),
    db.selectFrom('deudas').select(['moneda', 'saldo']).where('socioId', '=', s.id).where('estado', '=', 'pendiente').execute(),
    getConfig('gym'),
    entrenos(s.id),
  ]);
  const mes = hoy().slice(0, 7);
  const cedula = s.cedula ?? '';
  return {
    socio: { nombre: s.nombre, apellido: s.apellido, codigo: s.codigo, activo: s.activo, cedula: cedula.length > 4 ? `${'•'.repeat(cedula.length - 4)}${cedula.slice(-4)}` : cedula },
    privado: !!s.claveHash,
    entrenador: s.entrenadorId ? { nombre: s.entrenador, especialidad: s.entrenadorEspecialidad, telefono: s.entrenadorTelefono } : null,
    gym: { nombre: gym.nombre, slogan: gym.slogan, horario: gym.horario, telefono: gym.telefono, instagram: gym.instagram, direccion: gym.direccion },
    vigencia,
    membresias,
    asistencias: {
      ultimas: asistencias.slice(0, 15).map((a) => a.fechaHora),
      esteMes: asistencias.filter((a) => new Date(a.fechaHora).toISOString().slice(0, 7) === mes).length,
      total: asistencias.length,
    },
    clases,
    mediciones: med,
    rutina: rut[0] ?? null,
    entrenos: ent,
    deuda: deudas.length ? deudas.map((d) => fmt(Number(d.saldo), d.moneda)).join(' · ') : null,
  };
}
