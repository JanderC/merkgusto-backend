import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// La zona horaria se fija antes de crear cualquier Date
process.env.TZ = process.env.TZ || 'America/Caracas';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  // ── Servidor ──
  PORT: z.coerce.number().default(5050),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  TZ: z.string().default('America/Caracas'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  ABRIR_NAVEGADOR: bool(false),

  // ── Base de datos ──
  DATABASE_URL: z.string().optional(),
  DB_SSL: bool(false),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(5432),
  DB_NAME: z.string().default('merkgusto_gym'),
  DB_USER: z.string().default('postgres'),
  DB_PASSWORD: z.string().default(''),

  // ── Seguridad ──
  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  DUENO_NOMBRE: z.string().default('Dueño Merkgusto'),
  DUENO_USUARIO: z.string().default('dueno'),
  DUENO_PASSWORD: z.string().default('Merkgusto2026*'),

  // ── Negocio ──
  GYM_NOMBRE: z.string().default('MERKGUSTO GYM'),

  // ── Multimoneda ──
  /** Moneda en que se suman reportes y finanzas. Fíjala antes de empezar a vender. */
  MONEDA_REFERENCIA: z.enum(['USD', 'VES', 'COP']).default('COP'),
  DOLARAPI_VE_URL: z.string().default('https://ve.dolarapi.com'),
  DOLARAPI_CO_URL: z.string().default('https://co.dolarapi.com'),

  // ── Archivos (fotos de marcaciones, soportes, comprobantes) ──
  // Carpeta de datos del servidor (archivos, sesión de WhatsApp). Vacío = backend/storage
  // En Railway apúntala a un volumen (ej. /data) para que no se borre al redesplegar.
  STORAGE_DIR: z.string().default(''),
  // Se guardan en el disco del servidor. Vacío = STORAGE_DIR/archivos
  ARCHIVOS_DIR: z.string().default(''),

  // ── WhatsApp ──
  WHATSAPP_ENABLED: bool(true),
  WHATSAPP_CODIGO_PAIS: z.string().default('58'),
  GROQ_API_KEY: z.string().default(''),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),

  // ── Control de acceso biométrico (Hikvision DS-K1T344 · MinMoe) ──
  BIOMETRIC_MODE: z.enum(['mock', 'isapi', 'disabled']).default('mock'),
  /**
   * servidor → verificación remota: el lector consulta al sistema y el sistema decide si abre (recomendado)
   * lector   → el lector decide con la vigencia que se le sincroniza y solo informa el evento
   */
  BIOMETRIC_DECISION: z.enum(['servidor', 'lector']).default('servidor'),
  HIKVISION_HOST: z.string().default('http://192.168.1.64'),
  HIKVISION_USER: z.string().default('admin'),
  HIKVISION_PASSWORD: z.string().default(''),
  HIKVISION_DOOR_NO: z.coerce.number().int().positive().default(1),
  HIKVISION_FDID: z.string().default('1'),
  HIKVISION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  HIKVISION_FACE_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  HIKVISION_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  HIKVISION_BREAKER_THRESHOLD: z.coerce.number().int().positive().default(4),
  HIKVISION_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(30000),
  // Webhook (Listening Host) — el lector hace POST a /api/biometric/events/<token>
  BIOMETRIC_WEBHOOK_TOKEN: z.string().min(24, 'BIOMETRIC_WEBHOOK_TOKEN debe tener al menos 24 caracteres'),
  BIOMETRIC_ALLOWED_IPS: csv,
  BIOMETRIC_DEVICE_MACS: csv,
  BIOMETRIC_DEVICE_IPS: csv,
  BIOMETRIC_PUBLIC_URL: z.string().default(''),
  BIOMETRIC_MOCK_LATENCY_MS: z.coerce.number().int().min(0).default(250),
  BIOMETRIC_MOCK_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Configuración inválida en .env:');
  for (const issue of parsed.error.issues) console.error(`   • ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';

/** Carpeta raíz de datos del servidor (backend/storage por defecto). */
export const STORAGE_DIR = path.resolve(env.STORAGE_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../storage'));
