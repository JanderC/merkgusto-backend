/**
 * Entrenamiento personalizado — /api/personalizados
 *  La recepción ve quién pagó y quién no (sin totales: caja ciega).
 *  Dueño y administración ven además lo cobrado y lo que le toca a cada entrenador.
 */
import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { ah, parse } from '../../lib/http.js';
import { convertir, fmt, MONEDA_REF, redondear } from '../../lib/monedas.js';
import { hoy } from '../../lib/util.js';
import { gestionCaja, usuarioActual } from '../../middleware/auth.js';
import { getTasas } from '../tasas/tasas.service.js';
import { editarFechasPersonalizado, personalizadoSinCobro, personalizadosDeSocio, porLiquidar, tableroPersonalizados } from './personalizados.service.js';

export const personalizadosRouter = Router();

personalizadosRouter.get(
  '/',
  ah(async (req, res) => {
    const q = parse(z.object({ entrenadorId: z.string().uuid().optional(), dias: z.coerce.number().int().min(0).max(365).default(60) }), req.query);
    const gestion = usuarioActual(req).rol !== 'cajero';
    const [filas, entrenadores] = await Promise.all([
      tableroPersonalizados({ entrenadorId: q.entrenadorId, diasVencidos: q.dias }),
      db
        .selectFrom('entrenadores')
        .select(['id', 'nombre', 'apellido', 'especialidad', 'pagoMoneda', 'personalizadoPrecio', 'personalizadoSemanal', 'personalizadoMoneda', 'personalizadoComision', sql<boolean>`foto is not null`.as('tieneFoto')])
        .where('activo', '=', true)
        .orderBy('nombre')
        .execute(),
    ]);

    // Dinero (solo gestión): cobrado este mes y lo que falta pagarle a cada entrenador
    let dinero: Map<string, { cobradoMesTexto: string; cobradoMes: number; porPagarTexto: string; retenidoTexto: string | null }> | null = null;
    let totales: { cobradoMesTexto: string; clientesMes: number } | null = null;
    if (gestion) {
      const t = await getTasas();
      const h = hoy();
      const mes = `${h.slice(0, 7)}-01`;
      const delMes = await db
        .selectFrom('personalizados')
        .select(['entrenadorId', 'precio', 'moneda', 'socioId'])
        .where('estado', '=', 'activa')
        .where('ventaId', 'is not', null)
        .where(sql`creado_en::date`, '>=', mes)
        .execute();
      const liq = await porLiquidar(db, entrenadores.map((e) => e.id), h, (id) => entrenadores.find((e) => e.id === id)!.pagoMoneda, t);
      dinero = new Map();
      for (const e of entrenadores) {
        const cobrado = redondear(
          delMes.filter((p) => p.entrenadorId === e.id).reduce((s, p) => s + convertir(Number(p.precio), p.moneda, MONEDA_REF, t), 0),
          MONEDA_REF,
        );
        const l = liq.get(e.id)!;
        dinero.set(e.id, { cobradoMes: cobrado, cobradoMesTexto: fmt(cobrado, MONEDA_REF), porPagarTexto: l.montoTexto, retenidoTexto: l.retenido > 0 ? l.retenidoTexto : null });
      }
      const total = redondear(delMes.reduce((s, p) => s + convertir(Number(p.precio), p.moneda, MONEDA_REF, t), 0), MONEDA_REF);
      totales = { cobradoMesTexto: fmt(total, MONEDA_REF), clientesMes: new Set(delMes.map((p) => p.socioId)).size };
    }

    const resumen = entrenadores
      .map((e) => {
        const mias = filas.filter((f) => f.entrenadorId === e.id);
        const cuenta = (est: string) => mias.filter((f) => f.estado === est).length;
        return {
          id: e.id,
          nombre: `${e.nombre} ${e.apellido}`.trim(),
          especialidad: e.especialidad,
          tieneFoto: e.tieneFoto,
          tarifaTexto: e.personalizadoPrecio !== null && Number(e.personalizadoPrecio) > 0 ? `${fmt(Number(e.personalizadoPrecio), e.personalizadoMoneda)} al mes` : null,
          semanalTexto: e.personalizadoSemanal !== null && Number(e.personalizadoSemanal) > 0 ? `${fmt(Number(e.personalizadoSemanal), e.personalizadoMoneda)} a la semana` : null,
          comision: Number(e.personalizadoComision),
          clientes: mias.filter((f) => f.estado !== 'sin_pago').length,
          alDia: cuenta('al_dia') + cuenta('por_empezar'),
          vencen: cuenta('vence'),
          vencidos: cuenta('vencido'),
          deben: cuenta('debe'),
          sinPago: cuenta('sin_pago'),
          ...(dinero?.get(e.id) ?? {}),
        };
      })
      .filter((e) => !q.entrenadorId || e.id === q.entrenadorId)
      .filter((e) => e.tarifaTexto || e.clientes);

    res.json({ filas, entrenadores: resumen, totales });
  }),
);

const fechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida');

/** Registrar un personalizado sin cobro (solo dueño y administración). No suma a caja. */
personalizadosRouter.post(
  '/sin-cobro',
  gestionCaja,
  ah(async (req, res) => {
    const b = parse(
      z.object({ socioId: z.string().uuid(), entrenadorId: z.string().uuid(), fechaInicio: fechaISO, fechaFin: fechaISO, motivo: z.string().trim().min(3, 'Escribe el motivo').max(200) }),
      req.body,
    );
    const u = usuarioActual(req);
    const id = await personalizadoSinCobro({ ...b, usuarioId: u.id });
    await db.insertInto('auditoria').values({ usuarioId: u.id, accion: 'personalizado.sin_cobro', detalle: JSON.stringify({ personalizadoId: id, ...b }) }).execute();
    res.status(201).json({ id });
  }),
);

/** Corregir las fechas de un personalizado (solo dueño y administración). No suma a caja. */
personalizadosRouter.put(
  '/:id',
  gestionCaja,
  ah(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const b = parse(z.object({ fechaInicio: fechaISO, fechaFin: fechaISO, motivo: z.string().trim().min(3, 'Escribe el motivo del cambio').max(200) }), req.body);
    const r = await editarFechasPersonalizado(id, b.fechaInicio, b.fechaFin);
    await db
      .insertInto('auditoria')
      .values({ usuarioId: usuarioActual(req).id, accion: 'personalizado.editado', detalle: JSON.stringify({ personalizadoId: id, antes: r.antes, despues: { fechaInicio: b.fechaInicio, fechaFin: b.fechaFin }, motivo: b.motivo }) })
      .execute();
    res.json({ ok: true });
  }),
);

personalizadosRouter.get(
  '/socio/:id',
  ah(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    res.json(await personalizadosDeSocio(id));
  }),
);
