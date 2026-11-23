/**
 * Contrato del control de acceso.
 *
 * El dominio (socios, membresías, caja) solo conoce esta interfaz. Hoy hay
 * dos implementaciones:
 *   • IsapiAccessControlService → Hikvision DS-K1T344 (MinMoe) vía ISAPI + Digest
 *   • MockAccessControlService  → lector simulado en memoria (BIOMETRIC_MODE=mock)
 *
 * Mañana se puede agregar otra marca sin tocar el resto del sistema.
 *
 * Reglas del contrato:
 *   1. Toda operación es idempotente (upsert / delete tolerante a "no existe").
 *   2. Los errores se lanzan SIEMPRE como AccessControlError con `retryable`
 *      para que la cola decida si reintentar o descartar.
 *   3. Ninguna llamada puede bloquear más que su timeout configurado.
 */
import type { AccessUserDTO, BiometricMode, DeviceStatusDTO, FaceSyncDTO } from '../dto/access-control.dto.js';

export interface IAccessControlService {
  readonly mode: BiometricMode;

  /** Consulta el estado (ping a /ISAPI/System/deviceInfo). Nunca lanza. */
  getStatus(): Promise<DeviceStatusDTO>;

  /** Último estado conocido sin tocar la red. */
  getCachedStatus(): DeviceStatusDTO;

  /** Crea o actualiza la ficha del socio con su ventana de vigencia. */
  upsertUser(user: AccessUserDTO): Promise<void>;

  /** Elimina la ficha (y su rostro). No falla si no existe. */
  deleteUser(employeeNo: string): Promise<void>;

  /** Crea o reemplaza el rostro del socio. Requiere que la ficha exista. */
  upsertFace(face: FaceSyncDTO): Promise<void>;

  /** Elimina el rostro. No falla si no existe. */
  deleteFace(employeeNo: string): Promise<void>;

  /**
   * Configura el Listening Host del lector para que envíe los eventos
   * a nuestro webhook (POST /api/biometric/events/<token>).
   */
  configureEventListener(callbackUrl: string): Promise<void>;

  /**
   * Verificación remota: el lector reconoció un rostro y pregunta si abre.
   * El sistema responde con la decisión (tiempo máximo ~2 s, sin reintentos).
   */
  respondRemoteCheck(serialNo: number, allowed: boolean, info: string): Promise<void>;

  /** Activa/desactiva en el lector el modo "preguntar al servidor antes de abrir". */
  configureRemoteVerification(enabled: boolean): Promise<void>;

  /**
   * Toma la foto del rostro CON EL LECTOR (en recepción no hay cámara):
   * el equipo muestra "mire a la cámara", captura y devuelve el JPEG.
   * Devuelve un data URL (data:image/jpeg;base64,...).
   */
  captureFace(): Promise<string>;

  /** Abre la puerta una vez. Nunca se reintenta. */
  openDoor(): Promise<void>;
}
