/**
 * Mensajes automáticos al DUEÑO:
 *   • Aviso de cada cierre de caja (al momento, o cuando WhatsApp vuelva)
 *   • Reporte diario: personas que entraron, cierres y cuánto cerró cada uno
 * Y, opcional, recordatorio de vencimiento a los socios.
 *
 * Todo se registra en `reportes_enviados` para no duplicar y para reintentar
 * si WhatsApp estaba desconectado.
 */
import { sql } from 'kysely';
import { db } from '../../db/index.js';
import { bus } from '../../lib/events.js';
import { fechaLarga, hoy, horaCorta, sumarDias } from '../../lib/util.js';
import { resumenTurnos, type ResumenTurno } from '../caja/caja.service.js';
import { getConfig, getTasas } from '../configuracion/config.service.js';
import { fmt, INFO, MONEDA_REF } from '../../lib/monedas.js';
import { resumenDia } from '../dashboard/resumen.service.js';
import { whatsapp } from './whatsapp.service.js';
import { tickRecordatoriosClases } from '../clases/clases.service.js';

const signo = (n: number, f: (x: number) => string) => (n === 0 ? '✅ Cuadrado' : n > 0 ? `🟢 Sobrante ${f(n)}` : `🔴 Faltante ${f(Math.abs(n))}`);

function bloqueTurno(t: ResumenTurno, f: (n: number) => string) {
  const lineas = [
    `*Turno #${t.numero}* · ${t.cajero}`,
    `🕒 ${horaCorta(t.abiertoEn)} → ${t.cerradoEn ? horaCorta(t.cerradoEn) : 'abierto'} · ${t.operaciones} venta(s)${t.anuladas ? ` · ${t.anuladas} anulada(s)` : ''}`,
    `💰 Vendido: *${f(t.totalVendidoRef)}*${t.fiadoRef > 0 ? ` (fiado ${f(t.fiadoRef)})` : ''}`,
    ...(t.egresosRef || t.ingresosRef ? [`💸 Gastos de caja: ${f(t.egresosRef)}${t.ingresosRef ? ` · ingresos ${f(t.ingresosRef)}` : ''}`] : []),
  ];
  if (t.estado !== 'abierto') {
    for (const m of t.metodos) {
      const g = (n: number) => fmt(n, m.moneda);
      const dif = m.diferencia === 0 ? '' : m.diferencia > 0 ? ` (+${g(m.diferencia)})` : ` (−${g(Math.abs(m.diferencia))})`;
      lineas.push(`   • ${m.nombre} ${INFO[m.moneda].simbolo}: esperado ${g(m.esperado)} · entregó ${g(m.declarado)}${dif}`);
    }
    lineas.push(t.declaro ? `   ${signo(t.diferencia, f)}` : '   ⚠️ No declaró lo entregado');
    if (t.notaCajero) lineas.push(`   📝 "${t.notaCajero}"`);
  }
  return lineas.join('\n');
}

export async function textoCierre(turnoId: string) {
  const [t] = await resumenTurnos({ ids: [turnoId] });
  if (!t) return null;
  const gym = await getConfig('gym');
  const f = (n: number) => fmt(n, MONEDA_REF);
  return `🔒 *CIERRE DE CAJA* — ${gym.nombre}\n\n${bloqueTurno(t, f)}\n\n_Entregado al dueño. Detalle completo en el panel._`;
}

export async function textoReporteDiario(fecha: string) {
  const [r, gym, tasas] = await Promise.all([resumenDia(fecha), getConfig('gym'), getTasas()]);
  const f = (n: number) => fmt(n, MONEDA_REF);
  const a = r.asistencia;
  const partes = [
    `📊 *REPORTE DEL DÍA* — ${gym.nombre}`,
    `📅 ${fechaLarga(fecha)}`,
    '',
    `🏋️ *Entraron ${a.personas} persona(s)*`,
    `   ${a.entradas} entrada(s) registradas${a.denegados ? ` · ${a.denegados} rechazo(s) en el lector` : ''}`,
    r.sociosNuevos ? `   🆕 ${r.sociosNuevos} cliente(s) nuevo(s)` : null,
    '',
    `💵 *Total vendido: ${f(r.ventas.total)}*`,
    `   Planes: ${r.ventas.membresias.cantidad} · ${f(r.ventas.membresias.monto)}`,
    `   Productos: ${r.ventas.productos.cantidad} und · ${f(r.ventas.productos.monto)}`,
    r.ventas.abonos.cantidad ? `   Abonos a deudas: ${f(r.ventas.abonos.monto)}` : null,
    r.ventas.fiado > 0 ? `   📒 Quedó fiado: ${f(r.ventas.fiado)}` : null,
    '',
    '💳 *Cobrado por método*',
    ...r.ventas.porMetodo.map((m) => `   • ${m.nombre}: ${fmt(m.montoMoneda, m.moneda)}${m.moneda !== MONEDA_REF ? ` (≈ ${f(m.monto)})` : ''}`),
    r.caja.egresos || r.caja.ingresos ? `   💸 Egresos ${f(r.caja.egresos)} · Ingresos ${f(r.caja.ingresos)}` : null,
    r.deudas.cantidad ? `   📒 Por cobrar (total): ${f(r.deudas.saldo)} en ${r.deudas.cantidad} cliente(s)` : null,
    `   💱 Tasas en pesos: Dólar ${tasas.usdCop.toLocaleString('es-VE')} · Bs ${tasas.vesCop.toLocaleString('es-VE')} ($1 = Bs ${(tasas.usdCop / tasas.vesCop).toLocaleString('es-VE', { maximumFractionDigits: 2 })})`,
    r.ventas.anuladas ? `   ⚠️ ${r.ventas.anuladas} venta(s) anulada(s)` : null,
    '',
    `🔒 *Cierres de caja (${r.turnos.filter((t) => t.estado !== 'abierto').length})*`,
    ...(r.turnos.length ? r.turnos.map((t) => bloqueTurno(t, f)) : ['   Sin turnos hoy']),
  ];
  const abiertos = r.turnos.filter((t) => t.estado === 'abierto');
  if (abiertos.length) partes.push('', `⚠️ ${abiertos.length} turno(s) siguen ABIERTOS: ${abiertos.map((t) => t.cajero).join(', ')}`);
  const cerrados = r.turnos.filter((t) => t.estado !== 'abierto');
  if (cerrados.length) {
    const dif = cerrados.reduce((s, t) => s + t.diferencia, 0);
    partes.push('', `Balance de cierres: ${signo(Math.round(dif), f)}`);
  }
  return partes.filter((p) => p !== null).join('\n');
}

/** Envía al dueño una sola vez por (tipo, clave). Devuelve true si salió. */
export async function enviarUnaVez(tipo: string, clave: string, destino: string, texto: string, forzar = false) {
  const prev = await db.selectFrom('reportesEnviados').select(['estado']).where('tipo', '=', tipo).where('clave', '=', clave).executeTakeFirst();
  if (prev?.estado === 'enviado' && !forzar) return false;
  try {
    await whatsapp.enviar(destino, texto, tipo === 'recordatorio' || tipo.startsWith('clase') ? 'aviso' : 'reporte');
    await guardar(tipo, clave, 'enviado', null);
    return true;
  } catch (e) {
    await guardar(tipo, clave, 'error', (e as Error).message);
    throw e;
  }
}

async function guardar(tipo: string, clave: string, estado: 'enviado' | 'error', detalle: string | null) {
  await db
    .insertInto('reportesEnviados')
    .values({ tipo, clave, estado, detalle })
    .onConflict((oc) => oc.columns(['tipo', 'clave']).doUpdateSet({ estado, detalle, creadoEn: sql`now()` as never }))
    .execute();
}

export async function enviarReporteDiario(fecha = hoy(), forzar = false) {
  const cfg = await getConfig('whatsapp');
  if (!cfg.numeroDueno) throw new Error('Configura el número de WhatsApp del dueño');
  return enviarUnaVez('diario', fecha, cfg.numeroDueno, await textoReporteDiario(fecha), forzar);
}

async function avisarCierre(turnoId: string) {
  const cfg = await getConfig('whatsapp');
  if (!cfg.avisoCierre || !cfg.numeroDueno || !whatsapp.conectado) return;
  const texto = await textoCierre(turnoId);
  if (texto) await enviarUnaVez('cierre', turnoId, cfg.numeroDueno, texto);
}

/** Revisa cada minuto qué mensajes automáticos toca enviar. */
export async function tickReportes() {
  if (!whatsapp.conectado) return;
  const cfg = await getConfig('whatsapp');
  const ahora = new Date();
  const hhmm = `${String(ahora.getHours()).padStart(2, '0')}:${String(ahora.getMinutes()).padStart(2, '0')}`;

  // 1) Cierres pendientes de avisar (WhatsApp estaba caído cuando se cerró)
  if (cfg.avisoCierre && cfg.numeroDueno) {
    const pendientes = await db
      .selectFrom('turnos as t')
      .select('t.id')
      .where('t.estado', '!=', 'abierto')
      .where('t.cerradoEn', '>', sql<Date>`now() - interval '24 hours'`)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('reportesEnviados as r').select('r.id').where('r.tipo', '=', 'cierre').where('r.estado', '=', 'enviado').whereRef('r.clave', '=', sql`t.id::text`))),
      )
      .execute();
    for (const p of pendientes) await avisarCierre(p.id).catch((e) => console.error('✗ [WhatsApp] Aviso de cierre:', e.message));
  }

  // 2) Reporte diario a la hora configurada (o apenas se pueda si ya pasó)
  if (cfg.reporteDiario && cfg.numeroDueno && hhmm >= cfg.horaReporte) {
    await enviarReporteDiario().catch((e) => console.error('✗ [WhatsApp] Reporte diario:', e.message));
  }

  // 3) Recordatorio a socios cuya membresía vence en N días (desde las 9 AM)
  if (cfg.recordatorioVencimiento && hhmm >= '09:00' && hhmm < '20:00') {
    const objetivo = sumarDias(hoy(), cfg.diasRecordatorio);
    const gym = await getConfig('gym');
    const socios = await db
      .selectFrom('socios as s')
      .select(['s.id', 's.nombre', 's.telefono'])
      .where('s.activo', '=', true)
      .where('s.telefono', 'is not', null)
      .where(sql`(select max(m.fecha_fin) from membresias m where m.socio_id = s.id and m.estado = 'activa')`, '=', objetivo)
      .limit(40)
      .execute();
    for (const s of socios) {
      const cuando = cfg.diasRecordatorio === 0 ? 'hoy' : cfg.diasRecordatorio === 1 ? 'mañana' : `el ${fechaLarga(objetivo)}`;
      const texto = `¡Hola ${s.nombre}! 💪 Te recordamos que tu membresía en *${gym.nombre}* vence ${cuando}. Renueva en recepción para no perder tu ritmo. ¡Te esperamos! 🧡`;
      await enviarUnaVez('recordatorio', `${s.id}:${objetivo}`, s.telefono!, texto).catch(() => undefined);
    }
  }

  // 4) Recordatorio de clases a los inscritos (N horas antes; las de madrugada, la noche anterior)
  if (cfg.recordatorioClases) await tickRecordatoriosClases(cfg.horasAntesClase).catch((e) => console.error('✗ [WhatsApp] Recordatorio de clases:', e.message));
}

export function iniciarAvisos() {
  bus.al('turno:cerrado', ({ turnoId }) => avisarCierre(turnoId));
  whatsapp.onConectado = () => {
    setTimeout(() => void tickReportes().catch(() => undefined), 5000);
  };
}
