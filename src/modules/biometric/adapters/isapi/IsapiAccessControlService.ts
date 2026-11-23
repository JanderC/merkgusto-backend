/**
 * Adaptador REAL: Hikvision DS-K1T321MFWX (MinMoe) vía ISAPI, directo o por el puente.
 */
import type { IAccessControlService } from '../../contracts/IAccessControlService.js';
import { AccessControlError } from '../../contracts/errors.js';
import {
  accessUserSchema,
  decodeFaceImage,
  employeeNoSchema,
  FACE_MAX_BYTES,
  faceSyncSchema,
  type AccessUserDTO,
  type DeviceStatusDTO,
  type FaceSyncDTO,
} from '../../dto/access-control.dto.js';
import { StatusTracker } from '../status-tracker.js';
import { buildMultipart, extraerJpeg, IsapiHttpClient, type IsapiResponse, type Transporte } from './isapi-http.client.js';
import {
  parseDeviceInfoXml,
  relojMal,
  toIsapiTimeXml,
  toIsapiAcsCfgRemote,
  toIsapiRemoteCheck,
  toIsapiFaceDelete,
  toIsapiFaceRecord,
  toIsapiHttpHostXml,
  toIsapiUserDelete,
  toIsapiUserInfo,
} from './isapi.mappers.js';

export interface IsapiServiceConfig {
  host: string;
  username: string;
  password: string;
  doorNo: number;
  fdid: string;
  timeoutMs: number;
  faceTimeoutMs: number;
  retries: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  transporte?: Transporte;
}

const sub = (res: IsapiResponse) => (IsapiHttpClient.status(res).subStatusCode ?? '').toLowerCase();

export class IsapiAccessControlService implements IAccessControlService {
  readonly mode = 'isapi' as const;
  private readonly http: IsapiHttpClient;
  private readonly tracker = new StatusTracker('isapi');

  constructor(private readonly cfg: IsapiServiceConfig) {
    if (!cfg.password && !cfg.transporte) {
      console.warn('⚠ [Biométrico] HIKVISION_PASSWORD vacío: el lector rechazará todas las llamadas');
    }
    this.http = new IsapiHttpClient({
      baseUrl: cfg.host,
      username: cfg.username,
      password: cfg.password,
      timeoutMs: cfg.timeoutMs,
      retries: cfg.retries,
      breakerThreshold: cfg.breakerThreshold,
      breakerCooldownMs: cfg.breakerCooldownMs,
      transporte: cfg.transporte,
    });
  }

  getCachedStatus(): DeviceStatusDTO {
    return this.tracker.snapshot(this.http.breaker.current);
  }

  async getStatus(): Promise<DeviceStatusDTO> {
    const t0 = Date.now();
    try {
      const res = await this.http.request({ method: 'GET', path: '/ISAPI/System/deviceInfo', retry: false });
      IsapiHttpClient.assertOk(res, 'deviceInfo');
      this.tracker.ok(Date.now() - t0, parseDeviceInfoXml(res.text));
      // Con puente, el reloj lo cuida el puente (funciona aunque no haya internet)
      if (!this.cfg.transporte) await this.cuidarReloj().catch((e) => console.warn('⚠ [Lector] No se pudo revisar su reloj:', (e as Error).message));
    } catch (e) {
      this.tracker.fail((e as Error).message);
    }
    return this.getCachedStatus();
  }

  async upsertUser(input: AccessUserDTO): Promise<void> {
    const user = this.validate(() => accessUserSchema.parse({ ...input, doorNo: input.doorNo ?? this.cfg.doorNo }));
    const payload = toIsapiUserInfo(user);
    await this.track(async () => {
      // 1) Intentar alta; 2) si ya existe, modificar. Idempotente.
      const rec = await this.http.request({ method: 'POST', path: '/ISAPI/AccessControl/UserInfo/Record?format=json', json: payload });
      if (rec.status < 300 && IsapiHttpClient.status(rec).statusCode === 1) return;
      if (sub(rec).includes('exist')) {
        const mod = await this.http.request({ method: 'PUT', path: '/ISAPI/AccessControl/UserInfo/Modify?format=json', json: payload });
        IsapiHttpClient.assertOk(mod, 'modificar cliente');
        return;
      }
      IsapiHttpClient.assertOk(rec, 'registrar cliente');
    });
  }

  async deleteUser(employeeNo: string): Promise<void> {
    const id = this.validate(() => employeeNoSchema.parse(employeeNo));
    await this.track(async () => {
      const res = await this.http.request({
        method: 'PUT',
        path: '/ISAPI/AccessControl/UserInfo/Delete?format=json',
        json: toIsapiUserDelete(id),
      });
      if (sub(res).includes('notexist')) return; // ya no estaba: OK
      IsapiHttpClient.assertOk(res, 'eliminar cliente');
    });
  }

  async upsertFace(input: FaceSyncDTO): Promise<void> {
    const face = this.validate(() => faceSyncSchema.parse(input));
    const jpeg = this.validate(() => decodeFaceImage(face.imageBase64));
    const record = JSON.stringify(toIsapiFaceRecord(face.employeeNo, this.cfg.fdid));
    let campo = 'img';
    const mp = () =>
      buildMultipart([
        { name: 'FaceDataRecord', contentType: 'application/json', data: record },
        { name: campo, contentType: 'image/jpeg', data: jpeg, filename: `${face.employeeNo}.jpg` },
      ]);

    await this.track(async () => {
      const alta = () => {
        const a = mp();
        return this.http.request({
          method: 'POST',
          path: '/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json',
          body: a.body,
          contentType: a.contentType,
          timeoutMs: this.cfg.faceTimeoutMs, // el lector modela el rostro: tarda más
        });
      };
      let res = await alta();
      // Según el firmware la foto se llama "img" o "FaceImage"
      if (/badparameters|badjsoncontent|parameterslack/.test(sub(res))) {
        campo = 'FaceImage';
        res = await alta();
      }
      if (res.status < 300 && IsapiHttpClient.status(res).statusCode === 1) return;
      // Ya tenía rostro → reemplazar con FDSetUp
      if (sub(res).includes('exist')) {
        const b = mp();
        const up = await this.http.request({
          method: 'PUT',
          path: '/ISAPI/Intelligent/FDLib/FDSetUp?format=json',
          body: b.body,
          contentType: b.contentType,
          timeoutMs: this.cfg.faceTimeoutMs,
        });
        IsapiHttpClient.assertOk(up, 'reemplazar rostro');
        return;
      }
      IsapiHttpClient.assertOk(res, 'registrar rostro');
    });
  }

  async deleteFace(employeeNo: string): Promise<void> {
    const id = this.validate(() => employeeNoSchema.parse(employeeNo));
    await this.track(async () => {
      const res = await this.http.request({
        method: 'PUT',
        path: `/ISAPI/Intelligent/FDLib/FDSearch/Delete?format=json&FDID=${encodeURIComponent(this.cfg.fdid)}&faceLibType=blackFD`,
        json: toIsapiFaceDelete(id),
      });
      if (sub(res).includes('notexist')) return;
      IsapiHttpClient.assertOk(res, 'eliminar rostro');
    });
  }

  async openDoor(): Promise<void> {
    await this.track(async () => {
      const res = await this.http.request({
        method: 'PUT',
        path: `/ISAPI/AccessControl/RemoteControl/door/${this.cfg.doorNo}`,
        body: '<RemoteControlDoor><cmd>open</cmd></RemoteControlDoor>',
        contentType: 'application/xml',
        retry: false,
      });
      IsapiHttpClient.assertOk(res, 'abrir puerta');
    });
  }

  private async cuidarReloj(): Promise<void> {
    const res = await this.http.request({ method: 'GET', path: '/ISAPI/System/time', retry: false });
    IsapiHttpClient.assertOk(res, 'leer reloj');
    if (!relojMal(res.text, new Date())) return;
    const put = await this.http.request({ method: 'PUT', path: '/ISAPI/System/time', body: toIsapiTimeXml(new Date()), contentType: 'application/xml', retry: false });
    IsapiHttpClient.assertOk(put, 'poner en hora');
    console.log('🕒 [Lector] Reloj corregido');
  }

  async configureEventListener(callbackUrl: string): Promise<void> {
    if (this.cfg.transporte) throw new AccessControlError('INVALID_INPUT', 'Con el puente no hace falta: él mismo configura el aviso de eventos del lector');
    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      throw new AccessControlError('INVALID_INPUT', `URL de webhook inválida: ${callbackUrl}`);
    }
    await this.track(async () => {
      const res = await this.http.request({
        method: 'PUT',
        path: '/ISAPI/Event/notification/httpHosts',
        body: toIsapiHttpHostXml(url),
        contentType: 'application/xml',
      });
      IsapiHttpClient.assertOk(res, 'configurar Listening Host');
    });
  }

  async respondRemoteCheck(serialNo: number, allowed: boolean, info: string): Promise<void> {
    // Sin reintentos y con timeout corto: la persona está frente a la puerta
    const res = await this.http.request({
      method: 'PUT',
      path: '/ISAPI/AccessControl/remoteCheck?format=json',
      json: toIsapiRemoteCheck(serialNo, allowed, info),
      timeoutMs: 2500,
      retry: false,
    });
    IsapiHttpClient.assertOk(res, 'responder verificación remota');
  }

  /**
   * Captura de rostro con el lector:
   *   POST /ISAPI/AccessControl/CaptureFaceData (XML) → el equipo pide mirar a la cámara.
   *   Según el firmware responde la imagen en multipart (dataType=binary), una URL
   *   (faceDataUrl) que se descarga con Digest, o captureProgress < 100 (se reintenta).
   */
  async captureFace(): Promise<string> {
    const cuerpo = `<?xml version="1.0" encoding="UTF-8"?><CaptureFaceDataCond version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><captureInfrared>false</captureInfrared><dataType>binary</dataType></CaptureFaceDataCond>`;
    const limite = Date.now() + 30_000;
    let jpeg: Buffer | null = null;
    await this.track(async () => {
      while (Date.now() < limite) {
        const res = await this.http.request({
          method: 'POST',
          path: '/ISAPI/AccessControl/CaptureFaceData',
          body: cuerpo,
          contentType: 'application/xml',
          timeoutMs: 25_000,
          retry: false,
        });
        if (res.status >= 400) IsapiHttpClient.assertOk(res, 'capturar rostro');
        jpeg = extraerJpeg(res);
        if (jpeg) return;
        const url = res.text.match(/<faceDataUrl>([^<]+)<\/faceDataUrl>/)?.[1];
        if (url) {
          const u = new URL(url, this.cfg.host);
          const img = await this.http.request({ method: 'GET', path: u.pathname + u.search, timeoutMs: 10_000, retry: false });
          jpeg = extraerJpeg(img);
          if (jpeg) return;
        }
        const progreso = Number(res.text.match(/<captureProgress>(\d+)<\/captureProgress>/)?.[1] ?? 100);
        if (progreso >= 100) break;
        await new Promise((r) => setTimeout(r, 800));
      }
    });
    if (!jpeg) throw new AccessControlError('DEVICE_REJECTED', 'El lector no devolvió la foto: que la persona mire a la cámara e intenta de nuevo');
    const buf = jpeg as Buffer;
    if (buf.length > FACE_MAX_BYTES) throw new AccessControlError('INVALID_INPUT', `La foto del lector pesa ${Math.round(buf.length / 1024)} KB (máx. ${FACE_MAX_BYTES / 1024} KB)`);
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  }

  async configureRemoteVerification(enabled: boolean): Promise<void> {
    if (enabled && this.cfg.transporte) throw new AccessControlError('INVALID_INPUT', 'Con el puente decide el lector, para que abra aunque no haya internet');
    await this.track(async () => {
      const res = await this.http.request({ method: 'PUT', path: '/ISAPI/AccessControl/AcsCfg?format=json', json: toIsapiAcsCfgRemote(enabled) });
      IsapiHttpClient.assertOk(res, 'configurar verificación remota');
    });
  }

  /** Actualiza el estado online/offline según el resultado de cada operación. */
  private async track(fn: () => Promise<void>) {
    const t0 = Date.now();
    try {
      await fn();
      this.tracker.ok(Date.now() - t0);
    } catch (e) {
      // Un rechazo del lector significa que SÍ hay conexión
      if (e instanceof AccessControlError && e.code === 'DEVICE_REJECTED') this.tracker.ok(Date.now() - t0);
      else this.tracker.fail((e as Error).message);
      throw e;
    }
  }

  private validate<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      const msg = (e as { issues?: Array<{ message: string }> }).issues?.[0]?.message ?? (e as Error).message;
      throw new AccessControlError('INVALID_INPUT', msg);
    }
  }
}
