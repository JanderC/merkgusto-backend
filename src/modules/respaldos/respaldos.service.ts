/**
 * Respaldos de la base de datos (sin pg_dump: funciona en Railway y en la PC del gym).
 *   • Cada noche se guarda una copia completa en STORAGE_DIR/respaldos (se conservan los últimos 14).
 *   • El dueño puede hacer uno al instante y descargarlo desde Ajustes.
 *   • Para restaurar:  npm run db:restaurar -- <archivo.json.gz> --si
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { env, STORAGE_DIR } from '../../config/env.js';
import { pool } from '../../db/index.js';

export const DIR_RESPALDOS = path.join(STORAGE_DIR, 'respaldos');
const CONSERVAR = 14;
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const NOMBRE = /^respaldo-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-[a-z]+)?\.json\.gz$/;

interface Respaldo {
  formato: 'merkgusto-respaldo';
  version: 1;
  creadoEn: string;
  gym: string;
  migraciones: string[];
  tablas: Record<string, unknown[]>;
}

async function tablas(): Promise<string[]> {
  const r = await pool.query<{ t: string }>(`select table_name as t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> '_migraciones' order by table_name`);
  return r.rows.map((x) => x.t);
}

const sello = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

/** Toma una foto consistente de toda la base de datos y la guarda comprimida. */
export async function hacerRespaldo(origen: 'auto' | 'manual' = 'manual') {
  const client = await pool.connect();
  const datos: Respaldo = { formato: 'merkgusto-respaldo', version: 1, creadoEn: new Date().toISOString(), gym: env.GYM_NOMBRE, migraciones: [], tablas: {} };
  try {
    // Una sola transacción de solo lectura: todas las tablas en el mismo instante
    await client.query('begin isolation level repeatable read read only');
    datos.migraciones = (await client.query<{ nombre: string }>('select nombre from _migraciones order by nombre')).rows.map((r) => r.nombre);
    for (const t of await tablas()) {
      // Se exporta como JSON desde PostgreSQL para que tipos (fechas, numéricos, jsonb) vuelvan idénticos
      const r = await client.query<{ filas: unknown[] | null }>(`select json_agg(x) as filas from "${t.replace(/"/g, '')}" x`);
      datos.tablas[t] = r.rows[0]?.filas ?? [];
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  fs.mkdirSync(DIR_RESPALDOS, { recursive: true });
  const nombre = `respaldo-${sello()}${origen === 'auto' ? '-auto' : ''}.json.gz`;
  const buf = await gzip(Buffer.from(JSON.stringify(datos)));
  fs.writeFileSync(path.join(DIR_RESPALDOS, nombre), buf);
  limpiar();
  const filas = Object.values(datos.tablas).reduce((s, x) => s + x.length, 0);
  return { nombre, bytes: buf.length, tablas: Object.keys(datos.tablas).length, filas, creadoEn: datos.creadoEn };
}

function limpiar() {
  const lista = listarRespaldos();
  for (const r of lista.slice(CONSERVAR)) fs.rmSync(path.join(DIR_RESPALDOS, r.nombre), { force: true });
}

export function listarRespaldos() {
  if (!fs.existsSync(DIR_RESPALDOS)) return [];
  return fs
    .readdirSync(DIR_RESPALDOS)
    .filter((f) => NOMBRE.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(DIR_RESPALDOS, f));
      return { nombre: f, bytes: st.size, creadoEn: st.mtime.toISOString(), automatico: f.includes('-auto') };
    })
    .sort((a, b) => b.creadoEn.localeCompare(a.creadoEn));
}

export function rutaRespaldo(nombre: string) {
  if (!NOMBRE.test(nombre)) return null;
  const ruta = path.join(DIR_RESPALDOS, nombre);
  return fs.existsSync(ruta) ? ruta : null;
}

/**
 * Restaura un respaldo: BORRA todo lo actual y deja la base exactamente como estaba.
 * Solo desde la línea de comandos (nunca desde la web).
 */
export async function restaurarRespaldo(archivo: string) {
  const datos = JSON.parse((await gunzip(fs.readFileSync(archivo))).toString('utf8')) as Respaldo;
  if (datos.formato !== 'merkgusto-respaldo') throw new Error('Ese archivo no es un respaldo del sistema');
  const client = await pool.connect();
  try {
    const actuales = (await client.query<{ nombre: string }>('select nombre from _migraciones order by nombre')).rows.map((r) => r.nombre);
    const faltan = datos.migraciones.filter((m) => !actuales.includes(m));
    if (faltan.length) throw new Error(`El respaldo es de una versión más nueva del sistema (${faltan.join(', ')}). Actualiza el sistema antes de restaurar.`);
    const existentes = await tablas();
    await client.query('begin');
    // Sin revisar llaves foráneas mientras se recargan las tablas (todo queda consistente al final)
    await client.query('set local session_replication_role = replica');
    await client.query(`truncate ${existentes.map((t) => `"${t}"`).join(', ')} restart identity cascade`);
    let filas = 0;
    for (const t of existentes) {
      const rows = datos.tablas[t] ?? [];
      // Por bloques: tablas con fotos pueden pesar bastante
      for (let i = 0; i < rows.length; i += 500) {
        const bloque = rows.slice(i, i + 500);
        await client.query(`insert into "${t}" overriding system value select * from json_populate_recordset(null::"${t}", $1::json)`, [JSON.stringify(bloque)]);
        filas += bloque.length;
      }
    }
    // Los contadores (identity / serial) siguen desde el último id restaurado
    const seqs = await client.query<{ t: string; c: string }>(
      `select table_name as t, column_name as c from information_schema.columns where table_schema = 'public' and (is_identity = 'YES' or column_default like 'nextval(%')`,
    );
    for (const s of seqs.rows) {
      await client.query(`select setval(pg_get_serial_sequence('"${s.t}"', '${s.c}'), coalesce((select max("${s.c}") from "${s.t}"), 0) + 1, false)`);
    }
    await client.query('commit');
    return { tablas: existentes.length, filas, creadoEn: datos.creadoEn };
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
