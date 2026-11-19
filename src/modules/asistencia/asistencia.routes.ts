import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { ah, parse } from '../../lib/http.js';
import { hoy } from '../../lib/util.js';
import { usuarioActual } from '../../middleware/auth.js';
import { vigenciaSocio } from '../membresias/membresias.service.js';
import { registrarManual, resumenAsistencia } from './asistencia.service.js';

export const asistenciaRouter = Router();

asistenciaRouter.get(
  '/',
  ah(async (req, res) => {
    const q = parse(
      z.object({
        fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        resultado: z.enum(['permitido', 'denegado']).optional(),
        desdeId: z.coerce.number().int().optional(),
        limite: z.coerce.number().int().min(1).max(500).default(150),
      }),
      req.query,
    );
    const fecha = q.fecha ?? hoy();
    let query = db
      .selectFrom('asistencias as a')
      .leftJoin('socios as s', 's.id', 'a.socioId')
      .leftJoin('usuarios as u', 'u.id', 'a.registradoPor')
      .select([
        'a.id',
        'a.fechaHora',
        'a.origen',
        'a.resultado',
        'a.motivo',
        'a.alerta',
        'a.employeeNo',
        'a.metodoVerif',
        's.id as socioId',
        's.codigo',
        sql<string | null>`nullif(trim(s.nombre || ' ' || s.apellido), '')`.as('socio'),
        sql<boolean>`s.foto is not null`.as('tieneFoto'),
        'u.nombre as registradoPor',
      ])
      .where(sql`a.fecha_hora::date`, '=', fecha)
      .orderBy('a.fechaHora', 'desc')
      .limit(q.limite);
    if (q.resultado) query = query.where('a.resultado', '=', q.resultado);
    if (q.desdeId) query = query.where('a.id', '>', q.desdeId);
    const [items, resumen] = await Promise.all([query.execute(), resumenAsistencia(fecha)]);
    res.json({ fecha, resumen, items });
  }),
);

/** Último acceso (para la pantalla de bienvenida de la entrada). */
asistenciaRouter.get(
  '/ultimo',
  ah(async (_req, res) => {
    const a = await db
      .selectFrom('asistencias as a')
      .leftJoin('socios as s', 's.id', 'a.socioId')
      .select([
        'a.id',
        'a.fechaHora',
        'a.resultado',
        'a.motivo',
        'a.origen',
        's.id as socioId',
        's.nombre',
        's.apellido',
        sql<boolean>`s.foto is not null`.as('tieneFoto'),
      ])
      .orderBy('a.id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!a) return res.json(null);
    const vigencia = a.socioId ? await vigenciaSocio(a.socioId) : null;
    res.json({ ...a, vigencia, resumen: await resumenAsistencia(hoy()) });
  }),
);

asistenciaRouter.post(
  '/manual',
  ah(async (req, res) => {
    const { socioId } = parse(z.object({ socioId: z.string().uuid() }), req.body);
    res.status(201).json(await registrarManual(socioId, usuarioActual(req).id));
  }),
);
