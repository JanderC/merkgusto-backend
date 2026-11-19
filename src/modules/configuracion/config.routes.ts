import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { ah, badRequest, notFound, parse } from '../../lib/http.js';
import { MONEDA_REF } from '../../lib/monedas.js';
import { soloDueno } from '../../middleware/auth.js';
import { tasaVigente } from '../tasas/tasas.service.js';
import { cajaSchema, categoriasSchema, getConfig, gymSchema, setConfig, whatsappSchema } from './config.service.js';

export const configRouter = Router();

/** Datos visibles para cualquier usuario con sesión. */
configRouter.get(
  '/publica',
  ah(async (_req, res) => {
    const [gym, t] = await Promise.all([getConfig('gym'), tasaVigente()]);
    res.json({
      nombre: gym.nombre,
      slogan: gym.slogan,
      moneda: '$',
      monedaRef: MONEDA_REF,
      tasas: { usdVes: t.usdVes, usdCop: t.usdCop, vesCop: t.vesCop },
      tablero: { dolar: t.dolar, bs: t.bs },
      tasasActualizadas: t.creadoEn,
      tasasPor: t.creadoPor,
      fuenteUsdVes: t.fuenteUsdVes,
    });
  }),
);

configRouter.get(
  '/',
  soloDueno,
  ah(async (_req, res) => {
    const [gym, whatsapp, caja, categorias, metodos] = await Promise.all([
      getConfig('gym'),
      getConfig('whatsapp'),
      getConfig('caja'),
      getConfig('categorias'),
      db.selectFrom('metodosPago').selectAll().orderBy('orden').execute(),
    ]);
    res.json({ gym, whatsapp, caja, categorias, metodos, monedaRef: MONEDA_REF });
  }),
);

configRouter.put('/gym', soloDueno, ah(async (req, res) => res.json(await setConfig('gym', parse(gymSchema.partial(), req.body)))));
configRouter.put('/whatsapp', soloDueno, ah(async (req, res) => res.json(await setConfig('whatsapp', parse(whatsappSchema.partial(), req.body)))));
configRouter.put('/caja', soloDueno, ah(async (req, res) => res.json(await setConfig('caja', parse(cajaSchema.partial(), req.body)))));
configRouter.put('/categorias', soloDueno, ah(async (req, res) => res.json(await setConfig('categorias', parse(categoriasSchema.partial(), req.body)))));

const monedas = z.array(z.enum(['USD', 'VES', 'COP'])).min(1, 'Elige al menos una moneda');

/** Nuevo método de pago (Daviplata, Zinli, Binance…). */
configRouter.post(
  '/metodos',
  soloDueno,
  ah(async (req, res) => {
    const b = parse(z.object({ nombre: z.string().trim().min(2).max(40), monedas, pideReferencia: z.boolean().default(true) }), req.body);
    const codigo =
      b.nombre
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 20) || 'metodo';
    const existe = await db.selectFrom('metodosPago').select('codigo').where('codigo', '=', codigo).executeTakeFirst();
    if (existe) throw badRequest('Ya existe un método con ese nombre');
    const { max } = await db.selectFrom('metodosPago').select((eb) => eb.fn.max('orden').as('max')).executeTakeFirstOrThrow();
    res.status(201).json(
      await db
        .insertInto('metodosPago')
        .values({ codigo, nombre: b.nombre, monedas: b.monedas, pideReferencia: b.pideReferencia, orden: Number(max ?? 0) + 1 })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }),
);

configRouter.put(
  '/metodos/:codigo',
  soloDueno,
  ah(async (req, res) => {
    const b = parse(z.object({ nombre: z.string().trim().min(2).max(40).optional(), activo: z.boolean().optional(), pideReferencia: z.boolean().optional(), monedas: monedas.optional() }), req.body);
    if (req.params.codigo === 'efectivo' && b.activo === false) throw badRequest('El efectivo no se puede desactivar');
    const m = await db.updateTable('metodosPago').set(b).where('codigo', '=', req.params.codigo!).returningAll().executeTakeFirst();
    if (!m) throw notFound('Método no encontrado');
    res.json(m);
  }),
);
