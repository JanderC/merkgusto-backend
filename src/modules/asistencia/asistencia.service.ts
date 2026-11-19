import { sql } from 'kysely';
import { db } from '../../db/index.js';
import { badRequest, notFound } from '../../lib/http.js';
import { accessControl } from '../biometric/biometric.factory.js';
import { EMPLEADO_PREFIJO, encolar } from '../biometric/biometric-sync.service.js';
import { marcarDesdeLector } from '../entrenadores/entrenadores.service.js';
import type { AccessEventDTO } from '../biometric/dto/access-control.dto.js';
import { vigenciaSocio, type Vigencia } from '../membresias/membresias.service.js';

export interface ResultadoAcceso {
  registrado: boolean;
  duplicado: boolean;
  asistenciaId: number | null;
  resultado: 'permitido' | 'denegado';
  motivo: string;
  alerta: string | null;
  socio: { id: string; codigo: number; nombre: string; foto: string | null } | null;
  entrenador?: { id: string; nombre: string; marco: string | null } | null;
  vigencia: Vigencia | null;
  /** Verificación remota: si la decisión le llegó al lector */
  respuestaLector?: 'enviada' | 'fallo' | null;
}

const fmt = (f: string) => {
  const [y, m, d] = f.split('-');
  return `${d}/${m}/${y}`;
};

function motivoSinVigencia(v: Vigencia): string {
  if (v.congelada) return `Membresía congelada desde el ${fmt(v.congelada.desde)}`;
  if (v.desde && !v.vigente) return `Su membresía empieza el ${fmt(v.desde)}`;
  return v.ultimaFin ? `Membresía vencida el ${fmt(v.ultimaFin)}` : 'No tiene membresía';
}

/** Texto corto que muestra la pantalla del lector (máx. 32 caracteres). */
const textoLector = (permitido: boolean, nombre: string | null, motivo: string) =>
  (permitido ? `Bienvenido ${nombre?.split(' ')[0] ?? ''}`.trim() : motivo.replace('Membresía', 'Plan')).slice(0, 32);

async function responderLector(ev: AccessEventDTO, permitido: boolean, info: string): Promise<'enviada' | 'fallo' | null> {
  if (!ev.remoteCheck || ev.serialNo === null) return null;
  try {
    await accessControl.respondRemoteCheck(ev.serialNo, permitido, info);
    return 'enviada';
  } catch (e) {
    console.error(`✗ [Lector] No se pudo responder la verificación ${ev.serialNo}:`, (e as Error).message);
    return 'fallo';
  }
}

async function guardarAsistencia(ev: AccessEventDTO, v: { socioId: string | null; entrenadorId: string | null; resultado: 'permitido' | 'denegado'; motivo: string; alerta: string | null }) {
  return db
    .insertInto('asistencias')
    .values({
      socioId: v.socioId,
      entrenadorId: v.entrenadorId,
      employeeNo: ev.employeeNo,
      fechaHora: ev.occurredAt,
      origen: ev.simulated ? 'simulado' : 'biometrico',
      resultado: v.resultado,
      motivo: v.motivo.slice(0, 200),
      alerta: v.alerta?.slice(0, 200) ?? null,
      dispositivo: ev.deviceId,
      eventoSerial: ev.eventSerial,
      metodoVerif: ev.verifyMode,
      payload: JSON.stringify(ev.raw),
    })
    .onConflict((oc) => oc.columns(['dispositivo', 'eventoSerial']).where('eventoSerial', 'is not', null).doNothing())
    .returning('id')
    .executeTakeFirst();
}

/** Entrenador frente al lector (employeeNo "E<código>"): marca entrada/salida automáticamente. */
async function eventoEntrenador(ev: AccessEventDTO): Promise<ResultadoAcceso> {
  const codigo = Number(ev.employeeNo!.slice(EMPLEADO_PREFIJO.length));
  const e = Number.isInteger(codigo)
    ? await db.selectFrom('entrenadores').select(['id', 'nombre', 'apellido', 'activo']).where('codigo', '=', codigo).executeTakeFirst()
    : undefined;
  const nombre = e ? `${e.nombre} ${e.apellido}`.trim() : null;
  const permitido = Boolean(e?.activo) && ev.verdict === 'granted';
  const motivo = !e ? `Entrenador ${ev.employeeNo} no existe` : !e.activo ? 'Entrenador inactivo' : permitido ? 'Entrenador' : ev.description;
  const respuestaLector = await responderLector(ev, permitido, textoLector(permitido, nombre, motivo));
  const ins = await guardarAsistencia(ev, { socioId: null, entrenadorId: e?.id ?? null, resultado: permitido ? 'permitido' : 'denegado', motivo, alerta: null });
  let marco: string | null = null;
  if (permitido && ins && e) {
    const m = await marcarDesdeLector(e.id, ev.occurredAt).catch((err) => {
      console.warn('⚠ [Entrenadores] No se pudo marcar desde el lector:', (err as Error).message);
      return null;
    });
    marco = m?.marcacion.tipo ?? null;
  }
  return {
    registrado: Boolean(ins),
    duplicado: !ins,
    asistenciaId: ins?.id ?? null,
    resultado: permitido ? 'permitido' : 'denegado',
    motivo: marco ? `Entrenador · ${marco}` : motivo,
    alerta: null,
    socio: null,
    entrenador: e ? { id: e.id, nombre: nombre!, marco } : null,
    vigencia: null,
    respuestaLector,
  };
}

/**
 * Procesa un evento del lector.
 *
 *  • Verificación remota (BIOMETRIC_DECISION=servidor): el lector reconoció la cara y
 *    PREGUNTA. El sistema decide con la base de datos (existe, activo, al día, no congelado)
 *    y responde al lector para que abra o no. Primero se responde y luego se guarda,
 *    para no hacer esperar a la persona en la puerta.
 *  • Modo lector: el lector decidió con la vigencia sincronizada; aquí se registra y se
 *    contrasta para detectar desincronizaciones (y se reenvía la vigencia si hace falta).
 */
export async function registrarEventoAcceso(ev: AccessEventDTO): Promise<ResultadoAcceso> {
  if (ev.employeeNo?.startsWith(EMPLEADO_PREFIJO)) return eventoEntrenador(ev);

  const codigo = ev.employeeNo && /^\d+$/.test(ev.employeeNo) ? Number(ev.employeeNo) : null;
  const socio =
    codigo !== null && codigo <= 2_147_483_647
      ? await db.selectFrom('socios').select(['id', 'codigo', 'nombre', 'apellido', 'foto', 'activo']).where('codigo', '=', codigo).executeTakeFirst()
      : undefined;
  // Por el lector solo entran planes semanales/mensuales/anuales
  const vig = socio ? await vigenciaSocio(socio.id, db, { soloLector: true }) : null;
  // ¿Tiene un pase diario vigente? Entonces el lector no le abre, pero puede pasar por recepción
  const soloRecepcion = socio && vig && !vig.vigente ? (await vigenciaSocio(socio.id)).vigente : false;
  const nombre = socio ? `${socio.nombre} ${socio.apellido}`.trim() : null;

  let resultado: 'permitido' | 'denegado' = ev.verdict === 'granted' ? 'permitido' : 'denegado';
  let motivo = ev.description;
  let alerta: string | null = null;
  let resincronizar = false;
  let respuestaLector: 'enviada' | 'fallo' | null = null;

  if (ev.remoteCheck) {
    // ── El sistema decide ──
    const ok = Boolean(socio?.activo && vig?.vigente);
    resultado = ok ? 'permitido' : 'denegado';
    motivo = !socio
      ? ev.employeeNo ? `Código ${ev.employeeNo} no existe en el sistema` : 'Persona no registrada'
      : !socio.activo
        ? 'Cliente inactivo'
        : ok
          ? `${vig!.plan ?? 'Membresía'} · ${vig!.diasRestantes} día(s) restantes`
          : soloRecepcion
            ? 'Su plan no incluye el lector: pase por recepción'
            : motivoSinVigencia(vig!);
    respuestaLector = await responderLector(ev, ok, textoLector(ok, nombre, motivo));
    if (respuestaLector === 'fallo') alerta = 'El lector no recibió la respuesta (revisa la conexión)';
  } else if (!socio) {
    motivo = ev.employeeNo ? `Código ${ev.employeeNo} no existe en el sistema` : 'Persona no registrada';
    if (resultado === 'permitido') alerta = 'El lector permitió a alguien que no está en el sistema';
  } else if (resultado === 'permitido') {
    if (!vig?.vigente || !socio.activo) {
      alerta = `Lector con vigencia desactualizada (${socio.activo ? motivoSinVigencia(vig!) : 'cliente inactivo'}). Se reenvió la vigencia.`;
      resincronizar = true;
    } else {
      motivo = `${vig.plan ?? 'Membresía'} · ${vig.diasRestantes} día(s) restantes`;
    }
  } else {
    if (!socio.activo) motivo = 'Cliente inactivo';
    else if (!vig?.vigente) motivo = motivoSinVigencia(vig!);
    else if ([0x06, 0x07, 0x08].includes(ev.subEventType)) {
      alerta = 'Rechazado por vigencia aunque está al día. Se reenvió la vigencia al lector.';
      resincronizar = true;
    }
  }

  const inserted = await guardarAsistencia(ev, { socioId: socio?.id ?? null, entrenadorId: null, resultado, motivo, alerta });
  if (resincronizar && socio && inserted) await encolar(socio.id, 'sync_usuario');

  return {
    registrado: Boolean(inserted),
    duplicado: !inserted,
    asistenciaId: inserted?.id ?? null,
    resultado,
    motivo,
    alerta,
    socio: socio ? { id: socio.id, codigo: socio.codigo, nombre: nombre!, foto: socio.foto } : null,
    entrenador: null,
    vigencia: vig,
    respuestaLector,
  };
}

/** Entrada registrada a mano por la recepción (lector dañado, socio sin rostro, etc.). */
export async function registrarManual(socioId: string, usuarioId: string): Promise<ResultadoAcceso> {
  const socio = await db
    .selectFrom('socios')
    .select(['id', 'codigo', 'nombre', 'apellido', 'foto', 'activo'])
    .where('id', '=', socioId)
    .executeTakeFirst();
  if (!socio) throw notFound('Cliente no encontrado');

  const reciente = await db
    .selectFrom('asistencias')
    .select(['fechaHora'])
    .where('socioId', '=', socioId)
    .where('resultado', '=', 'permitido')
    .where('fechaHora', '>', sql<Date>`now() - interval '30 minutes'`)
    .executeTakeFirst();
  if (reciente) {
    const h = reciente.fechaHora.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
    throw badRequest(`${socio.nombre} ya registró su entrada a las ${h}`);
  }

  const vig = await vigenciaSocio(socioId);
  const ok = socio.activo && vig.vigente;
  const motivo = ok
    ? `${vig.plan ?? 'Membresía'} · ${vig.diasRestantes} día(s) restantes`
    : socio.activo
      ? motivoSinVigencia(vig)
      : 'Cliente inactivo';

  const row = await db
    .insertInto('asistencias')
    .values({
      socioId,
      employeeNo: String(socio.codigo),
      fechaHora: new Date(),
      origen: 'manual',
      resultado: ok ? 'permitido' : 'denegado',
      motivo,
      registradoPor: usuarioId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return {
    registrado: true,
    duplicado: false,
    asistenciaId: row.id,
    resultado: ok ? 'permitido' : 'denegado',
    motivo,
    alerta: null,
    socio: { id: socio.id, codigo: socio.codigo, nombre: `${socio.nombre} ${socio.apellido}`.trim(), foto: socio.foto },
    vigencia: vig,
  };
}

/** Conteos de asistencia de un día (YYYY-MM-DD). */
export async function resumenAsistencia(fecha: string) {
  const r = await db
    .selectFrom('asistencias')
    .select([
      sql<number>`count(distinct socio_id) filter (where resultado = 'permitido')`.as('personas'),
      sql<number>`count(*) filter (where resultado = 'permitido')`.as('entradas'),
      sql<number>`count(*) filter (where resultado = 'denegado')`.as('denegados'),
      sql<number>`count(*) filter (where alerta is not null)`.as('alertas'),
    ])
    .where(sql`(fecha_hora)::date`, '=', fecha)
    .executeTakeFirstOrThrow();
  return {
    personas: Number(r.personas),
    entradas: Number(r.entradas),
    denegados: Number(r.denegados),
    alertas: Number(r.alertas),
  };
}
