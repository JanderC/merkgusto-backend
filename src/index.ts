import { exec } from 'node:child_process';
import { env, isProd } from './config/env.js';
import { createApp } from './app.js';
import { checkDatabase, db } from './db/index.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { iniciarTareas } from './jobs/scheduler.js';
import { prepararAlmacenamiento } from './modules/archivos/archivos.service.js';
import { accessControl } from './modules/biometric/biometric.factory.js';
import { iniciarBot } from './modules/whatsapp/bot.service.js';
import { iniciarAvisos } from './modules/whatsapp/reportes.service.js';
import { whatsapp } from './modules/whatsapp/whatsapp.service.js';

async function main() {
  try {
    await migrate();
    await seed();
  } catch (err) {
    console.error('❌ No se pudo preparar la base de datos:', (err as Error).message);
    console.error('   Revisa que PostgreSQL esté encendido y los datos DB_* del archivo .env');
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.PORT, async () => {
    const url = `http://localhost:${env.PORT}`;
    console.log('══════════════════════════════════════════════════════');
    console.log(`   ${env.GYM_NOMBRE} · Sistema de gestión`);
    console.log('══════════════════════════════════════════════════════');
    console.log(`   ✓ API             ${url}/api`);
    console.log(`   ✓ Zona horaria    ${env.TZ} (${new Date().toLocaleString('es-VE')})`);
    console.log(`   ✓ Biométrico      ${env.BIOMETRIC_MODE.toUpperCase()}${env.BIOMETRIC_MODE === 'isapi' ? ` → ${env.HIKVISION_HOST}` : ''} · decide: ${env.BIOMETRIC_DECISION}`);
    console.log(`   ✓ Moneda base     ${env.MONEDA_REFERENCIA} (reportes y finanzas)`);
    console.log(`   ✓ Webhook lector  POST /api/biometric/events/<token>`);
    console.log(`   ✓ WhatsApp        ${env.WHATSAPP_ENABLED ? (env.GROQ_API_KEY ? 'activo con IA (Groq)' : 'activo (respuestas sin IA)') : 'deshabilitado'}`);
    console.log('══════════════════════════════════════════════════════');

    console.log(`   ✓ Archivos        en el servidor: ${prepararAlmacenamiento()}`);
    await iniciarTareas();
    iniciarBot();
    iniciarAvisos();
    // Solo se conecta solo si ya hay sesión guardada; si no, el dueño escanea el QR desde el panel
    if (env.WHATSAPP_ENABLED && whatsapp.tieneSesion()) void whatsapp.iniciar();
    void accessControl.getStatus();

    if (isProd && env.ABRIR_NAVEGADOR) {
      exec(process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`, () => undefined);
    }
  });

  setInterval(async () => {
    if (!(await checkDatabase())) console.warn('⚠ Sin conexión a PostgreSQL, reintentando…');
  }, 60_000).unref();

  const shutdown = async () => {
    console.log('\nCerrando servidor…');
    server.close();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
