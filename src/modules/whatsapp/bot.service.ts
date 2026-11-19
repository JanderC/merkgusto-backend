/**
 * Asistente que responde solo los mensajes de los clientes.
 *   • Con GROQ_API_KEY: respuestas naturales con IA (Llama 3.3 en Groq)
 *   • Sin clave o si la IA falla: respuestas por palabras clave (nunca deja en visto)
 *   • Reconoce al socio por su teléfono y le dice cuándo vence su membresía
 *   • El dueño puede escribir "reporte" para recibir el resumen del día al instante
 */
import Groq from 'groq-sdk';
import { sql } from 'kysely';
import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import { hoy, normalizarTelefono } from '../../lib/util.js';
import { getConfig, getTasas } from '../configuracion/config.service.js';
import { fmtTodas } from '../../lib/monedas.js';
import { describirDuracion } from '../membresias/membresias.service.js';
import { vigenciaSocio } from '../membresias/membresias.service.js';
import { textoReporteDiario } from './reportes.service.js';
import { whatsapp } from './whatsapp.service.js';

const groq = env.GROQ_API_KEY ? new Groq({ apiKey: env.GROQ_API_KEY }) : null;
const HISTORIAL_MAX = 10;
const historial = new Map<string, { t: number; msgs: Array<{ role: 'user' | 'assistant'; content: string }> }>();

let cachePlanes: { t: number; texto: string } | null = null;
async function planesTexto() {
  if (cachePlanes && Date.now() - cachePlanes.t < 5 * 60_000) return cachePlanes.texto;
  const tasas = await getTasas();
  const planes = await db.selectFrom('planes').select(['nombre', 'tipoDuracion', 'cantidad', 'precio', 'moneda', 'descripcion']).where('activo', '=', true).orderBy('orden').execute();
  // Precios en dólares con su equivalente en bolívares y pesos del día
  const texto =
    planes.map((p) => `• ${p.nombre} (${describirDuracion(p)}): ${fmtTodas(p.precio, p.moneda, tasas)}${p.descripcion ? ` — ${p.descripcion}` : ''}`).join('\n') +
    '\nSe aceptan dólares (efectivo, Zelle, Binance), bolívares (efectivo, pago móvil, punto) y pesos (efectivo, Bancolombia, Nequi); también pagos combinados. Los planes mensuales van mes a mes (ej. del 15 al 14 del mes siguiente).';
  cachePlanes = { t: Date.now(), texto };
  return texto;
}

async function socioPorTelefono(telefono: string | null) {
  if (!telefono) return null;
  const ultimos = telefono.slice(-10);
  const candidatos = await db
    .selectFrom('socios')
    .select(['id', 'nombre', 'apellido', 'telefono'])
    .where('activo', '=', true)
    .where(sql`regexp_replace(coalesce(telefono, ''), '\\D', '', 'g')`, 'like', `%${ultimos}`)
    .limit(5)
    .execute();
  const s = candidatos.find((c) => normalizarTelefono(c.telefono) === telefono) ?? candidatos[0];
  if (!s) return null;
  return { ...s, vigencia: await vigenciaSocio(s.id) };
}

const fmt = (f: string | null) => (f ? f.split('-').reverse().join('/') : '');

async function contexto(telefono: string | null) {
  const [gym, wa, planes, socio] = await Promise.all([getConfig('gym'), getConfig('whatsapp'), planesTexto(), socioPorTelefono(telefono)]);
  let infoSocio = 'La persona NO está registrada como cliente (o escribe desde otro número).';
  if (socio) {
    const v = socio.vigencia;
    infoSocio = v.vigente
      ? `Es cliente: ${socio.nombre} ${socio.apellido}. Plan ${v.plan}, vigente hasta el ${fmt(v.hasta)} (${v.diasRestantes} día(s) restantes).`
      : `Es cliente: ${socio.nombre} ${socio.apellido}. Su membresía está VENCIDA${v.ultimaFin ? ` desde el ${fmt(v.ultimaFin)}` : ''}. Invítalo amablemente a renovar.`;
  }
  return { gym, wa, planes, socio, infoSocio };
}

function prompt(c: Awaited<ReturnType<typeof contexto>>) {
  return `Eres parte del equipo de recepción de ${c.gym.nombre}, un gimnasio en Venezuela. Respondes por WhatsApp como una persona real: cálida, breve y motivadora. Nunca digas que eres un bot o una IA.

DATOS DEL GIMNASIO
Nombre: ${c.gym.nombre}${c.gym.slogan ? ` — "${c.gym.slogan}"` : ''}
Dirección: ${c.gym.direccion || 'pregunta en recepción'}
Teléfono: ${c.gym.telefono || 'este mismo WhatsApp'}
Horario: ${c.gym.horario || 'consultar'}
${c.gym.instagram ? `Instagram: ${c.gym.instagram}` : ''}
Acceso: reconocimiento facial en la entrada. Para registrar el rostro el cliente se toma una foto en recepción.

PLANES Y PRECIOS (actualizados del sistema)
${c.planes || 'Consultar en recepción'}

${c.wa.infoExtra ? `INFORMACIÓN ADICIONAL\n${c.wa.infoExtra}\n` : ''}
SOBRE QUIEN ESCRIBE
${c.infoSocio}

REGLAS
- Máximo 3-4 líneas por respuesta, español venezolano natural, 1-2 emojis como mucho.
- Usa SOLO los precios y datos de arriba. Si no sabes algo, di que lo consultas en recepción.
- Los pagos y renovaciones se hacen en recepción; no pidas ni aceptes datos bancarios por aquí.
- No inventes promociones, horarios ni servicios.
- No hables de temas ajenos al gimnasio, salud general básica sí.`;
}

function respuestaSinIA(texto: string, c: Awaited<ReturnType<typeof contexto>>) {
  const t = texto.toLowerCase();
  const saludo = c.socio ? `¡Hola ${c.socio.nombre}! 👋` : `¡Hola! 👋 Gracias por escribir a *${c.gym.nombre}*.`;
  if (/(precio|plan|cu[aá]nto|mensual|costo|tarifa|pase)/.test(t)) return `${saludo}\nEstos son nuestros planes:\n${c.planes}\n\nPuedes inscribirte directamente en recepción 💪`;
  if (/(horario|hora|abren|cierran|abierto)/.test(t)) return `${saludo}\nNuestro horario: ${c.gym.horario || 'consúltalo en recepción'}.`;
  if (/(d[oó]nde|direcci[oó]n|ubicaci[oó]n|llegar)/.test(t)) return `${saludo}\nEstamos en: ${c.gym.direccion || 'te paso la ubicación en un momento'}.`;
  if (/(vence|venc|membres[ií]a|mi plan|d[ií]as)/.test(t) && c.socio) {
    const v = c.socio.vigencia;
    return v.vigente
      ? `${saludo}\nTu plan ${v.plan} está vigente hasta el ${fmt(v.hasta)} (${v.diasRestantes} día(s)). ¡A darle! 🔥`
      : `${saludo}\nTu membresía está vencida${v.ultimaFin ? ` desde el ${fmt(v.ultimaFin)}` : ''}. Pasa por recepción para renovarla 💪`;
  }
  return `${saludo}\nEn un momento te atendemos. Mientras tanto, si quieres conocer precios escribe *planes* y para el horario escribe *horario*.`;
}

/** Comandos del dueño desde su WhatsApp. */
async function comandoDueno(texto: string): Promise<string | null> {
  const t = texto.trim().toLowerCase();
  if (/^(reporte|resumen|hoy|caja)$/.test(t)) return textoReporteDiario(hoy());
  if (/^(ayuda|comandos|menu|menú)$/.test(t)) return '🤖 Comandos disponibles:\n• *reporte* — resumen de hoy (entradas, ventas y cierres)';
  return null; // el resto de mensajes del dueño no se contestan
}

export async function responderMensaje(m: { jid: string; telefono: string | null; nombre: string | null; texto: string }): Promise<string | null> {
  const wa = await getConfig('whatsapp');
  const dueno = normalizarTelefono(wa.numeroDueno);
  if (dueno && m.telefono === dueno) return comandoDueno(m.texto);
  if (!wa.botActivo) return null;

  const c = await contexto(m.telefono);
  const h = historial.get(m.jid);
  const msgs = h && Date.now() - h.t < 2 * 3600_000 ? h.msgs : [];
  msgs.push({ role: 'user', content: m.texto.slice(0, 1500) });

  let respuesta: string | null = null;
  if (groq) {
    try {
      const r = await groq.chat.completions.create(
        {
          model: env.GROQ_MODEL,
          temperature: 0.6,
          max_tokens: 300,
          messages: [{ role: 'system', content: prompt(c) }, ...msgs.slice(-HISTORIAL_MAX)],
        },
        { timeout: 15_000 },
      );
      respuesta = r.choices[0]?.message?.content?.trim() || null;
    } catch (e) {
      console.error('✗ [Bot] Groq falló, uso respuesta local:', (e as Error).message);
    }
  }
  respuesta ??= respuestaSinIA(m.texto, c);
  msgs.push({ role: 'assistant', content: respuesta });
  historial.set(m.jid, { t: Date.now(), msgs: msgs.slice(-HISTORIAL_MAX) });
  return respuesta;
}

export function iniciarBot() {
  whatsapp.manejador = responderMensaje;
  // Limpieza de historiales viejos
  setInterval(() => {
    const limite = Date.now() - 2 * 3600_000;
    for (const [k, v] of historial) if (v.t < limite) historial.delete(k);
  }, 30 * 60_000).unref();
}
