/**
 * Crea la base de datos (si no existe) y aplica los scripts de /database en orden.
 *   npm run db:migrate
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from '../config/env.js';
import { connectionConfig } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_DIR = path.resolve(here, '../../database');

async function ensureDatabase() {
  if (env.DATABASE_URL) return;
  const admin = new pg.Client(connectionConfig('postgres'));
  await admin.connect();
  const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [env.DB_NAME]);
  if (!rowCount) {
    await admin.query(`create database "${env.DB_NAME.replace(/"/g, '')}"`);
    console.log(`✓ Base de datos "${env.DB_NAME}" creada`);
  }
  await admin.end();
}

export async function migrate() {
  await ensureDatabase();
  const client = new pg.Client(connectionConfig());
  await client.connect();
  try {
    await client.query(`create table if not exists _migraciones (
      nombre varchar(200) primary key,
      aplicada_en timestamptz default now()
    )`);
    const done = new Set((await client.query<{ nombre: string }>('select nombre from _migraciones')).rows.map((r) => r.nombre));
    const files = fs
      .readdirSync(DATABASE_DIR)
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(DATABASE_DIR, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into _migraciones (nombre) values ($1)', [file]);
        await client.query('commit');
        console.log(`✓ Migración aplicada: ${file}`);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Falló la migración ${file}: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌', err.message);
      process.exit(1);
    });
}
