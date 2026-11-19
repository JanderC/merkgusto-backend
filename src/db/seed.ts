/**
 * Datos iniciales: dueño, métodos de pago, planes y productos de ejemplo.
 * Solo inserta lo que falta, se puede ejecutar varias veces.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { db } from './index.js';
import type { Moneda } from './types.js';

export async function seed() {
  const dueno = await db.selectFrom('usuarios').select('id').where('rol', '=', 'dueno').executeTakeFirst();
  if (!dueno) {
    await db
      .insertInto('usuarios')
      .values({
        nombre: env.DUENO_NOMBRE,
        usuario: env.DUENO_USUARIO.toLowerCase(),
        passwordHash: await bcrypt.hash(env.DUENO_PASSWORD, 10),
        rol: 'dueno',
        telefono: null,
      })
      .execute();
    console.log(`✓ Usuario dueño creado: ${env.DUENO_USUARIO}`);
  }

  const metodos = [
    { codigo: 'efectivo', nombre: 'Efectivo', pideReferencia: false, orden: 1, monedas: ['USD', 'VES', 'COP'] as Moneda[] },
    { codigo: 'pago_movil', nombre: 'Pago Móvil', pideReferencia: true, orden: 2, monedas: ['VES'] as Moneda[] },
    { codigo: 'punto', nombre: 'Punto de venta', pideReferencia: false, orden: 3, monedas: ['VES'] as Moneda[] },
    { codigo: 'transferencia', nombre: 'Transferencia', pideReferencia: true, orden: 4, monedas: ['VES', 'COP'] as Moneda[] },
    { codigo: 'divisas', nombre: 'Zelle', pideReferencia: true, orden: 5, monedas: ['USD'] as Moneda[] },
  ];
  await db
    .insertInto('metodosPago')
    .values(metodos)
    .onConflict((oc) => oc.column('codigo').doNothing())
    .execute();

  const { n: planes } = await db
    .selectFrom('planes')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow();
  if (!planes) {
    await db
      .insertInto('planes')
      .values([
        { nombre: 'Pase diario', descripcion: 'Acceso por un día', tipoDuracion: 'dias', cantidad: 1, duracionDias: 1, precio: 10000, moneda: 'COP', congelable: false, accesoLector: false, color: '#BABFC8', orden: 1 },
        { nombre: 'Semanal', descripcion: '7 días de acceso libre', tipoDuracion: 'semanas', cantidad: 1, duracionDias: 7, precio: 10, moneda: 'USD', congelable: false, color: '#7DD3FC', orden: 2 },
        { nombre: 'Mensual', descripcion: 'Mes a mes, acceso libre', tipoDuracion: 'meses', cantidad: 1, duracionDias: 30, precio: 25, moneda: 'USD', color: '#FF8A10', orden: 3 },
        { nombre: 'Trimestral', descripcion: '3 meses · ahorra más', tipoDuracion: 'meses', cantidad: 3, duracionDias: 90, precio: 65, moneda: 'USD', maxDiasCongelado: 45, color: '#A3E635', orden: 4 },
        { nombre: 'Promo Dúo', descripcion: 'Mensual para 2 personas', tipoDuracion: 'meses', cantidad: 1, duracionDias: 30, precio: 45, moneda: 'USD', personas: 2, color: '#F472B6', orden: 5 },
      ])
      .execute();
    console.log('✓ Planes de ejemplo creados');
  }

  const { n: productos } = await db
    .selectFrom('productos')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow();
  if (!productos) {
    await db
      .insertInto('productos')
      .values([
        { nombre: 'Agua 600 ml', categoria: 'Bebidas', precio: 4500, moneda: 'COP', costo: 2500, stock: 48, stockMinimo: 12 },
        { nombre: 'Bebida hidratante', categoria: 'Bebidas', precio: 7000, moneda: 'COP', costo: 4200, stock: 24, stockMinimo: 6 },
        { nombre: 'Batido de proteína', categoria: 'Suplementos', precio: 4, moneda: 'USD', costo: 2.2, stock: 15, stockMinimo: 5 },
        { nombre: 'Barra energética', categoria: 'Snacks', precio: 6000, moneda: 'COP', costo: 3500, stock: 30, stockMinimo: 8 },
      ])
      .execute();
    console.log('✓ Productos de ejemplo creados');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  seed()
    .then(() => db.destroy())
    .catch((err) => {
      console.error('❌', err.message);
      process.exit(1);
    });
}
