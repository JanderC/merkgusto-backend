# Módulo biométrico · Hikvision DS-K1T321MFWX (MinMoe)

> Instalación y pruebas con el equipo: [`backend/lector/GUIA.md`](../../../lector/GUIA.md).
>
> - `BIOMETRIC_MODE=puente`: backend en la nube; una PC del gimnasio corre `lector/puente.mjs`. Decide el lector.
> - `BIOMETRIC_MODE=isapi`: backend en la misma red del lector.
> - El reloj del lector puede volver a 2015 al perder la luz (visto en otro DS-K1T321MFWX, firmware V4.61): se vigila y corrige.
> - Capacidad: 500 rostros.
> - Prueba sin hardware: `node scripts/e2e-lector.mjs`. Falta validar con el equipo real: verificación remota,
>   captura de rostro y códigos de evento exactos del firmware V3.9.2.

## Capas

```
                    ┌──────────── Dominio (caja, socios, membresías) ────────────┐
                    │  encolarSocio(id)  ← venta de plan, anulación, foto, baja  │
                    └───────────────────────────┬────────────────────────────────┘
                                                ▼
                     biometric-sync.service.ts  (outbox `bio_cola` + backoff)
                                                │  usa SOLO el contrato
                                                ▼
                         contracts/IAccessControlService.ts
                    ┌───────────────┬───────────────────────┬───────────────┐
                    ▼               ▼                       ▼
     IsapiAccessControlService  MockAccessControlService  Disabled
     (Digest + timeout +        (memoria + JSON en disco,
      reintentos + breaker)      fallos/caídas simuladas)
                    │
                    ▼  ISAPI
              DS-K1T344  ──── POST multipart (Listening Host) ────►  webhook/
                                                                    ├ webhook.security.ts  (token, IP/CIDR, MAC, rate-limit)
                                                                    ├ webhook.parser.ts    (Zod → AccessEventDTO)
                                                                    └ asistencia.service   (log idempotente + reconciliación)
```

`biometric.factory.ts` elige la implementación con `BIOMETRIC_MODE=mock|isapi|disabled`. El resto del sistema no sabe cuál está activa.

## Archivos

| Archivo | Responsabilidad |
|---|---|
| `contracts/IAccessControlService.ts` | Contrato: `getStatus`, `upsertUser`, `deleteUser`, `upsertFace`, `deleteFace`, `configureEventListener` |
| `contracts/errors.ts` | `AccessControlError` con `code` y `retryable` (TIMEOUT, UNREACHABLE, AUTH, DEVICE_REJECTED, CIRCUIT_OPEN, INVALID_INPUT…) |
| `dto/access-control.dto.ts` | DTOs validados con Zod: `AccessUserDTO`, `FaceSyncDTO`, `AccessEventDTO`, `DeviceStatusDTO` |
| `adapters/isapi/digest-auth.ts` | HTTP Digest (RFC 7616): MD5 / MD5-sess / SHA-256, `qop=auth`, reutiliza nonce, maneja `stale=true` |
| `adapters/isapi/isapi-http.client.ts` | `fetch` con `AbortSignal.timeout`, reintentos con backoff+jitter solo en errores transitorios, interpreta `ResponseStatus` JSON/XML, multipart reutilizable |
| `adapters/isapi/circuit-breaker.ts` | closed → open → half_open; enfriamiento exponencial hasta 10 min |
| `adapters/isapi/isapi.mappers.ts` | DTO ↔ JSON/XML de ISAPI y tabla de sub-eventos (único lugar a ajustar con el equipo real) |
| `adapters/mock/MockAccessControlService.ts` | Lector simulado; `simulateScan()` genera el payload real `AccessControllerEvent` |
| `biometric-sync.service.ts` | Cola persistente, fusión de duplicados, backoff 15 s → 30 min, máx. 12 intentos, job nocturno |
| `webhook/*` | Seguridad y parseo del evento entrante |
| `biometric.routes.ts` | Webhook público + administración (estado, cola, reintentos, sync total, Listening Host, simulador) |

## Endpoints ISAPI usados

| Operación | Endpoint |
|---|---|
| Salud / identidad | `GET /ISAPI/System/deviceInfo` |
| Alta de ficha | `POST /ISAPI/AccessControl/UserInfo/Record?format=json` |
| Edición (si ya existe) | `PUT /ISAPI/AccessControl/UserInfo/Modify?format=json` |
| Baja | `PUT /ISAPI/AccessControl/UserInfo/Delete?format=json` |
| Alta de rostro (multipart `FaceDataRecord` + `img`) | `POST /ISAPI/Intelligent/FDLib/FaceDataRecord?format=json` |
| Reemplazo de rostro | `PUT /ISAPI/Intelligent/FDLib/FDSetUp?format=json` |
| Baja de rostro | `PUT /ISAPI/Intelligent/FDLib/FDSearch/Delete?format=json&FDID=1&faceLibType=blackFD` |
| Webhook | `PUT /ISAPI/Event/notification/httpHosts` (XML) |

`employeeNo` = `socios.codigo` (numérico desde 1001). El rostro se vincula con `FPID = employeeNo`.

## Consistencia de vigencias

- La ficha lleva `Valid.beginTime / endTime` = bloque continuo de días pagados (`YYYY-MM-DDT00:00:00` → `T23:59:59`, `timeType: local`). **El propio lector rechaza al socio vencido**, aunque el servidor esté caído.
- ⚠ **`Valid.enable` siempre `true`**: en Hikvision `false` significa *sin límite de vigencia* (acceso permanente). Un socio sin plan recibe una ventana ya vencida.
- Renovar, anular una venta, regalar días, desactivar o cambiar la foto encola la actualización al instante. A las 00:05 se re-sincroniza a quien venció ayer.
- Al recibir un evento se contrasta con la base de datos:
  - Lector **permitió** pero la membresía está vencida → se registra la entrada con **alerta** y se reenvía la vigencia.
  - Lector **rechazó** a alguien al día (sub-evento de vigencia) → rechazo con alerta y reenvío.
  - Lector rechazó a un vencido → **rechazo limpio** con motivo exacto: *"Membresía vencida el 12/11/2026"*.

## Resiliencia

- Timeouts estrictos (`HIKVISION_TIMEOUT_MS=5000`, rostro `15000`). Reintentos solo en TIMEOUT / red / 5xx.
- Credenciales incorrectas (`AUTH`) **no se reintentan** y abren el circuito 10 min: los Hikvision bloquean la cuenta tras varios intentos fallidos.
- Con el circuito abierto las llamadas fallan al instante (sin esperar timeouts) y la cola espera. Cada minuto se hace un ping; al volver el lector se procesa todo lo pendiente.
- Las operaciones que quedaron "procesando" por un reinicio vuelven a la cola al arrancar.

## Seguridad del webhook

`POST /api/biometric/events/<BIOMETRIC_WEBHOOK_TOKEN>`

1. **Token** de 48 hex en la ruta (el lector no puede firmar ni agregar cabeceras), comparado con `timingSafeEqual`.
2. **IP de origen** (socket, nunca `X-Forwarded-For`) dentro de `BIOMETRIC_ALLOWED_IPS` (por defecto localhost + redes privadas).
3. **Identidad del equipo**: `macAddress` / `ipAddress` del payload contra `BIOMETRIC_DEVICE_MACS` / `BIOMETRIC_DEVICE_IPS`.
4. Límite de 120 peticiones/min por IP, cuerpo ≤ 1 MB, validación Zod del evento.
5. **Idempotencia**: índice único `(dispositivo, evento_serial)`; si el lector reenvía, no se duplica. Si la BD falla se responde 503 para que el lector lo reintente.

## Validar con el equipo real

`isapi.mappers.ts → SUB_EVENTS` contiene los sub-eventos del SDK (0x4b rostro OK, 0x4c rostro no reconocido, 0x07 fuera de vigencia, …). Con el equipo instalado, revisar en Panel → *Asistencia* que cada caso quede bien clasificado y ajustar allí si el firmware usa otros códigos.

`npm run test:isapi` prueba el adaptador real contra un lector falso que exige Digest (MD5, qop=auth): alta/edición idempotente, rostro multipart, credenciales erróneas, timeout y circuit breaker.
