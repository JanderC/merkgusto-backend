// Ajustes de la administración: editar membresía (fechas/plan) y personalizados sin cobro / editar fechas.
// Nada de esto pasa por caja. Corre contra PRUEBAS (puerto 5051, BD merkgusto_test) → node scripts/e2e-ajustes.mjs
const B = process.env.E2E_URL ?? 'http://localhost:5051/api';
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
const pad = (n) => String(n).padStart(2, '0');
const d = new Date();
const hoy = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const sumarDias = (f, n) => {
  const [y, m, dd] = f.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, dd));
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

const sfx = Date.now().toString(36).slice(-5);
const D = (await call('POST', '/auth/login', { usuario: 'dueno', password: 'Merkgusto2026*' })).j.token;
await call('POST', '/usuarios', { nombre: `Caja aj ${sfx}`, usuario: `aj${sfx}`, rol: 'cajero', password: '1234' }, D);
await call('POST', '/usuarios', { nombre: `Admin aj ${sfx}`, usuario: `ad${sfx}`, rol: 'admin_caja', password: '1234' }, D);
const C = (await call('POST', '/auth/login', { usuario: `aj${sfx}`, password: '1234' })).j.token;
const A = (await call('POST', '/auth/login', { usuario: `ad${sfx}`, password: '1234' })).j.token;
await call('POST', '/pos/turno/abrir', {}, C);
const ced = String(Date.now()).slice(-8);
const nuevoSocio = async (n, i) => (await call('POST', '/socios', { nombre: n, apellido: `Aj ${sfx}`, telefono: '04141112233', cedula: `V${Number(ced) + i}` }, C)).j;
const cat = (await call('GET', '/pos/catalogo', null, C)).j;
const plan = cat.planes.find((p) => p.personas === 1 && p.tipoDuracion === 'meses');
const otroPlan = cat.planes.find((p) => p.personas === 1 && p.id !== plan.id);
// Huella de la caja del día: lo que reporta finanzas (si cambia, algo pasó por caja)
const ventasTurno = async () => JSON.stringify((await call('GET', `/finanzas/resumen?desde=${hoy}&hasta=${hoy}`, null, D)).j);

console.log('\n── Editar membresía');
const ana = await nuevoSocio('Ana', 1);
const v = await call('POST', '/pos/ventas', { socioId: ana.id, items: [{ tipo: 'membresia', id: plan.id }], pagos: [{ metodo: 'efectivo', moneda: plan.moneda, monto: Number(plan.precio) }] }, C);
check(v.s === 201 || v.s === 200, 'se cobra la mensualidad de Ana', v.j);
let det = (await call('GET', `/socios/${ana.id}`, null, D)).j;
const mem = det.membresias[0];
check(mem && mem.planId === plan.id && 'ventaId' in mem, 'la ficha trae el plan y la venta de la membresía', mem);
const antesTurno = await ventasTurno();
const nuevoFin = sumarDias(mem.fechaFin, 10);
const body = { fechaInicio: sumarDias(mem.fechaInicio, -3), fechaFin: nuevoFin, motivo: 'se inscribió el lunes' };
check((await call('PUT', `/socios/${ana.id}/membresias/${mem.id}`, body, C)).s === 403, 'la recepción NO puede editar la membresía');
check((await call('PUT', `/socios/${ana.id}/membresias/${mem.id}`, { ...body, motivo: '' }, D)).s === 400, 'sin motivo no se guarda');
check((await call('PUT', `/socios/${ana.id}/membresias/${mem.id}`, { ...body, fechaFin: sumarDias(body.fechaInicio, -1) }, D)).s === 400, 'el vencimiento no puede ser antes del inicio');
const ed = await call('PUT', `/socios/${ana.id}/membresias/${mem.id}`, body, D);
check(ed.s === 200, 'el dueño cambia las fechas', ed.j);
det = (await call('GET', `/socios/${ana.id}`, null, D)).j;
const mem2 = det.membresias.find((m) => m.id === mem.id);
check(mem2.fechaInicio === body.fechaInicio && mem2.fechaFin === nuevoFin, 'quedan las fechas nuevas', mem2);
check(det.vigencia.hasta === nuevoFin, 'la vigencia (y el lector) usan el nuevo vencimiento', det.vigencia);
check(Number(mem2.precio) === Number(mem.precio) && mem2.ventaId === mem.ventaId, 'el precio cobrado y la venta quedan igual');
check(/Editada el/.test(mem2.notas ?? ''), 'queda la nota del cambio en la membresía', mem2.notas);
check((await ventasTurno()) === antesTurno, 'la caja no cambia (no se crea venta)');
const ed2 = await call('PUT', `/socios/${ana.id}/membresias/${mem.id}`, { fechaInicio: body.fechaInicio, fechaFin: nuevoFin, planId: otroPlan?.id, motivo: 'era el otro plan' }, A);
check(!otroPlan || ed2.s === 200, 'el administrador de caja también puede (cambia el plan)', ed2.j);
check((await call('PUT', `/socios/${ana.id}/membresias/${mem.id}`, { fechaInicio: body.fechaInicio, fechaFin: nuevoFin, planId: otroPlan?.id, motivo: 'nada' }, D)).s === 400, 'si no cambia nada, avisa');
const aud = (await call('GET', '/auditoria?limite=20', null, D)).j;
if (Array.isArray(aud?.filas ?? aud)) check((aud.filas ?? aud).some((x) => x.accion === 'membresia.editada'), 'queda en la auditoría');

console.log('\n── Asignar personalizado');
const ent = cat.entrenadores?.[0];
check(!!ent, 'hay un entrenador con tarifa para probar', cat.entrenadores);
const beto = await nuevoSocio('Beto', 2);
check((await call('PUT', `/socios/${beto.id}/entrenador`, { entrenadorId: ent.id }, C)).s === 200, 'la recepción asigna a Beto (solo asignar)');
let pz = (await call('GET', '/personalizados', null, C)).j;
check(pz.filas.some((f) => f.socioId === beto.id && f.estado === 'sin_pago'), 'Beto aparece en "Sin pagar"');

const sc = { socioId: beto.id, entrenadorId: ent.id, fechaInicio: hoy, fechaFin: sumarDias(hoy, 29), motivo: 'pagó al entrenador antes del sistema' };
check((await call('POST', '/personalizados/sin-cobro', sc, C)).s === 403, 'la recepción NO puede registrar sin cobro');
const antesPz = (await call('GET', '/personalizados', null, D)).j;
const r = await call('POST', '/personalizados/sin-cobro', sc, A);
check(r.s === 201, 'la administración lo registra sin cobro', r.j);
pz = (await call('GET', '/personalizados', null, D)).j;
const fb = pz.filas.find((f) => f.socioId === beto.id);
check(fb?.estado === 'al_dia' && fb.hasta === sc.fechaFin && fb.ultimoPago?.sinCobro && fb.ultimo?.id === r.j.id, 'Beto queda al día hasta la fecha puesta, marcado sin cobro', fb);
check(pz.totales.cobradoMesTexto === antesPz.totales.cobradoMesTexto && pz.totales.clientesMes === antesPz.totales.clientesMes, 'no suma a lo cobrado del mes', [antesPz.totales, pz.totales]);
const reE = pz.entrenadores.find((e) => e.id === ent.id);
const reA = antesPz.entrenadores.find((e) => e.id === ent.id);
check(reE.porPagarTexto === reA.porPagarTexto, 'no le genera pago al entrenador', [reA.porPagarTexto, reE.porPagarTexto]);
check((await ventasTurno()) === antesTurno, 'la caja sigue igual');

console.log('\n── Editar fechas del personalizado');
const ep = { fechaInicio: sumarDias(hoy, 2), fechaFin: sumarDias(hoy, 40), motivo: 'empezó después' };
check((await call('PUT', `/personalizados/${r.j.id}`, ep, C)).s === 403, 'la recepción NO puede editar');
check((await call('PUT', `/personalizados/${r.j.id}`, ep, D)).s === 200, 'el dueño corrige las fechas');
const fb2 = (await call('GET', '/personalizados', null, D)).j.filas.find((f) => f.socioId === beto.id);
check(fb2.estado === 'por_empezar' && fb2.hasta === ep.fechaFin, 'el estado se recalcula (pagado desde pasado mañana)', fb2);
const sd = (await call('GET', `/socios/${beto.id}`, null, C)).j;
check(sd.personalizados?.[0]?.sinCobro === true && sd.personalizados[0].ultimo?.fechaFin === ep.fechaFin, 'la ficha del cliente lo muestra', sd.personalizados);
const coach = (await call('GET', '/personalizados?entrenadorId=' + ent.id, null, C)).j;
check(!('totales' in coach) || coach.totales === null, 'la recepción sigue sin ver totales de dinero');

console.log(`\n${ok} OK · ${fail} fallas`);
process.exit(fail ? 1 : 0);
