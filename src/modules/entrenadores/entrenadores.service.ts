/**
 * Entrenadores: control de asistencia del personal.
 *
 *  Marcaciones (con foto y PIN propio, o con el rostro en el lector):
 *    entrada → (retiro → regreso)* → salida
 *  • entrada: calcula minutos de tardanza contra su horario del día
 *  • retiro:  sale en medio del turno (diligencia, almuerzo, emergencia) con motivo
 *  • regreso: vuelve del retiro
 *  • salida:  termina la jornada (si sale antes de su hora, queda registrado)
 *  Permisos: el entrenador los solicita con soporte; dueño/admin aprueban o rechazan.
 */
import bcrypt from 'bcryptjs';
import { sql } from 'kysely';
import { db } from '../../db/index.js';
import type { Horario, TipoMarcacion } from '../../db/types.js';
import { badRequest, conflict, notFound, unauthorized } from '../../lib/http.js';
import { hoy } from '../../lib/util.js';
import { guardarArchivo } from '../archivos/archivos.service.js';

export type EstadoEntrenador = 'fuera' | 'presente' | 'retirado' | 'salio';

const SIGUIENTES: Record<EstadoEntrenador, TipoMarcacion[]> = {
  fuera: ['entrada'],
  presente: ['salida', 'retiro'],
  retirado: ['regreso', 'salida'],
  salio: ['entrada'],
};

const estadoTras: Record<TipoMarcacion, EstadoEntrenador> = { entrada: 'presente', regreso: 'presente', retiro: 'retirado', salida: 'salio' };

/** Día de la semana ISO (1 = lunes … 7 = domingo) en la hora del gimnasio. */
const diaSemana = (d = new Date()) => String(((d.getDay() + 6) % 7) + 1) as keyof Horario;
const aMinutos = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};
const minutosDelDia = (d: Date) => d.getHours() * 60 + d.getMinutes();

export async function marcacionesDelDia(entrenadorId: string, fecha = hoy()) {
  return db
    .selectFrom('entrenadorMarcaciones')
    .select(['id', 'tipo', 'fechaHora', 'origen', 'fotoId', 'nota', 'minutosTarde'])
    .where('entrenadorId', '=', entrenadorId)
    .where('anulada', '=', false)
    .where(sql`fecha_hora::date`, '=', fecha)
    .orderBy('fechaHora')
    .execute();
}

export function estadoActual(marcas: Array<{ tipo: TipoMarcacion }>): EstadoEntrenador {
  const ult = marcas[marcas.length - 1];
  return ult ? estadoTras[ult.tipo] : 'fuera';
}

/** Minutos trabajados: tramos entre entrada/regreso y retiro/salida (el abierto cuenta hasta ahora). */
export function minutosTrabajados(marcas: Array<{ tipo: TipoMarcacion; fechaHora: Date }>, hasta = new Date()) {
  let total = 0;
  let desde: Date | null = null;
  for (const m of marcas) {
    if (m.tipo === 'entrada' || m.tipo === 'regreso') desde = m.fechaHora;
    else if (desde) {
      total += (m.fechaHora.getTime() - desde.getTime()) / 60000;
      desde = null;
    }
  }
  if (desde) total += (hasta.getTime() - desde.getTime()) / 60000;
  return Math.max(0, Math.round(total));
}

export async function verificarPin(entrenadorId: string, pin: string) {
  const e = await db.selectFrom('entrenadores').selectAll().where('id', '=', entrenadorId).executeTakeFirst();
  if (!e || !e.activo) throw notFound('Entrenador no encontrado');
  if (!(await bcrypt.compare(pin, e.pinHash))) throw unauthorized('PIN incorrecto');
  return e;
}

export async function marcar(args: {
  entrenadorId: string;
  tipo: TipoMarcacion;
  origen: 'kiosko' | 'lector' | 'manual';
  foto?: string | null;
  nota?: string | null;
  usuarioId: string | null;
  fechaHora?: Date;
}) {
  const e = await db.selectFrom('entrenadores').select(['id', 'nombre', 'horario', 'activo']).where('id', '=', args.entrenadorId).executeTakeFirst();
  if (!e || !e.activo) throw notFound('Entrenador no encontrado o inactivo');
  const ahora = args.fechaHora ?? new Date();
  const marcas = await marcacionesDelDia(e.id);
  const estado = estadoActual(marcas);
  if (!SIGUIENTES[estado].includes(args.tipo)) {
    const txt = { fuera: 'aún no ha marcado entrada', presente: 'está dentro', retirado: 'está en un retiro', salio: 'ya marcó salida' }[estado];
    throw conflict(`No se puede marcar "${args.tipo}": ${e.nombre} ${txt}`);
  }
  if (args.origen === 'kiosko' && !args.foto) throw badRequest('La foto es obligatoria para marcar');
  if (args.tipo === 'retiro' && !args.nota?.trim()) throw badRequest('Indica el motivo del retiro');

  const horarioHoy = (e.horario ?? {})[diaSemana(ahora)];
  let minutosTarde: number | null = null;
  if (args.tipo === 'entrada' && horarioHoy && !marcas.some((m) => m.tipo === 'entrada')) {
    minutosTarde = Math.max(0, minutosDelDia(ahora) - aMinutos(horarioHoy.entrada));
  }
  // Salida antes de su hora: se guarda en negativo para el reporte
  if (args.tipo === 'salida' && horarioHoy) {
    const antes = aMinutos(horarioHoy.salida) - minutosDelDia(ahora);
    if (antes > 0) minutosTarde = -antes;
  }
  const fotoId = args.foto ? await guardarArchivo(args.foto, 'entrenadores/marcaciones', args.usuarioId) : null;
  const m = await db
    .insertInto('entrenadorMarcaciones')
    .values({
      entrenadorId: e.id,
      tipo: args.tipo,
      fechaHora: ahora,
      origen: args.origen,
      fotoId,
      nota: args.nota?.trim() || null,
      minutosTarde,
      registradoPor: args.usuarioId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { marcacion: m, estado: estadoTras[args.tipo], nombre: e.nombre, minutosTarde };
}

/** Marcación desde el lector facial: alterna entrada/salida (y regreso si estaba en retiro). */
export async function marcarDesdeLector(entrenadorId: string, fechaHora: Date) {
  const marcas = await marcacionesDelDia(entrenadorId);
  const estado = estadoActual(marcas);
  // Evita dobles lecturas del lector (la persona se queda frente a la cámara): 2 minutos
  const ult = marcas[marcas.length - 1];
  if (ult && ult.origen === 'lector' && fechaHora.getTime() - new Date(ult.fechaHora).getTime() < 120_000) return null;
  const tipo: TipoMarcacion = estado === 'presente' ? 'salida' : estado === 'retirado' ? 'regreso' : 'entrada';
  return marcar({ entrenadorId, tipo, origen: 'lector', usuarioId: null, fechaHora });
}

export async function solicitarPermiso(args: {
  entrenadorId: string;
  tipo: 'permiso' | 'vacaciones' | 'reposo' | 'diligencia' | 'otro';
  desde: string;
  hasta: string;
  motivo: string;
  soporte?: string | null;
  usuarioId: string | null;
}) {
  if (new Date(args.hasta) <= new Date(args.desde)) throw badRequest('La fecha final debe ser posterior a la inicial');
  const soporteId = args.soporte ? await guardarArchivo(args.soporte, 'entrenadores/permisos', args.usuarioId) : null;
  return db
    .insertInto('entrenadorPermisos')
    .values({ entrenadorId: args.entrenadorId, tipo: args.tipo, desde: args.desde, hasta: args.hasta, motivo: args.motivo, soporteId })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Tablero de hoy: quién está, quién llegó tarde, quién falta, quién tiene permiso. */
export async function tableroHoy() {
  const h = hoy();
  const [lista, marcas, permisos] = await Promise.all([
    db
      .selectFrom('entrenadores')
      .select(['id', 'codigo', 'nombre', 'apellido', 'especialidad', 'horario', 'bioEstado', sql<boolean>`foto is not null`.as('tieneFoto')])
      .where('activo', '=', true)
      .orderBy('nombre')
      .execute(),
    db
      .selectFrom('entrenadorMarcaciones')
      .select(['id', 'entrenadorId', 'tipo', 'fechaHora', 'origen', 'fotoId', 'nota', 'minutosTarde'])
      .where('anulada', '=', false)
      .where(sql`fecha_hora::date`, '=', h)
      .orderBy('fechaHora')
      .execute(),
    db
      .selectFrom('entrenadorPermisos')
      .select(['id', 'entrenadorId', 'tipo', 'desde', 'hasta', 'motivo', 'estado'])
      .where('estado', '=', 'aprobado')
      .where(sql`desde::date`, '<=', h)
      .where(sql`hasta::date`, '>=', h)
      .execute(),
  ]);
  const ahora = new Date();
  const dia = diaSemana(ahora);
  return lista.map((e) => {
    const ms = marcas.filter((m) => m.entrenadorId === e.id);
    const estado = estadoActual(ms);
    const horarioHoy = (e.horario ?? {})[dia] ?? null;
    const permiso = permisos.find((p) => p.entrenadorId === e.id) ?? null;
    const entrada = ms.find((m) => m.tipo === 'entrada');
    // Ausente: tenía horario, ya pasó su hora de entrada + 15 min, no marcó y no tiene permiso
    const ausente = !entrada && !permiso && !!horarioHoy && minutosDelDia(ahora) > aMinutos(horarioHoy.entrada) + 15;
    return {
      ...e,
      estado,
      siguientes: SIGUIENTES[estado],
      horarioHoy,
      permiso,
      ausente,
      entrada: entrada?.fechaHora ?? null,
      minutosTarde: entrada?.minutosTarde ?? null,
      minutosHoy: minutosTrabajados(ms),
      marcaciones: ms,
    };
  });
}

/** Reporte por periodo: horas, tardanzas, salidas tempranas, retiros, permisos y ausencias. */
export async function reportePeriodo(desde: string, hasta: string) {
  const [lista, marcas, permisos] = await Promise.all([
    db.selectFrom('entrenadores').select(['id', 'nombre', 'apellido', 'horario', 'activo']).orderBy('nombre').execute(),
    db
      .selectFrom('entrenadorMarcaciones')
      .select(['entrenadorId', 'tipo', 'fechaHora', 'minutosTarde', sql<string>`to_char(fecha_hora, 'YYYY-MM-DD')`.as('dia')])
      .where('anulada', '=', false)
      .where(sql`fecha_hora::date`, '>=', desde)
      .where(sql`fecha_hora::date`, '<=', hasta)
      .orderBy('fechaHora')
      .execute(),
    db
      .selectFrom('entrenadorPermisos')
      .select(['entrenadorId', 'desde', 'hasta', 'estado'])
      .where('estado', '=', 'aprobado')
      .where(sql`hasta::date`, '>=', desde)
      .where(sql`desde::date`, '<=', hasta)
      .execute(),
  ]);
  // Días del periodo (hasta hoy)
  const dias: string[] = [];
  const fin = hasta < hoy() ? hasta : hoy();
  for (let d = new Date(`${desde}T12:00:00`); d.toISOString().slice(0, 10) <= fin; d.setDate(d.getDate() + 1)) dias.push(d.toISOString().slice(0, 10));

  return lista
    .filter((e) => e.activo || marcas.some((m) => m.entrenadorId === e.id))
    .map((e) => {
      const ms = marcas.filter((m) => m.entrenadorId === e.id);
      const porDia = new Map<string, typeof ms>();
      for (const m of ms) porDia.set(m.dia, [...(porDia.get(m.dia) ?? []), m]);
      let minutos = 0;
      for (const [dia, lista] of porDia) minutos += minutosTrabajados(lista, dia === hoy() ? new Date() : new Date(`${dia}T23:59:59`));
      const tardes = ms.filter((m) => m.tipo === 'entrada' && (m.minutosTarde ?? 0) > 5);
      const tempranas = ms.filter((m) => m.tipo === 'salida' && (m.minutosTarde ?? 0) < -5);
      const conPermiso = (dia: string) => permisos.some((p) => p.entrenadorId === e.id && new Date(p.desde).toISOString().slice(0, 10) <= dia && new Date(p.hasta).toISOString().slice(0, 10) >= dia);
      const ausencias = dias.filter((dia) => {
        const wd = String(((new Date(`${dia}T12:00:00`).getDay() + 6) % 7) + 1) as keyof Horario;
        return (e.horario ?? {})[wd] && !porDia.has(dia) && !conPermiso(dia);
      });
      return {
        id: e.id,
        nombre: `${e.nombre} ${e.apellido}`.trim(),
        diasTrabajados: porDia.size,
        horas: Math.round((minutos / 60) * 10) / 10,
        tardanzas: tardes.length,
        minutosTarde: tardes.reduce((s, m) => s + (m.minutosTarde ?? 0), 0),
        salidasTempranas: tempranas.length,
        retiros: ms.filter((m) => m.tipo === 'retiro').length,
        diasPermiso: dias.filter(conPermiso).length,
        ausencias: ausencias.length,
        fechasAusencia: ausencias,
      };
    });
}
