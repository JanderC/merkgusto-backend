/**
 * Convierte lo que envía el lector en un AccessEventDTO validado.
 *
 * El DS-K1T344 envía los eventos del Listening Host como multipart/form-data:
 *   • una parte de texto (normalmente "event_log" o "AccessControllerEvent")
 *     con el JSON del evento
 *   • opcionalmente una parte "Picture" con la foto capturada (se descarta)
 * Algunos firmwares envían el JSON directo (application/json). Se aceptan ambos.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import type { AccessEventDTO } from '../dto/access-control.dto.js';
import { classifyAccessEvent } from '../adapters/isapi/isapi.mappers.js';

const accessControllerEventSchema = z
  .object({
    majorEventType: z.coerce.number().int(),
    subEventType: z.coerce.number().int(),
    employeeNoString: z.string().optional(),
    employeeNo: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    serialNo: z.coerce.number().int().optional(),
    currentVerifyMode: z.string().optional(),
    remoteCheck: z.union([z.boolean(), z.string()]).optional(),
    deviceName: z.string().optional(),
  })
  .passthrough();

export const hikEventEnvelopeSchema = z
  .object({
    ipAddress: z.string().max(64).optional(),
    macAddress: z.string().max(32).optional(),
    dateTime: z.string().min(10).max(40),
    eventType: z.string().max(60),
    AccessControllerEvent: accessControllerEventSchema.optional(),
  })
  .passthrough();
export type HikEventEnvelope = z.infer<typeof hikEventEnvelopeSchema>;

/** Busca el JSON del evento en cualquier campo del multipart o en el body JSON. */
export function extractEnvelope(body: unknown): unknown {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.eventType === 'string') return obj;
  const preferidos = ['event_log', 'AccessControllerEvent', 'eventLog', 'EventNotificationAlert'];
  const candidatos = [...preferidos.map((k) => obj[k]), ...Object.values(obj)];
  for (const c of candidatos) {
    if (typeof c === 'string' && c.trim().startsWith('{')) {
      try {
        const j = JSON.parse(c);
        if (j && typeof j === 'object' && 'eventType' in j) return j;
      } catch {
        /* siguiente */
      }
    } else if (c && typeof c === 'object' && 'eventType' in (c as object)) {
      return c;
    }
  }
  return null;
}

export type ParseResult =
  | { kind: 'event'; envelope: HikEventEnvelope; event: AccessEventDTO }
  | { kind: 'ignored'; reason: string }
  | { kind: 'invalid'; reason: string };

export function parseHikEvent(body: unknown, opts: { simulated?: boolean } = {}): ParseResult {
  const raw = extractEnvelope(body);
  if (!raw) return { kind: 'invalid', reason: 'No se encontró el JSON del evento' };
  const parsed = hikEventEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'invalid', reason: parsed.error.issues[0]?.message ?? 'Evento inválido' };
  const env = parsed.data;

  if (env.eventType !== 'AccessControllerEvent' || !env.AccessControllerEvent) {
    return { kind: 'ignored', reason: `eventType ${env.eventType}` }; // heartBeat, videoloss, etc.
  }
  const ace = env.AccessControllerEvent;
  const remoteCheck = ace.remoteCheck === true || ace.remoteCheck === 'true';
  const clasif = classifyAccessEvent(ace.majorEventType, ace.subEventType);
  // En verificación remota el veredicto lo damos nosotros, aunque el sub-evento sea desconocido
  const verdict = remoteCheck ? 'granted' : clasif.verdict;
  const label = remoteCheck ? 'Consulta de acceso del lector' : clasif.label;
  if (verdict === 'other') return { kind: 'ignored', reason: label };

  const occurredAt = new Date(env.dateTime);
  if (Number.isNaN(occurredAt.getTime())) return { kind: 'invalid', reason: 'dateTime inválido' };

  const employeeNoRaw = ace.employeeNoString ?? (ace.employeeNo !== undefined ? String(ace.employeeNo) : '');
  const employeeNo = /^[A-Za-z0-9]{1,32}$/.test(employeeNoRaw) ? employeeNoRaw : null;
  const deviceId = (env.macAddress || env.ipAddress || 'desconocido').toLowerCase();
  // serialNo es único por equipo; si faltara se deriva un hash estable del evento
  const eventSerial =
    ace.serialNo !== undefined
      ? String(ace.serialNo)
      : crypto.createHash('sha1').update(`${env.dateTime}|${employeeNo}|${ace.subEventType}`).digest('hex').slice(0, 24);

  return {
    kind: 'event',
    envelope: env,
    event: {
      deviceId,
      deviceIp: env.ipAddress ?? null,
      eventSerial,
      employeeNo,
      personName: ace.name ?? null,
      occurredAt,
      verdict,
      majorEventType: ace.majorEventType,
      subEventType: ace.subEventType,
      description: label,
      verifyMode: ace.currentVerifyMode ?? null,
      remoteCheck,
      serialNo: ace.serialNo ?? null,
      simulated: Boolean(opts.simulated),
      raw: env,
    },
  };
}
