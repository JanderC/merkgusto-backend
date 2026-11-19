import cron from 'node-cron';
import { env } from '../config/env.js';
import { accessControl } from '../modules/biometric/biometric.factory.js';
import { encolarSocio, procesarCola, recuperarCola, resincronizarVencimientos } from '../modules/biometric/biometric-sync.service.js';
import { reanudarCongeladasVencidas } from '../modules/membresias/membresias.service.js';
import { tickTasasAutomaticas } from '../modules/tasas/tasas.service.js';
import { tickReportes } from '../modules/whatsapp/reportes.service.js';

export async function iniciarTareas() {
  const tz = { timezone: env.TZ };

  // ── Biométrico ──
  await recuperarCola();
  // Cola de sincronización: cada 10 s (sale al instante si no hay nada o el lector está caído)
  setInterval(() => void procesarCola().catch((e) => console.error('✗ Cola biométrica:', e.message)), 10_000).unref();
  // Salud del lector cada minuto (permite cerrar el circuito cuando vuelve)
  setInterval(async () => {
    const antes = accessControl.getCachedStatus().online;
    const st = await accessControl.getStatus();
    if (antes !== st.online && accessControl.mode !== 'disabled') {
      console.log(st.online ? '🟢 [Biométrico] Lector en línea' : `🔴 [Biométrico] Lector sin conexión: ${st.lastError}`);
      if (st.online) void procesarCola();
    }
  }, 60_000).unref();
  // Vigencias: 00:05 todos los días
  cron.schedule('5 0 * * *', () => void resincronizarVencimientos().then((n) => n && console.log(`↻ [Biométrico] ${n} vigencia(s) re-sincronizadas`)), tz);

  // ── Membresías congeladas que llegaron al tope de días: se reanudan solas (00:10) ──
  cron.schedule('10 0 * * *', async () => {
    const socios = await reanudarCongeladasVencidas().catch((e) => (console.error('✗ Congeladas:', e.message), []));
    for (const s of socios) await encolarSocio(s).catch(() => undefined);
    if (socios.length) console.log(`↻ [Membresías] ${socios.length} congelada(s) reanudada(s) por tope`);
  }, tz);

  // ── Tasas automáticas (BCV / paralelo / TRM) cada 30 min si están activadas ──
  setInterval(() => void tickTasasAutomaticas().catch((e) => console.error('✗ Tasas automáticas:', e.message)), 30 * 60_000).unref();
  setTimeout(() => void tickTasasAutomaticas().catch(() => undefined), 15_000).unref();

  // ── WhatsApp: avisos de cierre, reporte diario y recordatorios ──
  cron.schedule('* * * * *', () => void tickReportes().catch((e) => console.error('✗ Reportes WhatsApp:', e.message)), tz);
}
