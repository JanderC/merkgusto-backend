/**
 * Circuit breaker para el lector.
 *
 * Si el lector pierde conectividad (Wi-Fi del gimnasio, corte de luz…), no
 * tiene sentido que cada venta espere 5 s de timeout. Tras N fallos de red
 * seguidos el circuito se ABRE: las llamadas fallan al instante con
 * CIRCUIT_OPEN y la cola de sincronización las reintenta luego.
 * Pasado el enfriamiento pasa a HALF_OPEN: una sola llamada de prueba decide.
 */
import { AccessControlError } from '../../contracts/errors.js';
import type { BreakerState } from '../../dto/access-control.dto.js';

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private cooldown: number;
  private probing = false;

  constructor(
    private readonly threshold: number,
    private readonly baseCooldownMs: number,
  ) {
    this.cooldown = baseCooldownMs;
  }

  get current(): BreakerState {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.cooldown) return 'half_open';
    return this.state;
  }

  async exec<T>(fn: () => Promise<T>, countsAsFailure: (e: unknown) => boolean): Promise<T> {
    const st = this.current;
    if (st === 'open') {
      const secs = Math.ceil((this.cooldown - (Date.now() - this.openedAt)) / 1000);
      throw new AccessControlError('CIRCUIT_OPEN', `Lector sin conexión; se reintentará en ${secs}s`);
    }
    if (st === 'half_open') {
      if (this.probing) throw new AccessControlError('CIRCUIT_OPEN', 'Comprobando conexión con el lector…');
      this.probing = true;
    }
    try {
      const out = await fn();
      this.onSuccess();
      return out;
    } catch (e) {
      if (countsAsFailure(e)) this.onFailure();
      else if (st === 'half_open') this.onSuccess(); // respondió (aunque rechazara): hay red
      throw e;
    } finally {
      if (st === 'half_open') this.probing = false;
    }
  }

  /** Fuerza la apertura (p. ej. credenciales inválidas: evita bloquear la cuenta del lector). */
  trip(cooldownMs: number) {
    this.state = 'open';
    this.openedAt = Date.now();
    this.cooldown = cooldownMs;
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'closed';
    this.cooldown = this.baseCooldownMs;
  }

  private onFailure() {
    this.failures += 1;
    if (this.state !== 'closed' || this.failures >= this.threshold) {
      // Enfriamiento exponencial hasta 10 min
      if (this.state !== 'closed') this.cooldown = Math.min(this.cooldown * 2, 10 * 60_000);
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }
}
