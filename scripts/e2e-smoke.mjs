// Prueba de punta a punta de MERKGUSTO (caja ciega multimoneda, membresías mes a mes,
// deudas, egresos, roles, entrenadores, verificación remota del lector, finanzas).
// Corre contra la instancia de PRUEBAS (puerto 5051, BD merkgusto_test) → npm run test:e2e
import fs from 'node:fs';

const B = process.env.E2E_URL ?? 'http://localhost:5051/api';
const envTxt = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
const TOKEN = envTxt.match(/^BIOMETRIC_WEBHOOK_TOKEN=(.*)$/m)[1].trim();
let ok = 0;
let fail = 0;
const check = (c, m, extra) => {
  if (c) {
    ok++;
    console.log('  ✓', m);
  } else {
    fail++;
    console.log('  ✗', m, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : '');
  }
};
async function call(method, path, body, token) {
  const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try {
    j = await r.json();
  } catch {}
  return { s: r.status, j };
}
const hoyL = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sumarMeses = (f, n) => {
  const [y, m, d] = f.split('-').map(Number);
  const t = y * 12 + m - 1 + n;
  const ny = Math.floor(t / 12), nm = t % 12;
  const ult = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, ult)).padStart(2, '0')}`;
};
const sumarDias = (f, n) => {
  const [y, m, d] = f.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(B + '/health')).ok) break;
  } catch {}
  await espera(500);
}
const jpeg = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7), Buffer.from([0xff, 0xd9])]).toString('base64');
const H = hoyL();

console.log('Roles');
const D = (await call('POST', '/auth/login', { usuario: 'dueno', password: 'Merkgusto2026*' })).j.token;
const sfx = Date.now().toString().slice(-5);
await call('POST', '/usuarios', { nombre: 'Ana Cajera', usuario: `ana${sfx}`, password: '1234' }, D);
await call('POST', '/usuarios', { nombre: 'Admin Caja', usuario: `adm${sfx}`, password: '1234', rol: 'admin_caja' }, D);
const C = (await call('POST', '/auth/login', { usuario: `ana${sfx}`, password: '1234' })).j.token;
const A = (await call('POST', '/auth/login', { usuario: `adm${sfx}`, password: '1234' })).j.token;
for (const p of ['/caja/turnos', '/finanzas/dia?fecha=' + H, '/dashboard', '/usuarios', '/whatsapp/estado']) check((await call('GET', p, null, C)).s === 403, `cajera bloqueada: ${p}`);
for (const p of ['/caja/turnos', '/finanzas/dia?fecha=' + H, '/caja/movimientos']) check((await call('GET', p, null, A)).s === 200, `admin de caja ve: ${p}`);
for (const p of ['/usuarios', '/config', '/whatsapp/estado']) check((await call('GET', p, null, A)).s === 403, `admin de caja NO ve: ${p}`);

console.log('Tasas (tablero en pesos, como velozalcambio)');
const T = { dolar: 3300, bs: 3 };
T.usdCop = T.dolar;
T.usdVes = T.dolar / T.bs; // $1 = Bs 1.100, sale del peso
check((await call('POST', '/tasas', T, C)).s === 403, 'cajera no cambia tasas');
const tz = await call('POST', '/tasas', { dolar: T.dolar, bs: T.bs, fuenteBs: 'manual' }, A);
check(tz.s === 201 && tz.j.bs === 3 && tz.j.dolar === 3300 && tz.j.vesCop === 3, 'admin de caja publica tablero: Dólar 3.300 · Bs 3', tz.j);
check(Math.abs(tz.j.usdVes - 1100) < 1e-9, '$1 en Bs se deriva: 3.300 ÷ 3 = 1.100', tz.j);
const tz2 = await call('POST', '/tasas', { dolar: T.dolar, bs: T.bs }, A);
const hist = (await call('GET', '/tasas', null, A)).j;
check(tz2.s === 201 && hist.historial[0].tendencia.dolar === null && hist.historial.length >= 2, 'historial de versiones con tendencia', hist.historial[0]);
const ext = await call('GET', '/tasas/externas', null, C);
check(ext.s === 200 && 'bcv' in ext.j, 'consulta BCV/paralelo/TRM', ext.j);

console.log('Catálogo multimoneda y planes mes a mes');
const agua = (await call('POST', '/productos', { nombre: 'Agua E2E', categoria: 'Bebidas', precio: 4500, moneda: 'COP', costo: 2500, stock: 50 }, D)).j;
const mensual = (await call('POST', '/planes', { nombre: 'Mensual E2E', tipoDuracion: 'meses', cantidad: 1, precio: 25, moneda: 'USD' }, D)).j;
const duo = (await call('POST', '/planes', { nombre: 'Duo E2E', tipoDuracion: 'meses', cantidad: 1, precio: 40, moneda: 'USD', personas: 2 }, D)).j;
check(agua.moneda === 'COP' && mensual.tipoDuracion === 'meses', 'producto en COP y plan mensual en USD', [agua, mensual]);
const cat = (await call('GET', '/pos/catalogo', null, C)).j;
check(cat.tasas.vesCop === 3 && cat.planes.find((p) => p.id === mensual.id)?.duracion === '1 mes', 'catálogo con tasas y duración "1 mes"', cat.planes);

const s1 = (await call('POST', '/socios', { nombre: 'Carlos', apellido: 'Mes', telefono: '04141234567', foto: jpeg, cedula: `V${sfx}10` }, C)).j;
const s2 = (await call('POST', '/socios', { nombre: 'Luisa', apellido: 'Duo', foto: jpeg, cedula: `V${sfx}20`, telefono: '04140000002' }, C)).j;
const s3 = (await call('POST', '/socios', { nombre: 'Pedro', apellido: 'Fiado', foto: jpeg, cedula: `V${sfx}30`, telefono: '04140000003' }, C)).j;
check((await call('PUT', '/config/caja', { fondo: { USD: 0, VES: 0, COP: 50000 } }, D)).s === 200, 'dueño fija fondo de caja COP 50.000');
await call('POST', '/pos/turno/abrir', {}, C);

console.log('Cobros');
// La BD de pruebas guarda corridas anteriores del mismo día: finanzas se mide por diferencia
const fin0 = (await call('GET', `/finanzas/resumen?desde=${H}&hasta=${H}`, null, A)).j;
const cop0 = fin0.flujo.find((f) => f.moneda === 'COP') ?? { egresos: 0 };
const v1 = await call('POST', '/pos/ventas', { socioId: null, items: [{ tipo: 'producto', id: agua.id, cantidad: 1 }], pagos: [{ metodo: 'pago_movil', moneda: 'VES', monto: 1500, referencia: '1234' }] }, C);
check(v1.s === 201 && v1.j.totales.VES === 1500, 'agua COP 4.500 pagada con Bs 1.500 (÷3)', v1.j);
const v1d = await call('POST', '/pos/ventas', { socioId: null, items: [{ tipo: 'producto', id: agua.id, cantidad: 1 }], pagos: [{ metodo: 'divisas', moneda: 'USD', monto: 1.37, referencia: 'z-agua' }] }, C);
check(v1d.s === 201 && v1d.j.totales.USD === 1.37, 'agua COP 4.500 en dólares: ÷ 3.300 = $1,37', v1d.j);
const vMal = await call('POST', '/pos/ventas', { socioId: null, items: [{ tipo: 'producto', id: agua.id, cantidad: 1 }], pagos: [{ metodo: 'nequi', moneda: 'VES', monto: 1500, referencia: 'x' }] }, C);
check(vMal.s === 400, 'Nequi no recibe bolívares', vMal.j);
const v2 = await call('POST', '/pos/ventas', { socioId: s1.id, items: [{ tipo: 'membresia', id: mensual.id }], pagos: [
  { metodo: 'efectivo', moneda: 'VES', monto: 12.5 * T.usdVes },
  { metodo: 'bancolombia', moneda: 'COP', monto: 12.5 * T.usdCop, referencia: 'BC-9' },
] }, C);
check(v2.s === 201, 'plan $25: mitad en Bs y mitad por Bancolombia en COP', v2.j);
check(v2.j?.membresias?.[0]?.fechaInicio === H && v2.j?.membresias?.[0]?.fechaFin === sumarMeses(H, 1), 'mes a mes: del 23 al 23 del mes siguiente', v2.j?.membresias);
const v3 = await call('POST', '/pos/ventas', { socioId: s1.id, items: [{ tipo: 'membresia', id: mensual.id }], pagos: [{ metodo: 'efectivo', moneda: 'USD', monto: 30 }], vuelto: { metodo: 'efectivo', moneda: 'COP', monto: 5 * T.usdCop } }, C);
check(v3.s === 201 && v3.j.vuelto?.texto === 'COP 16.500', 'renovación con $30 y vuelto COP 16.500', v3.j);
check(v3.j?.membresias?.[0]?.fechaInicio === sumarDias(sumarMeses(H, 1), 1) && v3.j?.membresias?.[0]?.fechaFin === sumarMeses(H, 2), 'la renovación sigue mes a mes sin correr el día (23 → 23)', v3.j?.membresias);
const vDuo1 = await call('POST', '/pos/ventas', { socioId: s2.id, items: [{ tipo: 'membresia', id: duo.id }], pagos: [{ metodo: 'zelle', moneda: 'USD', monto: 40, referencia: 'z1' }] }, C);
check(vDuo1.s === 400, 'plan dúo exige acompañante', vDuo1.j);
const vDuo = await call('POST', '/pos/ventas', { socioId: s2.id, items: [{ tipo: 'membresia', id: duo.id, acompanantes: [s3.id] }], pagos: [{ metodo: 'efectivo', moneda: 'USD', monto: 40 }] }, C);
check(vDuo.s === 201 && vDuo.j.membresias[0].personas === 2, 'plan dúo para 2 personas', vDuo.j);
const vPar = await call('POST', '/pos/ventas', { socioId: s3.id, items: [{ tipo: 'producto', id: agua.id, cantidad: 2 }], pagos: [{ metodo: 'efectivo', moneda: 'COP', monto: 5000 }], pagoParcial: true }, C);
check(vPar.s === 201 && vPar.j.deuda?.saldo === 4000, 'pago parcial: queda deuda de COP 4.000', vPar.j);
const deudas = (await call('GET', `/pos/deudas/${s3.id}`, null, C)).j;
const abono = await call('POST', '/pos/ventas', { socioId: s3.id, items: [{ tipo: 'abono', deudaId: deudas[0].id, monto: 4000 }], pagos: [{ metodo: 'nequi', moneda: 'COP', monto: 4000, referencia: 'nq' }] }, C);
check(abono.s === 201 && (await call('GET', `/pos/deudas/${s3.id}`, null, C)).j.length === 0, 'abono salda la deuda', abono.j);
const corto = await call('POST', '/pos/ventas', { socioId: null, items: [{ tipo: 'producto', id: agua.id, cantidad: 1 }], pagos: [{ metodo: 'efectivo', moneda: 'COP', monto: 4000 }] }, C);
check(corto.s === 400 && /Faltan/.test(corto.j.message), 'sin pago parcial, si falta se rechaza', corto.j);

console.log('Egresos en el turno (caja ciega)');
const eg = await call('POST', '/pos/movimientos', { tipo: 'egreso', categoria: 'Proveedores', concepto: 'Pago de botellones', metodo: 'efectivo', moneda: 'COP', monto: 10000 }, C);
check(eg.s === 201, 'cajera registra egreso de caja', eg.j);
const vista = (await call('GET', '/pos/turno', null, C)).j;
check(vista && Object.keys(vista).sort().join() === 'abiertoEn,id,numero', 'caja ciega total: la cajera no ve ventas, conteos ni gastos', vista);

console.log('Cierre ciego multimoneda');
// Esperado: efectivo VES 13.750 · USD 30+40 = 70 · COP fondo 50.000 + 5.000 − 16.500 vuelto − 10.000 egreso = 28.500
const turnosAntes = (await call('GET', '/caja/turnos?estado=abierto', null, A)).j;
const mio = turnosAntes.find((t) => t.cajero === 'Ana Cajera');
const esperado = Object.fromEntries(mio.metodos.map((m) => [`${m.metodo}|${m.moneda}`, m.esperado]));
check(esperado['efectivo|VES'] === 13750 && esperado['efectivo|USD'] === 70, 'esperado efectivo: Bs 13.750 ($12,50 × 1.100) y $70', esperado);
check(esperado['efectivo|COP'] === 50000 + 5000 - 16500 - 10000, 'efectivo COP = fondo + cobrado − vuelto − egreso', esperado);
check(esperado['pago_movil|VES'] === 1500 && esperado['bancolombia|COP'] === 41250 && esperado['nequi|COP'] === 4000, 'pago móvil, Bancolombia y Nequi exactos', esperado);
const decl = mio.metodos.map((m) => ({ metodo: m.metodo, moneda: m.moneda, monto: Math.max(0, m.esperado) }));
const cierre = await call('POST', '/pos/turno/cerrar', { declaraciones: decl.map((d) => (d.metodo === 'efectivo' && d.moneda === 'USD' ? { ...d, monto: 65 } : d)) }, C);
check(cierre.s === 200 && !/esperado|diferencia|monto/i.test(JSON.stringify(cierre.j)), 'cajera cierra sin ver montos', cierre.j);
const t = (await call('GET', `/caja/turnos/${mio.id}`, null, A)).j;
const usd = t.metodos.find((m) => m.metodo === 'efectivo' && m.moneda === 'USD');
check(usd.diferencia === -5 && t.diferencia === -5 * T.usdCop, 'faltan $5 → COP −16.500 en la moneda de referencia', { usd, total: t.diferencia });
check(t.metodos.filter((m) => !(m.metodo === 'efectivo' && m.moneda === 'USD')).every((m) => m.diferencia === 0), 'todo lo demás cuadra exacto', t.metodos);

console.log('Membresías: congelar / reanudar');
const det = (await call('GET', `/socios/${s1.id}`, null, A)).j;
const actual = det.membresias.find((m) => m.fechaInicio === H);
const cong = await call('POST', `/socios/${s1.id}/membresias/${actual.id}/congelar`, { motivo: 'Viaje' }, A);
check(cong.s === 200, 'admin congela la membresía', cong.j);
check((await call('GET', `/socios/${s1.id}`, null, C)).j.vigencia.vigente === false, 'congelada: no está vigente');
const rean = await call('POST', `/socios/${s1.id}/membresias/${actual.id}/reanudar`, {}, A);
check(rean.s === 200 && rean.j.dias === 0, 'reanudar el mismo día devuelve 0 días', rean.j);

console.log('Lector: el sistema decide (verificación remota)');
await espera(2500);
const esc1 = await call('POST', '/biometric/simulador/escanear', { socioId: s1.id }, D);
check(esc1.j.verificacionRemota === true && esc1.j.puerta === 'abierta' && /Bienvenido/.test(esc1.j.pantallaLector), 'cliente al día → el sistema abre la puerta', esc1.j);
const s4 = (await call('POST', '/socios', { nombre: 'Sin', apellido: 'Plan', foto: jpeg, cedula: `V${sfx}40`, telefono: '04140000004' }, C)).j;
await espera(2000);
const esc2 = await call('POST', '/biometric/simulador/escanear', { socioId: s4.id }, D);
check(esc2.j.puerta === 'cerrada' && /No tiene/.test(esc2.j.resultado.motivo), 'sin plan → puerta cerrada con motivo', esc2.j.resultado);
await call('POST', `/socios/${s1.id}/membresias/${actual.id}/congelar`, { motivo: 'Lesión' }, A);
const esc3 = await call('POST', '/biometric/simulador/escanear', { socioId: s1.id }, D);
check(esc3.j.puerta === 'cerrada' && /congelada/i.test(esc3.j.resultado.motivo), 'congelada → puerta cerrada', esc3.j.resultado);

console.log('Lector: solo planes semanales/mensuales; foto tomada por el lector');
const cap = await call('POST', '/lector/capturar-rostro', {}, C);
check(cap.s === 200 && cap.j.foto.startsWith('data:image/jpeg;base64,'), 'la cajera pide la foto al lector y llega el JPEG', cap.j?.origen);
const diario = (await call('POST', '/planes', { nombre: 'Pase E2E', tipoDuracion: 'dias', cantidad: 1, precio: 10000, moneda: 'COP' }, D)).j;
check(diario.accesoLector === false, 'un plan por días queda SIN acceso por el lector', diario);
const s5 = (await call('POST', '/socios', { nombre: 'Rutina', apellido: 'Diaria', foto: cap.j.foto, cedula: `V${sfx}50`, telefono: '04140000005' }, C)).j;
await call('POST', '/pos/turno/abrir', {}, C);
const vD = await call('POST', '/pos/ventas', { socioId: s5.id, items: [{ tipo: 'membresia', id: diario.id }], pagos: [{ metodo: 'efectivo', moneda: 'COP', monto: 10000 }] }, C);
check(vD.s === 201, 'se vende el pase diario', vD.j);
await espera(2500);
const escD = await call('POST', '/biometric/simulador/escanear', { socioId: s5.id }, D);
check(escD.j.puerta === 'cerrada' && /recepci/i.test(escD.j.resultado.motivo), 'pase diario en el lector → no abre, “pase por recepción”', escD.j.resultado);
const manD = await call('POST', '/asistencia/manual', { socioId: s5.id }, C);
check(manD.s === 201 && manD.j.resultado === 'permitido', 'en recepción sí entra con su pase diario', manD.j);
const usrs = (await call('GET', '/biometric/simulador/usuarios', null, D)).j;
const fichaD = usrs.find((u) => u.employeeNo === String(s5.codigo));
check(fichaD && fichaD.validity.endTime < H, 'en el lector su vigencia queda vencida (no cuenta el pase diario)', fichaD);

console.log('Eliminar planes');
const pB = (await call('POST', '/planes', { nombre: 'Borrar E2E', tipoDuracion: 'meses', cantidad: 1, precio: 5, moneda: 'USD' }, D)).j;
const usoB = (await call('GET', `/planes/${pB.id}/uso`, null, D)).j;
check(usoB.tieneHistorial === false && usoB.vigentes.length === 0, 'plan nunca vendido: sin clientes ni historial', usoB);
const delB = await call('DELETE', `/planes/${pB.id}`, {}, D);
check(delB.s === 200 && delB.j.resultado === 'borrado', 'plan sin ventas → se borra de verdad', delB.j);
const pM = (await call('POST', '/planes', { nombre: 'Mover E2E', tipoDuracion: 'meses', cantidad: 1, precio: 20, moneda: 'USD' }, D)).j;
const pK = (await call('POST', '/planes', { nombre: 'Dejar E2E', tipoDuracion: 'meses', cantidad: 1, precio: 20, moneda: 'USD' }, D)).j;
const s6 = (await call('POST', '/socios', { nombre: 'Mario', apellido: 'Movido', cedula: `V${sfx}6`, telefono: '04140000006', foto: jpeg }, C)).j;
const s7 = (await call('POST', '/socios', { nombre: 'Delia', apellido: 'Dejada', foto: jpeg, cedula: `V${sfx}60`, telefono: '04140000006' }, C)).j;
await call('POST', '/pos/ventas', { socioId: s6.id, items: [{ tipo: 'membresia', id: pM.id }], pagos: [{ metodo: 'efectivo', moneda: 'USD', monto: 20 }] }, C);
await call('POST', '/pos/ventas', { socioId: s7.id, items: [{ tipo: 'membresia', id: pK.id }], pagos: [{ metodo: 'efectivo', moneda: 'USD', monto: 20 }] }, C);
const usoM = (await call('GET', `/planes/${pM.id}/uso`, null, D)).j;
const vM = usoM.vigentes.find((v) => v.socioId === s6.id);
check(vM && vM.desde === H && vM.hasta === sumarMeses(H, 1) && vM.telefono === '04140000006' && vM.diasRestantes > 27, 'uso del plan: cliente vigente con su fecha de pago y vencimiento', usoM);
check((await call('GET', `/planes/${pM.id}/uso`, null, C)).s === 403, 'la cajera no ve ni elimina planes');
const sinModo = await call('DELETE', `/planes/${pM.id}`, {}, D);
check(sinModo.s === 409 && /1 cliente/.test(sinModo.j.message), 'con clientes vigentes pide decidir qué pasa con ellos', sinModo.j);
const delM = await call('DELETE', `/planes/${pM.id}`, { modo: 'mover', destinoId: mensual.id }, D);
check(delM.s === 200 && delM.j.resultado === 'borrado' && delM.j.movidos === 1 && delM.j.destino === 'Mensual E2E', 'mover clientes a otro plan (sin historial propio → se borra)', delM.j);
const usoMen = (await call('GET', `/planes/${mensual.id}/uso`, null, D)).j;
check(usoMen.vigentes.some((v) => v.socioId === s6.id && v.hasta === vM.hasta), 'el cliente movido conserva sus fechas en el plan destino', usoMen.vigentes);
const delK = await call('DELETE', `/planes/${pK.id}`, { modo: 'dejar' }, D);
check(delK.s === 200 && delK.j.resultado === 'archivado' && delK.j.movidos === 0, 'dejar clientes hasta vencer y archivar', delK.j);
const det7 = (await call('GET', `/socios/${s7.id}`, null, A)).j;
check(det7.vigencia?.vigente === true || det7.vigente === true || det7.membresias?.some((m) => m.estado === 'activa' && m.fechaFin >= H), 'el cliente que se queda sigue vigente', det7.vigencia ?? det7);
const lista = (await call('GET', '/planes', null, D)).j;
const elim = (await call('GET', '/planes?eliminados=1', null, D)).j;
const catE = (await call('GET', '/pos/catalogo', null, C)).j;
check(!lista.some((p) => [pB.id, pM.id, pK.id].includes(p.id)) && elim.some((p) => p.id === pK.id && p.activos === 1) && !catE.planes.some((p) => p.id === pK.id), 'eliminados fuera del catálogo y de caja; listados como eliminados', elim);
const vK = await call('POST', '/pos/ventas', { socioId: s7.id, items: [{ tipo: 'membresia', id: pK.id }], pagos: [{ metodo: 'efectivo', moneda: 'USD', monto: 20 }] }, C);
check(vK.s === 400, 'un plan eliminado ya no se puede vender', vK.j);
const rest = await call('POST', `/planes/${pK.id}/restaurar`, {}, D);
check(rest.s === 200 && (await call('GET', '/planes', null, D)).j.some((p) => p.id === pK.id), 'restaurar un plan eliminado', rest.j);

console.log('Registro rápido: cédula, nombre y teléfono');
const sinCed = await call('POST', '/socios', { nombre: 'Sin', telefono: '04141112233' }, C);
check(sinCed.s === 400 && /cédula/i.test(sinCed.j.message), 'sin cédula → no registra', sinCed.j);
const sinTel = await call('POST', '/socios', { nombre: 'Sin', cedula: `V${sfx}99` }, C);
check(sinTel.s === 400 && /teléfono/i.test(sinTel.j.message), 'sin teléfono → no registra', sinTel.j);
const rapido = await call('POST', '/socios', { cedula: `v-${sfx}.98`, nombre: 'Rápido', telefono: '0414-555.12.12' }, C);
check(rapido.s === 201, 'con solo cédula, nombre y teléfono se registra', rapido.j);
const dupCed = await call('POST', '/socios', { cedula: `V${sfx}98`, nombre: 'Otro', telefono: '04140000000' }, C);
check(dupCed.s === 409 && /Rápido/.test(dupCed.j.message), 'cédula repetida → dice quién la tiene', dupCed.j);
const telNuevo = await call('PUT', `/socios/${s1.id}`, { telefono: '0424-7654321' }, C);
const telVacio = await call('PUT', `/socios/${s1.id}`, { telefono: '' }, C);
check(telNuevo.s === 200 && telVacio.s === 400, 'la cajera actualiza solo el teléfono; no se puede dejar vacío', [telNuevo.j, telVacio.j]);

console.log('Membresías: días y acceso');
const mb = await call('GET', '/membresias', null, C);
const f1 = mb.j?.filas?.find((f) => f.socioId === s1.id);
check(mb.s === 200 && f1 && f1.estado === 'congelada' && f1.acceso.tipo === 'bloqueado' && f1.telefono === '0424-7654321' && !('precio' in f1), 'congelada: no entra; ya con el teléfono nuevo', f1);
const f2 = mb.j.filas.find((f) => f.socioId === s2.id);
check(f2 && f2.estado === 'vigente' && f2.diasRestantes >= 28 && f2.proximoPago === sumarMeses(H, 1) && f2.acceso.tipo === 'lector', 'la cajera ve los días que le quedan, su próxima mensualidad y que el lector le abre', f2);
const f5 = mb.j.filas.find((f) => f.socioId === s5.id);
check(f5 && f5.estado === 'vence_hoy' && f5.acceso.tipo === 'recepcion', 'pase diario: vence hoy y entra por recepción', f5);
const f7 = mb.j.filas.find((f) => f.socioId === s7.id);
check(f7 && f7.plan === 'Dejar E2E' && mb.j.planes.some((p) => p.id === mensual.id && p.vigentes >= 1 && p.congeladas >= 1), 'conteo por plan (incluye planes eliminados con clientes)', mb.j.planes);
check(mb.j.resumen.vigentes >= 3 && typeof mb.j.resumen.sinLector === 'number', 'resumen de membresías', mb.j.resumen);
check((await call('POST', `/membresias/${s1.id}/lector`, {}, C)).s === 200, 'reenviar cliente al lector desde membresías');

console.log('Entrenadores');
const ent = await call('POST', '/entrenadores', { nombre: 'Jorge', apellido: 'Coach', especialidad: 'Funcional', pin: '4321', foto: jpeg, horario: { 1: { entrada: '00:00', salida: '23:59' }, 2: { entrada: '00:00', salida: '23:59' }, 3: { entrada: '00:00', salida: '23:59' }, 4: { entrada: '00:00', salida: '23:59' }, 5: { entrada: '00:00', salida: '23:59' }, 6: { entrada: '00:00', salida: '23:59' }, 7: { entrada: '00:00', salida: '23:59' } } }, A);
check(ent.s === 201, 'admin crea entrenador con PIN, foto y horario', ent.j);
const entSin = await call('POST', '/entrenadores', { nombre: 'Ana', apellido: 'Sinfoto', pin: '1111' }, D);
check(entSin.s === 201 && entSin.j.codigo > 0, 'dueño crea entrenador sin rostro (solo datos y PIN)', entSin.j);
check((await call('POST', '/entrenadores', { nombre: 'X', pin: '1' }, C)).s === 403, 'la cajera no crea entrenadores');
const pAdm = await call('POST', '/entrenadores/permisos', { entrenadorId: entSin.j.id, tipo: 'reposo', desde: `${H}T00:00`, hasta: `${H}T23:59`, motivo: 'Reposo médico' }, A);
const pLista = (await call('GET', `/entrenadores/permisos?estado=todos&entrenadorId=${entSin.j.id}`, null, A)).j;
check(pAdm.s === 201 && pLista.length === 1 && pLista[0].estado === 'aprobado' && pLista[0].entrenadorId === entSin.j.id, 'admin registra permiso aprobado sin PIN y se filtra por entrenador', pLista);
check((await call('POST', `/entrenadores/${ent.j.id}/sincronizar`, {}, A)).s === 200, 'reenviar entrenador al lector');
check((await call('PUT', `/entrenadores/${entSin.j.id}`, { activo: false }, A)).s === 200 && !(await call('GET', '/entrenadores/hoy', null, C)).j.some((e) => e.id === entSin.j.id), 'desactivado no aparece en recepción');
check((await call('POST', '/entrenadores/marcar', { entrenadorId: ent.j.id, pin: '0000', tipo: 'entrada', foto: jpeg }, C)).s === 401, 'PIN incorrecto rechazado');
check((await call('POST', '/entrenadores/marcar', { entrenadorId: ent.j.id, pin: '4321', tipo: 'salida', foto: jpeg }, C)).s === 409, 'no puede marcar salida sin entrada');
const me = await call('POST', '/entrenadores/marcar', { entrenadorId: ent.j.id, pin: '4321', tipo: 'entrada', foto: jpeg }, C);
check(me.s === 201 && me.j.minutosTarde >= 0 && me.j.marcacion.fotoId, 'entrada con foto guardada y tardanza calculada', me.j);
check((await call('POST', '/entrenadores/marcar', { entrenadorId: ent.j.id, pin: '4321', tipo: 'retiro', foto: jpeg }, C)).s === 400, 'retiro exige motivo');
const ret = await call('POST', '/entrenadores/marcar', { entrenadorId: ent.j.id, pin: '4321', tipo: 'retiro', foto: jpeg, nota: 'Cita médica' }, C);
check(ret.s === 201 && ret.j.estado === 'retirado', 'retiro con motivo', ret.j);
const tab = (await call('GET', '/entrenadores/hoy', null, C)).j.find((e) => e.id === ent.j.id);
check(tab.estado === 'retirado' && tab.siguientes.includes('regreso'), 'tablero: retirado, puede regresar', tab);
const foto = await fetch(`${B}/archivos/${me.j.marcacion.fotoId}?t=${encodeURIComponent(A)}`);
check(foto.status === 200 && (foto.headers.get('content-type') ?? '').includes('image'), 'la foto de la marcación se puede ver', foto.status);
const per = await call('POST', '/entrenadores/permisos/solicitar', { entrenadorId: ent.j.id, pin: '4321', tipo: 'diligencia', desde: `${sumarDias(H, 1)}T08:00`, hasta: `${sumarDias(H, 1)}T12:00`, motivo: 'Trámite bancario', soporte: jpeg }, C);
check(per.s === 201 && per.j.estado === 'pendiente', 'entrenador solicita permiso con soporte', per.j);
check((await call('POST', `/entrenadores/permisos/${per.j.id}/resolver`, { estado: 'aprobado' }, A)).s === 200, 'admin aprueba el permiso');
await espera(2000);
const escE = await call('POST', '/biometric/simulador/escanear', { entrenadorId: ent.j.id }, D);
check(escE.j.puerta === 'abierta' && escE.j.resultado.entrenador?.marco === 'regreso', 'entrenador en el lector: abre y marca regreso', escE.j.resultado);
const rep = (await call('GET', `/entrenadores/reporte?desde=${H}&hasta=${H}`, null, A)).j.find((r) => r.id === ent.j.id);
check(rep && rep.retiros === 1 && rep.diasTrabajados === 1, 'reporte de entrenador: días, horas y retiros', rep);

console.log('Clases ancladas a planes');
const opc = (await call('GET', '/clases/opciones', null, C)).j;
check(opc.entrenadores.some((e) => e.id === ent.j.id) && opc.caracteristicas.length === 6, 'la cajera ve entrenadores y las 6 características', opc.caracteristicas);
const car = { movilidad: 2, fuerza: 4, cardio: 3, resistencia: 4, potencia: 5, desplazamiento: 4 };
const cl = await call('POST', '/clases', { nombre: 'Funcional avanzada E2E', planId: mensual.id, entrenadorId: ent.j.id, fecha: H, hora: '10:00', duracionMin: 60, cupo: 3, nivel: 'avanzado', caracteristicas: car, repetirSemanas: 1 }, C);
check(cl.s === 201 && cl.j.creadas === 2 && cl.j.entrenador === 'Jorge Coach' && cl.j.hora === '10:00' && cl.j.dia === H, 'la cajera crea la clase (y la repite la semana siguiente)', cl.j);
const semanaCl = (await call('GET', `/clases?desde=${H}&hasta=${sumarDias(H, 7)}`, null, C)).j.filter((c) => c.nombre === 'Funcional avanzada E2E');
const cl2 = semanaCl.find((c) => c.dia === sumarDias(H, 7));
check(semanaCl.length >= 2 && cl2 && Object.entries(car).every(([k, v]) => semanaCl[0].caracteristicas[k] === v), 'calendario con la clase de hoy y la próxima semana, con sus características', semanaCl.map((c) => [c.dia, c.caracteristicas]));
const detCl0 = (await call('GET', `/clases/${cl.j.id}`, null, C)).j;
check(detCl0.sugeridos.some((s) => s.socioId === s6.id), 'sugiere a los que tienen el plan vigente', detCl0.sugeridos.map((s) => s.nombre));
const insc = await call('POST', `/clases/${cl.j.id}/inscritos`, { socioIds: [s6.id, s2.id, s4.id] }, C);
const lleno = await call('POST', `/clases/${cl.j.id}/inscritos`, { socioIds: [s5.id] }, C);
check(insc.s === 201 && insc.j.agregados === 3 && lleno.s === 409 && /Cupo lleno/.test(lleno.j.message), 'inscribe hasta el cupo; luego avisa cupo lleno', [insc.j, lleno.j]);
const detCl = (await call('GET', `/clases/${cl.j.id}`, null, C)).j;
const cob = Object.fromEntries(detCl.inscritos.map((i) => [i.socioId, i.acceso]));
check(cob[s6.id] === 'plan' && cob[s2.id] === 'mensualidad' && cob[s4.id] === 'sin_mensualidad', 'cada inscrito dice si entra con el plan, con otra mensualidad o sin mensualidad', cob);
const pSin = await call('POST', `/clases/${cl.j.id}/inscritos/${s4.id}/pasar`, {}, C);
const pCort = await call('POST', `/clases/${cl.j.id}/inscritos/${s4.id}/pasar`, { cobertura: 'cortesia' }, C);
check(pSin.s === 400 && pCort.s === 200 && pCort.j.cobertura === 'cortesia', 'sin mensualidad: la cajera elige pase o cortesía y lo deja pasar', [pSin.j, pCort.j]);
const p6 = await call('POST', `/clases/${cl.j.id}/inscritos/${s6.id}/pasar`, {}, C);
const p6b = await call('POST', `/clases/${cl.j.id}/inscritos/${s6.id}/pasar`, {}, C);
check(p6.s === 200 && p6.j.cobertura === 'plan' && p6b.s === 409, 'con su plan entra directo; no se marca dos veces', [p6.j, p6b.j]);
const asis4 = (await call('GET', `/socios/${s4.id}`, null, A)).j.asistencias;
check(asis4.some((a) => a.resultado === 'permitido' && /Clase Funcional avanzada E2E/.test(a.motivo)), 'la entrada a la clase queda en la asistencia del cliente', asis4[0]);
const futura = await call('POST', `/clases/${cl2.id}/inscritos`, { socioIds: [s6.id] }, C);
const pFut = await call('POST', `/clases/${cl2.id}/inscritos/${s6.id}/pasar`, {}, C);
check(futura.s === 201 && pFut.s === 400, 'la clase de la próxima semana se arma hoy, pero la entrada se da ese día', pFut.j);
check((await call('POST', `/clases/${cl.j.id}/inscritos/${s6.id}/deshacer`, {}, C)).s === 200 && (await call('DELETE', `/clases/${cl.j.id}/inscritos/${s4.id}`, null, C)).s === 400 && (await call('DELETE', `/clases/${cl.j.id}/inscritos/${s2.id}`, null, C)).s === 200, 'deshacer entrada; no se quita a quien ya entró; sí a quien no');
const detCl2 = (await call('GET', `/clases/${cl.j.id}`, null, C)).j;
check(detCl2.inscritos.length === 2 && detCl2.asistieron === 1, 'lista final: 2 inscritos, 1 entró', { n: detCl2.inscritos.length, a: detCl2.asistieron });
const canc = await call('POST', `/clases/${cl2.id}/cancelar`, { motivo: 'Feriado' }, C);
const inscCanc = await call('POST', `/clases/${cl2.id}/inscritos`, { socioIds: [s2.id] }, C);
check(canc.s === 200 && inscCanc.s === 400, 'clase cancelada: no se inscribe a nadie', inscCanc.j);
check((await call('DELETE', `/clases/${cl2.id}`, null, C)).s === 403 && (await call('DELETE', `/clases/${cl2.id}`, null, A)).s === 200 && (await call('DELETE', `/clases/${cl.j.id}`, null, A)).s === 409, 'solo administración borra, y no si alguien ya asistió');

console.log('Recordatorio de clases por WhatsApp');
const recCl = (await call('GET', `/clases/${cl.j.id}/recordatorio`, null, C)).j;
check(recCl && /Funcional avanzada E2E/.test(recCl.ejemplo) && /Jorge/.test(recCl.ejemplo) && /potencia/.test(recCl.ejemplo) && recCl.automatico === true && recCl.cuando === '3 h antes', 'mensaje del recordatorio con clase, hora, entrenador y lo que se trabaja', recCl);
const recSin = await call('POST', `/clases/${cl.j.id}/recordar`, {}, C);
check(recSin.s === 409 && /WhatsApp no está conectado/.test(recSin.j.message), 'sin WhatsApp conectado avisa en vez de fallar', recSin.j);

console.log('Planes de la apertura');
const catA = (await call('GET', '/pos/catalogo', null, C)).j;
const pl = (n) => catA.planes.find((p) => p.nombre === n);
check(pl('Trimestre')?.precio == 210000 && pl('Trimestre').moneda === 'COP' && pl('Trimestre').duracion === '3 meses', 'Trimestre COP 210.000 (3 meses)', pl('Trimestre'));
check(pl('Mensualidad')?.precio == 80000 && pl('Mensualidad').duracion === '1 mes', 'Mensualidad COP 80.000', pl('Mensualidad'));
check(pl('Semana')?.precio == 30000 && pl('Semana').accesoLector === true && pl('Semana').duracion === '1 semana', 'Semana COP 30.000 con lector', pl('Semana'));
check(pl('Día')?.precio == 8000 && pl('Día').accesoLector === false, 'Día COP 8.000 (entra por recepción)', pl('Día'));
check(catA.masVendidos?.length > 0 && catA.masVendidos.every((id) => catA.productos.some((p) => p.id === id)), 'venta rápida: los productos más vendidos del mes', catA.masVendidos);

console.log('Finanzas');
const fin = (await call('GET', `/finanzas/resumen?desde=${H}&hasta=${H}`, null, A)).j;
const cop = fin.flujo.find((f) => f.moneda === 'COP');
check(fin.monedaRef === 'COP' && fin.totales.egresos - fin0.totales.egresos === 10000 && cop.egresos - cop0.egresos === 10000, 'finanzas: egresos y flujo por moneda', fin.totales);
check(fin.totales.costoVendido - fin0.totales.costoVendido === 2500 * 4 && fin.totales.abonosCobrados - fin0.totales.abonosCobrados === 4000, 'costo de lo vendido y abonos cobrados', fin.totales);
const prev = await call('GET', '/whatsapp/reporte/preview', null, D);
check(prev.s === 200 && /Cobrado por método/.test(prev.j.texto) && /Tasas en pesos: Dólar 3\.300 · Bs 3/.test(prev.j.texto), 'reporte de WhatsApp con métodos y tablero en pesos', prev.j?.texto);

console.log('Excel para la administradora');
const { default: ExcelJS } = await import('exceljs');
const bajar = async (path, token) => {
  const r = await fetch(B + path, { headers: { Authorization: `Bearer ${token}` } });
  const wb = new ExcelJS.Workbook();
  if (r.ok) await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  return { s: r.status, tipo: r.headers.get('content-type'), nombre: r.headers.get('content-disposition'), wb };
};
const xc = await bajar(`/caja/exportar/cierres?desde=${H}&hasta=${H}`, A);
const hojas = xc.wb.worksheets.map((w) => w.name);
check(xc.s === 200 && /spreadsheetml/.test(xc.tipo) && /cierres-/.test(xc.nombre) && ['Resumen', 'Arqueo por método', 'Totales por método', 'Ventas', 'Movimientos'].every((h) => hojas.includes(h)), 'Excel de cierres con sus 5 hojas', { s: xc.s, hojas });
const txtRes = JSON.stringify(xc.wb.getWorksheet('Resumen').getSheetValues());
const txtMov = JSON.stringify(xc.wb.getWorksheet('Movimientos').getSheetValues());
check(txtRes.includes(`#${mio.numero}`) && txtRes.includes('Faltante') && txtMov.includes('Pago de botellones'), 'el Excel trae el turno, su faltante y el gasto', txtRes.slice(0, 400));
const xt = await bajar(`/caja/exportar/turno/${mio.id}`, A);
check(xt.s === 200 && new RegExp(`cierre-turno-${mio.numero}`).test(xt.nombre) && JSON.stringify(xt.wb.getWorksheet('Ventas').getSheetValues()).includes('Agua E2E'), 'Excel de un turno con sus ventas', xt.nombre);
const xm = await bajar(`/caja/exportar/movimientos?desde=${H}&hasta=${H}`, D);
check(xm.s === 200 && JSON.stringify(xm.wb.getWorksheet('Totales').getSheetValues()).includes('Proveedores'), 'Excel de movimientos con totales por categoría', xm.wb.worksheets.map((w) => w.name));
check((await bajar(`/caja/exportar/cierres?desde=${H}&hasta=${H}`, C)).s === 403, 'la cajera no descarga los cierres');

console.log('Caja en vivo (administración)');
const vivo = await call('GET', '/caja/en-vivo', null, A);
const cajaAna = vivo.j?.cajas?.find((c) => c.cajero === 'Ana Cajera');
check(vivo.s === 200 && cajaAna && vivo.j.dia.ventas >= 5 && vivo.j.eventos.some((e) => /Pago de botellones/.test(e.titulo)) && vivo.j.eventos.some((e) => e.tipo === 'venta'), 've cada caja abierta, el día y todo lo que va pasando', { cajas: vivo.j?.cajas?.length, dia: vivo.j?.dia });
check((await call('GET', '/caja/en-vivo', null, C)).s === 403, 'la cajera no ve la caja en vivo (caja ciega)');
const efAntes = cajaAna.metodos.find((m) => m.metodo === 'efectivo' && m.moneda === 'COP')?.esperado ?? 0;
const retiro = await call('POST', `/caja/turnos/${cajaAna.id}/movimientos`, { tipo: 'egreso', categoria: 'Retiro', concepto: 'Retiro de efectivo E2E', metodo: 'efectivo', moneda: 'COP', monto: 1000 }, A);
const cajaAna2 = (await call('GET', '/caja/en-vivo', null, A)).j.cajas.find((c) => c.id === cajaAna.id);
const efDespues = cajaAna2.metodos.find((m) => m.metodo === 'efectivo' && m.moneda === 'COP')?.esperado ?? 0;
check(retiro.s === 201 && retiro.j.turnoId === cajaAna.id && Math.round(efAntes - efDespues) === 1000, 'administración retira efectivo de una caja y se descuenta al instante', { efAntes, efDespues });
const vistaAna = (await call('GET', '/pos/turno', null, C)).j;
check(!('movimientos' in vistaAna) && !('ventas' in vistaAna), 'el retiro no le revela nada a la cajera (caja ciega)', vistaAna);

console.log('Webhook seguro');
const w = await fetch(`${B}/biometric/events/token-falso`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
check(w.status === 401, 'token inválido → 401');
const hb = await fetch(`${B}/biometric/events/${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventType: 'heartBeat', dateTime: new Date().toISOString() }) });
check(hb.status === 200, 'heartBeat aceptado');

console.log(`\nResultado: ${ok} OK, ${fail} fallos`);
process.exit(fail ? 1 : 0);
