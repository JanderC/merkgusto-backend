// Kit del lector: 1) diagnóstico (solo lee)  2) prueba real con una persona  3) conectar con el sistema.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import * as L from './lib.mjs';

const DIR = process.env.LECTOR_DIR ?? path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(DIR, 'lector.config.json');
const PUERTO = Number(process.env.LECTOR_PUERTO_LOCAL ?? 5055);
const ESPERA = Number(process.env.LECTOR_ESPERA_MS ?? 45000);
const SISTEMA = 'https://merkgusto-backend-production.up.railway.app';

const pasos = [];
const registro = [];
function decir(t = '') {
  console.log(t);
  registro.push(t);
}
function paso(estado, nombre, detalle = '') {
  pasos.push({ estado, nombre, detalle });
  decir(`  [${estado}] ${nombre}${detalle ? `: ${detalle}` : ''}`);
  return estado === 'PASA';
}

// ───────── Preguntas ─────────
let oculto = false;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '', terminal: !!process.stdin.isTTY });
const escribir = rl._writeToOutput?.bind(rl);
if (escribir) rl._writeToOutput = (s) => { if (!oculto) escribir(s); };
const lineas = rl[Symbol.asyncIterator]();
async function preguntar(texto, defecto = '', secreto = false) {
  process.stdout.write(`${texto}${defecto ? ` [${defecto}]` : ''}: `);
  oculto = secreto;
  const { value, done } = await lineas.next();
  oculto = false;
  if (secreto) process.stdout.write('\n');
  if (done) throw new Error('cancelado');
  return value.trim() || defecto;
}
const si = async (texto) => /^s/i.test(await preguntar(`${texto} (S/N)`));

function guardarInforme(nombre) {
  const archivo = path.join(DIR, `informe-${nombre}-${L.horaGym().replace(/:/g, '-')}.txt`);
  const n = (e) => pasos.filter((p) => p.estado === e).length;
  decir('');
  decir(`RESULTADO: ${n('PASA')} pasan, ${n('FALLA')} fallan, ${n('OJO')} por revisar`);
  for (const p of pasos) if (p.estado !== 'PASA') decir(`  ${p.estado} -> ${p.nombre}: ${p.detalle}`);
  fs.writeFileSync(archivo, `﻿${registro.join('\r\n')}\r\n`);
  console.log(`\nInforme guardado (sin contraseñas): ${archivo}\nPásaselo a Claude tal cual.`);
}
// La ruta del aviso y las credenciales nunca van al informe
const limpiar = (t) =>
  t
    .replace(/<(url|userName|password)>[^<]*<\/\1>/gi, '<$1>***</$1>')
    .replace(/"(url|userName|password)"\s*:\s*"[^"]*"/gi, '"$1":"***"');

async function entrar() {
  const previa = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')).lector : {};
  const ip = await preguntar('IP del lector', previa.ip ?? '192.168.1.20');
  const puerto = Number(await preguntar('Puerto', String(previa.puerto ?? 80)));
  const usuario = await preguntar('Usuario', previa.usuario ?? 'admin');
  const escrita = await preguntar(`Contraseña del lector (no se ve al escribir${previa.clave ? '; Enter = la guardada' : ''})`, '', true);
  const clave = escrita || previa.clave || '';
  const datos = { ip, puerto, usuario, clave };
  const lector = L.crearLector(datos);

  let miIp;
  try {
    miIp = await L.ipHacia(ip, puerto);
    paso('PASA', 'Red', `esta PC (${miIp}) llega al lector (${ip}:${puerto})`);
  } catch (e) {
    paso('FALLA', 'Red', `no responde ${ip}:${puerto} (${e.code ?? e.message}). Revisa cable, que la PC esté en la misma red y la IP en el menú del lector (o con SADP)`);
    return null;
  }
  const r = await lector.pedir('GET', '/ISAPI/System/deviceInfo');
  if (r.status === 401) {
    const espera = L.tag(r.texto, 'unlockTime');
    paso('FALLA', 'Contraseña', espera && Number(espera) > 0 ? `cuenta bloqueada ${Math.ceil(espera / 60)} min: espera` : 'rechazada. NO pruebes muchas veces: al 5.º fallo se bloquea. Verifícala en la web del lector');
    return null;
  }
  if (!L.resultado(r).ok) {
    paso('FALLA', 'ISAPI', L.resultado(r).detalle);
    return null;
  }
  paso('PASA', 'Contraseña e ISAPI');
  const modelo = L.tag(r.texto, 'model') ?? '?';
  paso(/K1T321/i.test(modelo) ? 'PASA' : 'OJO', 'Equipo', `${modelo} · firmware ${L.tag(r.texto, 'firmwareVersion')} ${L.tag(r.texto, 'firmwareReleasedDate') ?? ''}`);
  return { lector, datos, miIp };
}

// ═════════ 1. Diagnóstico ═════════
async function diagnostico() {
  decir('DIAGNÓSTICO (solo lee, no cambia nada)\n');
  const c = await entrar();
  if (!c) return;
  const { lector } = c;
  const reloj = await L.revisarReloj(lector);
  paso(reloj.ok ? 'PASA' : 'OJO', 'Reloj', reloj.detalle);

  const consultas = [
    ['Personas cargadas', '/ISAPI/AccessControl/UserInfo/Count?format=json'],
    ['Rostros cargados', '/ISAPI/Intelligent/FDLib/Count?format=json&FDID=1&faceLibType=blackFD'],
    ['Reglas de personas', '/ISAPI/AccessControl/UserInfo/capabilities?format=json'],
    ['Reglas de rostros', '/ISAPI/Intelligent/FDLib/capabilities?format=json'],
    ['Captura de rostro', '/ISAPI/AccessControl/CaptureFaceData/capabilities'],
    ['Control de puerta', '/ISAPI/AccessControl/RemoteControl/door/capabilities'],
    ['Puerta', '/ISAPI/AccessControl/Door/param/1'],
    ['Opciones de acceso', '/ISAPI/AccessControl/AcsCfg?format=json'],
    ['Aviso de eventos', '/ISAPI/Event/notification/httpHosts'],
    ['Reglas del aviso', '/ISAPI/Event/notification/httpHosts/capabilities'],
  ];
  const crudo = [];
  for (const [nombre, ruta] of consultas) {
    try {
      const r = await lector.pedir('GET', ruta);
      const e = L.resultado(r);
      const total = nombre.endsWith('cargados') || nombre.endsWith('cargadas') ? r.texto.match(/"(?:userNumber|recordDataNumber|totalMatches)"\s*:\s*(\d+)/)?.[1] : null;
      paso(e.ok ? (Number(total) >= 450 ? 'OJO' : 'PASA') : 'OJO', nombre, e.ok ? (total ? `${total}${nombre.includes('Rostros') ? ' de 500' : ''}` : 'disponible') : e.detalle);
      crudo.push(`\r\n### ${ruta} (HTTP ${r.status})\r\n${limpiar(r.texto).slice(0, 8000)}`);
    } catch (e) {
      paso('OJO', nombre, e.message);
    }
  }
  registro.push('\r\n---- respuestas del lector ----', ...crudo);
}

// ═════════ 2. Prueba real ═════════
const ID = '99999999'; // cliente de prueba
const ID_ENT = 'E99999999'; // formato de los entrenadores

async function prueba() {
  decir('PRUEBA REAL (crea una persona de prueba y al final la borra)\n');
  const c = await entrar();
  if (!c) return;
  const { lector, miIp } = c;
  if (!(await si('Voy a poner el lector en hora y hacer pruebas con una persona temporal. ¿Seguimos?'))) return;

  const creados = [];
  let respaldoAviso = null;
  let servidor = null;
  let deshecho = false;

  async function deshacer() {
    if (deshecho) return;
    deshecho = true;
    decir('\nDejando el lector como estaba...');
    for (const id of creados) {
      try {
        await lector.pedir('PUT', '/ISAPI/Intelligent/FDLib/FDSearch/Delete?format=json&FDID=1&faceLibType=blackFD', { json: { FPID: [{ value: id }] } });
        const b = L.resultado(await lector.pedir('PUT', '/ISAPI/AccessControl/UserInfo/Delete?format=json', { json: { UserInfoDelCond: { EmployeeNoList: [{ employeeNo: id }] } } }));
        paso(b.ok ? 'PASA' : 'FALLA', `Borrar persona de prueba ${id}`, b.ok ? '' : b.detalle);
      } catch (e) {
        paso('FALLA', `Borrar persona de prueba ${id}`, `${e.message}. Bórrala en el menú del lector`);
      }
    }
    if (respaldoAviso) {
      const r = await L.restaurarAviso(lector, respaldoAviso).catch((e) => ({ ok: false, detalle: e.message }));
      paso(r.ok ? 'PASA' : 'OJO', 'Restaurar aviso de eventos', r.ok ? '' : r.detalle);
    }
    servidor?.close();
    servidor?.closeAllConnections();
  }
  const cancelar = () => void deshacer().finally(() => {
    guardarInforme('prueba');
    process.exit(1);
  });
  process.once('SIGINT', cancelar);
  rl.once('SIGINT', cancelar);

  try {
    const reloj = await L.revisarReloj(lector, { corregir: true });
    if (!paso(reloj.ok ? 'PASA' : 'FALLA', 'Reloj', reloj.detalle)) return;

    const hoy = L.horaGym().slice(0, 10);
    const vigente = L.ficha(ID, 'Prueba Sistema', `${hoy}T00:00:00`, '2037-12-31T23:59:59');
    // Misma ventana que manda el sistema para un cliente vencido
    const ayer = L.horaGym(new Date(Date.now() - 86_400_000)).slice(0, 10);
    const vencido = L.ficha(ID, 'Prueba Sistema', '2000-01-01T00:00:00', `${ayer}T23:59:59`);

    for (const [id, f] of [[ID, vigente], [ID_ENT, L.ficha(ID_ENT, 'Prueba Entrenador', '2020-01-01T00:00:00', '2037-12-31T23:59:59')]]) {
      const r = L.resultado(await lector.pedir('POST', '/ISAPI/AccessControl/UserInfo/Record?format=json', { json: f }));
      if (r.ok) creados.push(id);
      // Si ya existía no es nuestro: no se toca ni se borra
      const nombre = id === ID ? 'Crear cliente' : 'Crear entrenador (código con E)';
      if (!paso(r.ok ? 'PASA' : 'FALLA', nombre, r.ok ? '' : r.detalle) && id === ID) return;
    }

    await preguntar('\nPárate frente al lector, de frente y sin gorra. Enter para tomar la foto');
    let foto = await L.capturarRostro(lector);
    paso(foto.jpeg ? 'PASA' : 'OJO', 'Foto tomada por el lector', foto.jpeg ? `${Math.round(foto.jpeg.length / 1024)} KB` : foto.error);
    if (!foto.jpeg) {
      const archivo = (await preguntar('Arrastra aquí una foto .jpg de tu rostro (menos de 200 KB), o Enter para terminar')).replace(/^"|"$/g, '');
      if (!archivo || !fs.existsSync(archivo)) return;
      foto = { jpeg: fs.readFileSync(archivo) };
    }
    if (foto.jpeg.length > 200 * 1024) paso('OJO', 'Tamaño de la foto', 'pasa de 200 KB');
    const subida = await L.subirRostro(lector, ID, foto.jpeg);
    if (!paso(subida.ok ? 'PASA' : 'FALLA', 'Cargar rostro', subida.ok ? '' : subida.detalle)) return;

    const ruta = `/evento/${crypto.randomBytes(12).toString('hex')}`;
    const eventos = [];
    try {
      servidor = await L.escuchar({
        puerto: PUERTO,
        ruta,
        ipLector: lector.ip,
        alRecibir: (e) => {
          const a = e.AccessControllerEvent;
          if (!a) return;
          eventos.push(a);
          registro.push(`    evento ${e.dateTime} ${a.majorEventType}/${a.subEventType} persona=${a.employeeNoString ?? '-'} modo=${a.currentVerifyMode ?? '-'}`);
        },
        alRechazar: (m) => registro.push(`    rechazado: ${m}`),
      });
    } catch (e) {
      paso('FALLA', 'Puerto para eventos', e.code === 'EADDRINUSE' ? 'está ocupado: cierra PUENTE.bat durante la prueba' : e.message);
      return;
    }
    const antes = await L.leerAviso(lector);
    if (antes.ok) respaldoAviso = antes.xml;
    const aviso = await L.ponerAviso(lector, { ip: miIp, puerto: PUERTO, ruta });
    if (!paso(aviso.ok ? 'PASA' : 'FALLA', 'Configurar aviso de eventos', aviso.ok ? `${miIp}:${PUERTO}` : aviso.detalle)) return;

    // Cada mirada: el evento debe llegar Y la puerta hacer lo correcto
    async function mirar(titulo, debeAbrir) {
      await preguntar(`\n${titulo}. Aléjate del lector y presiona Enter; después MIRA AL LECTOR`);
      const desde = eventos.length;
      const limite = Date.now() + ESPERA;
      const buenos = debeAbrir ? [1, 75] : [6, 7, 8];
      const esMio = (a) => Number(a.majorEventType) === 5 && a.employeeNoString === ID;
      let visto;
      while (Date.now() < limite) {
        visto = eventos.slice(desde).find((a) => esMio(a) && buenos.includes(Number(a.subEventType)));
        if (visto) break;
        await L.dormir(300);
      }
      const otros = [...new Set(eventos.slice(desde).map((a) => `${a.majorEventType}/${a.subEventType}`))].join(', ');
      paso(
        visto ? 'PASA' : 'FALLA',
        `${titulo}: evento recibido`,
        visto ? `código ${visto.subEventType}` : otros ? `llegó otro código (${otros}); pásame el informe` : 'no llegó nada; casi siempre es el firewall de Windows (ver GUIA.md)',
      );
      const abrio = await si('¿La puerta o el relé abrió?');
      paso(abrio === debeAbrir ? 'PASA' : 'FALLA', `${titulo}: puerta`, abrio ? 'abrió' : 'no abrió');
    }

    const modificar = async (f, nombre) => {
      const r = L.resultado(await lector.pedir('PUT', '/ISAPI/AccessControl/UserInfo/Modify?format=json', { json: f }));
      return paso(r.ok ? 'PASA' : 'FALLA', nombre, r.ok ? '' : r.detalle);
    };

    await mirar('Cliente al día', true);
    if (await modificar(vencido, 'Vencer membresía')) await mirar('Cliente vencido', false);
    if (await modificar(vigente, 'Renovar membresía')) await mirar('Cliente renovado', true);

    if (await si('\n¿Probamos abrir la puerta desde la PC? Que no haya nadie pasando')) {
      const r = L.resultado(await lector.pedir('PUT', '/ISAPI/AccessControl/RemoteControl/door/1', { body: '<RemoteControlDoor><cmd>open</cmd></RemoteControlDoor>', tipo: 'application/xml' }));
      if (paso(r.ok ? 'PASA' : 'FALLA', 'Orden de abrir', r.ok ? '' : r.detalle)) paso((await si('¿Abrió?')) ? 'PASA' : 'FALLA', 'Cerradura o torniquete', 'si la orden pasa y no abre, es cableado o fuente');
    } else {
      paso('OJO', 'Abrir desde la PC', 'no se probó');
    }

    if (await si('\n¿Probamos un corte de luz? Es la prueba más importante')) {
      await preguntar('Desconecta la corriente del lector 10 segundos, conéctalo y, cuando termine de encender, presiona Enter');
      const limite = Date.now() + 120_000;
      let despues;
      while (!despues && Date.now() < limite) {
        try {
          despues = await L.revisarReloj(lector);
        } catch {
          await L.dormir(3000);
        }
      }
      if (!paso(despues ? 'PASA' : 'FALLA', 'Vuelve a la red tras el corte', despues ? '' : 'no volvió en 2 min: la IP pudo cambiar, ponla fija')) return;
      paso(despues.ok ? 'PASA' : 'OJO', 'Reloj tras el corte', despues.ok ? 'conservó la hora' : `${despues.detalle}. El puente lo corrige solo`);
      if (!despues.ok) {
        const f = await L.revisarReloj(lector, { corregir: true });
        paso(f.ok ? 'PASA' : 'FALLA', 'Corregir reloj tras el corte', f.detalle);
      }
      await mirar('Cliente al día tras el corte', true);
    } else {
      paso('OJO', 'Corte de luz', 'no se probó');
    }
  } finally {
    await deshacer();
  }
}

// ═════════ 4. Ver personas (solo lee) ═════════
async function personas() {
  decir('PERSONAS DEL LECTOR (solo lee, no cambia nada)\n');
  const c = await entrar();
  if (!c) return;
  const { lector } = c;
  const reloj = await L.revisarReloj(lector);
  paso(reloj.ok ? 'PASA' : 'OJO', 'Reloj', reloj.detalle);
  const todas = [];
  for (let pos = 0; pos < 3000; pos += 30) {
    const r = await lector.pedir('POST', '/ISAPI/AccessControl/UserInfo/Search?format=json', { json: { UserInfoSearchCond: { searchID: `ver${Date.now()}`, searchResultPosition: pos, maxResults: 30 } } });
    const s = r.json?.UserInfoSearch;
    if (!s) {
      paso('FALLA', 'Leer personas', L.resultado(r).detalle);
      return;
    }
    todas.push(...(s.UserInfo ?? []));
    if (s.responseStatusStrg !== 'MORE' || !(s.UserInfo ?? []).length) break;
  }
  const ahora = L.horaGym();
  const tipo = (id) => (/^E\d+$/.test(id) ? 'entrenador' : /^\d+$/.test(id) ? 'cliente' : 'otro');
  decir(`\n  ${todas.length} personas · ahora en el lector: ${ahora}\n`);
  for (const u of todas) {
    const v = u.Valid ?? {};
    const problemas = [];
    if (!u.numOfFace) problemas.push('SIN ROSTRO');
    if (u.userType && u.userType !== 'normal') problemas.push(`tipo ${u.userType}`);
    if (v.enable && v.beginTime > ahora) problemas.push('aún no empieza');
    if (v.enable && v.endTime < ahora) problemas.push('vencido');
    if (!u.doorRight) problemas.push('sin permiso de puerta');
    const linea = `${tipo(u.employeeNo).padEnd(10)} ${String(u.employeeNo).padEnd(10)} ${String(u.name ?? '').slice(0, 24).padEnd(24)} ${v.enable ? `${v.beginTime?.slice(0, 10)} → ${v.endTime?.slice(0, 10)}` : 'sin fechas'.padEnd(23)}  ${problemas.length ? `<< ${problemas.join(', ')}` : 'ok'}`;
    decir(`  ${linea}`);
    registro.push(`    detalle ${u.employeeNo}: ${JSON.stringify({ userType: u.userType, Valid: u.Valid, doorRight: u.doorRight, RightPlan: u.RightPlan, numOfFace: u.numOfFace, userVerifyMode: u.userVerifyMode, localUIRight: u.localUIRight })}`);
  }
  const ents = todas.filter((u) => tipo(u.employeeNo) === 'entrenador');
  paso(ents.length ? 'PASA' : 'OJO', 'Entrenadores en el lector', ents.length ? `${ents.length}` : 'ninguno: el sistema no los ha enviado');
  const malos = ents.filter((u) => !u.numOfFace || (u.Valid?.enable && (u.Valid.endTime < ahora || u.Valid.beginTime > ahora)));
  if (ents.length) paso(malos.length ? 'FALLA' : 'PASA', 'Entrenadores con rostro y fechas válidas', malos.length ? malos.map((u) => u.employeeNo).join(', ') : 'todos');
}

// ═════════ 3. Conectar con el sistema ═════════
async function conectar() {
  decir('CONECTAR CON EL SISTEMA\n');
  const c = await entrar();
  if (!c) return;
  const sistema = (await preguntar('Dirección del backend', SISTEMA)).replace(/\/+$/, '');
  const u = new URL(sistema);
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) {
    paso('FALLA', 'Dirección', 'por internet tiene que empezar con https://');
    return;
  }
  const previa = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {};
  const cfg = {
    ...previa,
    lector: c.datos,
    sistema,
    token: previa.token ?? crypto.randomBytes(32).toString('hex'),
    puertoLocal: PUERTO,
    ruta: previa.ruta ?? `/evento/${crypto.randomBytes(12).toString('hex')}`,
  };
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
  paso('PASA', 'Configuración guardada', 'lector.config.json (tiene contraseñas: no lo compartas)');
  // Directo a la consola: la clave no puede quedar en el informe
  console.log(`
En Railway -> servicio del backend -> Variables, pon estas dos:

  BIOMETRIC_MODE=puente
  BIOMETRIC_PUENTE_TOKEN=${cfg.token}

Espera a que redespliegue y abre PUENTE.bat. Debe decir "sistema: conectado" y "lector: conectado".
`);
}

const OPCIONES = { 1: ['diagnostico', diagnostico], 2: ['prueba', prueba], 3: ['conectar', conectar], 4: ['personas', personas] };
console.log(`
LECTOR FACIAL · MERKGUSTO GYM · Hikvision DS-K1T321MFWX

  1. Diagnóstico (solo lee)
  2. Prueba real con una persona
  3. Conectar con el sistema
  4. Ver personas del lector (solo lee)
`);
const elegida = OPCIONES[process.argv[2] ?? (await preguntar('Opción', '1'))];
if (elegida) {
  decir(`${elegida[0].toUpperCase()} · ${L.horaGym()}`);
  try {
    await elegida[1]();
  } catch (e) {
    paso('FALLA', 'Se interrumpió', String(e.cause?.code ?? e.message));
  }
  guardarInforme(elegida[0]);
}
rl.close();
process.stdin.destroy();
// Sin process.exit(): en Windows aborta (UV_HANDLE_CLOSING) si fetch todavía está cerrando conexiones
process.exitCode = pasos.some((p) => p.estado === 'FALLA') ? 1 : 0;
