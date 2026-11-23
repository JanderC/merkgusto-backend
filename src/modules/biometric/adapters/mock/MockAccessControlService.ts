/**
 * Adaptador SIMULADO (BIOMETRIC_MODE=mock).
 *
 * Se comporta como el lector real para poder probar flujos completos sin hardware:
 *   • Guarda fichas y rostros en memoria con las mismas validaciones del DTO
 *   • Latencia configurable (BIOMETRIC_MOCK_LATENCY_MS)
 *   • Fallos aleatorios (BIOMETRIC_MOCK_FAILURE_RATE) y modo "desconectado"
 *     para probar la cola de reintentos y el circuit breaker
 *   • `simulateScan()` genera el MISMO JSON que envía un DS-K1T344 al webhook,
 *     decidiendo permitir/denegar con la vigencia almacenada, igual que el equipo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IAccessControlService } from '../../contracts/IAccessControlService.js';
import { AccessControlError } from '../../contracts/errors.js';
import {
  accessUserSchema,
  decodeFaceImage,
  employeeNoSchema,
  faceSyncSchema,
  type AccessUserDTO,
  type DeviceStatusDTO,
  type FaceSyncDTO,
} from '../../dto/access-control.dto.js';
import { CircuitBreaker } from '../isapi/circuit-breaker.js';
import { MAJOR_EVENT_ACCESS } from '../isapi/isapi.mappers.js';
import { StatusTracker } from '../status-tracker.js';

interface MockUser extends AccessUserDTO {
  hasFace: boolean;
  faceBytes: number;
  updatedAt: string;
}

export interface MockOptions {
  latencyMs: number;
  failureRate: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  /** Archivo JSON donde el lector simulado guarda sus fichas (opcional). */
  storageFile?: string;
  /** Verificación remota activa (el servidor decide) */
  remota?: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
const localNow = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export class MockAccessControlService implements IAccessControlService {
  readonly mode = 'mock' as const;
  readonly deviceMac = '00:4d:45:52:4b:47'; // "MERKG"
  readonly deviceIp = '127.0.0.1';
  private readonly users = new Map<string, MockUser>();
  private readonly tracker = new StatusTracker('mock');
  private readonly breaker: CircuitBreaker;
  private serial = Math.floor(Date.now() / 1000) % 100000;
  private offline = false;
  private remota: boolean;
  /** Decisiones recibidas del servidor (verificación remota) por serial */
  readonly decisiones = new Map<number, { allowed: boolean; info: string; at: string }>();

  constructor(private readonly opts: MockOptions) {
    this.breaker = new CircuitBreaker(opts.breakerThreshold, opts.breakerCooldownMs);
    this.remota = opts.remota ?? true;
    // Como un lector real, las fichas sobreviven a reinicios del servidor
    if (opts.storageFile) {
      try {
        const saved = JSON.parse(fs.readFileSync(opts.storageFile, 'utf8')) as MockUser[];
        for (const u of saved) this.users.set(u.employeeNo, u);
      } catch {
        /* primer arranque */
      }
    }
    this.tracker.ok(0, {
      model: 'DS-K1T344MBFWX-E1 (simulado)',
      serialNumber: 'MOCK-MERKGUSTO-0001',
      firmware: 'V3.x simulado',
      macAddress: this.deviceMac,
      deviceName: 'Lector Entrada (simulado)',
    });
  }

  // ── Controles exclusivos del simulador ──
  setOffline(offline: boolean) {
    this.offline = offline;
    if (offline) this.tracker.fail('Lector simulado desconectado');
  }
  get isOffline() {
    return this.offline;
  }
  listUsers() {
    return [...this.users.values()].sort((a, b) => a.employeeNo.localeCompare(b.employeeNo));
  }

  getCachedStatus(): DeviceStatusDTO {
    return this.tracker.snapshot(this.breaker.current);
  }

  async getStatus(): Promise<DeviceStatusDTO> {
    try {
      await this.call(async () => undefined);
    } catch {
      /* el estado ya quedó registrado */
    }
    return this.getCachedStatus();
  }

  async upsertUser(input: AccessUserDTO): Promise<void> {
    const user = this.validate(() => accessUserSchema.parse(input));
    await this.call(async () => {
      const prev = this.users.get(user.employeeNo);
      this.users.set(user.employeeNo, {
        ...user,
        hasFace: prev?.hasFace ?? false,
        faceBytes: prev?.faceBytes ?? 0,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async deleteUser(employeeNo: string): Promise<void> {
    const id = this.validate(() => employeeNoSchema.parse(employeeNo));
    await this.call(async () => {
      this.users.delete(id);
    });
  }

  async upsertFace(input: FaceSyncDTO): Promise<void> {
    const face = this.validate(() => faceSyncSchema.parse(input));
    const jpeg = this.validate(() => decodeFaceImage(face.imageBase64));
    await this.call(async () => {
      const user = this.users.get(face.employeeNo);
      // Igual que el equipo real: el rostro necesita una ficha previa
      if (!user) throw new AccessControlError('DEVICE_REJECTED', 'El lector rechazó "registrar rostro": employeeNoNotExist');
      user.hasFace = true;
      user.faceBytes = jpeg.length;
      user.updatedAt = new Date().toISOString();
    });
  }

  async deleteFace(employeeNo: string): Promise<void> {
    const id = this.validate(() => employeeNoSchema.parse(employeeNo));
    await this.call(async () => {
      const u = this.users.get(id);
      if (u) u.hasFace = false;
    });
  }

  async respondRemoteCheck(serialNo: number, allowed: boolean, info: string): Promise<void> {
    await this.call(async () => {
      this.decisiones.set(serialNo, { allowed, info, at: new Date().toISOString() });
      if (this.decisiones.size > 200) this.decisiones.delete(this.decisiones.keys().next().value!);
    });
  }

  async configureRemoteVerification(enabled: boolean): Promise<void> {
    await this.call(async () => {
      this.remota = enabled;
    });
  }

  /** Simula la captura: el lector tarda ~1,5 s mientras la persona mira a la cámara. */
  async captureFace(): Promise<string> {
    return this.call(async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const archivo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../assets/rostro-simulado.jpg');
      return `data:image/jpeg;base64,${fs.readFileSync(archivo).toString('base64')}`;
    });
  }

  get verificacionRemota() {
    return this.remota;
  }

  async openDoor(): Promise<void> {
    await this.call(async () => {
      console.log('🧪 [Biométrico simulado] Puerta abierta');
    });
  }

  async configureEventListener(callbackUrl: string): Promise<void> {
    await this.call(async () => {
      console.log(`🧪 [Biométrico simulado] Listening Host configurado → ${callbackUrl}`);
    });
  }

  /**
   * Simula que una persona se para frente al lector.
   * Devuelve el payload con el formato real de Hikvision (AccessControllerEvent).
   */
  simulateScan(employeeNo: string | null): Record<string, unknown> {
    if (this.offline) throw new AccessControlError('UNREACHABLE', 'El lector simulado está desconectado');
    const user = employeeNo ? this.users.get(employeeNo) : undefined;
    const now = localNow();
    let subEventType = 0x4b; // rostro verificado
    if (!user || !user.hasFace) subEventType = 0x4c; // rostro desconocido
    else if (!this.remota && (now < user.validity.beginTime || now > user.validity.endTime)) subEventType = 0x07; // fuera de vigencia
    // Con verificación remota, si reconoce el rostro le pregunta al servidor
    const remoteCheck = this.remota && subEventType === 0x4b;

    this.serial += 1;
    const offset = -new Date().getTimezoneOffset();
    const tz = `${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
    return {
      ipAddress: this.deviceIp,
      portNo: 80,
      protocol: 'HTTP',
      macAddress: this.deviceMac,
      channelID: 1,
      dateTime: `${now}${tz}`,
      activePostCount: 1,
      eventType: 'AccessControllerEvent',
      eventState: 'active',
      eventDescription: 'Access Controller Event',
      AccessControllerEvent: {
        deviceName: 'Lector Entrada (simulado)',
        majorEventType: MAJOR_EVENT_ACCESS,
        subEventType,
        // El lector solo informa employeeNo cuando reconoce el rostro
        ...(user && user.hasFace ? { employeeNoString: user.employeeNo, name: user.name } : {}),
        cardReaderNo: 1,
        doorNo: 1,
        serialNo: this.serial,
        userType: 'normal',
        currentVerifyMode: 'cardOrFace',
        ...(remoteCheck ? { remoteCheck: true } : {}),
        mask: 'no',
        picturesNumber: 0,
      },
    };
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    return this.breaker.exec(
      async () => {
        if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs * (0.6 + Math.random() * 0.8)));
        if (this.offline) {
          this.tracker.fail('Lector simulado desconectado');
          throw new AccessControlError('TIMEOUT', 'El lector simulado no respondió (modo desconectado)');
        }
        if (Math.random() < this.opts.failureRate) {
          this.tracker.fail('Fallo de red simulado');
          throw new AccessControlError('UNREACHABLE', 'Fallo de red simulado (BIOMETRIC_MOCK_FAILURE_RATE)');
        }
        const t0 = Date.now();
        const out = await fn();
        this.persist();
        this.tracker.ok(Date.now() - t0 + this.opts.latencyMs);
        return out;
      },
      (e) => e instanceof AccessControlError && ['TIMEOUT', 'UNREACHABLE'].includes(e.code),
    );
  }

  private persist() {
    if (!this.opts.storageFile) return;
    try {
      fs.mkdirSync(path.dirname(this.opts.storageFile), { recursive: true });
      fs.writeFileSync(this.opts.storageFile, JSON.stringify([...this.users.values()]));
    } catch (e) {
      console.warn('⚠ [Biométrico simulado] No se pudo guardar el estado:', (e as Error).message);
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
