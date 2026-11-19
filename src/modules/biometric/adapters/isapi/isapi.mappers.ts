/**
 * Traducción DTO ↔ formato ISAPI (Hikvision Access Control, serie MinMoe).
 *
 * Referencias ISAPI usadas (firmware V3.x de DS-K1T341/342/343/344):
 *   POST /ISAPI/AccessControl/UserInfo/Record?format=json       alta de ficha
 *   PUT  /ISAPI/AccessControl/UserInfo/Modify?format=json       edición de ficha
 *   PUT  /ISAPI/AccessControl/UserInfo/Delete?format=json       baja de ficha
 *   POST /ISAPI/Intelligent/FDLib/FaceDataRecord?format=json    alta de rostro (multipart)
 *   PUT  /ISAPI/Intelligent/FDLib/FDSetUp?format=json           alta/reemplazo de rostro (multipart)
 *   PUT  /ISAPI/Intelligent/FDLib/FDSearch/Delete?format=json…  baja de rostro
 *   GET  /ISAPI/System/deviceInfo                               salud / identidad
 *   PUT  /ISAPI/Event/notification/httpHosts                    Listening Host (webhook)
 *
 * ⚠ Validar los códigos de evento con el equipo real al instalarlo: algunos
 *   firmwares agregan sub-eventos nuevos. Todo está centralizado aquí.
 */
import type { AccessUserDTO, AccessVerdict, DeviceInfoDTO } from '../../dto/access-control.dto.js';

export function toIsapiUserInfo(u: AccessUserDTO) {
  return {
    UserInfo: {
      employeeNo: u.employeeNo,
      name: u.name,
      userType: 'normal',
      Valid: {
        // ⚠ enable SIEMPRE true: con false el lector ignora la vigencia (acceso permanente)
        enable: true,
        beginTime: u.validity.beginTime,
        endTime: u.validity.endTime,
        timeType: 'local',
      },
      doorRight: String(u.doorNo),
      RightPlan: [{ doorNo: u.doorNo, planTemplateNo: '1' }], // plantilla 1 = todo el día
    },
  };
}

export const toIsapiUserDelete = (employeeNo: string) => ({
  UserInfoDelCond: { EmployeeNoList: [{ employeeNo }] },
});

export const toIsapiFaceRecord = (employeeNo: string, fdid: string) => ({
  faceLibType: 'blackFD', // en Hikvision "blackFD" es la biblioteca normal de rostros
  FDID: fdid,
  FPID: employeeNo, // el rostro se vincula a la ficha por employeeNo
});

export const toIsapiFaceDelete = (employeeNo: string) => ({
  FPID: [{ value: employeeNo }],
});

/** Respuesta a la verificación remota (PUT /ISAPI/AccessControl/remoteCheck?format=json). */
export const toIsapiRemoteCheck = (serialNo: number, allowed: boolean, info: string) => ({
  RemoteCheck: { serialNo, checkResult: allowed ? 'success' : 'failed', info: info.slice(0, 32) },
});

/** Activa la verificación remota por el canal de escucha HTTP (PUT /ISAPI/AccessControl/AcsCfg?format=json). */
export const toIsapiAcsCfgRemote = (enabled: boolean) => ({
  AcsCfg: { remoteCheckDoorEnabled: enabled, checkChannelType: 'ISAPIListen' },
});

export function toIsapiHttpHostXml(url: URL, id = 1): string {
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `<?xml version="1.0" encoding="UTF-8"?>
<HttpHostNotificationList version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
  <HttpHostNotification>
    <id>${id}</id>
    <url>${escapeXml(url.pathname + url.search)}</url>
    <protocolType>${url.protocol === 'https:' ? 'HTTPS' : 'HTTP'}</protocolType>
    <parameterFormatType>JSON</parameterFormatType>
    <addressingFormatType>ipaddress</addressingFormatType>
    <ipAddress>${escapeXml(url.hostname)}</ipAddress>
    <portNo>${port}</portNo>
    <httpAuthenticationMethod>none</httpAuthenticationMethod>
  </HttpHostNotification>
</HttpHostNotificationList>`;
}

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

export function parseDeviceInfoXml(xml: string): DeviceInfoDTO {
  const tag = (t: string) => xml.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1] ?? null;
  return {
    model: tag('model'),
    serialNumber: tag('serialNumber'),
    firmware: [tag('firmwareVersion'), tag('firmwareReleasedDate')].filter(Boolean).join(' ') || null,
    macAddress: tag('macAddress'),
    deviceName: tag('deviceName'),
  };
}

// ── Eventos de acceso (majorEventType 5 = "Event") ───────────────────
export const MAJOR_EVENT_ACCESS = 5;

/** subEventType → (veredicto, descripción). Constantes MINOR_* del SDK de Hikvision. */
export const SUB_EVENTS: Record<number, { verdict: AccessVerdict; label: string }> = {
  0x01: { verdict: 'granted', label: 'Tarjeta válida' },
  0x06: { verdict: 'denied', label: 'Sin permiso de acceso' },
  0x07: { verdict: 'denied', label: 'Fuera del periodo de vigencia' },
  0x08: { verdict: 'denied', label: 'Credencial vencida' },
  0x09: { verdict: 'denied', label: 'Usuario no registrado' },
  0x26: { verdict: 'granted', label: 'Huella verificada' },
  0x27: { verdict: 'denied', label: 'Huella no coincide' },
  0x4b: { verdict: 'granted', label: 'Rostro verificado' },
  0x4c: { verdict: 'denied', label: 'Rostro no reconocido' },
  0x69: { verdict: 'granted', label: 'Código + rostro verificado' },
  0x6a: { verdict: 'denied', label: 'Código + rostro no coincide' },
};

export function classifyAccessEvent(major: number, sub: number): { verdict: AccessVerdict; label: string } {
  if (major !== MAJOR_EVENT_ACCESS) return { verdict: 'other', label: `Evento ${major}/${sub}` };
  return SUB_EVENTS[sub] ?? { verdict: 'other', label: `Evento de acceso ${sub}` };
}
