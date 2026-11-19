/**
 * Archivos privados: fotos de marcaciones de entrenadores, soportes de
 * permisos y comprobantes de egresos.
 *
 * Todo se guarda en el disco del propio servidor (ARCHIVOS_DIR, por defecto
 * STORAGE_DIR/archivos), sin servicios externos: funciona sin internet.
 * Se sirven por la API, solo con sesión.
 *
 * Los rostros de clientes y entrenadores (para el lector) van en la base de
 * datos, así entran en el respaldo de PostgreSQL.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env, STORAGE_DIR } from '../../config/env.js';
import { db } from '../../db/index.js';
import { badRequest, notFound } from '../../lib/http.js';

export const DIR_ARCHIVOS = path.resolve(env.ARCHIVOS_DIR || path.join(STORAGE_DIR, 'archivos'));
const MAX_BYTES = 4 * 1024 * 1024;
const TIPOS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

/** Crea la carpeta de archivos si no existe (se llama al arrancar). */
export function prepararAlmacenamiento() {
  fs.mkdirSync(DIR_ARCHIVOS, { recursive: true });
  return DIR_ARCHIVOS;
}

/** Decodifica un data URL (data:image/jpeg;base64,...) validando tipo y tamaño. */
export function decodificarDataUrl(dataUrl: string): { buf: Buffer; mime: string } {
  const m = dataUrl.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) throw badRequest('Archivo inválido');
  const mime = m[1]!.toLowerCase();
  if (!TIPOS[mime]) throw badRequest('Solo se aceptan imágenes JPG, PNG, WEBP o PDF');
  const buf = Buffer.from(m[2]!, 'base64');
  if (buf.length > MAX_BYTES) throw badRequest('El archivo pesa más de 4 MB');
  return { buf, mime };
}

/** Guarda un archivo en disco y devuelve su id. `carpeta` ej. "entrenadores/marcaciones". */
export async function guardarArchivo(dataUrl: string, carpeta: string, usuarioId: string | null): Promise<number> {
  const { buf, mime } = decodificarDataUrl(dataUrl);
  const fecha = new Date().toISOString().slice(0, 10);
  const ruta = `${carpeta}/${fecha}/${crypto.randomUUID()}.${TIPOS[mime]}`;
  const destino = path.join(DIR_ARCHIVOS, ruta);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, buf);
  try {
    const fila = await db
      .insertInto('archivos')
      .values({ proveedor: 'local', bucket: null, ruta, mime, bytes: buf.length, creadoPor: usuarioId })
      .returning('id')
      .executeTakeFirstOrThrow();
    return fila.id;
  } catch (e) {
    fs.rmSync(destino, { force: true }); // sin registro no queda archivo huérfano
    throw e;
  }
}

/** Ruta en disco de un archivo, validada para que no salga de la carpeta. */
export async function abrirArchivo(id: number): Promise<{ ruta: string; mime: string }> {
  const a = await db.selectFrom('archivos').selectAll().where('id', '=', id).executeTakeFirst();
  if (!a) throw notFound('Archivo no encontrado');
  const ruta = path.resolve(DIR_ARCHIVOS, a.ruta);
  if (!ruta.startsWith(DIR_ARCHIVOS + path.sep) || !fs.existsSync(ruta)) throw notFound('Archivo no encontrado');
  return { ruta, mime: a.mime };
}
