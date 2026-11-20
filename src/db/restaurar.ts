/**
 * Restaurar un respaldo (BORRA los datos actuales):
 *   npm run db:restaurar -- storage/respaldos/respaldo-2026-11-20_03-00-00-auto.json.gz --si
 * Antes de restaurar se hace un respaldo de lo que hay ahora, por si acaso.
 */
import fs from 'node:fs';
import { hacerRespaldo, restaurarRespaldo } from '../modules/respaldos/respaldos.service.js';
import { migrate } from './migrate.js';
import { db } from './index.js';

const archivo = process.argv.slice(2).find((a) => !a.startsWith('--'));
const confirmado = process.argv.includes('--si');

if (!archivo || !fs.existsSync(archivo)) {
  console.error('Uso: npm run db:restaurar -- <archivo.json.gz> --si');
  process.exit(1);
}
if (!confirmado) {
  console.error('⚠ Esto BORRA todos los datos actuales y los reemplaza por los del respaldo.');
  console.error('  Si estás seguro, repite el comando agregando --si al final.');
  process.exit(1);
}

try {
  await migrate();
  const antes = await hacerRespaldo('manual');
  console.log(`✓ Respaldo de seguridad de lo actual: ${antes.nombre}`);
  const r = await restaurarRespaldo(archivo);
  console.log(`✓ Restaurado el respaldo del ${new Date(r.creadoEn).toLocaleString('es-VE')}: ${r.filas} registros en ${r.tablas} tablas`);
} catch (e) {
  console.error('✗ No se pudo restaurar:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
