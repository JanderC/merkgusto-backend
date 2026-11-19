export type AccessControlErrorCode =
  | 'TIMEOUT' // el lector no respondió a tiempo
  | 'UNREACHABLE' // red caída, IP incorrecta, lector apagado
  | 'AUTH' // credenciales Digest rechazadas (¡no reintentar: el lector bloquea la cuenta!)
  | 'DEVICE_REJECTED' // el lector respondió con statusCode != 1
  | 'DEVICE_ERROR' // HTTP 5xx del lector
  | 'CIRCUIT_OPEN' // demasiados fallos seguidos, se espera antes de volver a intentar
  | 'INVALID_INPUT' // datos que nunca serán aceptados (foto no JPEG, etc.)
  | 'DISABLED'; // BIOMETRIC_MODE=disabled

const RETRYABLE: Record<AccessControlErrorCode, boolean> = {
  TIMEOUT: true,
  UNREACHABLE: true,
  DEVICE_ERROR: true,
  CIRCUIT_OPEN: true,
  AUTH: false,
  DEVICE_REJECTED: false,
  INVALID_INPUT: false,
  DISABLED: false,
};

export class AccessControlError extends Error {
  readonly retryable: boolean;
  constructor(
    public readonly code: AccessControlErrorCode,
    message: string,
    public readonly details?: { httpStatus?: number; subStatusCode?: string; statusString?: string },
  ) {
    super(message);
    this.name = 'AccessControlError';
    this.retryable = RETRYABLE[code];
  }
}

export const isAccessControlError = (e: unknown): e is AccessControlError => e instanceof AccessControlError;
