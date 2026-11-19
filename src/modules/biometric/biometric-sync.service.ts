/**
 * Sincronización socios → lector mediante una cola persistente (outbox).
 *
 * ¿Por qué una cola y no llamar al lector directamente al vender?
 *   • La venta NUNCA debe fallar porque el lector esté apagado o sin red.
 *   • Lo que no se pudo enviar queda en `bio_cola` y se reintenta con backoff
 *     exponencial hasta que el lector vuelva (aunque se reinicie el servidor).
 *   • Operaciones duplicadas se fusionan: solo importa el estado más reciente.
 *
 * Consistencia de vigencias: la ficha del lector lleva Valid.endTime = último
 * día pagado 23:59:59. Así el propio lector rechaza al socio vencido aunque el
 * servidor esté caído. Además, el job nocturno re-sincroniza a quien venció.
 */
import { sql } from 'kysely';
import { db, type Db } from '../../db/index.js';
import { hoy, sumarDias } from '../../lib/util.js';
import { vigenciaSocio } from '../membresias/membresias.service.js';
import { accessControl } from './biometric.factory.js';
import { isAccessControlError } from './contracts/errors.js';
import type { AccessUserDTO } from './dto/access-control.dto.js';

type Operacion = 'sync_usuario' | 'sync_rostro' | 'eliminar';

const MAX_INTENTOS = 12;
const LOTE = 10;

/** Agrega (o reactiva) una operación pendiente para el socio. */
export async function encolar(socioId: string, operacion: Operacion, dbx: Db = db) {
  if (accessControl.mode === 'disabled') return;
  const existente = await dbx
    .selectFrom('bioCola')
    .select('id')
    .where('socioId', '=', socioId)
    .where('operacion', '=', operacion)
    .where('estado', 'in', ['pendiente', 'error'])
    .executeTakeFirst();
  if (existente) {
    await dbx
      .updateTable('bioCola')
      .set({ estado: 'pendiente', intentos: 0, proximoIntento: sql`now()` as never, actualizadoEn: sql`now()` as never })
      .where('id', '=', existente.id)
      .execute();
  } else {
    await dbx
      .insertInto('bioCola')
      .values({ socioId, operacion, proximoIntento: sql`now()` as never, actualizadoEn: sql`now()` as never })
      .execute();
  }
  // Una baja cancela lo que estuviera pendiente para ese socio
  if (operacion === 'eliminar') {
    await dbx
      .updateTable('bioCola')
      .set({ estado: 'descartado', ultimoError: 'Reemplazado por eliminación', actualizadoEn: sql`now()` as never })
      .where('socioId', '=', socioId)
      .where('operacion', '!=', 'eliminar')
      .where('estado', 'in', ['pendiente', 'error'])
      .execute();
  }
  setImmediate(() => void procesarCola());
}

/**
 * Entrenadores en el lector: employeeNo "E<código>" para no chocar con los
 * clientes (que son numéricos). Vigentes mientras estén activos.
 */
export const EMPLEADO_PREFIJO = 'E';

export async function encolarEntrenador(entrenadorId: string) {
  if (accessControl.mode === 'disabled') return;
  const e = await db.selectFrom('entrenadores').select(['foto', 'bioEstado', 'activo']).where('id', '=', entrenadorId).executeTakeFirst();
  if (!e) return;
  const operacion: Operacion = !e.activo ? 'eliminar' : e.foto && e.bioEstado !== 'sincronizado' ? 'sync_rostro' : 'sync_usuario';
  if (operacion === 'sync_rostro') await db.updateTable('entrenadores').set({ bioEstado: 'pendiente' }).where('id', '=', entrenadorId).execute();
  const existente = await db
    .selectFrom('bioCola')
    .select('id')
    .where('entrenadorId', '=', entrenadorId)
    .where('operacion', '=', operacion)
    .where('estado', 'in', ['pendiente', 'error'])
    .executeTakeFirst();
  if (existente) {
    await db.updateTable('bioCola').set({ estado: 'pendiente', intentos: 0, proximoIntento: sql`now()` as never }).where('id', '=', existente.id).execute();
  } else {
    await db.insertInto('bioCola').values({ entrenadorId, operacion, proximoIntento: sql`now()` as never, actualizadoEn: sql`now()` as never }).execute();
  }
  setImmediate(() => void procesarCola());
}

async function fichaEntrenador(entrenadorId: string): Promise<AccessUserDTO | null> {
  const e = await db.selectFrom('entrenadores').select(['codigo', 'nombre', 'apellido', 'activo']).where('id', '=', entrenadorId).executeTakeFirst();
  if (!e) return null;
  return {
    employeeNo: `${EMPLEADO_PREFIJO}${e.codigo}`,
    name: `${e.nombre} ${e.apellido}`.trim(),
    validity: e.activo ? { beginTime: '2020-01-01T00:00:00', endTime: '2037-12-31T23:59:59' } : { beginTime: '2000-01-01T00:00:00', endTime: '2000-01-02T00:00:00' },
    doorNo: 1,
  };
}

/** Encola lo necesario para que el lector refleje el estado actual del socio. */
export async function encolarSocio(socioId: string, dbx: Db = db) {
  const s = await dbx.selectFrom('socios').select(['foto', 'bioEstado']).where('id', '=', socioId).executeTakeFirst();
  if (!s) return;
  // sync_rostro también actualiza la ficha, así que basta con una operación
  if (s.foto && s.bioEstado !== 'sincronizado') {
    await dbx.updateTable('socios').set({ bioEstado: 'pendiente' }).where('id', '=', socioId).execute();
    await encolar(socioId, 'sync_rostro', dbx);
  } else {
    await encolar(socioId, 'sync_usuario', dbx);
  }
}

/** Ficha del lector a partir de los datos y membresías del socio. */
export async function construirFicha(socioId: string): Promise<AccessUserDTO | null> {
  const s = await db.selectFrom('socios').select(['codigo', 'nombre', 'apellido', 'activo']).where('id', '=', socioId).executeTakeFirst();
  if (!s) return null;
  // El lector solo conoce los planes que dan acceso por rostro (no pases diarios)
  const v = await vigenciaSocio(socioId, db, { soloLector: true });
  const ayer = sumarDias(hoy(), -1);
  // Sin membresía vigente (o socio inactivo): ventana ya vencida → el lector lo rechaza
  const validity =
    s.activo && v.desde && v.hasta
      ? { beginTime: `${v.desde}T00:00:00`, endTime: `${v.hasta}T23:59:59` }
      : { beginTime: '2000-01-01T00:00:00', endTime: `${ayer}T23:59:59` };
  return {
    employeeNo: String(s.codigo),
    name: `${s.nombre} ${s.apellido}`.trim(),
    validity,
    doorNo: 1,
  };
}

let corriendo = false;
let repetir = false;

/**
 * Procesa las operaciones vencidas. Seguro de llamar muchas veces: nunca se
 * solapa, y si llega trabajo nuevo mientras corre, da otra vuelta al terminar.
 */
export async function procesarCola(): Promise<{ procesadas: number }> {
  if (accessControl.mode === 'disabled') return { procesadas: 0 };
  if (corriendo) {
    repetir = true;
    return { procesadas: 0 };
  }
  corriendo = true;
  let total = 0;
  try {
    do {
      repetir = false;
      if (accessControl.getCachedStatus().breaker === 'open') break;
      total += await procesarLote();
    } while (repetir);
  } finally {
    corriendo = false;
  }
  return { procesadas: total };
}

async function procesarLote(): Promise<number> {
  let procesadas = 0;
  {
    const filas = await db
      .selectFrom('bioCola as c')
      .leftJoin('socios as s', 's.id', 'c.socioId')
      .leftJoin('entrenadores as e', 'e.id', 'c.entrenadorId')
      .select([
        'c.id',
        'c.socioId',
        'c.entrenadorId',
        'c.operacion',
        'c.intentos',
        sql<string | null>`coalesce(s.codigo::text, ${EMPLEADO_PREFIJO} || e.codigo::text)`.as('employeeNo'),
        sql<string | null>`coalesce(s.foto, e.foto)`.as('foto'),
      ])
      .where('c.estado', 'in', ['pendiente', 'error'])
      .where('c.proximoIntento', '<=', sql<Date>`now()`)
      .orderBy('c.id')
      .limit(LOTE)
      .execute();

    for (const f of filas) {
      await db.updateTable('bioCola').set({ estado: 'procesando', actualizadoEn: sql`now()` as never }).where('id', '=', f.id).execute();
      try {
        if (f.operacion === 'eliminar') {
          if (f.employeeNo != null) {
            await accessControl.deleteFace(f.employeeNo).catch(() => undefined);
            await accessControl.deleteUser(f.employeeNo);
          }
        } else {
          const ficha = f.socioId ? await construirFicha(f.socioId) : f.entrenadorId ? await fichaEntrenador(f.entrenadorId) : null;
          if (!ficha) throw new Error('La persona ya no existe');
          await accessControl.upsertUser(ficha);
          if (f.operacion === 'sync_rostro') {
            if (!f.foto) throw new Error('El cliente no tiene foto');
            await accessControl.upsertFace({ employeeNo: ficha.employeeNo, imageBase64: f.foto });
          }
        }
        await db.updateTable('bioCola').set({ estado: 'ok', ultimoError: null, actualizadoEn: sql`now()` as never }).where('id', '=', f.id).execute();
        if (f.entrenadorId && f.operacion === 'sync_rostro') {
          await db.updateTable('entrenadores').set({ bioEstado: 'sincronizado', bioError: null }).where('id', '=', f.entrenadorId).execute();
        }
        if (f.socioId && f.operacion !== 'eliminar') {
          await db
            .updateTable('socios')
            .set(
              f.operacion === 'sync_rostro'
                ? { bioEstado: 'sincronizado', bioSincronizadoEn: sql`now()` as never, bioError: null }
                : { bioSincronizadoEn: sql`now()` as never },
            )
            .where('id', '=', f.socioId)
            .execute();
        }
        procesadas++;
      } catch (e) {
        const msg = (e as Error).message;
        const reintentar = isAccessControlError(e) ? e.retryable : false;
        const intentos = f.intentos + 1;
        const descartar = !reintentar || intentos >= MAX_INTENTOS;
        const esperaSeg = Math.min(15 * 2 ** (intentos - 1), 30 * 60); // 15s, 30s, 1m … máx 30 min
        await db
          .updateTable('bioCola')
          .set({
            estado: descartar ? 'descartado' : 'error',
            intentos,
            ultimoError: msg.slice(0, 500),
            proximoIntento: sql`now() + make_interval(secs => ${esperaSeg})` as never,
            actualizadoEn: sql`now()` as never,
          })
          .where('id', '=', f.id)
          .execute();
        if (f.entrenadorId && f.operacion === 'sync_rostro') {
          await db
            .updateTable('entrenadores')
            .set({ bioEstado: descartar ? 'error' : 'pendiente', bioError: msg.slice(0, 300) })
            .where('id', '=', f.entrenadorId)
            .execute();
        }
        if (f.socioId && f.operacion === 'sync_rostro') {
          await db
            .updateTable('socios')
            .set({ bioEstado: descartar ? 'error' : 'pendiente', bioError: msg.slice(0, 300) })
            .where('id', '=', f.socioId)
            .execute();
        }
        // Si el lector se cayó no seguimos golpeándolo en este lote
        if (isAccessControlError(e) && ['TIMEOUT', 'UNREACHABLE', 'CIRCUIT_OPEN', 'AUTH'].includes(e.code)) {
          repetir = false;
          break;
        }
      }
    }
    // Lote lleno: puede haber más pendientes
    if (filas.length === LOTE) repetir = true;
  }
  return procesadas;
}

/** Al arrancar: lo que quedó "procesando" por un reinicio vuelve a la cola. */
export async function recuperarCola() {
  await db.updateTable('bioCola').set({ estado: 'pendiente' }).where('estado', '=', 'procesando').execute();
}

/**
 * Job nocturno: re-sincroniza la vigencia de los socios cuya membresía terminó
 * ayer (refuerzo: el lector ya los rechaza por Valid.endTime) y de los que
 * empiezan hoy una renovación no consecutiva.
 */
export async function resincronizarVencimientos() {
  const ayer = sumarDias(hoy(), -1);
  const ids = await db
    .selectFrom('membresias')
    .select('socioId')
    .distinct()
    .where((eb) => eb.or([eb('fechaFin', '=', ayer), eb('fechaInicio', '=', hoy())]))
    .execute();
  for (const { socioId } of ids) await encolar(socioId, 'sync_usuario');
  return ids.length;
}

export async function resumenCola() {
  return db
    .selectFrom('bioCola')
    .select(['estado', (eb) => eb.fn.countAll<number>().as('n')])
    .where('creadoEn', '>', sql<Date>`now() - interval '7 days'`)
    .groupBy('estado')
    .execute();
}
