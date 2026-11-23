// Puente: PC del gimnasio ↔ sistema en la nube. Se deja abierto todo el día (PUENTE.bat).
//  • Ejecuta en el lector lo que pide el sistema (altas, rostros, vigencias, abrir puerta).
//  • Guarda cada entrada en disco y luego la sube: sin internet no se pierde.
//  • Mantiene el lector en hora aunque no haya internet (al irse la luz puede volver a 2015).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crearLector, dormir, escuchar, ipHacia, ponerAviso, revisarReloj } from './lib.mjs';

const DIR = process.env.LECTOR_DIR ?? path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = path.join(DIR, 'lector.config.json');
const LOG = path.join(DIR, 'puente.log');

/** Pantalla + archivo: corriendo por debajo (tarea de Windows) no hay ventana, el log cuenta qué pasó. */
function log(texto) {
  const linea = `[${new Date().toLocaleString('es-VE')}] ${texto}`;
  console.log(linea);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1024 * 1024) fs.renameSync(LOG, `${LOG}.1`);
    fs.appendFileSync(LOG, `${linea}
`);
  } catch {
    /* sin disco no se detiene el puente */
  }
}
// Un error inesperado cierra el proceso a propósito: la tarea de Windows lo vuelve a abrir
process.on('uncaughtException', (e) => (log(`ERROR inesperado: ${e.stack ?? e}`), process.exit(1)));
process.on('unhandledRejection', (e) => (log(`ERROR inesperado: ${e?.stack ?? e}`), process.exit(1)));

if (!fs.existsSync(ARCHIVO)) {
  log('Falta configurar: abre LECTOR.bat y elige la opción 3.');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
const lector = crearLector(cfg.lector);
const API = `${cfg.sistema.replace(/\/+$/, '')}/api/puente`;
const COLA = path.join(DIR, 'eventos-pendientes');
fs.mkdirSync(COLA, { recursive: true });

// Solo lo que el sistema necesita. Ni reinicio de fábrica, ni usuarios del equipo, ni red.
const PERMITIDO = [
  ['GET', /^\/ISAPI\/System\/deviceInfo$/],
  ['POST', /^\/ISAPI\/AccessControl\/UserInfo\/Record$/],
  ['PUT', /^\/ISAPI\/AccessControl\/UserInfo\/(Modify|Delete)$/],
  ['POST', /^\/ISAPI\/Intelligent\/FDLib\/FaceDataRecord$/],
  ['PUT', /^\/ISAPI\/Intelligent\/FDLib\/(FDSetUp|FDSearch\/Delete)$/],
  ['POST', /^\/ISAPI\/AccessControl\/CaptureFaceData$/],
  ['PUT', /^\/ISAPI\/AccessControl\/RemoteControl\/door\/\d+$/],
  ['GET', /^\/LOCALS\//i], // la foto recién capturada
];

const anterior = new Map();
/** Muestra solo los cambios, para que la ventana se pueda leer. */
function avisar(tema, texto) {
  if (anterior.get(tema) === texto) return;
  anterior.set(tema, texto);
  log(`${tema}: ${texto}`);
}

async function sistema(ruta, body, timeout = 15000) {
  const r = await fetch(API + ruta, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${cfg.token}`, ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
    redirect: 'error',
  });
  if (!r.ok) {
    const que = r.status === 401 ? 'la clave del puente no coincide con Railway' : r.status === 404 ? 'el servidor no tiene el puente activado (BIOMETRIC_MODE=puente)' : `HTTP ${r.status}`;
    throw Object.assign(new Error(que), { status: r.status });
  }
  return r.json();
}

export function permitido(metodo, ruta) {
  if (!ruta.startsWith('/')) return false;
  const u = new URL(ruta, 'http://lector');
  return u.host === 'lector' && u.pathname + u.search === ruta && PERMITIDO.some(([m, re]) => m === metodo && re.test(u.pathname));
}

async function atender(p) {
  let resp;
  try {
    if (!permitido(p.method, p.path)) throw new Error('operación no permitida por el puente');
    const r = await lector.pedir(p.method, p.path, { body: p.body ? Buffer.from(p.body, 'base64') : undefined, tipo: p.contentType, timeout: Math.min(p.venceEnMs, 30000) });
    resp = { status: r.status, contentType: r.tipo, body: r.buffer.toString('base64') };
  } catch (e) {
    resp = { error: String(e.cause?.code ?? e.message).slice(0, 300) };
  }
  await sistema(`/respuestas/${p.id}`, resp).catch((e) => avisar('sistema', `no recibió una respuesta: ${e.message}`));
}

async function buclePedidos() {
  for (;;) {
    try {
      const { pedidos } = await sistema('/pedidos', undefined, 30000);
      avisar('sistema', 'conectado');
      for (const p of pedidos) void atender(p);
    } catch (e) {
      avisar('sistema', `SIN CONEXIÓN (${e.cause?.code ?? e.message}). Las entradas se guardan aquí.`);
      await dormir(5000);
    }
  }
}

let n = 0;
async function guardarEvento(evento) {
  const a = evento.AccessControllerEvent;
  if (evento.eventType !== 'AccessControllerEvent' || !a) return; // latidos
  if (Number(a.majorEventType) !== 5) return;
  const destino = path.join(COLA, `${Date.now()}-${String(++n).padStart(6, '0')}-${crypto.randomBytes(3).toString('hex')}.json`);
  fs.writeFileSync(`${destino}.tmp`, JSON.stringify({ recibidoEn: new Date().toISOString(), evento }));
  fs.renameSync(`${destino}.tmp`, destino);
  if (a.employeeNoString) log(`lector: persona ${a.employeeNoString} · evento ${a.subEventType}`);
}

async function bucleEventos() {
  for (;;) {
    for (const f of fs.readdirSync(COLA).filter((x) => x.endsWith('.json')).sort()) {
      const archivo = path.join(COLA, f);
      try {
        await sistema('/evento', JSON.parse(fs.readFileSync(archivo, 'utf8')));
        fs.unlinkSync(archivo);
        avisar('entradas', 'subiendo al sistema');
      } catch (e) {
        // Un evento imposible no atasca a los demás; todo lo otro se reintenta
        if (e.status === 400 || e instanceof SyntaxError) {
          fs.renameSync(archivo, `${archivo}.rechazado`);
          continue;
        }
        avisar('entradas', `guardadas en esta PC hasta que se pueda (${e.cause?.code ?? e.message})`);
        break;
      }
    }
    await dormir(2000);
  }
}

async function bucleLector() {
  let avisadoA = '';
  let cuando = 0;
  for (;;) {
    let conectado = true;
    try {
      const reloj = await revisarReloj(lector, { corregir: true });
      avisar('reloj', reloj.ok ? (reloj.corregido ? reloj.detalle : 'en hora') : reloj.detalle);
      const mia = await ipHacia(cfg.lector.ip, cfg.lector.puerto);
      // Se repite cada 5 min y si cambia la IP de la PC
      if (mia !== avisadoA || Date.now() - cuando > 300_000) {
        const r = await ponerAviso(lector, { ip: mia, puerto: cfg.puertoLocal, ruta: cfg.ruta });
        avisar('lector', r.ok ? `conectado; avisa las entradas a ${mia}:${cfg.puertoLocal}` : `no aceptó el aviso de eventos (${r.detalle})`);
        if (r.ok) {
          avisadoA = mia;
          cuando = Date.now();
        }
      }
    } catch (e) {
      avisar('lector', `SIN CONEXIÓN con ${cfg.lector.ip} (${e.cause?.code ?? e.message}). Reintentando…`);
      avisadoA = '';
      conectado = false;
    }
    // Caído: se reintenta cada 5 s para reconectar apenas vuelva
    await dormir(conectado ? (cfg.revisarCadaMs ?? 20000) : 5000);
  }
}

try {
  await escuchar({ puerto: cfg.puertoLocal, ruta: cfg.ruta, ipLector: cfg.lector.ip, alRecibir: guardarEvento, alRechazar: (m) => avisar('rechazado', m) });
} catch (e) {
  log(e.code === 'EADDRINUSE' ? 'El puente ya está corriendo (en otra ventana o por debajo como tarea de Windows).' : e.message);
  process.exit(2);
}
log('PUENTE DEL LECTOR · MERKGUSTO GYM · iniciado');
void buclePedidos();
void bucleEventos();
void bucleLector();
