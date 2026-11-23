// Lector de punta a punta SIN hardware: kit + puente + backend + BD desechable + DS-K1T321MFWX falso.
// El lector falso tiene reloj propio (vuelve a 2015 al cortar la luz), decide con Valid y manda multipart.
//   node scripts/e2e-lector.mjs        (crea y borra su propia base; no toca ninguna otra)
import 'dotenv/config';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lector e2e '));
const DB = `merkgusto_lector_e2e_${Date.now()}`;
const PL = 18080; // lector
const PS = 5067; // backend (fetch bloquea 5060 y 5061)
const PA = 5056; // puente
const CLAVE = 'Clave-Falsa-2026!';
const TOKEN = crypto.randomBytes(32).toString('hex');
const WEBHOOK = crypto.randomBytes(24).toString('hex');
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const local = (ms) => new Date(ms - 4 * 3600_000).toISOString().slice(0, 19);

let ok = 0;
let mal = 0;
const check = (c, m, extra) => {
  if (c) ok++;
  else mal++;
  console.log(`  ${c ? '✓' : '✗'} ${m}${!c && extra !== undefined ? ` ${JSON.stringify(extra).slice(0, 700)}` : ''}`);
};
async function hasta(fn, ms = 20000) {
  const fin = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    if (Date.now() > fin) return null;
    await dormir(300);
  }
}

// ═════════ Lector falso ═════════
const F = {
  personas: new Map(),
  rostros: new Map(),
  desfase: 0,
  serie: 100,
  avisoUrl: null,
  avisoXml: '<HttpHostNotificationList><HttpHostNotification><id>1</id><url>/original</url></HttpHostNotification></HttpHostNotificationList>',
  aperturas: 0,
  abrio: false,
  fallosClave: 0,
  rutas: [],
  puerta403: false,
  campoFoto: 'img',
};
const sockets = new Set();
const nonce = crypto.randomBytes(12).toString('hex');
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(4000).map((b) => b & 0x7f), Buffer.from([0xff, 0xd9])]);

const lectorFalso = http.createServer((req, res) => {
  const t = [];
  req.on('data', (c) => t.push(c));
  req.on('end', () => {
    const b = Buffer.concat(t);
    const enviar = (s, ct, c) => (res.writeHead(s, { 'Content-Type': ct }), res.end(c));
    const bien = () => enviar(200, 'application/json', '{"statusCode":1,"statusString":"OK","subStatusCode":"ok"}');
    const no = (sub, s = 400) => enviar(s, 'application/json', JSON.stringify({ statusCode: 6, subStatusCode: sub }));
    const a = req.headers.authorization ?? '';
    const p = {};
    for (const m of a.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) p[m[1]] = m[2] ?? m[3];
    const bueno =
      p.nonce === nonce && p.uri === req.url &&
      p.response === md5(`${md5(`${p.username}:FALSO:${CLAVE}`)}:${nonce}:${p.nc}:${p.cnonce}:auth:${md5(`${req.method}:${p.uri}`)}`);
    if (!bueno) {
      if (a) F.fallosClave++;
      res.writeHead(401, { 'WWW-Authenticate': `Digest qop="auth", realm="FALSO", nonce="${nonce}", stale="FALSE"` });
      return res.end();
    }
    const u = new URL(req.url, 'http://x').pathname;
    const k = `${req.method} ${u}`;
    F.rutas.push(k);
    if (k === 'GET /ISAPI/System/deviceInfo')
      return enviar(200, 'application/xml', '<DeviceInfo><model>DS-K1T321MFWX</model><serialNumber>FALSO321</serialNumber><macAddress>aa:bb:cc:dd:ee:ff</macAddress><firmwareVersion>V3.9.2</firmwareVersion></DeviceInfo>');
    if (k === 'GET /ISAPI/System/time')
      return enviar(200, 'application/xml', `<Time><timeMode>manual</timeMode><localTime>${local(Date.now() + F.desfase)}-04:00</localTime><timeZone>CST+4:00:00</timeZone></Time>`);
    if (k === 'PUT /ISAPI/System/time') {
      F.desfase = Date.parse(b.toString().match(/<localTime>([^<]+)/)[1]) - Date.now();
      return bien();
    }
    if (u.endsWith('/UserInfo/Record') || u.endsWith('/UserInfo/Modify')) {
      if (req.method !== (u.endsWith('Record') ? 'POST' : 'PUT')) return no('methodNotAllowed');
      const i = JSON.parse(b.toString()).UserInfo;
      if (!i.doorRight || i.Valid.endTime > '2037-12-31T23:59:59' || i.Valid.beginTime < '1970-01-01') return no('badParameters');
      if (u.endsWith('Record') && F.personas.has(i.employeeNo)) return no('employeeNoAlreadyExist');
      if (u.endsWith('Modify') && !F.personas.has(i.employeeNo)) return no('employeeNoNotExist');
      F.personas.set(i.employeeNo, i);
      return bien();
    }
    if (k === 'PUT /ISAPI/AccessControl/UserInfo/Delete') {
      for (const e of JSON.parse(b.toString()).UserInfoDelCond.EmployeeNoList) {
        F.personas.delete(e.employeeNo);
        F.rostros.delete(e.employeeNo);
      }
      return bien();
    }
    if (u.endsWith('/FaceDataRecord') || u.endsWith('/FDSetUp')) {
      const s = b.toString('latin1');
      const id = s.match(/"FPID":"(\w+)"/)?.[1];
      if (!s.includes(`name="${F.campoFoto}"`)) return no('badParameters');
      if (!F.personas.has(id)) return no('employeeNoNotExist');
      if (u.endsWith('FaceDataRecord') && F.rostros.has(id)) return no('deviceUserAlreadyExistFace');
      F.rostros.set(id, b.length);
      return bien();
    }
    if (u.endsWith('/FDSearch/Delete')) {
      for (const x of JSON.parse(b.toString()).FPID) F.rostros.delete(x.value);
      return bien();
    }
    if (k === 'POST /ISAPI/AccessControl/CaptureFaceData') {
      // Como octet-stream: algunos firmwares no lo marcan image/jpeg
      const c = Buffer.concat([Buffer.from('--cap\r\nContent-Type: application/xml\r\n\r\n<CaptureFaceData><captureProgress>100</captureProgress></CaptureFaceData>\r\n--cap\r\nContent-Type: application/octet-stream\r\n\r\n'), jpeg, Buffer.from('\r\n--cap--\r\n')]);
      return enviar(200, 'multipart/form-data; boundary=cap', c);
    }
    if (k === 'PUT /ISAPI/AccessControl/RemoteControl/door/1') {
      if (F.puerta403) return no('notSupport', 403);
      F.aperturas++;
      F.abrio = true;
      return bien();
    }
    if (u.startsWith('/ISAPI/Event/notification/httpHosts')) {
      if (req.method === 'GET') return enviar(200, 'application/xml', F.avisoXml);
      const s = b.toString();
      F.avisoXml = s;
      const de = (n) => s.match(new RegExp(`<${n}>([^<]+)`))?.[1];
      F.avisoUrl = de('ipAddress') ? `http://${de('ipAddress')}:${de('portNo')}${de('url')}` : null;
      return bien();
    }
    if (k.endsWith('UserInfo/Count')) return enviar(200, 'application/json', `{"UserInfoCount":{"userNumber":${F.personas.size}}}`);
    if (k.endsWith('FDLib/Count')) return enviar(200, 'application/json', `{"FDRecordDataInfo":[{"recordDataNumber":${F.rostros.size}}]}`);
    return no('notSupport', 403);
  });
});
lectorFalso.on('connection', (s) => (sockets.add(s), s.on('close', () => sockets.delete(s))));

function cortarLuz() {
  F.desfase = Date.parse('2015-01-01T00:00:06-04:00') - Date.now();
  for (const s of sockets) s.destroy();
}

/** Alguien mira al lector: decide con su reloj y avisa. */
async function mirar(id, { repetir, sub, grande } = {}) {
  let ev = repetir;
  if (!ev) {
    const p = F.personas.get(id);
    const ahora = local(Date.now() + F.desfase);
    const codigo = sub ?? (!p || !F.rostros.has(id) ? 76 : ahora < p.Valid.beginTime || ahora > p.Valid.endTime ? 8 : 75);
    F.abrio = codigo === 75;
    ev = {
      ipAddress: '127.0.0.1',
      macAddress: 'aa:bb:cc:dd:ee:ff',
      dateTime: `${ahora}-04:00`,
      eventType: 'AccessControllerEvent',
      AccessControllerEvent: { majorEventType: 5, subEventType: codigo, ...(p && { employeeNoString: id }), serialNo: ++F.serie, currentVerifyMode: 'cardOrFaceOrFpOrEmployeeNoAndPwOrSomethingLong' },
    };
  }
  let status = 0;
  if (F.avisoUrl) {
    const body = Buffer.concat([
      Buffer.from(`--ev\r\nContent-Disposition: form-data; name="event_log"; filename="event_log.json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(ev)}\r\n`),
      Buffer.from('--ev\r\nContent-Disposition: form-data; name="Picture"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'),
      grande ? Buffer.alloc(2 * 1024 * 1024, 7) : jpeg,
      Buffer.from('\r\n--ev--\r\n'),
    ]);
    status = await fetch(F.avisoUrl, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=ev' }, body }).then((r) => r.status, () => 0);
  }
  return { ev, status, abrio: F.abrio };
}

// ═════════ Procesos ═════════
const hijos = new Set();
function lanzar(args, env = {}) {
  const p = spawn(process.execPath, args, { cwd: RAIZ, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  p.salida = '';
  p.stdout.on('data', (d) => (p.salida += d));
  p.stderr.on('data', (d) => (p.salida += d));
  p.fin = new Promise((r) => p.on('exit', (c) => (hijos.delete(p), r(c))));
  hijos.add(p);
  return p;
}
async function parar(p) {
  p.kill();
  await p.fin;
}

/** Corre el kit contestando como lo haría una persona en el gimnasio. */
async function kit(opcion, { clave = CLAVE } = {}) {
  const p = lanzar(['lector/lector.mjs', String(opcion)], { LECTOR_DIR: TMP, LECTOR_PUERTO_LOCAL: String(PA), LECTOR_ESPERA_MS: '5000' });
  let visto = 0;
  const reglas = [
    [/IP del lector.*: $/, () => '127.0.0.1'],
    [/Puerto.*: $/, () => String(PL)],
    [/Usuario.*: $/, () => 'admin'],
    [/Contraseña del lector.*: $/, () => clave],
    [/Dirección del backend.*: $/, () => `http://localhost:${PS}`],
    [/MIRA AL LECTOR: $/, () => (setTimeout(() => void mirar('99999999'), 300), '')],
    [/¿La puerta o el relé abrió\?.*: $/, () => (F.abrio ? 'S' : 'N')],
    [/Desconecta la corriente.*: $/, () => (cortarLuz(), '')],
    [/\(S\/N\): $/, () => 'S'],
    [/Enter para tomar la foto: $/, () => ''],
  ];
  let vivo = true;
  void p.fin.then(() => (vivo = false));
  const limite = Date.now() + 90000;
  while (vivo && Date.now() < limite) {
    const nuevo = p.salida.slice(visto);
    const r = reglas.find(([re]) => re.test(nuevo));
    if (r) {
      visto = p.salida.length;
      p.stdin.write(`${r[1]()}\n`);
    }
    await dormir(50);
  }
  if (vivo) p.kill();
  return { codigo: await p.fin, salida: p.salida };
}

const BASE = `http://localhost:${PS}/api`;
async function call(metodo, ruta, body, token) {
  const r = await fetch(BASE + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) });
  return { s: r.status, j: await r.json().catch(() => null) };
}
async function backend(modo) {
  const p = lanzar(['--import', 'tsx', 'src/index.ts'], {
    PORT: String(PS),
    DATABASE_URL: '',
    DB_NAME: DB,
    NODE_ENV: 'development',
    ABRIR_NAVEGADOR: 'false',
    WHATSAPP_ENABLED: 'false',
    GROQ_API_KEY: '',
    STORAGE_DIR: path.join(TMP, 'storage'),
    ARCHIVOS_DIR: '',
    DUENO_USUARIO: 'dueno',
    DUENO_PASSWORD: 'SoloPruebas2026*',
    BIOMETRIC_MODE: modo,
    BIOMETRIC_DECISION: 'lector',
    BIOMETRIC_PUENTE_TOKEN: TOKEN,
    BIOMETRIC_WEBHOOK_TOKEN: WEBHOOK,
    BIOMETRIC_PUBLIC_URL: `http://127.0.0.1:${PS}`,
    BIOMETRIC_ALLOWED_IPS: '',
    BIOMETRIC_DEVICE_MACS: '',
    BIOMETRIC_DEVICE_IPS: '',
    HIKVISION_HOST: `http://127.0.0.1:${PL}`,
    HIKVISION_USER: 'admin',
    HIKVISION_PASSWORD: modo === 'isapi' ? CLAVE : '',
    HIKVISION_BREAKER_COOLDOWN_MS: '1000',
  });
  if (!(await hasta(async () => (await fetch(`${BASE}/health`)).ok, 90000))) throw new Error(`backend no arrancó:\n${p.salida}`);
  return p;
}

const pgCfg = (database) => ({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database,
});
let db;

try {
  if (!['localhost', '127.0.0.1'].includes(pgCfg().host)) throw new Error('esta prueba solo corre contra un Postgres local');
  await new Promise((r) => lectorFalso.listen(PL, '0.0.0.0', r));

  console.log('\n── Kit');
  F.desfase = Date.parse('2015-01-01T00:00:06-04:00') - Date.now();
  let k = await kit(1);
  check(k.codigo === 0 && /\[OJO\] Reloj: MAL/.test(k.salida) && /DS-K1T321MFWX/.test(k.salida), 'diagnóstico identifica el equipo y ve el reloj en 2015', k.salida.slice(-700));
  check(!F.rutas.some((r) => r.startsWith('PUT') || r.startsWith('POST')), 'el diagnóstico no escribe nada en el lector', F.rutas);
  F.fallosClave = 0;
  k = await kit(1, { clave: 'incorrecta' });
  check(k.codigo === 1 && F.fallosClave === 1, 'contraseña mala: un solo intento', F.fallosClave);

  F.campoFoto = 'FaceImage';
  k = await kit(2);
  check(k.codigo === 0 && !/\[FALLA\]/.test(k.salida), 'prueba completa sin fallas', k.salida.slice(-1800));
  for (const n of ['Cliente al día', 'Cliente vencido', 'Cliente renovado', 'Cliente al día tras el corte'])
    check(k.salida.includes(`[PASA] ${n}: evento recibido`) && k.salida.includes(`[PASA] ${n}: puerta`), `kit: ${n}`);
  check(/Corregir reloj tras el corte/.test(k.salida), 'kit: corrige el reloj tras el corte de luz');
  check(!F.personas.size && !F.rostros.size, 'borra las personas de prueba', [...F.personas.keys()]);
  check(F.avisoXml.includes('/original'), 'restaura el aviso de eventos que tenía');
  k = await kit(3);
  const archivo = path.join(TMP, 'lector.config.json');
  const cfg = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  check(k.codigo === 0 && cfg.token.length === 64 && k.salida.includes('BIOMETRIC_MODE=puente'), 'opción 3 guarda la configuración');
  const informes = fs.readdirSync(TMP).filter((f) => f.startsWith('informe-')).map((f) => fs.readFileSync(path.join(TMP, f), 'utf8')).join();
  check(!informes.includes(CLAVE) && !informes.includes(cfg.token), 'los informes no llevan contraseña ni clave');
  fs.writeFileSync(archivo, JSON.stringify({ ...cfg, token: TOKEN, revisarCadaMs: 1500 }));

  console.log('\n── Sistema en la nube + puente');
  let srv = await backend('puente');
  db = new pg.Client(pgCfg(DB));
  db.on('error', () => undefined);
  await db.connect();
  const D = (await call('POST', '/auth/login', { usuario: 'dueno', password: 'SoloPruebas2026*' })).j.token;
  check((await call('GET', '/puente/pedidos')).s === 401, 'puente sin clave: 401');
  check((await call('GET', '/puente/pedidos', null, D)).s === 401, 'la sesión del dueño no sirve como clave del puente');
  let est = (await call('GET', '/biometric/status', null, D)).j;
  check(!est.online && est.puente.conectado === false && est.decision === 'lector', 'sin puente: fuera de línea y decide el lector', est);

  let puente = lanzar(['lector/puente.mjs'], { LECTOR_DIR: TMP });
  est = await hasta(async () => {
    const e = (await call('GET', '/biometric/status', null, D)).j;
    return e.online ? e : null;
  }, 30000);
  check(est?.device?.model === 'DS-K1T321MFWX', 'el panel ve el lector a través del puente', est);
  check(!!(await hasta(() => F.avisoUrl?.includes(`:${PA}/evento/`))), 'el puente se registra en el lector');

  const cap = await call('POST', '/lector/capturar-rostro', {}, D);
  check(cap.s === 200 && cap.j.foto === `data:image/jpeg;base64,${jpeg.toString('base64')}`, 'foto capturada por el puente, idéntica byte a byte', cap.s);
  const socio = async (nombre, ced, foto) => (await call('POST', '/socios', { nombre, apellido: 'Lector', telefono: '04141112233', cedula: ced, foto }, D)).j;
  const s1 = await socio('Andrés', 'V20111222', cap.j.foto);
  const cod = String(s1.codigo ?? (await db.query('select codigo from socios where id=$1', [s1.id])).rows[0].codigo);
  check(!!(await hasta(() => F.rostros.has(cod), 30000)), 'alta: ficha y rostro llegan al lector (campo FaceImage)');
  check((await mirar(cod)).abrio === false, 'sin plan: no abre');
  check(!!(await hasta(async () => (await db.query("select 1 from asistencias where employee_no=$1 and resultado='denegado'", [cod])).rowCount === 1)), 'sin plan: el rechazo queda registrado');

  let plan = (await db.query('select id from planes where acceso_lector and activo limit 1')).rows[0]?.id;
  if (!plan) plan = (await call('POST', '/planes', { nombre: 'Mensual prueba', duracionDias: 30, tipoDuracion: 'meses', cantidad: 1, precio: 10, moneda: 'USD', accesoLector: true }, D)).j?.id;
  const darPlan = async (dias) => {
    await db.query('delete from membresias where socio_id=$1', [s1.id]);
    await db.query(
      `insert into membresias (socio_id, plan_id, fecha_inicio, fecha_fin, estado, precio) values ($1,$2,current_date-40,current_date+$3::int,'activa',0)`,
      [s1.id, plan, dias],
    );
    await call('POST', `/biometric/socios/${s1.id}/sync`, {}, D);
  };
  await darPlan(20);
  const hoyLocal = local(Date.now());
  check(!!(await hasta(() => F.personas.get(cod).Valid.endTime > hoyLocal, 30000)), 'pago: la vigencia llega al lector (Record → Modify)');

  const filas = async () => (await db.query('select resultado, fecha_hora, metodo_verif from asistencias where employee_no=$1 order by id', [cod])).rows;
  let antes = (await filas()).length;
  const e1 = await mirar(cod, { grande: true });
  check(e1.abrio && e1.status === 200, 'al día: abre y el puente acepta una foto de 2 MB', e1.status);
  check(!!(await hasta(async () => (await filas()).length === antes + 1)), 'la entrada aparece en el sistema');
  check((await filas()).at(-1)?.resultado === 'permitido', 'queda como permitida (modo de verificación largo incluido)');
  await mirar(cod, { repetir: e1.ev });
  await dormir(4000);
  check((await filas()).length === antes + 1, 'evento repetido: no se duplica');

  antes = (await filas()).length;
  await mirar(cod, { repetir: { ...e1.ev, dateTime: `${local(Date.now() - 3600_000)}-04:00` } });
  check(!!(await hasta(async () => (await filas()).length === antes + 1)), 'serial reiniciado con otra hora: no se pierde');

  antes = (await filas()).length;
  await mirar(cod, { repetir: { ...e1.ev, dateTime: '2015-01-01T00:03:00-04:00', AccessControllerEvent: { ...e1.ev.AccessControllerEvent, serialNo: 9001 } } });
  await hasta(async () => (await filas()).length === antes + 1);
  const ult = (await filas()).at(-1);
  check(Math.abs(new Date(ult.fecha_hora) - Date.now()) < 120000, 'evento fechado en 2015 se guarda con la hora real', ult);

  cortarLuz();
  check((await mirar(cod)).abrio === false, 'se reproduce el fallo: con reloj en 2015 rechaza a un cliente al día');
  check(!!(await hasta(() => Math.abs(F.desfase) < 60000, 15000)), 'el puente corrige el reloj solo');
  check((await mirar(cod)).abrio === true, 'y el cliente vuelve a entrar');

  const ap = F.aperturas;
  check((await call('POST', '/lector/abrir-puerta', {}, D)).s === 400 && F.aperturas === ap, 'sin motivo no abre');
  check((await call('POST', '/lector/abrir-puerta', { motivo: 'Visita del técnico' }, D)).s === 200 && F.aperturas === ap + 1, 'abre desde recepción una sola vez');
  check((await db.query("select 1 from auditoria where accion='puerta.abierta'")).rowCount === 1, 'apertura auditada');
  F.puerta403 = true;
  check((await call('POST', '/lector/abrir-puerta', { motivo: 'Prueba de rechazo' }, D)).s === 400, '403 notSupport se informa');
  est = (await call('GET', '/biometric/status', null, D)).j;
  check(est.online && est.breaker === 'closed', 'un 403 no tumba la integración', est);
  F.puerta403 = false;

  const simulada = `data:image/jpeg;base64,${fs.readFileSync(path.join(RAIZ, 'assets/rostro-simulado.jpg')).toString('base64')}`;
  const s2 = await socio('Beatriz', 'V20111333', simulada);
  const errFoto = await hasta(async () => (await db.query("select ultimo_error from bio_cola where socio_id=$1 and estado='descartado'", [s2.id])).rows[0], 20000);
  check(/simulado/.test(errFoto?.ultimo_error ?? ''), 'una foto del simulador no llega al lector real', errFoto);
  const st = await call('POST', '/biometric/sync-total', {}, D);
  check(st.j.omitidosSinPlan >= 1, 'sincronizar todos no gasta cupos en clientes sin plan', st.j);
  await hasta(async () => !(await db.query("select 1 from bio_cola where estado in ('pendiente','procesando')")).rowCount, 30000);

  console.log('\n── Caídas');
  await parar(puente);
  await hasta(async () => !(await call('GET', '/biometric/status', null, D)).j.online, 60000);
  await darPlan(60);
  // Primero que falle una vez: si se cambia mientras se procesa, el proceso pisa el contador
  await hasta(async () => (await db.query("update bio_cola set intentos=50 where socio_id=$1 and estado='error' and proximo_intento > now() + interval '2 seconds' returning id", [s1.id])).rowCount, 100000);
  const fila = await hasta(async () => (await db.query("select estado,intentos from bio_cola where socio_id=$1 and estado in ('error','descartado') and intentos>50 order by id desc limit 1", [s1.id])).rows[0], 100000);
  check(fila?.estado === 'error', 'PC apagada por horas: la renovación espera y NO se descarta', fila);
  const finEsperado = local(Date.now() + 55 * 86400_000);
  puente = lanzar(['lector/puente.mjs'], { LECTOR_DIR: TMP });
  check(!!(await hasta(() => F.personas.get(cod).Valid.endTime > finEsperado, 150000)), 'al volver la PC la renovación llega sola');

  await parar(srv);
  antes = (await filas()).length;
  check((await mirar(cod)).abrio === true, 'sin internet el lector sigue abriendo');
  await mirar(cod);
  await dormir(1500);
  check(fs.readdirSync(path.join(TMP, 'eventos-pendientes')).length === 2, 'sin internet las entradas quedan en la PC');
  await parar(puente);
  puente = lanzar(['lector/puente.mjs'], { LECTOR_DIR: TMP });
  srv = await backend('puente');
  check(!!(await hasta(async () => (await filas()).length === antes + 2, 30000)), 'al volver suben todas, aun reiniciando el puente');

  await darPlan(-1);
  check(!!(await hasta(() => F.personas.get(cod).Valid.endTime < local(Date.now()), 90000)), 'vencimiento llega al lector');
  antes = (await filas()).length;
  check((await mirar(cod)).abrio === false, 'vencido: no abre');
  check(!!(await hasta(async () => (await filas()).slice(antes).some((r) => r.resultado === 'denegado'))), 'vencido: el rechazo queda registrado');
  await parar(puente);
  await parar(srv);

  console.log('\n── Servidor en la misma red (isapi directo)');
  cortarLuz();
  srv = await backend('isapi');
  const D2 = (await call('POST', '/auth/login', { usuario: 'dueno', password: 'SoloPruebas2026*' })).j.token;
  check(!!(await hasta(async () => (await call('GET', '/biometric/status', null, D2)).j.online && Math.abs(F.desfase) < 60000)), 'directo: conecta y corrige el reloj');
  check((await call('POST', '/biometric/listener', {}, D2)).s === 200, 'directo: configura el webhook');
  antes = (await filas()).length;
  const e2 = await mirar(cod, { grande: true });
  check(e2.status === 200 && (await filas()).length === antes + 1, 'directo: JSON como archivo + foto de 2 MB', e2.status);
  antes = (await filas()).length;
  await mirar(cod, { sub: 80 });
  check((await filas()).slice(antes)[0]?.resultado === 'denegado', 'directo: código 80 queda como rechazo');
  const basura = await fetch(F.avisoUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check(basura.status === 200, 'cuerpo raro: 200, no atasca la cola del lector');
  await parar(srv);
} catch (e) {
  check(false, `la prueba se interrumpió: ${e.stack}`);
} finally {
  for (const p of [...hijos]) await parar(p);
  await db?.end().catch(() => undefined);
  const adm = new pg.Client(pgCfg('postgres'));
  try {
    await adm.connect();
    await adm.query(`drop database if exists "${DB}" with (force)`); // solo la que creó esta corrida
  } catch (e) {
    console.log(`no se pudo borrar ${DB}: ${e.message}`);
  } finally {
    await adm.end().catch(() => undefined);
  }
  lectorFalso.close();
  lectorFalso.closeAllConnections();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${ok} OK, ${mal} fallos`);
  process.exit(mal ? 1 : 0);
}
