import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type TimestampNull = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json = ColumnType<unknown, string | undefined, string>;
type JsonNull = ColumnType<unknown, string | null | undefined, string | null>;
type Num = ColumnType<number, number | string, number | string>;

export type Rol = 'dueno' | 'admin_caja' | 'cajero';
export type BioEstado = 'sin_rostro' | 'pendiente' | 'sincronizado' | 'error';
export type Moneda = 'USD' | 'VES' | 'COP';
export type TipoDuracion = 'dias' | 'semanas' | 'meses' | 'anios';

export interface UsuariosTable {
  id: Generated<string>;
  nombre: string;
  usuario: string;
  passwordHash: string;
  rol: Rol;
  telefono: string | null;
  activo: Generated<boolean>;
  creadoEn: Generated<Date>;
  ultimoAcceso: TimestampNull;
  /** PIN de supervisor (bcrypt) para autorizar devoluciones */
  pinHash: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface SociosTable {
  id: Generated<string>;
  codigo: Generated<number>;
  cedula: string | null;
  nombre: string;
  apellido: Generated<string>;
  telefono: string | null;
  email: string | null;
  fechaNacimiento: string | null;
  genero: 'M' | 'F' | 'O' | null;
  foto: string | null;
  notas: string | null;
  activo: Generated<boolean>;
  bioEstado: Generated<BioEstado>;
  bioSincronizadoEn: TimestampNull;
  bioError: string | null;
  creadoEn: Generated<Date>;
  actualizadoEn: Generated<Date>;
  portalTokenHash: ColumnType<string | null, string | null | undefined, string | null>;
  portalCreadoEn: TimestampNull;
  /** Entrenador que lo atiende (lo ve en su app) */
  entrenadorId: ColumnType<string | null, string | null | undefined, string | null>;
  /** Clave de la app (bcrypt). Null = entra solo con su cédula */
  claveHash: ColumnType<string | null, string | null | undefined, string | null>;
  claveCreadaEn: TimestampNull;
  appUltimoAcceso: TimestampNull;
  appSesion: Generated<number>;
}

export interface PlanesTable {
  id: Generated<number>;
  nombre: string;
  descripcion: string | null;
  duracionDias: number;
  precio: Num;
  moneda: Generated<Moneda>;
  tipoDuracion: Generated<TipoDuracion>;
  cantidad: Generated<number>;
  personas: Generated<number>;
  congelable: Generated<boolean>;
  maxDiasCongelado: Generated<number>;
  /** El lector facial le abre (semanas/meses/años). Pases diarios: no, entran por recepción */
  accesoLector: Generated<boolean>;
  color: Generated<string>;
  activo: Generated<boolean>;
  orden: Generated<number>;
  creadoEn: Generated<Date>;
  /** Archivado: tenía historial de membresías y se eliminó */
  eliminadoEn: Date | null;
}

export interface ProductosTable {
  id: Generated<number>;
  nombre: string;
  categoria: Generated<string>;
  precio: Num;
  moneda: Generated<Moneda>;
  costo: ColumnType<number, number | undefined, number>;
  stock: Generated<number>;
  stockMinimo: Generated<number>;
  controlaStock: Generated<boolean>;
  activo: Generated<boolean>;
  codigoBarras: ColumnType<string | null, string | null | undefined, string | null>;
  creadoEn: Generated<Date>;
}

export interface MetodosPagoTable {
  codigo: string;
  nombre: string;
  monedas: ColumnType<Moneda[], Moneda[] | undefined, Moneda[]>;
  pideReferencia: Generated<boolean>;
  activo: Generated<boolean>;
  orden: Generated<number>;
  esSistema: Generated<boolean>;
}

export interface TasasTable {
  id: Generated<number>;
  usdVes: Num;
  usdCop: Num;
  vesCop: Num;
  fuenteUsdVes: Generated<'manual' | 'bcv' | 'paralelo'>;
  fuenteUsdCop: Generated<'manual' | 'trm'>;
  nota: string | null;
  creadoPor: string | null;
  creadoEn: Generated<Date>;
}

export interface TurnosTable {
  id: Generated<string>;
  numero: Generated<number>;
  cajeroId: string;
  abiertoEn: Generated<Date>;
  cerradoEn: TimestampNull;
  cerradoPor: string | null;
  estado: Generated<'abierto' | 'cerrado' | 'revisado'>;
  fondoInicial: ColumnType<number, number | undefined, number>;
  fondo: ColumnType<Partial<Record<Moneda, number>>, string | undefined, string>;
  tasasCierre: JsonNull;
  notaCajero: string | null;
  notaDueno: string | null;
  revisadoPor: string | null;
  revisadoEn: TimestampNull;
}

export interface TurnoDeclaracionesTable {
  turnoId: string;
  metodo: string;
  moneda: Moneda;
  monto: Num;
}

export interface VentasTable {
  id: Generated<string>;
  numero: Generated<number>;
  turnoId: string;
  cajeroId: string;
  socioId: string | null;
  /** Columna histórica (USD); los totales vigentes son total_ref y totales */
  total: ColumnType<number, number | undefined, number>;
  monedaRef: Moneda;
  totalRef: Num;
  pagadoRef: Num;
  totales: Json | null;
  tasas: JsonNull;
  estado: Generated<'pagada' | 'anulada'>;
  nota: string | null;
  creadoEn: Generated<Date>;
  anuladaPor: string | null;
  anuladaEn: TimestampNull;
  motivoAnulacion: string | null;
}

export interface VentaItemsTable {
  id: Generated<number>;
  ventaId: string;
  tipo: 'membresia' | 'producto' | 'abono';
  referenciaId: number;
  descripcion: string;
  cantidad: number;
  moneda: Moneda;
  precioUnitario: Num;
  subtotal: Num;
  subtotalRef: Num;
  datos: JsonNull;
}

export interface VentaPagosTable {
  id: Generated<number>;
  ventaId: string;
  metodo: string;
  moneda: Moneda;
  montoMoneda: Num;
  /** Parte del total que cubre este pago (1 = todo). Negativa si es vuelto. */
  fraccion: Num;
  montoRef: Num;
  /** Columna histórica (USD) */
  monto: ColumnType<number, number | undefined, number>;
  tasa: ColumnType<number, number | undefined, number>;
  esVuelto: ColumnType<boolean, boolean | undefined, boolean>;
  referencia: string | null;
}

export interface MembresiasTable {
  id: Generated<string>;
  socioId: string;
  planId: number;
  ventaId: string | null;
  fechaInicio: string;
  fechaFin: string;
  precio: Num;
  moneda: Generated<Moneda>;
  estado: Generated<'activa' | 'congelada' | 'anulada' | 'reemplazada'>;
  grupoId: string | null;
  congeladaDesde: string | null;
  diasCongelados: Generated<number>;
  notas: string | null;
  creadoEn: Generated<Date>;
}

export interface DeudasTable {
  id: Generated<number>;
  socioId: string;
  ventaId: string | null;
  concepto: string;
  moneda: Moneda;
  montoTotal: Num;
  saldo: Num;
  estado: Generated<'pendiente' | 'pagada' | 'anulada'>;
  creadoPor: string | null;
  creadoEn: Generated<Date>;
  actualizadoEn: Generated<Date>;
}

export interface CajaMovimientosTable {
  id: Generated<number>;
  turnoId: string | null;
  usuarioId: string;
  tipo: 'ingreso' | 'egreso';
  categoria: string;
  concepto: string;
  metodo: string;
  moneda: Moneda;
  monto: Num;
  montoRef: Num;
  tasas: JsonNull;
  referencia: string | null;
  comprobanteId: number | null;
  anulado: Generated<boolean>;
  anuladoPor: string | null;
  motivoAnulacion: string | null;
  creadoEn: Generated<Date>;
}

export interface ArchivosTable {
  id: Generated<number>;
  proveedor: 'local';
  bucket: string | null;
  ruta: string;
  mime: string;
  bytes: number;
  creadoPor: string | null;
  creadoEn: Generated<Date>;
}

export type Horario = Partial<Record<'1' | '2' | '3' | '4' | '5' | '6' | '7', { entrada: string; salida: string }>>;

export interface EntrenadoresTable {
  id: Generated<string>;
  codigo: Generated<number>;
  nombre: string;
  apellido: Generated<string>;
  cedula: string | null;
  telefono: string | null;
  especialidad: string | null;
  foto: string | null;
  pinHash: string;
  horario: ColumnType<Horario, string | undefined, string>;
  activo: Generated<boolean>;
  bioEstado: Generated<BioEstado>;
  bioError: string | null;
  creadoEn: Generated<Date>;
  pagoTipo: Generated<PagoTipo>;
  pagoTarifa: ColumnType<number, number | string | undefined, number | string>;
  pagoMoneda: Generated<Moneda>;
  usuario: ColumnType<string | null, string | null | undefined, string | null>;
  passwordHash: ColumnType<string | null, string | null | undefined, string | null>;
  ultimoAcceso: TimestampNull;
  sesionVersion: Generated<number>;
}

export type PagoTipo = 'ninguno' | 'fijo' | 'por_hora' | 'por_clase';

export type TipoMarcacion = 'entrada' | 'salida' | 'retiro' | 'regreso';

export interface EntrenadorMarcacionesTable {
  id: Generated<number>;
  entrenadorId: string;
  tipo: TipoMarcacion;
  fechaHora: Timestamp;
  origen: 'kiosko' | 'lector' | 'manual';
  fotoId: number | null;
  nota: string | null;
  minutosTarde: number | null;
  registradoPor: string | null;
  anulada: Generated<boolean>;
}

export interface EntrenadorPermisosTable {
  id: Generated<number>;
  entrenadorId: string;
  tipo: 'permiso' | 'vacaciones' | 'reposo' | 'diligencia' | 'otro';
  desde: Timestamp;
  hasta: Timestamp;
  motivo: string;
  soporteId: number | null;
  estado: Generated<'pendiente' | 'aprobado' | 'rechazado'>;
  resueltoPor: string | null;
  resueltoEn: TimestampNull;
  notaResolucion: string | null;
  creadoEn: Generated<Date>;
}

export type CaracteristicaClase = 'movilidad' | 'fuerza' | 'cardio' | 'resistencia' | 'potencia' | 'desplazamiento';

export interface ClasesTable {
  id: Generated<number>;
  nombre: string;
  descripcion: string | null;
  planId: number | null;
  entrenadorId: string | null;
  inicio: Date;
  duracionMin: Generated<number>;
  cupo: number | null;
  nivel: 'principiante' | 'intermedio' | 'avanzado' | 'todos' | null;
  caracteristicas: ColumnType<Partial<Record<CaracteristicaClase, number>>, string | undefined, string>;
  color: Generated<string>;
  estado: Generated<'programada' | 'cancelada'>;
  motivoCancelacion: string | null;
  serieId: string | null;
  creadoPor: string | null;
  creadoEn: Generated<Date>;
}

export interface ClaseInscritosTable {
  id: Generated<number>;
  claseId: number;
  socioId: string;
  cobertura: 'plan' | 'mensualidad' | 'pase' | 'cortesia' | null;
  asistioEn: Date | null;
  asistenciaId: number | null;
  nota: string | null;
  inscritoPor: string | null;
  pasoPor: string | null;
  creadoEn: Generated<Date>;
  inscritoPorEntrenador: ColumnType<string | null, string | null | undefined, string | null>;
  pasoPorEntrenador: ColumnType<string | null, string | null | undefined, string | null>;
  reservadoPorSocio: Generated<boolean>;
}

export interface AsistenciasTable {
  id: Generated<number>;
  socioId: string | null;
  entrenadorId: string | null;
  employeeNo: string | null;
  fechaHora: Timestamp;
  origen: 'biometrico' | 'manual' | 'simulado';
  resultado: 'permitido' | 'denegado';
  motivo: string | null;
  alerta: string | null;
  dispositivo: string | null;
  eventoSerial: string | null;
  metodoVerif: string | null;
  registradoPor: string | null;
  payload: Json | null;
  creadoEn: Generated<Date>;
}

export interface BioColaTable {
  id: Generated<number>;
  socioId: string | null;
  entrenadorId: string | null;
  operacion: 'sync_usuario' | 'sync_rostro' | 'eliminar';
  estado: Generated<'pendiente' | 'procesando' | 'ok' | 'error' | 'descartado'>;
  intentos: Generated<number>;
  proximoIntento: Timestamp;
  ultimoError: string | null;
  creadoEn: Generated<Date>;
  actualizadoEn: Timestamp;
}

export interface WaMensajesTable {
  id: Generated<number>;
  direccion: 'entrante' | 'saliente';
  jid: string;
  nombre: string | null;
  texto: string;
  tipo: Generated<'chat' | 'bot' | 'reporte' | 'aviso' | 'manual'>;
  creadoEn: Generated<Date>;
}

export interface ReportesEnviadosTable {
  id: Generated<number>;
  tipo: string;
  clave: string;
  estado: 'enviado' | 'error';
  detalle: string | null;
  creadoEn: Generated<Date>;
}

export interface ConfiguracionTable {
  clave: string;
  valor: Json;
  actualizadoEn: Timestamp;
}

export interface AuditoriaTable {
  id: Generated<number>;
  usuarioId: string | null;
  accion: string;
  detalle: Json | null;
  creadoEn: Generated<Date>;
}

export interface DevolucionesTable {
  id: Generated<number>;
  ventaId: string;
  turnoId: string;
  cajeroId: string;
  autorizadoPor: string;
  motivo: string;
  reingresaStock: Generated<boolean>;
  metodo: string;
  moneda: Moneda;
  monto: Num;
  montoRef: Num;
  movimientoId: number | null;
  creadoEn: Generated<Date>;
}

export interface DevolucionItemsTable {
  id: Generated<number>;
  devolucionId: number;
  ventaItemId: number;
  productoId: number;
  descripcion: string;
  cantidad: number;
  moneda: Moneda;
  subtotal: Num;
}

export interface ProveedoresTable {
  id: Generated<number>;
  nombre: string;
  documento: string | null;
  telefono: string | null;
  contacto: string | null;
  notas: string | null;
  activo: Generated<boolean>;
  creadoEn: Generated<Date>;
}

export type EstadoCompra = 'pagada' | 'pendiente' | 'anulada';

export interface ComprasTable {
  id: Generated<number>;
  proveedorId: number | null;
  factura: string | null;
  fecha: ColumnType<string, string | undefined, string>;
  moneda: Moneda;
  total: Num;
  totalRef: Num;
  saldo: ColumnType<number, number | string | undefined, number | string>;
  tasas: JsonNull;
  estado: Generated<EstadoCompra>;
  nota: string | null;
  soporteId: number | null;
  registradoPor: string;
  creadoEn: Generated<Date>;
  anuladaPor: string | null;
  anuladaEn: TimestampNull;
  motivoAnulacion: string | null;
}

export interface CompraItemsTable {
  id: Generated<number>;
  compraId: number;
  productoId: number;
  cantidad: number;
  costoUnitario: Num;
  subtotal: Num;
  costoConvertido: Num | null;
  monedaProducto: Moneda | null;
  precioVenta: Num | null;
  precioAnterior: Num | null;
  productoNuevo: Generated<boolean>;
}

export interface CompraPagosTable {
  id: Generated<number>;
  compraId: number;
  movimientoId: number | null;
  metodo: string;
  moneda: Moneda;
  monto: Num;
  registradoPor: string;
  creadoEn: Generated<Date>;
}

export type TipoMovInventario = 'venta' | 'anulacion' | 'devolucion' | 'compra' | 'compra_anulada' | 'ajuste' | 'conteo';

export interface InventarioMovimientosTable {
  id: Generated<number>;
  productoId: number;
  tipo: TipoMovInventario;
  cantidad: number;
  stockResultante: number | null;
  referencia: string | null;
  usuarioId: string | null;
  creadoEn: Generated<Date>;
}

export interface ConteosTable {
  id: Generated<number>;
  estado: Generated<'abierto' | 'cerrado' | 'cancelado'>;
  nota: string | null;
  creadoPor: string;
  creadoEn: Generated<Date>;
  cerradoPor: string | null;
  cerradoEn: TimestampNull;
  faltanteRef: ColumnType<number, number | string | undefined, number | string>;
  sobranteRef: ColumnType<number, number | string | undefined, number | string>;
}

export interface ConteoItemsTable {
  id: Generated<number>;
  conteoId: number;
  productoId: number;
  contado: number;
  esperado: number | null;
  diferencia: number | null;
  costo: ColumnType<number | null, number | string | null | undefined, number | string | null>;
  moneda: Moneda | null;
  contadoPor: string | null;
  actualizadoEn: Timestamp;
}

export interface EntrenadorPagosTable {
  id: Generated<number>;
  entrenadorId: string;
  desde: string;
  hasta: string;
  pagoTipo: PagoTipo;
  tarifa: Num;
  horas: Num;
  clases: number;
  montoBase: Num;
  bonos: Num;
  descuentos: Num;
  total: Num;
  moneda: Moneda;
  metodo: string;
  movimientoId: number | null;
  nota: string | null;
  registradoPor: string;
  creadoEn: Generated<Date>;
  anulado: Generated<boolean>;
}

type NumNull = ColumnType<number | null, number | string | null | undefined, number | string | null>;

export interface SocioMedicionesTable {
  id: Generated<number>;
  socioId: string;
  fecha: ColumnType<string, string | undefined, string>;
  peso: NumNull;
  grasa: NumNull;
  musculo: NumNull;
  cintura: NumNull;
  cadera: NumNull;
  pecho: NumNull;
  brazo: NumNull;
  pierna: NumNull;
  nota: string | null;
  registradoPor: string | null;
  creadoEn: Generated<Date>;
  autor: Generated<Autor>;
  entrenadorId: ColumnType<string | null, string | null | undefined, string | null>;
}

export type Autor = 'equipo' | 'entrenador' | 'cliente';

export interface DiaRutina {
  nombre: string;
  ejercicios: Array<{ nombre: string; series: string; reps: string; nota: string }>;
}

export interface SocioRutinasTable {
  id: Generated<number>;
  socioId: string;
  titulo: string;
  objetivo: string | null;
  dias: ColumnType<DiaRutina[], string | undefined, string>;
  entrenadorId: string | null;
  activa: Generated<boolean>;
  creadoPor: string | null;
  creadoEn: Generated<Date>;
  actualizadoEn: Timestamp;
  autor: Generated<Autor>;
}

export interface RutinaPlantillasTable {
  id: Generated<number>;
  entrenadorId: string;
  titulo: string;
  objetivo: string | null;
  dias: ColumnType<DiaRutina[], string | undefined, string>;
  creadoEn: Generated<Date>;
  actualizadoEn: Timestamp;
}

export interface EntrenadorNotasTable {
  id: Generated<number>;
  entrenadorId: string;
  socioId: string;
  texto: string;
  creadoEn: Generated<Date>;
}

export interface SocioEntrenosTable {
  id: Generated<number>;
  socioId: string;
  fecha: ColumnType<string, string, string>;
  rutinaId: number | null;
  dia: Generated<string>;
  nota: string | null;
  creadoEn: Generated<Date>;
}

export interface DB {
  usuarios: UsuariosTable;
  socios: SociosTable;
  planes: PlanesTable;
  productos: ProductosTable;
  metodosPago: MetodosPagoTable;
  tasas: TasasTable;
  turnos: TurnosTable;
  turnoDeclaraciones: TurnoDeclaracionesTable;
  ventas: VentasTable;
  ventaItems: VentaItemsTable;
  ventaPagos: VentaPagosTable;
  membresias: MembresiasTable;
  deudas: DeudasTable;
  cajaMovimientos: CajaMovimientosTable;
  archivos: ArchivosTable;
  entrenadores: EntrenadoresTable;
  entrenadorMarcaciones: EntrenadorMarcacionesTable;
  entrenadorPermisos: EntrenadorPermisosTable;
  asistencias: AsistenciasTable;
  clases: ClasesTable;
  claseInscritos: ClaseInscritosTable;
  bioCola: BioColaTable;
  waMensajes: WaMensajesTable;
  reportesEnviados: ReportesEnviadosTable;
  configuracion: ConfiguracionTable;
  auditoria: AuditoriaTable;
  devoluciones: DevolucionesTable;
  devolucionItems: DevolucionItemsTable;
  proveedores: ProveedoresTable;
  compras: ComprasTable;
  compraItems: CompraItemsTable;
  compraPagos: CompraPagosTable;
  inventarioMovimientos: InventarioMovimientosTable;
  conteos: ConteosTable;
  conteoItems: ConteoItemsTable;
  entrenadorPagos: EntrenadorPagosTable;
  socioMediciones: SocioMedicionesTable;
  socioRutinas: SocioRutinasTable;
  rutinaPlantillas: RutinaPlantillasTable;
  entrenadorNotas: EntrenadorNotasTable;
  socioEntrenos: SocioEntrenosTable;
}
