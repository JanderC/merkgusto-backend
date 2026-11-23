// Mantiene vivo el puente: si se cierra por cualquier motivo, lo vuelve a abrir.
// Lo arranca la tarea de Windows (INSTALAR-PUENTE.bat); no hace falta abrirlo a mano.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(DIR, 'puente.log');
const nota = (t) => {
  try {
    fs.appendFileSync(LOG, `[${new Date().toLocaleString('es-VE')}] vigilante: ${t}\r\n`);
  } catch {
    /* sin disco igual sigue */
  }
};

let rapidas = 0;
function abrir() {
  const inicio = Date.now();
  const p = spawn(process.execPath, [path.join(DIR, 'puente.mjs')], { cwd: DIR, stdio: 'ignore', windowsHide: true });
  p.on('exit', (codigo) => {
    // Si se cae en menos de 1 minuto varias veces seguidas, se espera más para no saturar
    rapidas = Date.now() - inicio < 60_000 ? rapidas + 1 : 0;
    const espera = codigo === 2 ? 30_000 : Math.min(5_000 * 2 ** Math.min(rapidas, 4), 60_000);
    nota(`el puente se cerró (código ${codigo}); se vuelve a abrir en ${espera / 1000} s`);
    setTimeout(abrir, espera);
  });
}
nota('iniciado');
abrir();
