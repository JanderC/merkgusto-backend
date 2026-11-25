/**
 * App de entrenadores (web y móvil) — /api/coach
 *
 *  • Inicio: sus clases de hoy y de la semana, y alertas de sus clientes
 *    (vence pronto, vencidos, sin venir, sin rutina, sin medidas).
 *  • Mis clientes: los que tiene asignados (o se asigna buscando por nombre o cédula).
 *    En cada uno: días que le quedan, entradas, medidas, rutina, notas privadas,
 *    clases y su enlace personal por WhatsApp.
 *  • Clases: inscribe a sus clientes, pasa lista en sus clases y programa clases nuevas.
 *  • Plantillas de rutina para asignarlas en un toque.
 *
 *  El entrenador solo ve a sus clientes y a quienes están inscritos en sus clases.
 */
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { fmt as fmtM } from '../../lib/monedas.js';
import { ah, badRequest, conflict, forbidden, notFound, parse } from '../../lib/http.js';
import { hoy, sumarDias } from '../../lib/util.js';
import { entrenadorActual, tokenEntrenador } from '../../middleware/auth.js';
import { baseClases, cargarClase, claseSchema, coberturas, diaLocal, inicioDe, inscribirEnClase, limpiarCar, pasarAClase } from '../clases/clases.routes.js';
import { describirDuracion, vigenciaDesdeFilas } from '../membresias/membresias.service.js';
import { porLiquidar, tableroPersonalizados, type FilaPersonalizado } from '../personalizados/personalizados.service.js';
import { getTasas } from '../tasas/tasas.service.js';
import { crearRutina, diasSchema, editarRutina, entrenos, generarEnlace, mediciones, medicionSchema, rutinas, rutinaSchema, socioExiste } from '../socios/progreso.service.js';

export const coachRouter = Router();

const nombreEntrenador = sql<string | null>`nullif(trim(e.nombre || ' ' || e.apellido), '')`;

/** ¿Puede este entrenador ver al cliente? Si es suyo o está en alguna de sus clases (últimos 60 días o próximas). */
async function puedeVer(entrenadorId: string, socioId: string) {
  const s = await socioExiste(socioId);
  if (s.entrenadorId === entrenadorId) return { ...s, mio: true };
  const enClase = await db
    .selectFrom('claseInscritos as i')
    .innerJoin('clases as c', 'c.id', 'i.claseId')
    .select('i.id')
    .where('i.socioId', '=', socioId)
    .where('c.entrenadorId', '=', entrenadorId)
    .where('c.inicio', '>', sql<Date>`now() - interval '60 days'`)
    .executeTakeFirst();
  if (!enClase) throw forbidden('Este cliente no está asignado a ti');
  return { ...s, mio: false };
}

/** Resumen de varios clientes a la vez: vigencia, última entrada, medidas, rutina y entrenos. */
async function resumenClientes(ids: string[]) {
  if (!ids.length) return new Map<string, ReturnType<typeof filaVacia>>();
  const h = hoy();
  const [membs, entradas, meds, ruts, ents] = await Promise.all([
    db
      .selectFrom('membresias as m')
      .innerJoin('planes as p', 'p.id', 'm.planId')
      .select(['m.id', 'm.socioId', 'm.fechaInicio', 'm.fechaFin', 'm.estado', 'm.congeladaDesde', 'p.nombre'])
      .where('m.socioId', 'in', ids)
      .where('m.estado', 'in', ['activa', 'congelada'])
      .orderBy('m.fechaFin', 'desc')
      .execute(),
    db.selectFrom('asistencias').select(['socioId', sql<Date>`max(fecha_hora)`.as('ultima')]).where('socioId', 'in', ids).where('resultado', '=', 'permitido').groupBy('socioId').execute(),
    db.selectFrom('socioMediciones').select(['socioId', sql<string>`max(fecha)::text`.as('ultima')]).where('socioId', 'in', ids).groupBy('socioId').execute(),
    db.selectFrom('socioRutinas').select(['socioId', 'titulo']).where('socioId', 'in', ids).where('activa', '=', true).execute(),
    db
      .selectFrom('socioEntrenos')
      .select(['socioId', sql<number>`count(*)::int`.as('n')])
      .where('socioId', 'in', ids)
      .where('fecha', '>=', sumarDias(h, -6))
      .groupBy('socioId')
      .execute(),
  ]);
  const out = new Map<string, ReturnType<typeof filaVacia>>();
  for (const id of ids) {
    const v = vigenciaDesdeFilas(
      membs.filter((m) => m.socioId === id),
      h,
    );
    const ultimaEntrada = entradas.find((e) => e.socioId === id)?.ultima ?? null;
    out.set(id, {
      vigente: v.vigente,
      plan: v.plan,
      diasRestantes: v.diasRestantes,
      hasta: v.hasta ?? v.ultimaFin,
      congelada: !!v.congelada,
      ultimaEntrada,
      diasSinVenir: ultimaEntrada ? Math.floor((Date.now() - new Date(ultimaEntrada).getTime()) / 86_400_000) : null,
      ultimaMedicion: meds.find((m) => m.socioId === id)?.ultima ?? null,
      rutina: ruts.find((r) => r.socioId === id)?.titulo ?? null,
      entrenosSemana: ents.find((e) => e.socioId === id)?.n ?? 0,
    });
  }
  return out;
}
function filaVacia() {
  return {
    vigente: false,
    plan: null as string | null,
    diasRestantes: 0,
    hasta: null as string | null,
    congelada: false,
    ultimaEntrada: null as Date | null,
    diasSinVenir: null as number | null,
    ultimaMedicion: null as string | null,
    rutina: null as string | null,
    entrenosSemana: 0,
  };
}

type Alerta = { tipo: 'vence' | 'vencido' | 'ausente' | 'sin_rutina' | 'medir' | 'personalizado'; texto: string };

/** Lo que el entrenador ve del personalizado de su cliente. */
function resumenPz(f: FilaPersonalizado | undefined) {
  if (!f) return null;
  return { estado: f.estado, texto: f.estadoTexto, desde: f.desde, hasta: f.hasta, diasRestantes: f.diasRestantes, deudaTexto: f.deudaTexto, ultimoPago: f.ultimoPago ? { fecha: f.ultimoPago.fecha, duracion: f.ultimoPago.duracion, precioTexto: f.ultimoPago.precioTexto } : null };
}
function alertasDe(r: ReturnType<typeof filaVacia>): Alerta[] {
  const a: Alerta[] = [];
  if (r.vigente && r.diasRestantes <= 5) a.push({ tipo: 'vence', texto: r.diasRestantes <= 0 ? 'Vence hoy' : `Le quedan ${r.diasRestantes} día(s)` });
  if (!r.vigente && !r.congelada) a.push({ tipo: 'vencido', texto: 'Sin plan vigente' });
  if (r.vigente && (r.diasSinVenir === null || r.diasSinVenir >= 7)) a.push({ tipo: 'ausente', texto: r.diasSinVenir === null ? 'Nunca ha venido' : `No viene hace ${r.diasSinVenir} días` });
  if (!r.rutina) a.push({ tipo: 'sin_rutina', texto: 'Sin rutina' });
  if (!r.ultimaMedicion || r.ultimaMedicion < sumarDias(hoy(), -30)) a.push({ tipo: 'medir', texto: r.ultimaMedicion ? 'Medidas de hace más de un mes' : 'Sin medidas' });
  return a;
}

async function misClientes(entrenadorId: string) {
  const pz = await tableroPersonalizados({ entrenadorId, diasVencidos: 365 });
  const socios = await db
    .selectFrom('socios')
    .select(['id', 'codigo', 'nombre', 'apellido', 'telefono', 'activo', sql<boolean>`foto is not null`.as('tieneFoto'), sql<boolean>`clave_hash is not null`.as('privado'), 'appUltimoAcceso'])
    .where('entrenadorId', '=', entrenadorId)
    .orderBy('nombre')
    .orderBy('apellido')
    .execute();
  const r = await resumenClientes(socios.map((s) => s.id));
  return socios.map((s) => {
    const x = r.get(s.id) ?? filaVacia();
    const personalizado = resumenPz(pz.find((f) => f.socioId === s.id && f.estado !== 'sin_pago'));
    const alertas = alertasDe(x);
    if (personalizado && ['vencido', 'debe', 'vence'].includes(personalizado.estado)) alertas.unshift({ tipo: 'personalizado', texto: `Personalizado: ${personalizado.texto.toLowerCase()}` });
    return { ...s, ...x, personalizado, alertas };
  });
}

// ═════════════ Perfil ═════════════
coachRouter.get(
  '/yo',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    const e = await db
      .selectFrom('entrenadores')
      .select(['id', 'codigo', 'nombre', 'apellido', 'especialidad', 'usuario', 'telefono', sql<boolean>`foto is not null`.as('tieneFoto')])
      .where('id', '=', yo.id)
      .executeTakeFirstOrThrow();
    res.json(e);
  }),
);

coachRouter.post(
  '/password',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    const b = parse(z.object({ actual: z.string().min(1), nueva: z.string().min(6, 'Mínimo 6 caracteres').max(100) }), req.body);
    const e = await db.selectFrom('entrenadores').select(['id', 'nombre', 'passwordHash', 'sesionVersion']).where('id', '=', yo.id).executeTakeFirstOrThrow();
    if (!e.passwordHash || !(await bcrypt.compare(b.actual, e.passwordHash))) throw badRequest('La contraseña actual no es correcta');
    const v = e.sesionVersion + 1;
    await db.updateTable('entrenadores').set({ passwordHash: await bcrypt.hash(b.nueva, 10), sesionVersion: v }).where('id', '=', e.id).execute();
    res.json({ ok: true, token: tokenEntrenador({ id: e.id, nombre: e.nombre, sesionVersion: v }) });
  }),
);

// ═════════════ Inicio ═════════════
coachRouter.get(
  '/inicio',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    const h = hoy();
    const [clases, clientes] = await Promise.all([
      baseClases().where('c.entrenadorId', '=', yo.id).where(diaLocal, '>=', h).where(diaLocal, '<=', sumarDias(h, 6)).where('c.estado', '=', 'programada').orderBy('c.inicio').execute(),
      misClientes(yo.id),
    ]);
    const conAlerta = clientes.filter((c) => c.alertas.some((a) => a.tipo !== 'medir')).slice(0, 12);
    res.json({
      hoy: clases.filter((c) => c.dia === h),
      semana: clases.filter((c) => c.dia !== h),
      clientes: {
        total: clientes.length,
        alDia: clientes.filter((c) => c.vigente).length,
        vencen: clientes.filter((c) => c.alertas.some((a) => a.tipo === 'vence')).length,
        ausentes: clientes.filter((c) => c.alertas.some((a) => a.tipo === 'ausente')).length,
        sinRutina: clientes.filter((c) => !c.rutina).length,
        entrenaronSemana: clientes.filter((c) => c.entrenosSemana > 0).length,
      },
      personalizados: {
        alDia: clientes.filter((c) => c.personalizado && ['al_dia', 'por_empezar'].includes(c.personalizado.estado)).length,
        vencen: clientes.filter((c) => c.personalizado?.estado === 'vence').length,
        vencidos: clientes.filter((c) => c.personalizado?.estado === 'vencido').length,
        deben: clientes.filter((c) => c.personalizado?.estado === 'debe').length,
        sinPago: clientes.filter((c) => !c.personalizado).length,
      },
      alertas: conAlerta.map((c) => ({ id: c.id, nombre: `${c.nombre} ${c.apellido}`.trim(), tieneFoto: c.tieneFoto, alertas: c.alertas.filter((a) => a.tipo !== 'medir') })),
    });
  }),
);

// ═════════════ Clientes ═════════════
coachRouter.get(
  '/clientes',
  ah(async (req, res) => {
    res.json(await misClientes(entrenadorActual(req).id));
  }),
);

/** Mis personalizados: quién pagó, quién no y lo que me toca cobrar en mi próximo pago. */
coachRouter.get(
  '/personalizados',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    const [filas, e, tasas] = await Promise.all([
      tableroPersonalizados({ entrenadorId: yo.id, diasVencidos: 365 }),
      db.selectFrom('entrenadores').select(['pagoMoneda', 'personalizadoPrecio', 'personalizadoSemanal', 'personalizadoMoneda', 'personalizadoComision']).where('id', '=', yo.id).executeTakeFirstOrThrow(),
      getTasas(),
    ]);
    const liq = (await porLiquidar(db, [yo.id], hoy(), () => e.pagoMoneda, tasas)).get(yo.id)!;
    res.json({
      filas: filas.map((f) => ({ socioId: f.socioId, nombre: f.nombre, telefono: f.telefono, tieneFoto: f.tieneFoto, ...resumenPz(f)! })),
      tarifa: {
        mensual: e.personalizadoPrecio !== null && Number(e.personalizadoPrecio) > 0 ? fmtM(Number(e.personalizadoPrecio), e.personalizadoMoneda) : null,
        semanal: e.personalizadoSemanal !== null && Number(e.personalizadoSemanal) > 0 ? fmtM(Number(e.personalizadoSemanal), e.personalizadoMoneda) : null,
        comision: Number(e.personalizadoComision),
      },
      porCobrar: { texto: liq.montoTexto, cantidad: liq.listos.length, retenidoTexto: liq.retenido > 0 ? liq.retenidoTexto : null, retenidos: liq.retenidos.length, detalle: [...liq.listos.map((d) => ({ ...d, retenido: false })), ...liq.retenidos.map((d) => ({ ...d, retenido: true }))] },
    });
  }),
);

/** Buscar en todo el gimnasio para asignarse un cliente. */
coachRouter.get(
  '/buscar',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    const { q } = parse(z.object({ q: z.string().trim().min(2, 'Escribe al menos 2 letras').max(60) }), req.query);
    const like = `%${q.replace(/[%_]/g, '')}%`;
    const digitos = q.replace(/\D/g, '');
    const filas = await db
      .selectFrom('socios as s')
      .leftJoin('entrenadores as e', 'e.id', 's.entrenadorId')
      .select(['s.id', 's.codigo', 's.nombre', 's.apellido', sql<boolean>`s.foto is not null`.as('tieneFoto'), 's.entrenadorId', nombreEntrenador.as('entrenador')])
      .where('s.activo', '=', true)
      .where((eb) =>
        eb.or([
          eb(sql`s.nombre || ' ' || s.apellido`, 'ilike', like),
          ...(digitos.length >= 3 ? [eb('s.cedula', 'ilike', `%${digitos}%`), eb(sql`s.codigo::text`, '=', digitos)] : []),
        ]),
      )
      .orderBy('s.nombre')
      .limit(15)
      .execute();
    res.json(filas.map((f) => ({ ...f, mio: f.entrenadorId === yo.id })));
  }),
);

coachRouter.post(
  '/clientes/:id/asignar',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    const s = await socioExiste(req.params.id!);
    if (!s.activo) throw badRequest('El cliente está inactivo');
    if (s.entrenadorId && s.entrenadorId !== yo.id) {
      const otro = await db.selectFrom('entrenadores').select(['nombre', 'activo']).where('id', '=', s.entrenadorId).executeTakeFirst();
      if (otro?.activo) throw conflict(`Ya lo atiende ${otro.nombre}. Pide en recepción que lo cambien.`);
    }
    await db.updateTable('socios').set({ entrenadorId: yo.id }).where('id', '=', s.id).execute();
    res.json({ ok: true });
  }),
);

coachRouter.delete(
  '/clientes/:id/asignar',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    await db.updateTable('socios').set({ entrenadorId: null }).where('id', '=', req.params.id!).where('entrenadorId', '=', yo.id).execute();
    res.json({ ok: true });
  }),
);

coachRouter.get(
  '/clientes/:id',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    const s = await puedeVer(yo.id, req.params.id!);
    const [ficha, resumen, med, rut, notas, clases, entradas, ent] = await Promise.all([
      db.selectFrom('socios').select(['cedula', 'fechaNacimiento', 'genero', 'notas', sql<boolean>`foto is not null`.as('tieneFoto'), 'creadoEn']).where('id', '=', s.id).executeTakeFirstOrThrow(),
      resumenClientes([s.id]),
      mediciones(s.id),
      rutinas(s.id),
      db.selectFrom('entrenadorNotas').select(['id', 'texto', 'creadoEn']).where('socioId', '=', s.id).where('entrenadorId', '=', yo.id).orderBy('creadoEn', 'desc').limit(50).execute(),
      db
        .selectFrom('claseInscritos as i')
        .innerJoin('clases as c', 'c.id', 'i.claseId')
        .leftJoin('entrenadores as e', 'e.id', 'c.entrenadorId')
        .select(['c.id', 'c.nombre', 'c.inicio', 'c.color', 'i.asistioEn', 'i.reservadoPorSocio', nombreEntrenador.as('entrenador')])
        .where('i.socioId', '=', s.id)
        .where('c.estado', '=', 'programada')
        .where('c.inicio', '>', sql<Date>`now() - interval '30 days'`)
        .orderBy('c.inicio', 'desc')
        .limit(20)
        .execute(),
      db.selectFrom('asistencias').select(['fechaHora']).where('socioId', '=', s.id).where('resultado', '=', 'permitido').orderBy('fechaHora', 'desc').limit(30).execute(),
      entrenos(s.id),
    ]);
    const r = resumen.get(s.id) ?? filaVacia();
    const edad = ficha.fechaNacimiento ? Math.floor((Date.now() - new Date(`${ficha.fechaNacimiento}T12:00:00`).getTime()) / (365.25 * 86_400_000)) : null;
    res.json({
      id: s.id,
      codigo: s.codigo,
      nombre: s.nombre,
      apellido: s.apellido,
      telefono: s.telefono,
      tieneFoto: ficha.tieneFoto,
      edad,
      genero: ficha.genero,
      desde: ficha.creadoEn,
      mio: s.mio,
      app: { privado: !!s.claveHash, ultimoAcceso: s.appUltimoAcceso, enlace: !!s.portalTokenHash },
      ...r,
      personalizado: resumenPz((await tableroPersonalizados({ entrenadorId: yo.id, socioId: s.id, diasVencidos: 365 })).find((f) => f.estado !== 'sin_pago')),
      alertas: alertasDe(r),
      mediciones: med,
      rutinas: rut,
      notas,
      clases,
      entradas: entradas.map((e) => e.fechaHora),
      entrenos: ent,
    });
  }),
);

coachRouter.post(
  '/clientes/:id/mediciones',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    const s = await puedeVer(yo.id, req.params.id!);
    const b = parse(medicionSchema, req.body);
    if (b.fecha && b.fecha > hoy()) throw badRequest('La fecha no puede ser futura');
    const r = await db
      .insertInto('socioMediciones')
      .values({ ...b, fecha: b.fecha ?? hoy(), socioId: s.id, registradoPor: null, autor: 'entrenador', entrenadorId: yo.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    res.status(201).json(r);
  }),
);

coachRouter.delete(
  '/clientes/:id/mediciones/:mid',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    const r = await db.deleteFrom('socioMediciones').where('id', '=', Number(req.params.mid)).where('socioId', '=', req.params.id!).where('entrenadorId', '=', yo.id).executeTakeFirst();
    if (!Number(r.numDeletedRows)) throw notFound('Solo puedes borrar las medidas que anotaste tú');
    res.json({ ok: true });
  }),
);

const rutinaCoach = rutinaSchema.omit({ entrenadorId: true });

coachRouter.post(
  '/clientes/:id/rutinas',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    const s = await puedeVer(yo.id, req.params.id!);
    const b = parse(rutinaCoach, req.body);
    res.status(201).json(await crearRutina(s.id, { ...b, entrenadorId: yo.id }, 'entrenador', null));
  }),
);

coachRouter.put(
  '/clientes/:id/rutinas/:rid',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    const s = await puedeVer(yo.id, req.params.id!);
    const b = parse(rutinaCoach.partial().extend({ activa: z.boolean().optional() }), req.body);
    res.json(await editarRutina(s.id, Number(req.params.rid), b, 'entrenador', yo.id));
  }),
);

coachRouter.post(
  '/clientes/:id/notas',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    const s = await puedeVer(yo.id, req.params.id!);
    const { texto } = parse(z.object({ texto: z.string().trim().min(2, 'Escribe la nota').max(500) }), req.body);
    res.status(201).json(await db.insertInto('entrenadorNotas').values({ entrenadorId: yo.id, socioId: s.id, texto }).returning(['id', 'texto', 'creadoEn']).executeTakeFirstOrThrow());
  }),
);

coachRouter.delete(
  '/clientes/:id/notas/:nid',
  ah(async (req, res) => {
    await db.deleteFrom('entrenadorNotas').where('id', '=', Number(req.params.nid)).where('entrenadorId', '=', entrenadorActual(req).id).execute();
    res.json({ ok: true });
  }),
);

/** Enlace personal del cliente: entra a su app sin clave (y desde ahí puede ponerse una). */
coachRouter.post(
  '/clientes/:id/enlace',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    const s = await puedeVer(yo.id, req.params.id!);
    const b = parse(z.object({ baseUrl: z.string().url().max(200).refine((u) => /^https?:\/\//.test(u), 'URL inválida'), enviar: z.boolean().default(false) }), req.body);
    res.json(await generarEnlace(s.id, b.baseUrl, b.enviar, { entrenador: yo }));
  }),
);

// ═════════════ Clases ═════════════
coachRouter.get(
  '/clases',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    const q = parse(z.object({ desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), soloMias: z.enum(['1', '0']).optional() }), req.query);
    const desde = q.desde ?? hoy();
    let query = baseClases().where(diaLocal, '>=', desde).where(diaLocal, '<=', sumarDias(desde, 6)).where('c.estado', '=', 'programada').orderBy('c.inicio');
    if (q.soloMias === '1') query = query.where('c.entrenadorId', '=', yo.id);
    const lista = await query.execute();
    res.json(lista.map((c) => ({ ...c, mia: c.entrenadorId === yo.id })));
  }),
);

coachRouter.get(
  '/clases/opciones',
  ah(async (_req, res) => {
    const planes = await db.selectFrom('planes').select(['id', 'nombre', 'color', 'tipoDuracion', 'cantidad']).where('eliminadoEn', 'is', null).where('activo', '=', true).orderBy('orden').orderBy('nombre').execute();
    res.json({ planes: planes.map((p) => ({ ...p, duracion: describirDuracion(p) })) });
  }),
);

coachRouter.get(
  '/clases/:id',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    const c = await cargarClase(Number(req.params.id));
    const mia = c.entrenadorId === yo.id;
    const inscritos = await db
      .selectFrom('claseInscritos as i')
      .innerJoin('socios as s', 's.id', 'i.socioId')
      .select(['i.socioId', 'i.asistioEn', 'i.cobertura', 'i.reservadoPorSocio', 'i.inscritoPorEntrenador', 's.codigo', 's.nombre', 's.apellido', 's.entrenadorId', sql<boolean>`s.foto is not null`.as('tieneFoto')])
      .where('i.claseId', '=', c.id)
      .orderBy('s.nombre')
      .execute();
    // En clases de otros solo ve a sus propios clientes
    const visibles = mia ? inscritos : inscritos.filter((i) => i.entrenadorId === yo.id);
    const cob = await coberturas(
      visibles.map((i) => i.socioId),
      c.planId,
      c.dia,
    );
    res.json({
      ...c,
      mia,
      esHoy: c.dia === hoy(),
      inscritos: visibles.map((i) => ({ ...i, mio: i.entrenadorId === yo.id, puedoQuitar: !i.asistioEn && (mia || i.inscritoPorEntrenador === yo.id), ...cob.get(i.socioId)! })),
    });
  }),
);

coachRouter.post(
  '/clases/:id/inscribir',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    const { socioIds } = parse(z.object({ socioIds: z.array(z.string().uuid()).min(1).max(100) }), req.body);
    const c = await cargarClase(Number(req.params.id));
    if (new Date(c.inicio).getTime() < Date.now() - 30 * 60_000) throw badRequest('La clase ya pasó');
    if (c.entrenadorId !== yo.id) {
      const mios = await db.selectFrom('socios').select('id').where('id', 'in', socioIds).where('entrenadorId', '=', yo.id).execute();
      if (mios.length !== new Set(socioIds).size) throw forbidden('En clases de otros entrenadores solo puedes inscribir a tus clientes');
    }
    res.status(201).json(await inscribirEnClase(c.id, socioIds, { entrenadorId: yo.id }));
  }),
);

coachRouter.delete(
  '/clases/:id/inscritos/:socioId',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    const c = await cargarClase(Number(req.params.id));
    let q = db.deleteFrom('claseInscritos').where('claseId', '=', c.id).where('socioId', '=', req.params.socioId!).where('asistioEn', 'is', null);
    if (c.entrenadorId !== yo.id) q = q.where('inscritoPorEntrenador', '=', yo.id);
    const r = await q.executeTakeFirst();
    if (!Number(r.numDeletedRows)) throw badRequest('No se puede quitar (ya entró, o lo inscribió otra persona)');
    res.json({ ok: true });
  }),
);

/** Pasar lista en su clase: entrada para quien tiene plan o mensualidad. */
coachRouter.post(
  '/clases/:id/pasar/:socioId',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    const c = await cargarClase(Number(req.params.id));
    if (c.entrenadorId !== yo.id) throw forbidden('Solo pasas lista en tus clases');
    res.json(await pasarAClase(c.id, req.params.socioId!, {}, { entrenadorId: yo.id }));
  }),
);

/** Programar una clase propia (se puede repetir varias semanas). */
coachRouter.post(
  '/clases',
  ah(async (req, res) => {
    const yo = entrenadorActual(req);
    const b = parse(claseSchema, req.body);
    if (b.fecha < hoy()) throw badRequest('La fecha ya pasó');
    const serieId = b.repetirSemanas ? crypto.randomUUID() : null;
    const filas = Array.from({ length: b.repetirSemanas + 1 }, (_, k) => ({
      nombre: b.nombre,
      descripcion: b.descripcion || null,
      planId: b.planId ?? null,
      entrenadorId: yo.id,
      inicio: inicioDe(sumarDias(b.fecha, k * 7), b.hora),
      duracionMin: b.duracionMin,
      cupo: b.cupo || null,
      nivel: b.nivel ?? null,
      caracteristicas: limpiarCar(b.caracteristicas),
      color: b.color,
      serieId,
      creadoPor: null,
    }));
    const creadas = await db.insertInto('clases').values(filas).returning('id').execute();
    await db.insertInto('auditoria').values({ usuarioId: null, accion: 'clase.creada_entrenador', detalle: JSON.stringify({ entrenadorId: yo.id, claseId: creadas[0]!.id, creadas: creadas.length }) }).execute();
    res.status(201).json({ id: creadas[0]!.id, creadas: creadas.length });
  }),
);

// ═════════════ Plantillas de rutina ═════════════
const plantillaSchema = z.object({
  titulo: z.string().trim().min(2, 'Ponle un nombre').max(100),
  objetivo: z.string().trim().max(150).nullish().transform((v) => v || null),
  dias: diasSchema,
});

coachRouter.get(
  '/plantillas',
  ah(async (req, res) => {
    res.json(await db.selectFrom('rutinaPlantillas').select(['id', 'titulo', 'objetivo', 'dias', 'actualizadoEn']).where('entrenadorId', '=', entrenadorActual(req).id).orderBy('titulo').execute());
  }),
);

coachRouter.post(
  '/plantillas',
  ah(async (req, res) => {
    const b = parse(plantillaSchema, req.body);
    const r = await db
      .insertInto('rutinaPlantillas')
      .values({ entrenadorId: entrenadorActual(req).id, titulo: b.titulo, objetivo: b.objetivo, dias: JSON.stringify(b.dias), actualizadoEn: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow();
    res.status(201).json(r);
  }),
);

coachRouter.put(
  '/plantillas/:pid',
  ah(async (req, res) => {
    const b = parse(plantillaSchema, req.body);
    const r = await db
      .updateTable('rutinaPlantillas')
      .set({ titulo: b.titulo, objetivo: b.objetivo, dias: JSON.stringify(b.dias), actualizadoEn: new Date() })
      .where('id', '=', Number(req.params.pid))
      .where('entrenadorId', '=', entrenadorActual(req).id)
      .executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw notFound('Plantilla no encontrada');
    res.json({ ok: true });
  }),
);

coachRouter.delete(
  '/plantillas/:pid',
  ah(async (req, res) => {
    await db.deleteFrom('rutinaPlantillas').where('id', '=', Number(req.params.pid)).where('entrenadorId', '=', entrenadorActual(req).id).execute();
    res.json({ ok: true });
  }),
);

