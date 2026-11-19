/**
 * Módulo de Membresías: quién tiene qué plan, cuántos días le quedan y si el
 * lector le abre. Lo ven todos (la cajera también: "¿cuántos días me quedan?").
 * No expone precios.
 */
import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { ah, notFound, parse } from '../../lib/http.js';
import { diasEntre, hoy, sumarDias } from '../../lib/util.js';
import { encolarSocio } from '../biometric/biometric-sync.service.js';
import { vigenciaDesdeFilas } from './membresias.service.js';

export const membresiasRouter = Router();

/** Vencidas hace más de esto ya no se listan (se consideran clientes inactivos). */
const DIAS_VENCIDAS = 90;
const POR_VENCER = 5;

export type EstadoMembresia = 'vigente' | 'por_vencer' | 'vence_hoy' | 'por_empezar' | 'congelada' | 'vencida';

membresiasRouter.get(
  '/',
  ah(async (req, res) => {
    const { dias } = parse(z.object({ dias: z.coerce.number().int().min(7).max(730).default(DIAS_VENCIDAS) }), req.query);
    const h = hoy();
    const desdeVencidas = sumarDias(h, -dias);
    const [filas, planes] = await Promise.all([
      db
        .selectFrom('membresias as m')
        .innerJoin('planes as p', 'p.id', 'm.planId')
        .innerJoin('socios as s', 's.id', 'm.socioId')
        .select([
          'm.id',
          'm.socioId',
          'm.fechaInicio',
          'm.fechaFin',
          'm.estado',
          'm.congeladaDesde',
          'p.id as planId',
          'p.nombre',
          'p.color',
          'p.accesoLector',
          's.codigo',
          's.nombre as socioNombre',
          's.apellido',
          's.cedula',
          's.telefono',
          's.bioEstado',
          sql<boolean>`s.foto is not null`.as('tieneFoto'),
        ])
        .where('s.activo', '=', true)
        .where('m.estado', 'in', ['activa', 'congelada'])
        // Solo socios con algo vigente, congelado o vencido hace poco
        .where(sql<boolean>`exists (select 1 from membresias x where x.socio_id = s.id and x.estado in ('activa', 'congelada') and (x.estado = 'congelada' or x.fecha_fin >= ${desdeVencidas}))`)
        .orderBy('m.fechaFin', 'desc')
        .execute(),
      db.selectFrom('planes').select(['id', 'nombre', 'color', 'accesoLector', 'activo', 'orden']).where('eliminadoEn', 'is', null).orderBy('orden').orderBy('nombre').execute(),
    ]);

    const porSocio = new Map<string, typeof filas>();
    for (const f of filas) {
      const l = porSocio.get(f.socioId);
      if (l) l.push(f);
      else porSocio.set(f.socioId, [f]);
    }
    const ids = [...porSocio.keys()];
    const visitas = ids.length
      ? await db
          .selectFrom('asistencias')
          .select(['socioId', sql<Date>`max(fecha_hora)`.as('ultima')])
          .where('socioId', 'in', ids)
          .where('resultado', '=', 'permitido')
          .groupBy('socioId')
          .execute()
      : [];
    const ultimaVisita = new Map(visitas.map((v) => [v.socioId, v.ultima]));

    const lista = [...porSocio.values()].map((rows) => {
      const s = rows[0]!;
      const v = vigenciaDesdeFilas(rows, h);
      const a = v.actual ?? s;
      let estado: EstadoMembresia;
      if (v.congelada) estado = 'congelada';
      else if (v.vigente) estado = v.diasRestantes <= 1 ? 'vence_hoy' : v.diasRestantes <= POR_VENCER ? 'por_vencer' : 'vigente';
      else if (v.desde && v.desde > h) estado = 'por_empezar';
      else estado = 'vencida';
      const dentro = estado === 'vigente' || estado === 'por_vencer' || estado === 'vence_hoy';

      // ¿Cómo entra hoy?
      let acceso: { tipo: 'lector' | 'recepcion' | 'pendiente' | 'bloqueado'; texto: string };
      if (estado === 'congelada') acceso = { tipo: 'bloqueado', texto: 'Congelada: no entra' };
      else if (estado === 'vencida') acceso = { tipo: 'bloqueado', texto: 'Vencida: el lector no le abre' };
      else if (estado === 'por_empezar') acceso = { tipo: 'bloqueado', texto: `Empieza el ${v.desde}` };
      else if (!a.accesoLector) acceso = { tipo: 'recepcion', texto: 'Pase por recepción (el lector no le abre)' };
      else if (!s.tieneFoto) acceso = { tipo: 'recepcion', texto: 'Sin rostro: entra por recepción' };
      else if (s.bioEstado === 'sincronizado') acceso = { tipo: 'lector', texto: 'El lector le abre' };
      else if (s.bioEstado === 'error') acceso = { tipo: 'pendiente', texto: 'Error al enviar al lector' };
      else acceso = { tipo: 'pendiente', texto: 'Enviando al lector…' };

      return {
        socioId: s.socioId,
        codigo: s.codigo,
        nombre: s.socioNombre,
        apellido: s.apellido,
        cedula: s.cedula,
        telefono: s.telefono,
        tieneFoto: s.tieneFoto,
        bioEstado: s.bioEstado,
        planId: a.planId,
        plan: a.nombre,
        color: a.color,
        estado,
        desde: v.desde ?? a.fechaInicio,
        hasta: v.hasta ?? v.ultimaFin,
        diasRestantes: dentro ? v.diasRestantes : 0,
        diasVencida: estado === 'vencida' && v.ultimaFin ? diasEntre(v.ultimaFin, h) : null,
        proximoPago: v.hasta ? sumarDias(v.hasta, 1) : v.ultimaFin ? sumarDias(v.ultimaFin, 1) : null,
        congeladaDesde: v.congelada?.desde ?? null,
        diasCongelada: v.congelada?.dias ?? null,
        membresiaCongeladaId: v.congelada?.membresiaId ?? null,
        membresiaActualId: estado !== 'vencida' && estado !== 'congelada' ? (v.actual?.id ?? null) : null,
        acceso,
        ultimaVisita: ultimaVisita.get(s.socioId) ?? null,
      };
    });

    const orden: Record<EstadoMembresia, number> = { vence_hoy: 0, por_vencer: 1, vigente: 2, por_empezar: 3, congelada: 4, vencida: 5 };
    lista.sort((x, y) => orden[x.estado] - orden[y.estado] || (x.estado === 'vencida' ? (x.diasVencida ?? 0) - (y.diasVencida ?? 0) : x.diasRestantes - y.diasRestantes) || x.nombre.localeCompare(y.nombre));

    const contar = (l: typeof lista) => ({
      vigentes: l.filter((x) => ['vigente', 'por_vencer', 'vence_hoy'].includes(x.estado)).length,
      porVencer: l.filter((x) => x.estado === 'por_vencer').length,
      venceHoy: l.filter((x) => x.estado === 'vence_hoy').length,
      porEmpezar: l.filter((x) => x.estado === 'por_empezar').length,
      congeladas: l.filter((x) => x.estado === 'congelada').length,
      vencidas: l.filter((x) => x.estado === 'vencida').length,
      sinLector: l.filter((x) => ['vigente', 'por_vencer', 'vence_hoy'].includes(x.estado) && x.acceso.tipo !== 'lector').length,
    });

    res.json({
      hoy: h,
      diasVencidas: dias,
      porVencerDias: POR_VENCER,
      resumen: contar(lista),
      planes: planes
        .map((p) => ({ ...p, ...contar(lista.filter((x) => x.planId === p.id)) }))
        .filter((p) => p.activo || p.vigentes || p.congeladas || p.vencidas),
      filas: lista,
    });
  }),
);

/** Volver a mandar al cliente al lector (rostro + vigencia). */
membresiasRouter.post(
  '/:socioId/lector',
  ah(async (req, res) => {
    const s = await db.selectFrom('socios').select(['id', 'foto']).where('id', '=', req.params.socioId!).executeTakeFirst();
    if (!s) throw notFound('Cliente no encontrado');
    if (s.foto) await db.updateTable('socios').set({ bioEstado: 'pendiente', bioError: null }).where('id', '=', s.id).execute();
    await encolarSocio(s.id);
    res.json({ ok: true });
  }),
);
