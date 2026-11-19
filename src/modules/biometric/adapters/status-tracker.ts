import type { BiometricMode, BreakerState, DeviceInfoDTO, DeviceStatusDTO } from '../dto/access-control.dto.js';

/** Lleva el último estado conocido del lector (para el panel y para decidir reintentos). */
export class StatusTracker {
  private status: DeviceStatusDTO;

  constructor(mode: BiometricMode) {
    this.status = {
      mode,
      online: false,
      checkedAt: new Date().toISOString(),
      lastOkAt: null,
      lastError: null,
      breaker: 'closed',
      latencyMs: null,
      device: null,
    };
  }

  ok(latencyMs: number | null, device?: DeviceInfoDTO | null) {
    const now = new Date().toISOString();
    this.status = {
      ...this.status,
      online: true,
      checkedAt: now,
      lastOkAt: now,
      lastError: null,
      latencyMs,
      device: device ?? this.status.device,
    };
  }

  fail(message: string) {
    this.status = { ...this.status, online: false, checkedAt: new Date().toISOString(), lastError: message, latencyMs: null };
  }

  snapshot(breaker: BreakerState): DeviceStatusDTO {
    return { ...this.status, breaker };
  }
}
