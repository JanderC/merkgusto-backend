/**
 * Punto único de creación del servicio de control de acceso.
 * BIOMETRIC_MODE = mock | isapi | disabled
 */
import path from 'node:path';
import { env, STORAGE_DIR } from '../../config/env.js';
import type { IAccessControlService } from './contracts/IAccessControlService.js';
import { AccessControlError } from './contracts/errors.js';
import type { DeviceStatusDTO } from './dto/access-control.dto.js';
import { IsapiAccessControlService } from './adapters/isapi/IsapiAccessControlService.js';
import { MockAccessControlService } from './adapters/mock/MockAccessControlService.js';

class DisabledAccessControlService implements IAccessControlService {
  readonly mode = 'disabled' as const;
  private readonly status: DeviceStatusDTO = {
    mode: 'disabled',
    online: false,
    checkedAt: new Date().toISOString(),
    lastOkAt: null,
    lastError: 'Control de acceso desactivado (BIOMETRIC_MODE=disabled)',
    breaker: 'closed',
    latencyMs: null,
    device: null,
  };
  getCachedStatus = () => this.status;
  getStatus = async () => this.status;
  private off = async (): Promise<never> => {
    throw new AccessControlError('DISABLED', 'Control de acceso desactivado');
  };
  upsertUser = this.off;
  deleteUser = this.off;
  upsertFace = this.off;
  deleteFace = this.off;
  configureEventListener = this.off;
  respondRemoteCheck = this.off;
  configureRemoteVerification = this.off;
  captureFace = this.off;
}

function create(): IAccessControlService {
  switch (env.BIOMETRIC_MODE) {
    case 'isapi':
      return new IsapiAccessControlService({
        host: env.HIKVISION_HOST,
        username: env.HIKVISION_USER,
        password: env.HIKVISION_PASSWORD,
        doorNo: env.HIKVISION_DOOR_NO,
        fdid: env.HIKVISION_FDID,
        timeoutMs: env.HIKVISION_TIMEOUT_MS,
        faceTimeoutMs: env.HIKVISION_FACE_TIMEOUT_MS,
        retries: env.HIKVISION_RETRIES,
        breakerThreshold: env.HIKVISION_BREAKER_THRESHOLD,
        breakerCooldownMs: env.HIKVISION_BREAKER_COOLDOWN_MS,
      });
    case 'mock': {
      const mock = new MockAccessControlService({
        latencyMs: env.BIOMETRIC_MOCK_LATENCY_MS,
        failureRate: env.BIOMETRIC_MOCK_FAILURE_RATE,
        breakerThreshold: env.HIKVISION_BREAKER_THRESHOLD,
        breakerCooldownMs: Math.min(env.HIKVISION_BREAKER_COOLDOWN_MS, 15_000),
        storageFile: env.NODE_ENV === 'test' ? undefined : path.join(STORAGE_DIR, 'mock-lector.json'),
        remota: env.BIOMETRIC_DECISION === 'servidor',
      });
      return mock;
    }
    default:
      return new DisabledAccessControlService();
  }
}

export const accessControl: IAccessControlService = create();

export const mockDevice = (): MockAccessControlService | null =>
  accessControl instanceof MockAccessControlService ? accessControl : null;
