/**
 * DTOs y contratos de datos del control de acceso.
 *
 * Todo lo que entra o sale del lector pasa por aquí y se valida con Zod.
 * El resto del sistema NUNCA trabaja con el formato ISAPI crudo: lo hacen
 * los adaptadores (isapi.mappers.ts) y el parser del webhook.
 */
import { z } from 'zod';

/** Fecha-hora local sin zona: el formato que exige ISAPI con timeType "local". */
export const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, 'Formato YYYY-MM-DDTHH:mm:ss');

/** employeeNo: identificador del socio en el lector (usamos socios.codigo). */
export const employeeNoSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{1,32}$/, 'employeeNo: solo letras/números, máximo 32');

// ── Ficha de usuario ─────────────────────────────────────────────────
export const accessUserSchema = z
  .object({
    employeeNo: employeeNoSchema,
    /** El lector admite nombres cortos; se recorta a 32 caracteres. */
    name: z
      .string()
      .trim()
      .min(1)
      .transform((s) => s.slice(0, 32)),
    /**
     * Vigencia de la membresía. ⚠ En Hikvision `Valid.enable=false` significa
     * "sin límite de vigencia" (acceso permanente). Por eso SIEMPRE se envía
     * enable=true y, para un socio sin membresía, una ventana ya vencida.
     */
    validity: z.object({
      beginTime: localDateTime,
      endTime: localDateTime,
    }),
    doorNo: z.number().int().positive().default(1),
  })
  .refine((u) => u.validity.endTime >= u.validity.beginTime, {
    message: 'endTime debe ser posterior a beginTime',
    path: ['validity', 'endTime'],
  });
export type AccessUserDTO = z.infer<typeof accessUserSchema>;

// ── Rostro ───────────────────────────────────────────────────────────
/** Los terminales MinMoe aceptan JPEG de hasta ~200 KB. */
export const FACE_MAX_BYTES = 200 * 1024;

export const faceSyncSchema = z.object({
  employeeNo: employeeNoSchema,
  /** JPEG en base64, con o sin prefijo data:image/jpeg;base64, */
  imageBase64: z.string().min(100, 'Imagen vacía'),
});
export type FaceSyncDTO = z.infer<typeof faceSyncSchema>;

/** Decodifica y valida que sea un JPEG dentro del límite del lector. */
export function decodeFaceImage(imageBase64: string): Buffer {
  const raw = imageBase64.replace(/^data:image\/[a-z]+;base64,/i, '');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new Error('La foto del rostro debe ser JPEG');
  }
  if (buf.length > FACE_MAX_BYTES) {
    throw new Error(`La foto pesa ${Math.round(buf.length / 1024)} KB; el lector admite máximo ${FACE_MAX_BYTES / 1024} KB`);
  }
  return buf;
}

// ── Evento de acceso normalizado ─────────────────────────────────────
export type AccessVerdict = 'granted' | 'denied' | 'other';

export interface AccessEventDTO {
  /** MAC (preferida) o IP del lector: identifica el dispositivo. */
  deviceId: string;
  deviceIp: string | null;
  /** Clave de idempotencia por dispositivo (serialNo del lector). */
  eventSerial: string;
  employeeNo: string | null;
  personName: string | null;
  occurredAt: Date;
  verdict: AccessVerdict;
  majorEventType: number;
  subEventType: number;
  description: string;
  verifyMode: string | null;
  /** El lector espera nuestra decisión (verificación remota) */
  remoteCheck: boolean;
  serialNo: number | null;
  simulated: boolean;
  raw: unknown;
}

// ── Estado del dispositivo ───────────────────────────────────────────
export type BiometricMode = 'isapi' | 'mock' | 'disabled';
export type BreakerState = 'closed' | 'open' | 'half_open';

export interface DeviceInfoDTO {
  model: string | null;
  serialNumber: string | null;
  firmware: string | null;
  macAddress: string | null;
  deviceName: string | null;
}

export interface DeviceStatusDTO {
  mode: BiometricMode;
  online: boolean;
  checkedAt: string;
  lastOkAt: string | null;
  lastError: string | null;
  breaker: BreakerState;
  latencyMs: number | null;
  device: DeviceInfoDTO | null;
}
