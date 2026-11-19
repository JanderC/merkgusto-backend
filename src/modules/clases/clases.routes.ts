/**
 * Clases grupales ancladas a planes (CrossFit, Funcional, Funcional avanzada…).
 *
 *  • La cajera (y la administración) crean la clase: día y hora, entrenador,
 *    cupo, nivel y características (movilidad, fuerza, cardio, resistencia,
 *    potencia, desplazamiento) de 0 a 5.
 *  • Inscriben a la gente. Cada inscrito muestra si está cubierto:
 *      plan        → tiene vigente el plan de la clase ese día
 *      mensualidad → tiene otra membresía vigente
 *      sin mensualidad → la cajera cobra el pase o lo deja pasar (cortesía)
 *  • "Dejar pasar" registra la entrada (asistencia) aunque no tenga mensualidad.
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import type { CaracteristicaClase } from '../../db/types.js';
import { ah, badRequest, conflict, notFound, parse } from '../../lib/http.js';
import { hoy, sumarDias } from '../../lib/util.js';
import { gestionCaja, usuarioActual } from '../../middleware/auth.js';
import { describirDuracion, vigenciaDesdeFilas } from '../membresias/membresias.service.js';
import { avisarCancelacion, estadoRecordatorio, recordarClase } from './clases.service.js';

export const clasesRouter = Router();

export const CARACTERISTICAS: CaracteristicaClase[] = ['movilidad', 'fuerza', 'cardio', 'resistencia', 'potencia', 'desplazamiento'];
const TZ = env.TZ;
/** Día local (Venezuela) de un instante. */
const diaLocal = sql<string>`to_char(c.inicio at time zone ${sql.lit(TZ)}, 'YYYY-MM-DD')`;
const fechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const claseSchema = z.object({
  nombre: z.string().trim().min(2, 'Escribe el nombre de la clase').max(80),
  descripcion: z.string().trim().max(400).nullish(),
  planId: z.number().int().positive().nullish(),
  entrenadorId: z.string().uuid().nullish(),
  fecha: fechaISO,
  hora: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora inválida'),
  duracionMin: z.number().int().min(10).max(300).default(60),
  /** 0 o vacío = sin límite */
  cupo: z.number().int().min(0).max(500).nullish(),
  nivel: z.enum(['principiante', 'intermedio', 'avanzado', 'todos']).nullish(),
  caracteristicas: z.record(z.enum(CARACTERISTICAS as [CaracteristicaClase, ...CaracteristicaClase[]]), z.number().int().min(0).max(5)).default({}),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#FF8A10'),
  /** Al crear: repetir la misma clase N semanas más */
  repetirSemanas: z.number().int().min(0).max(26).default(0),
});

const inicioDe = (fecha: string, hora: string) => new Date(`${fecha}T${hora}:00`);
const limpiarCar = (c: Partial<Record<CaracteristicaClase, number>>) => JSON.stringify(Object.fromEntries(Object.entries(c).filter(([, v]) => (v ?? 0) > 0)));

const baseClases = () =>
  db
    .selectFrom('clases as c')
    .leftJoin('planes as p', 'p.id', 'c.planId')
    .leftJoin('entrenadores as e', 'e.id', 'c.entrenadorId')
    .select([
      'c.id',
      'c.nombre',
      'c.descripcion',
      'c.planId',
      'p.nombre as plan',
      'p.color as planColor',
      'c.entrenadorId',
      sql<string | null>`nullif(trim(e.nombre || ' ' || e.apellido), '')`.as('entrenador'),
      'e.especialidad as entrenadorEspecialidad',
      sql<boolean>`e.foto is not null`.as('entrenadorFoto'),
      'c.inicio',
      'c.duracionMin',
      'c.cupo',
      'c.nivel',
      'c.caracteristicas',
      'c.color',
      'c.estado',
      'c.motivoCancelacion',
      'c.serieId',
      diaLocal.as('dia'),
      sql<string>`to_char(c.inicio at time zone ${sql.lit(TZ)}, 'HH24:MI')`.as('hora'),
      sql<number>`(select count(*)::int from clase_inscritos i where i.clase_id = c.id)`.as('inscritos'),
      sql<number>`(select count(*)::int from clase_inscritos i where i.clase_id = c.id and i.asistio_en is not null)`.as('asistieron'),
    ]);

/** Entrenadores y planes para el formulario (la cajera no tiene acceso al módulo de entrenadores). */
clasesRouter.get(
  '/opciones',
  ah(async (_req, res) => {
    const [entrenadores, planes] = await Promise.all([
      db.selectFrom('entrenadores').select(['id', 'nombre', 'apellido', 'especialidad', sql<boolean>`foto is not null`.as('tieneFoto')]).where('activo', '=', true).orderBy('nombre').execute(),
      db.selectFrom('planes').select(['id', 'nombre', 'color', 'activo', 'tipoDuracion', 'cantidad', 'personas']).where('eliminadoEn', 'is', null).orderBy('orden').orderBy('nombre').execute(),
    ]);
    res.json({ entrenadores, planes: planes.map((p) => ({ ...p, duracion: describirDuracion(p) })), caracteristicas: CARACTERISTICAS });
  }),
);

clasesRouter.get(
  '/',
  ah(async (req, res) => {
    const q = parse(z.object({ desde: fechaISO.optional(), hasta: fechaISO.optional(), planId: z.coerce.number().int().optional() }), req.query);
    const desde = q.desde ?? hoy();
    const hasta = q.hasta ?? sumarDias(desde, 6);
    let query = baseClases().where(diaLocal, '>=', desde).where(diaLocal, '<=', hasta).orderBy('c.inicio');
    if (q.planId) query = query.where('c.planId', '=', q.planId);
    res.json(await query.execute());
  }),
);

/** Cómo está cubierto cada socio el día de la clase. */
async function coberturas(socioIds: string[], planId: number | null, dia: string) {
  const out = new Map<string, { acceso: 'plan' | 'mensualidad' | 'sin_mensualidad'; plan: string | null; diasRestantes: number; hasta: string | null; congelada: boolean }>();
  if (!socioIds.length) return out;
  const filas = await db
    .selectFrom('membresias as m')
    .innerJoin('planes as p', 'p.id', 'm.planId')
    .select(['m.id', 'm.socioId', 'm.planId', 'm.fechaInicio', 'm.fechaFin', 'm.estado', 'm.congeladaDesde', 'p.nombre'])
    .where('m.socioId', 'in', socioIds)
    .where('m.estado', 'in', ['activa', 'congelada'])
    .orderBy('m.fechaFin', 'desc')
    .execute();
  for (const id of socioIds) {
    const mias = filas.filter((f) => f.socioId === id);
    const delPlan = planId ? vigenciaDesdeFilas(mias.filter((f) => f.planId === planId), dia) : null;
    const todas = vigenciaDesdeFilas(mias, dia);
    const v = delPlan?.vigente ? delPlan : todas;
    out.set(id, {
      acceso: delPlan?.vigente ? 'plan' : todas.vigente ? 'mensualidad' : 'sin_mensualidad',
      plan: v.plan,
      diasRestantes: v.diasRestantes,
      hasta: v.hasta ?? v.ultimaFin,
      congelada: !!todas.congelada,
    });
  }
  return out;
}

async function cargarClase(id: number) {
  const c = await baseClases().where('c.id', '=', id).executeTakeFirst();
  if (!c) throw notFound('Clase no encontrada');
  return c;
}

clasesRouter.get(
  '/:id',
  ah(async (req, res) => {
    const c = await cargarClase(Number(req.params.id));
    const inscritos = await db
      .selectFrom('claseInscritos as i')
      .innerJoin('socios as s', 's.id', 'i.socioId')
      .leftJoin('usuarios as u', 'u.id', 'i.pasoPor')
      .select([
        'i.socioId',
        'i.cobertura',
        'i.asistioEn',
        'i.nota',
        'i.creadoEn',
        's.codigo',
        's.nombre',
        's.apellido',
        's.cedula',
        's.telefono',
        sql<boolean>`s.foto is not null`.as('tieneFoto'),
        'u.nombre as pasoPor',
      ])
      .where('i.claseId', '=', c.id)
      .orderBy('i.creadoEn')
      .execute();
    // Los que tienen vigente el plan de la clase y aún no están inscritos
    const sugeridos = c.planId
      ? await db
          .selectFrom('membresias as m')
          .innerJoin('socios as s', 's.id', 'm.socioId')
          .select(['s.id as socioId', 's.codigo', 's.nombre', 's.apellido', 's.cedula', 's.telefono', sql<boolean>`s.foto is not null`.as('tieneFoto'), sql<string>`max(m.fecha_fin)`.as('hasta')])
          .where('m.planId', '=', c.planId)
          .where('m.estado', '=', 'activa')
          .where('m.fechaInicio', '<=', c.dia)
          .where('m.fechaFin', '>=', c.dia)
          .where('s.activo', '=', true)
          .where(sql<boolean>`not exists (select 1 from clase_inscritos i where i.clase_id = ${c.id} and i.socio_id = s.id)`)
          .groupBy(['s.id', 's.codigo', 's.nombre', 's.apellido', 's.cedula', 's.telefono', 's.foto'])
          .orderBy('s.nombre')
          .limit(200)
          .execute()
      : [];
    const cob = await coberturas(
      inscritos.map((i) => i.socioId),
      c.planId,
      c.dia,
    );
    res.json({
      ...c,
      esHoy: c.dia === hoy(),
      inscritos: inscritos.map((i) => ({ ...i, ...cob.get(i.socioId)! })),
      sugeridos,
    });
  }),
);

clasesRouter.post(
  '/',
  ah(async (req, res) => {
    const b = parse(claseSchema, req.body);
    const u = usuarioActual(req);
    const serieId = b.repetirSemanas ? crypto.randomUUID() : null;
    const filas = Array.from({ length: b.repetirSemanas + 1 }, (_, k) => ({
      nombre: b.nombre,
      descripcion: b.descripcion || null,
      planId: b.planId ?? null,
      entrenadorId: b.entrenadorId ?? null,
      inicio: inicioDe(sumarDias(b.fecha, k * 7), b.hora),
      duracionMin: b.duracionMin,
      cupo: b.cupo || null,
      nivel: b.nivel ?? null,
      caracteristicas: limpiarCar(b.caracteristicas),
      color: b.color,
      serieId,
      creadoPor: u.id,
    }));
    const creadas = await db.insertInto('clases').values(filas).returning('id').execute();
    res.status(201).json({ ...(await cargarClase(creadas[0]!.id)), creadas: creadas.length });
  }),
);

clasesRouter.put(
  '/:id',
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const b = parse(claseSchema.omit({ repetirSemanas: true }).partial(), req.body);
    const actual = await cargarClase(id);
    const fecha = b.fecha ?? actual.dia;
    const hora = b.hora ?? actual.hora;
    await db
      .updateTable('clases')
      .set({
        ...(b.nombre !== undefined && { nombre: b.nombre }),
        ...(b.descripcion !== undefined && { descripcion: b.descripcion || null }),
        ...(b.planId !== undefined && { planId: b.planId ?? null }),
        ...(b.entrenadorId !== undefined && { entrenadorId: b.entrenadorId ?? null }),
        ...((b.fecha !== undefined || b.hora !== undefined) && { inicio: inicioDe(fecha, hora) }),
        ...(b.duracionMin !== undefined && { duracionMin: b.duracionMin }),
        ...(b.cupo !== undefined && { cupo: b.cupo || null }),
        ...(b.nivel !== undefined && { nivel: b.nivel ?? null }),
        ...(b.caracteristicas !== undefined && { caracteristicas: limpiarCar(b.caracteristicas) }),
        ...(b.color !== undefined && { color: b.color }),
      })
      .where('id', '=', id)
      .execute();
    res.json(await cargarClase(id));
  }),
);

clasesRouter.post(
  '/:id/cancelar',
  ah(async (req, res) => {
    const { motivo, reactivar } = parse(z.object({ motivo: z.string().trim().max(200).nullish(), reactivar: z.boolean().optional() }), req.body ?? {});
    const r = await db
      .updateTable('clases')
      .set(reactivar ? { estado: 'programada', motivoCancelacion: null } : { estado: 'cancelada', motivoCancelacion: motivo || null })
      .where('id', '=', Number(req.params.id))
      .executeTakeFirst();
    if (!r.numUpdatedRows) throw notFound('Clase no encontrada');
    // Avisa por WhatsApp a los inscritos (sin hacer esperar a la cajera)
    if (!reactivar) void avisarCancelacion(Number(req.params.id)).catch(() => 0);
    res.json({ ok: true });
  }),
);

/** Recordatorio por WhatsApp: estado y ejemplo del mensaje. */
clasesRouter.get(
  '/:id/recordatorio',
  ah(async (req, res) => {
    res.json(await estadoRecordatorio(Number(req.params.id)));
  }),
);

/** Enviar el recordatorio ahora a los inscritos (una vez por persona; forzar = reenviar). */
clasesRouter.post(
  '/:id/recordar',
  ah(async (req, res) => {
    const { forzar } = parse(z.object({ forzar: z.boolean().optional() }), req.body ?? {});
    res.json(await recordarClase(Number(req.params.id), forzar));
  }),
);

/** Borrar (solo administración y solo si nadie asistió). */
clasesRouter.delete(
  '/:id',
  gestionCaja,
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const c = await cargarClase(id);
    if (c.asistieron) throw conflict('Ya hay gente que asistió a esta clase: cancélala en vez de borrarla');
    await db.deleteFrom('clases').where('id', '=', id).execute();
    res.json({ ok: true });
  }),
);

clasesRouter.post(
  '/:id/inscritos',
  ah(async (req, res) => {
    const { socioIds } = parse(z.object({ socioIds: z.array(z.string().uuid()).min(1).max(300) }), req.body);
    const c = await cargarClase(Number(req.params.id));
    if (c.estado === 'cancelada') throw badRequest('La clase está cancelada');
    const ya = new Set((await db.selectFrom('claseInscritos').select('socioId').where('claseId', '=', c.id).execute()).map((r) => r.socioId));
    const nuevos = [...new Set(socioIds)].filter((s) => !ya.has(s));
    if (c.cupo && ya.size + nuevos.length > c.cupo) throw conflict(`Cupo lleno: ${ya.size} de ${c.cupo}. Quedan ${Math.max(0, c.cupo - ya.size)} puesto(s)`);
    const activos = nuevos.length ? await db.selectFrom('socios').select('id').where('id', 'in', nuevos).where('activo', '=', true).execute() : [];
    if (activos.length !== nuevos.length) throw badRequest('Algún cliente no existe o está inactivo');
    if (nuevos.length) await db.insertInto('claseInscritos').values(nuevos.map((socioId) => ({ claseId: c.id, socioId, inscritoPor: usuarioActual(req).id }))).execute();
    res.status(201).json({ agregados: nuevos.length, yaEstaban: socioIds.length - nuevos.length });
  }),
);

clasesRouter.delete(
  '/:id/inscritos/:socioId',
  ah(async (req, res) => {
    const r = await db.deleteFrom('claseInscritos').where('claseId', '=', Number(req.params.id)).where('socioId', '=', req.params.socioId!).where('asistioEn', 'is', null).executeTakeFirst();
    if (!r.numDeletedRows) throw badRequest('No se puede quitar: ya entró a la clase (deshaz la entrada primero)');
    res.json({ ok: true });
  }),
);

const TEXTO_COB = { plan: 'con su plan', mensualidad: 'con su mensualidad', pase: 'pagó su pase', cortesia: 'cortesía (sin mensualidad)' } as const;

/**
 * Dejar pasar a la clase: registra la entrada aunque no tenga mensualidad.
 * Sin mensualidad hay que decir si pagó su pase o es cortesía.
 */
clasesRouter.post(
  '/:id/inscritos/:socioId/pasar',
  ah(async (req, res) => {
    const b = parse(z.object({ cobertura: z.enum(['pase', 'cortesia']).optional(), nota: z.string().trim().max(200).nullish() }), req.body ?? {});
    const c = await cargarClase(Number(req.params.id));
    if (c.estado === 'cancelada') throw badRequest('La clase está cancelada');
    if (c.dia !== hoy()) throw badRequest(`La entrada se da el día de la clase (${c.dia.split('-').reverse().join('/')})`);
    const socioId = req.params.socioId!;
    const ins = await db.selectFrom('claseInscritos').select(['id', 'asistioEn']).where('claseId', '=', c.id).where('socioId', '=', socioId).executeTakeFirst();
    if (!ins) throw notFound('No está inscrito en esta clase');
    if (ins.asistioEn) throw conflict('Ya entró a esta clase');
    const cob = (await coberturas([socioId], c.planId, c.dia)).get(socioId)!;
    const cobertura = cob.acceso === 'plan' ? 'plan' : cob.acceso === 'mensualidad' ? 'mensualidad' : b.cobertura;
    if (!cobertura) throw badRequest('No tiene mensualidad: indica si pagó su pase o si lo dejas pasar como cortesía');
    const u = usuarioActual(req);
    const socio = await db.selectFrom('socios').select(['codigo']).where('id', '=', socioId).executeTakeFirstOrThrow();
    // Si ya entró al gym hace poco (lector o recepción), se usa esa entrada
    const reciente = await db
      .selectFrom('asistencias')
      .select('id')
      .where('socioId', '=', socioId)
      .where('resultado', '=', 'permitido')
      .where('fechaHora', '>', sql<Date>`now() - interval '3 hours'`)
      .orderBy('fechaHora', 'desc')
      .executeTakeFirst();
    const asistenciaId =
      reciente?.id ??
      (
        await db
          .insertInto('asistencias')
          .values({ socioId, employeeNo: String(socio.codigo), fechaHora: new Date(), origen: 'manual', resultado: 'permitido', motivo: `Clase ${c.nombre} · ${TEXTO_COB[cobertura]}`, registradoPor: u.id })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    await db
      .updateTable('claseInscritos')
      .set({ cobertura, asistioEn: new Date(), asistenciaId, pasoPor: u.id, nota: b.nota ?? null })
      .where('id', '=', ins.id)
      .execute();
    if (cobertura === 'cortesia') await db.insertInto('auditoria').values({ usuarioId: u.id, accion: 'clase.cortesia', detalle: JSON.stringify({ claseId: c.id, socioId, nota: b.nota ?? null }) }).execute();
    res.json({ ok: true, cobertura, texto: TEXTO_COB[cobertura] });
  }),
);

/** Deshacer la entrada a la clase (se equivocó de persona). */
clasesRouter.post(
  '/:id/inscritos/:socioId/deshacer',
  ah(async (req, res) => {
    const ins = await db
      .selectFrom('claseInscritos')
      .select(['id', 'asistenciaId'])
      .where('claseId', '=', Number(req.params.id))
      .where('socioId', '=', req.params.socioId!)
      .where('asistioEn', 'is not', null)
      .executeTakeFirst();
    if (!ins) throw badRequest('No tiene entrada registrada en esta clase');
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('claseInscritos').set({ cobertura: null, asistioEn: null, asistenciaId: null, pasoPor: null }).where('id', '=', ins.id).execute();
      // Solo se borra la asistencia si la creó la clase (y nadie más la usa)
      if (ins.asistenciaId) {
        const otra = await trx.selectFrom('claseInscritos').select('id').where('asistenciaId', '=', ins.asistenciaId).executeTakeFirst();
        if (!otra) await trx.deleteFrom('asistencias').where('id', '=', ins.asistenciaId).where('motivo', 'like', 'Clase %').execute();
      }
    });
    res.json({ ok: true });
  }),
);
