# merkgusto-backend

API de **MERKGUSTO GYM**: caja ciega, membresías, clases, entrenadores, WhatsApp (Baileys) y control de acceso facial Hikvision.
Node 20+ · TypeScript · Express · Kysely · PostgreSQL. La web está en el repo `merkgustogym`.

## Desarrollo

```bash
cp .env.example .env     # completa JWT_SECRET y BIOMETRIC_WEBHOOK_TOKEN
npm install
npm run dev              # http://localhost:5050 — crea la base y aplica /database al arrancar
```

Pruebas e2e (sobre una base aparte, nunca la real):

```bash
PORT=5051 DB_NAME=merkgusto_test NODE_ENV=test WHATSAPP_ENABLED=false npx tsx src/index.ts
npm run test:e2e
```

## Despliegue en Railway

1. **New Project → Deploy from GitHub** con este repo (`railway.json` ya define build, start y healthcheck `/api/health`).
2. Agrega un servicio **PostgreSQL** y en el backend pon la variable `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
3. Agrega un **Volume** montado en `/data` (fotos, comprobantes y sesión de WhatsApp sobreviven a cada despliegue).
4. Variables:

| Variable | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `STORAGE_DIR` | `/data` |
| `CORS_ORIGIN` | URL de Vercel, ej. `https://merkgustogym.vercel.app` (acepta comodín `https://*.vercel.app`) |
| `DUENO_PASSWORD` | clave inicial del dueño (cámbiala luego) |
| `BIOMETRIC_MODE` | `mock` mientras el lector no esté conectado |
| `TZ` | `America/Caracas` |

`JWT_SECRET` y `BIOMETRIC_WEBHOOK_TOKEN` son opcionales: si faltan se generan una vez y quedan en `STORAGE_DIR/secretos.json` (por eso el volumen). Railway define `PORT` solo. Las migraciones de `/database` se aplican en cada arranque.

> **Lector Hikvision en la nube:** el lector está en la red del gimnasio. Railway no puede entrar a él (ISAPI); para el acceso facial real se usa la instalación local en el gimnasio.

## Archivos

Todo se guarda en el disco del servidor (`STORAGE_DIR`, por defecto `backend/storage`), sin servicios externos. Respalda esa carpeta junto con la base de datos.
