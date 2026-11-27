import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { ah, badRequest, HttpError, notFound, parse } from '../../lib/http.js';
import { hoy, sumarDias } from '../../lib/util.js';
import { gestionCaja, soloDueno, usuarioActual } from '../../middleware/auth.js';
import { encolar, encolarSocio } from '../biometric/biometric-sync.service.js';
import { FACE_MAX_BYTES } from '../biometric/dto/access-control.dto.js';
import { congelarMembresia, reanudarMembresia, vigenciaSocio } from '../membresias/membresias.service.js';
import { personalizadosDeSocio } from '../personalizados/personalizados.service.js';

export const sociosRouter = Router();

const fotoSchema = z
  .string()
  .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, 'La foto debe ser JPEG')
  .refine((s) => Math.floor(((s.length - 23) * 3) / 4) <= FACE_MAX_BYTES, `La foto debe pesar menos de ${FACE_MAX_BYTES / 1024} KB`);

/** Cédula: V-12.345.678 → V12345678 (solo letras y números). */
const cedulaSchema = z
  .string({ required_error: 'La cédula es obligatoria', invalid_type_error: 'La cédula es obligatoria' })
  .trim()
  .max(20)
  .transform((s) => s.replace(/[^0-9A-Za-z]/g, '').toUpperCase())
  .refine((s) => /\d{5,}/.test(s), 'Escribe una cédula válida (mínimo 5 números)');
/** Teléfono / WhatsApp: se guarda tal como lo escriben, pero con 7 a 15 dígitos. */
const telefonoSchema = z
  .string({ required_error: 'El teléfono es obligatorio', invalid_type_error: 'El teléfono es obligatorio' })
  .trim()
  .max(30)
  .refine((s) => {
    const d = s.replace(/\D/g, '').length;
    return d >= 7 && d <= 15;
  }, 'Escribe un teléfono válido (ej. 0414-1234567)');

/** Registro rápido: obligatorios cédula, nombre y teléfono; lo demás es opcional. */
const socioSchema = z.object({
  cedula: cedulaSchema,
  nombre: z.string({ required_error: 'Escribe el nombre' }).trim().min(2, 'Escribe el nombre').max(80),
  apellido: z.string().trim().max(80).nullish().transform((s) => s ?? ''),
  telefono: telefonoSchema,
  email: z.string().trim().email('Correo inválido').max(120).nullish().or(z.literal('').transform(() => null)),
  fechaNacimiento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().or(z.literal('').transform(() => null)),
  genero: z.enum(['M', 'F', 'O']).nullish(),
  notas: z.string().max(1000).nullish(),
  foto: fotoSchema.nullish(),
});

/** La cédula no puede repetirse: avisa quién la tiene para buscarlo. */
async function cedulaLibre(cedula: string, excepto?: string) {
  let q = db.selectFrom('socios').select(['id', 'codigo', 'nombre', 'apellido']).where('cedula', '=', cedula);
  if (excepto) q = q.where('id', '!=', excepto);
  const otro = await q.executeTakeFirst();
  if (otro) throw new HttpError(409, `Ya existe un cliente con la cédula ${cedula}: ${`${otro.nombre} ${otro.apellido}`.trim()} (#${otro.codigo}). Búscalo en Clientes.`, { socioId: otro.id });
}

/** Vigencia calculada en SQL para listados. */
const finVigente = sql<string | null>`(select max(m.fecha_fin) from membresias m where m.socio_id = s.id and m.estado = 'activa')`;

sociosRouter.get(
  '/',
  ah(async (req, res) => {
    const q = parse(
      z.object({
        buscar: z.string().trim().max(80).optional(),
        estado: z.enum(['todos', 'vigentes', 'vencidos', 'por_vencer', 'inactivos', 'sin_rostro']).default('todos'),
        limite: z.coerce.number().int().min(1).max(5000).default(100),
      }),
      req.query,
    );
    let query = db
      .selectFrom('socios as s')
      .select([
        's.id',
        's.codigo',
        's.cedula',
        's.nombre',
        's.apellido',
        's.telefono',
        's.activo',
        's.bioEstado',
        sql<boolean>`s.foto is not null`.as('tieneFoto'),
        finVigente.as('vence'),
        sql<string | null>`(select p.nombre from membresias m join planes p on p.id = m.plan_id where m.socio_id = s.id and m.estado = 'activa' order by m.fecha_fin desc limit 1)`.as('plan'),
        sql<Date | null>`(select max(a.fecha_hora) from asistencias a where a.socio_id = s.id and a.resultado = 'permitido')`.as('ultimaVisita'),
      ])
      .orderBy('s.creadoEn', 'desc')
      .limit(q.limite);

    if (q.buscar) {
      const like = `%${q.buscar.toLowerCase()}%`;
      query = query.where((eb) =>
        eb.or([
          eb(sql`lower(s.nombre || ' ' || s.apellido)`, 'like', like),
          eb('s.cedula', 'ilike', like),
          eb('s.telefono', 'like', `%${q.buscar!.replace(/\D/g, '') || q.buscar}%`),
          eb(sql`s.codigo::text`, '=', q.buscar!),
        ]),
      );
    }
    const h = hoy();
    if (q.estado === 'inactivos') query = query.where('s.activo', '=', false);
    else if (q.estado !== 'todos') query = query.where('s.activo', '=', true);
    if (q.estado === 'vigentes') query = query.where(finVigente, '>=', h);
    if (q.estado === 'vencidos') query = query.where((eb) => eb.or([eb(finVigente, '<', h), eb(finVigente, 'is', null)]));
    if (q.estado === 'por_vencer') query = query.where(finVigente, '>=', h).where(finVigente, '<=', sql<string>`(current_date + 5)::text`);
    if (q.estado === 'sin_rostro') query = query.where('s.bioEstado', '!=', 'sincronizado');
    res.json(await query.execute());
  }),
);

sociosRouter.get(
  '/:id',
  ah(async (req, res) => {
    const s = await db.selectFrom('socios').selectAll().where('id', '=', req.params.id!).executeTakeFirst();
    if (!s) throw notFound('Cliente no encontrado');
    const esDueno = usuarioActual(req).rol !== 'cajero';
    const [vigencia, membresias, asistencias, colaBio, deudas, personalizados] = await Promise.all([
      vigenciaSocio(s.id),
      db
        .selectFrom('membresias as m')
        .innerJoin('planes as p', 'p.id', 'm.planId')
        .select(['m.id', 'm.planId', 'm.ventaId', 'm.fechaInicio', 'm.fechaFin', 'm.estado', 'm.creadoEn', 'm.congeladaDesde', 'm.diasCongelados', 'm.grupoId', 'm.notas', 'p.nombre as plan', 'p.color', 'p.congelable', 'm.precio', 'm.moneda'])
        .where('m.socioId', '=', s.id)
        .orderBy('m.fechaFin', 'desc')
        .limit(30)
        .execute(),
      db
        .selectFrom('asistencias')
        .select(['id', 'fechaHora', 'origen', 'resultado', 'motivo', 'alerta'])
        .where('socioId', '=', s.id)
        .orderBy('fechaHora', 'desc')
        .limit(30)
        .execute(),
      db
        .selectFrom('bioCola')
        .select(['estado', 'ultimoError'])
        .where('socioId', '=', s.id)
        .where('estado', 'in', ['pendiente', 'procesando', 'error'])
        .execute(),
      db.selectFrom('deudas').select(['id', 'concepto', 'moneda', 'montoTotal', 'saldo', 'creadoEn']).where('socioId', '=', s.id).where('estado', '=', 'pendiente').execute(),
      personalizadosDeSocio(s.id),
    ]);
    res.json({
      ...s,
      vigencia,
      // ¿Queda algo por enviar al lector? (la pantalla "Listo" espera a que llegue a 0)
      bioPendiente: colaBio.length > 0,
      bioReintentando: colaBio.find((c) => c.estado === 'error')?.ultimoError ?? null,
      // La cajera ve planes y fechas, pero no precios históricos
      membresias: esDueno ? membresias : membresias.map(({ precio: _p, ...m }) => m),
      asistencias,
      deudas,
      personalizados,
    });
  }),
);

sociosRouter.post(
  '/',
  ah(async (req, res) => {
    const body = parse(socioSchema, req.body);
    await cedulaLibre(body.cedula);
    const s = await db
      .insertInto('socios')
      .values({
        cedula: body.cedula,
        nombre: body.nombre,
        apellido: body.apellido,
        telefono: body.telefono,
        email: body.email || null,
        fechaNacimiento: body.fechaNacimiento || null,
        genero: body.genero ?? null,
        notas: body.notas || null,
        foto: body.foto ?? null,
        bioEstado: body.foto ? 'pendiente' : 'sin_rostro',
      })
      .returning(['id', 'codigo', 'nombre', 'apellido'])
      .executeTakeFirstOrThrow();
    // Se registra en el lector aunque no tenga membresía (queda con vigencia vencida)
    await encolarSocio(s.id);
    res.status(201).json(s);
  }),
);

sociosRouter.put(
  '/:id',
  ah(async (req, res) => {
    // Editar: se puede mandar solo un campo (ej. el teléfono), pero cédula,
    // nombre y teléfono nunca se pueden dejar vacíos.
    const body = parse(socioSchema.partial(), req.body);
    const prev = await db.selectFrom('socios').select(['id', 'foto', 'nombre', 'apellido']).where('id', '=', req.params.id!).executeTakeFirst();
    if (!prev) throw notFound('Cliente no encontrado');
    if (body.cedula !== undefined) await cedulaLibre(body.cedula, prev.id);
    const fotoCambio = body.foto !== undefined && body.foto !== prev.foto;
    const s = await db
      .updateTable('socios')
      .set({
        ...body,
        ...(body.telefono !== undefined && { telefono: body.telefono || null }),
        ...(fotoCambio && { bioEstado: body.foto ? 'pendiente' : 'sin_rostro', bioError: null }),
        actualizadoEn: sql`now()` as never,
      })
      .where('id', '=', prev.id)
      .returning(['id', 'codigo', 'nombre', 'apellido', 'bioEstado'])
      .executeTakeFirstOrThrow();
    if (fotoCambio && !body.foto) await encolar(s.id, 'sync_usuario');
    if (fotoCambio || body.nombre !== undefined || body.apellido !== undefined) await encolarSocio(s.id);
    res.json(s);
  }),
);

/** Desactivar / reactivar (solo dueño). Al desactivar se borra del lector. */
sociosRouter.post(
  '/:id/estado',
  soloDueno,
  ah(async (req, res) => {
    const { activo } = parse(z.object({ activo: z.boolean() }), req.body);
    const s = await db
      .updateTable('socios')
      .set({ activo, bioEstado: sql`case when foto is null then 'sin_rostro' else 'pendiente' end` as never, actualizadoEn: sql`now()` as never })
      .where('id', '=', req.params.id!)
      .returning(['id'])
      .executeTakeFirst();
    if (!s) throw notFound('Cliente no encontrado');
    if (activo) await encolarSocio(s.id);
    else await encolar(s.id, 'eliminar');
    res.json({ ok: true });
  }),
);

/** Ajuste manual de membresía por el dueño (cortesías, correcciones). No pasa por caja. */
sociosRouter.post(
  '/:id/membresias/:mid/anular',
  soloDueno,
  ah(async (req, res) => {
    const m = await db
      .updateTable('membresias')
      .set({ estado: 'anulada' })
      .where('id', '=', req.params.mid!)
      .where('socioId', '=', req.params.id!)
      .where('ventaId', 'is', null)
      .returning(['id'])
      .executeTakeFirst();
    if (!m) throw badRequest('Solo se anulan aquí las cortesías. Las membresías vendidas se anulan anulando la venta.');
    await encolarSocio(req.params.id!);
    res.json({ ok: true });
  }),
);

/**
 * Editar una membresía (solo dueño y administración): corregir fechas o el plan.
 * NO pasa por caja: no crea venta, no cambia el precio cobrado ni los totales. Queda en la auditoría.
 */
const fechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida');
sociosRouter.put(
  '/:id/membresias/:mid',
  gestionCaja,
  ah(async (req, res) => {
    const b = parse(
      z.object({
        fechaInicio: fechaISO,
        fechaFin: fechaISO,
        planId: z.number().int().positive().optional(),
        motivo: z.string().trim().min(3, 'Escribe el motivo del cambio').max(200),
      }),
      req.body,
    );
    if (b.fechaFin < b.fechaInicio) throw badRequest('La fecha de vencimiento no puede ser antes del inicio');
    const m = await db
      .selectFrom('membresias as m')
      .innerJoin('planes as p', 'p.id', 'm.planId')
      .select(['m.id', 'm.estado', 'm.fechaInicio', 'm.fechaFin', 'm.planId', 'p.nombre as plan', 'p.personas'])
      .where('m.id', '=', req.params.mid!)
      .where('m.socioId', '=', req.params.id!)
      .executeTakeFirst();
    if (!m) throw notFound('Membresía no encontrada');
    if (m.estado !== 'activa') throw badRequest(m.estado === 'congelada' ? 'Reanuda la membresía antes de editarla' : 'Solo se editan membresías activas');
    let plan = { id: m.planId, nombre: m.plan };
    if (b.planId && b.planId !== m.planId) {
      const p = await db.selectFrom('planes').select(['id', 'nombre', 'personas']).where('id', '=', b.planId).where('eliminadoEn', 'is', null).executeTakeFirst();
      if (!p) throw badRequest('Plan no encontrado');
      if (p.personas !== m.personas) throw badRequest(`Solo se puede cambiar por un plan de ${m.personas} persona(s)`);
      plan = p;
    }
    const cambios = [
      m.fechaInicio !== b.fechaInicio || m.fechaFin !== b.fechaFin ? `fechas ${m.fechaInicio}→${m.fechaFin} pasan a ${b.fechaInicio}→${b.fechaFin}` : null,
      plan.id !== m.planId ? `plan ${m.plan} pasa a ${plan.nombre}` : null,
    ].filter(Boolean);
    if (!cambios.length) throw badRequest('No cambiaste nada');
    const u = usuarioActual(req);
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('membresias')
        .set({
          fechaInicio: b.fechaInicio,
          fechaFin: b.fechaFin,
          planId: plan.id,
          notas: sql`coalesce(notas || ' · ', '') || ${`Editada el ${hoy()} por ${u.nombre}: ${cambios.join(', ')} (${b.motivo})`}` as never,
        })
        .where('id', '=', m.id)
        .execute();
      await trx
        .insertInto('auditoria')
        .values({ usuarioId: u.id, accion: 'membresia.editada', detalle: JSON.stringify({ socioId: req.params.id, membresiaId: m.id, antes: { fechaInicio: m.fechaInicio, fechaFin: m.fechaFin, planId: m.planId }, despues: { fechaInicio: b.fechaInicio, fechaFin: b.fechaFin, planId: plan.id }, motivo: b.motivo }) })
        .execute();
    });
    // El lector se actualiza con la nueva vigencia
    await encolarSocio(req.params.id!);
    res.json({ ok: true, cambios });
  }),
);

/** Congelar la membresía vigente (viaje, lesión…): no da acceso y los días se devuelven al reanudar. */
sociosRouter.post(
  '/:id/membresias/:mid/congelar',
  gestionCaja,
  ah(async (req, res) => {
    const { motivo } = parse(z.object({ motivo: z.string().trim().max(200).nullish() }), req.body);
    const r = await congelarMembresia(req.params.mid!, motivo ?? null);
    if (r.socioId !== req.params.id) throw badRequest('La membresía no es de este cliente');
    await db.insertInto('auditoria').values({ usuarioId: usuarioActual(req).id, accion: 'membresia.congelada', detalle: JSON.stringify({ membresiaId: req.params.mid, motivo }) }).execute();
    await encolarSocio(r.socioId);
    res.json({ ok: true });
  }),
);

sociosRouter.post(
  '/:id/membresias/:mid/reanudar',
  gestionCaja,
  ah(async (req, res) => {
    const r = await reanudarMembresia(req.params.mid!);
    await encolarSocio(r.socioId);
    res.json(r);
  }),
);

sociosRouter.post(
  '/:id/cortesia',
  soloDueno,
  ah(async (req, res) => {
    const { dias, motivo } = parse(z.object({ dias: z.number().int().min(1).max(366), motivo: z.string().trim().min(3).max(200) }), req.body);
    const socio = await db.selectFrom('socios').select('id').where('id', '=', req.params.id!).executeTakeFirst();
    if (!socio) throw notFound('Cliente no encontrado');
    const v = await vigenciaSocio(socio.id);
    const plan =
      (await db.selectFrom('planes').select('id').where('nombre', '=', 'Cortesía').executeTakeFirst()) ??
      (await db
        .insertInto('planes')
        .values({ nombre: 'Cortesía', descripcion: 'Días regalados por el dueño', duracionDias: 1, tipoDuracion: 'dias', cantidad: 1, congelable: false, precio: 0, color: '#A78BFA', activo: false, orden: 99 })
        .returning('id')
        .executeTakeFirstOrThrow());
    const inicio = v.hasta && v.hasta >= hoy() ? sumarDias(v.hasta, 1) : hoy();
    await db
      .insertInto('membresias')
      .values({ socioId: socio.id, planId: plan.id, ventaId: null, fechaInicio: inicio, fechaFin: sumarDias(inicio, dias - 1), precio: 0 })
      .execute();
    await db
      .insertInto('auditoria')
      .values({ usuarioId: usuarioActual(req).id, accion: 'membresia.cortesia', detalle: JSON.stringify({ socioId: socio.id, dias, motivo }) })
      .execute();
    await encolarSocio(socio.id);
    res.json({ ok: true });
  }),
);

/** Foto del socio como imagen (se monta ANTES del requireAuth global, valida el token por query). */
export const socioFotoHandler = ah(async (req, res) => {
  const s = await db.selectFrom('socios').select('foto').where('id', '=', req.params.id!).executeTakeFirst();
  if (!s?.foto) throw notFound('Sin foto');
  const buf = Buffer.from(s.foto.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.end(buf);
});
