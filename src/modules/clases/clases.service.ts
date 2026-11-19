/**
 * Recordatorios de clases por WhatsApp.
 *
 *  • Automático: N horas antes de la clase (configurable, 3 h por defecto).
 *    Las clases de madrugada (antes de las 9 AM) se recuerdan la noche anterior
 *    entre 7 y 9 PM. Nunca se escribe entre 9 PM y 6 AM.
 *  • Manual: la cajera toca "Enviar recordatorio" en la clase.
 *  • Si la clase se cancela, se avisa a los inscritos.
 * Cada persona recibe el recordatorio una sola vez por clase.
 */
import { sql } from 'kysely';
import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import type { CaracteristicaClase } from '../../db/types.js';
import { conflict, notFound } from '../../lib/http.js';
import { fechaLarga, hoy, horaCorta, sumarDias } from '../../lib/util.js';
import { getConfig } from '../configuracion/config.service.js';
import { enviarUnaVez } from '../whatsapp/reportes.service.js';
import { whatsapp } from '../whatsapp/whatsapp.service.js';

const NOMBRES: Record<CaracteristicaClase, string> = {
  movilidad: 'movilidad',
  fuerza: 'fuerza',
  cardio: 'cardio',
  resistencia: 'resistencia',
  potencia: 'potencia',
  desplazamiento: 'desplazamiento',
};
const NIVEL: Record<string, string> = { principiante: 'principiante', intermedio: 'intermedio', avanzado: 'avanzado', todos: 'todos los niveles' };

interface ClaseAviso {
  id: number;
  nombre: string;
  inicio: Date;
  duracionMin: number;
  nivel: string | null;
  caracteristicas: Partial<Record<CaracteristicaClase, number>>;
  entrenador: string | null;
  motivoCancelacion?: string | null;
}

const diaLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function cuando(inicio: Date) {
  const dia = diaLocal(inicio);
  const h = hoy();
  return dia === h ? 'hoy' : dia === sumarDias(h, 1) ? 'mañana' : `el ${fechaLarga(dia)}`;
}

export async function textoRecordatorioClase(c: ClaseAviso, nombre: string) {
  const gym = await getConfig('gym');
  const trabaja = Object.entries(c.caracteristicas)
    .filter(([, v]) => (v ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([k]) => NOMBRES[k as CaracteristicaClase]);
  const lista = trabaja.length > 1 ? `${trabaja.slice(0, -1).join(', ')} y ${trabaja.at(-1)}` : trabaja[0];
  return [
    `¡Hola ${nombre}! 💪`,
    `Te esperamos ${cuando(c.inicio)} a las *${horaCorta(c.inicio)}* en la clase *${c.nombre}*${c.entrenador ? ` con ${c.entrenador}` : ''} en *${gym.nombre}*.`,
    lista ? `🔥 Trabajaremos ${lista}.` : null,
    `⏱ ${c.duracionMin} min${c.nivel ? ` · Nivel ${NIVEL[c.nivel] ?? c.nivel}` : ''}`,
    'Llega 10 minutos antes y trae toalla e hidratación. ¡Nos vemos! 🧡',
  ]
    .filter(Boolean)
    .join('\n');
}

async function textoCancelacion(c: ClaseAviso, nombre: string) {
  const gym = await getConfig('gym');
  return `Hola ${nombre} 🙏 La clase *${c.nombre}* de ${cuando(c.inicio)} a las ${horaCorta(c.inicio)} en *${gym.nombre}* fue cancelada${c.motivoCancelacion ? `: ${c.motivoCancelacion}` : ''}. Disculpa las molestias, te avisamos la próxima.`;
}

async function claseAviso(id: number) {
  const c = await db
    .selectFrom('clases as c')
    .leftJoin('entrenadores as e', 'e.id', 'c.entrenadorId')
    .select(['c.id', 'c.nombre', 'c.inicio', 'c.duracionMin', 'c.nivel', 'c.caracteristicas', 'c.estado', 'c.motivoCancelacion', 'e.nombre as entrenador'])
    .where('c.id', '=', id)
    .executeTakeFirst();
  if (!c) throw notFound('Clase no encontrada');
  return c;
}

const destinatarios = (claseId: number) =>
  db
    .selectFrom('claseInscritos as i')
    .innerJoin('socios as s', 's.id', 'i.socioId')
    .select(['s.id', 's.nombre', 's.telefono'])
    .where('i.claseId', '=', claseId)
    .where('i.asistioEn', 'is', null)
    .execute();

/** Envía el recordatorio a los inscritos (una vez por persona, salvo forzar). */
export async function recordarClase(id: number, forzar = false) {
  if (!whatsapp.conectado) throw conflict('WhatsApp no está conectado. Conéctalo en Panel → WhatsApp.');
  const c = await claseAviso(id);
  if (c.estado === 'cancelada') throw conflict('La clase está cancelada');
  let enviados = 0;
  let yaEnviados = 0;
  let sinTelefono = 0;
  let errores = 0;
  for (const s of await destinatarios(id)) {
    if (!s.telefono) {
      sinTelefono++;
      continue;
    }
    try {
      const salio = await enviarUnaVez('clase', `${id}:${s.id}`, s.telefono, await textoRecordatorioClase(c, s.nombre), forzar);
      if (salio) enviados++;
      else yaEnviados++;
    } catch {
      errores++;
    }
  }
  return { enviados, yaEnviados, sinTelefono, errores };
}

/** Aviso de cancelación (si WhatsApp está conectado). */
export async function avisarCancelacion(id: number) {
  const cfg = await getConfig('whatsapp');
  if (!cfg.recordatorioClases || !whatsapp.conectado) return 0;
  const c = await claseAviso(id);
  if (c.inicio.getTime() < Date.now()) return 0;
  let n = 0;
  for (const s of await destinatarios(id)) {
    if (!s.telefono) continue;
    if (await enviarUnaVez('clase-cancelada', `${id}:${s.id}`, s.telefono, await textoCancelacion(c, s.nombre)).catch(() => false)) n++;
  }
  return n;
}

/** Estado del recordatorio de una clase (para mostrarlo en la pantalla). */
export async function estadoRecordatorio(id: number) {
  const [cfg, c, enviados] = await Promise.all([
    getConfig('whatsapp'),
    claseAviso(id),
    db
      .selectFrom('reportesEnviados')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('tipo', '=', 'clase')
      .where('estado', '=', 'enviado')
      .where('clave', 'like', `${id}:%`)
      .executeTakeFirst(),
  ]);
  const madrugada = c.inicio.getHours() < 9;
  return {
    conectado: whatsapp.conectado,
    automatico: cfg.recordatorioClases,
    horasAntes: cfg.horasAntesClase,
    cuando: madrugada ? 'la noche anterior (7 a 9 PM)' : `${cfg.horasAntesClase} h antes`,
    enviados: Number(enviados?.n ?? 0),
    ejemplo: await textoRecordatorioClase(c, 'Ana'),
  };
}

/** Lo llama el tick de WhatsApp cada minuto. */
export async function tickRecordatoriosClases(horasAntes: number) {
  const ahora = new Date();
  const hh = ahora.getHours();
  if (hh < 6 || hh >= 21) return;
  const nocheAnterior = hh >= 19;
  const manana = sumarDias(hoy(), 1);
  const clases = await db
    .selectFrom('clases as c')
    .select(['c.id', 'c.inicio'])
    .where('c.estado', '=', 'programada')
    .where('c.inicio', '>', ahora)
    .where((eb) =>
      eb.or([
        eb('c.inicio', '<=', new Date(ahora.getTime() + horasAntes * 3_600_000)),
        // Clases de mañana antes de las 9 AM: se recuerdan esta noche
        ...(nocheAnterior ? [eb.and([eb(sql`to_char(c.inicio at time zone ${sql.lit(env.TZ)}, 'YYYY-MM-DD')`, '=', manana), eb(sql`extract(hour from c.inicio at time zone ${sql.lit(env.TZ)})`, '<', 9)])] : []),
      ]),
    )
    .where(sql<boolean>`exists (select 1 from clase_inscritos i where i.clase_id = c.id and i.asistio_en is null)`)
    .limit(30)
    .execute();
  for (const c of clases) await recordarClase(c.id).catch(() => undefined);
}
