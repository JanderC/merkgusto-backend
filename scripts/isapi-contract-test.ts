/**
 * Prueba de contrato del adaptador ISAPI SIN hardware.
 * Levanta un "lector falso" que exige HTTP Digest (MD5, qop=auth) y responde
 * como un DS-K1T344, y ejercita IsapiAccessControlService de punta a punta:
 *   Digest, alta/edición idempotente, rostro multipart, borrado,
 *   credenciales erróneas, timeout y circuit breaker.
 *
 *   npx tsx scripts/isapi-contract-test.ts
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { AccessControlError } from '../src/modules/biometric/contracts/errors.js';
import { IsapiAccessControlService } from '../src/modules/biometric/adapters/isapi/IsapiAccessControlService.js';

const USER = 'admin';
const PASS = 'Clave123!';
const REALM = 'DS-K1T344(MOCK)';
const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
const users = new Map<string, unknown>();
const faces = new Set<string>();
let colgado = false;
let capturas = 0;
let acsCfg: { remoteCheckDoorEnabled?: boolean } = {};
const remotos: Array<{ serialNo: number; checkResult: string; info: string }> = [];
const nonces = new Set<string>();

function digestOk(req: http.IncomingMessage): boolean {
  const h = req.headers.authorization;
  if (!h?.startsWith('Digest ')) return false;
  const p: Record<string, string> = {};
  for (const m of h.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) p[m[1]!] = m[2] ?? m[3] ?? '';
  if (!nonces.has(p.nonce!) || p.uri !== req.url) return false;
  const ha1 = md5(`${p.username}:${REALM}:${PASS}`);
  const ha2 = md5(`${req.method}:${p.uri}`);
  return p.response === md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (colgado) return; // simula lector que no responde
    if (!digestOk(req)) {
      const nonce = crypto.randomBytes(16).toString('hex');
      nonces.add(nonce);
      res.writeHead(401, { 'WWW-Authenticate': `Digest qop="auth", realm="${REALM}", nonce="${nonce}", stale="FALSE"` });
      return res.end();
    }
    const body = Buffer.concat(chunks).toString('latin1');
    const json = (o: unknown, s = 200) => {
      res.writeHead(s, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    const ok = { statusCode: 1, statusString: 'OK', subStatusCode: 'ok' };
    const url = req.url ?? '';
    if (url.startsWith('/ISAPI/System/deviceInfo')) {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end('<DeviceInfo><deviceName>Entrada</deviceName><model>DS-K1T344MBFWX-E1</model><serialNumber>FAKE123</serialNumber><macAddress>aa:bb:cc:dd:ee:ff</macAddress><firmwareVersion>V3.2.30</firmwareVersion></DeviceInfo>');
    }
    if (url.startsWith('/ISAPI/AccessControl/UserInfo/Record')) {
      const u = JSON.parse(body).UserInfo;
      if (users.has(u.employeeNo)) return json({ statusCode: 6, statusString: 'Invalid Content', subStatusCode: 'employeeNoAlreadyExist' }, 400);
      users.set(u.employeeNo, u);
      return json(ok);
    }
    if (url.startsWith('/ISAPI/AccessControl/UserInfo/Modify')) {
      const u = JSON.parse(body).UserInfo;
      users.set(u.employeeNo, u);
      return json(ok);
    }
    if (url.startsWith('/ISAPI/AccessControl/UserInfo/Delete')) {
      const id = JSON.parse(body).UserInfoDelCond.EmployeeNoList[0].employeeNo;
      users.delete(id);
      return json(ok);
    }
    if (url.startsWith('/ISAPI/Intelligent/FDLib/FaceDataRecord') || url.startsWith('/ISAPI/Intelligent/FDLib/FDSetUp')) {
      if (!String(req.headers['content-type']).startsWith('multipart/form-data')) return json({ statusCode: 4, subStatusCode: 'badContentType' }, 400);
      const fpid = body.match(/"FPID":"(\w+)"/)?.[1];
      const hasJpeg = body.includes('\xff\xd8');
      if (!fpid || !hasJpeg) return json({ statusCode: 6, subStatusCode: 'badFace' }, 400);
      if (url.includes('FaceDataRecord') && faces.has(fpid)) return json({ statusCode: 6, subStatusCode: 'deviceUserAlreadyExistFace' }, 400);
      faces.add(fpid);
      return json(ok);
    }
    if (url.startsWith('/ISAPI/AccessControl/CaptureFaceData')) {
      // Primera llamada: "capturando" (progreso 0); segunda: devuelve la foto en multipart
      capturas++;
      if (capturas === 1) {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        return res.end('<CaptureFaceData><captureProgress>0</captureProgress></CaptureFaceData>');
      }
      const b = 'MIMEboundary';
      const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(800, 9), Buffer.from([0xff, 0xd9])]);
      res.writeHead(200, { 'Content-Type': `multipart/form-data; boundary=${b}` });
      return res.end(
        Buffer.concat([
          Buffer.from(`--${b}\r\nContent-Type: application/xml\r\n\r\n<CaptureFaceData><captureProgress>100</captureProgress></CaptureFaceData>\r\n--${b}\r\nContent-Disposition: form-data; name="FaceImage"\r\nContent-Type: image/jpeg\r\n\r\n`),
          jpg,
          Buffer.from(`\r\n--${b}--\r\n`),
        ]),
      );
    }
    if (url.startsWith('/ISAPI/AccessControl/remoteCheck')) {
      const rc = JSON.parse(body).RemoteCheck;
      remotos.push(rc);
      return json(ok);
    }
    if (url.startsWith('/ISAPI/AccessControl/AcsCfg')) {
      acsCfg = JSON.parse(body).AcsCfg;
      return json(ok);
    }
    if (url.startsWith('/ISAPI/Event/notification/httpHosts')) {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end('<ResponseStatus><statusCode>1</statusCode><subStatusCode>ok</subStatusCode></ResponseStatus>');
    }
    json({ statusCode: 4, subStatusCode: 'notSupport' }, 400);
  });
});

let pass = 0;
let fail = 0;
const check = (c: boolean, m: string) => {
  if (c) pass++;
  else fail++;
  console.log(`  ${c ? '✓' : '✗'} ${m}`);
};

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const make = (password = PASS, timeoutMs = 1500) =>
  new IsapiAccessControlService({
    host: `http://127.0.0.1:${port}`,
    username: USER,
    password,
    doorNo: 1,
    fdid: '1',
    timeoutMs,
    faceTimeoutMs: timeoutMs,
    retries: 1,
    breakerThreshold: 2,
    breakerCooldownMs: 800,
  });

const svc = make();
const st = await svc.getStatus();
check(st.online && st.device?.model === 'DS-K1T344MBFWX-E1', 'Digest MD5 + deviceInfo');

const user = { employeeNo: '1001', name: 'Carlos Pérez', validity: { beginTime: '2026-11-18T00:00:00', endTime: '2026-12-17T23:59:59' }, doorNo: 1 };
await svc.upsertUser(user);
await svc.upsertUser({ ...user, validity: { ...user.validity, endTime: '2027-01-16T23:59:59' } });
const stored = users.get('1001') as { Valid: { enable: boolean; endTime: string } };
check(stored.Valid.enable === true && stored.Valid.endTime === '2027-01-16T23:59:59', 'alta + edición idempotente (Record → Modify) con Valid.enable=true');

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(500), Buffer.from([0xff, 0xd9])]).toString('base64');
await svc.upsertFace({ employeeNo: '1001', imageBase64: jpeg });
await svc.upsertFace({ employeeNo: '1001', imageBase64: jpeg });
check(faces.has('1001'), 'rostro multipart (FaceDataRecord → FDSetUp si ya existe)');

try {
  await svc.upsertFace({ employeeNo: '1001', imageBase64: Buffer.from('no-es-jpeg'.repeat(20)).toString('base64') });
  check(false, 'rechaza imagen que no es JPEG');
} catch (e) {
  check(e instanceof AccessControlError && e.code === 'INVALID_INPUT' && !e.retryable, 'rechaza imagen que no es JPEG (no reintentable)');
}

await svc.configureEventListener('http://192.168.1.10:5050/api/biometric/events/abc');
check(true, 'configura Listening Host (XML)');

const foto = await svc.captureFace();
check(foto.startsWith('data:image/jpeg;base64,') && capturas === 2, 'captura de rostro con el lector (espera progreso y extrae el JPEG del multipart)');

await svc.respondRemoteCheck(4242, true, 'Bienvenido Carlos');
await svc.respondRemoteCheck(4243, false, 'Plan vencido');
check(remotos[0]?.checkResult === 'success' && remotos[1]?.checkResult === 'failed' && remotos[0]?.serialNo === 4242, 'responde la verificación remota (abrir / no abrir)');

await svc.configureRemoteVerification(true);
check(acsCfg.remoteCheckDoorEnabled === true, 'activa la verificación remota en el lector (AcsCfg)');

await svc.deleteUser('1001');
check(!users.has('1001'), 'baja de usuario');

const malo = make('incorrecta');
try {
  await malo.upsertUser(user);
  check(false, 'credenciales erróneas');
} catch (e) {
  check(e instanceof AccessControlError && e.code === 'AUTH' && !e.retryable, 'credenciales erróneas → AUTH, sin reintentos');
}
check(malo.getCachedStatus().breaker === 'open', 'tras AUTH el circuito se abre (evita bloqueo de la cuenta del lector)');

colgado = true;
const lento = make(PASS, 400);
const t0 = Date.now();
try {
  await lento.upsertUser(user);
} catch (e) {
  check(e instanceof AccessControlError && e.code === 'TIMEOUT' && e.retryable, `timeout estricto (${Date.now() - t0} ms con 1 reintento)`);
}
try {
  await lento.upsertUser(user);
} catch {
  /* segundo fallo → abre */
}
const t1 = Date.now();
try {
  await lento.upsertUser(user);
} catch (e) {
  check(e instanceof AccessControlError && e.code === 'CIRCUIT_OPEN' && Date.now() - t1 < 50, 'circuito abierto: falla al instante sin esperar timeout');
}
colgado = false;
await new Promise((r) => setTimeout(r, 900));
await lento.upsertUser(user);
check(lento.getCachedStatus().breaker === 'closed' && lento.getCachedStatus().online, 'half-open → el lector volvió y el circuito se cierra');

console.log(`\n${pass} OK, ${fail} fallos`);
server.closeAllConnections();
server.close();
process.exit(fail ? 1 : 0);
