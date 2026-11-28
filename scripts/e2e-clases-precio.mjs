// Clases con precio (bailoterapia) y rutina sin cliente.
// Corre contra PRUEBAS (puerto 5051, BD merkgusto_test) → node scripts/e2e-clases-precio.mjs
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
const manana = (() => {
  const x = new Date(d.getTime() + 86_400_000);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
})();

const sfx = Date.now().toString(36).slice(-5);
const D = (await call('POST', '/auth/login', { usuario: 'dueno', password: 'Merkgusto2026*' })).j.token;
await call('POST', '/usuarios', { nombre: `Caja cl ${sfx}`, usuario: `cl${sfx}`, rol: 'cajero', password: '1234' }, D);
const C = (await call('POST', '/auth/login', { usuario: `cl${sfx}`, password: '1234' })).j.token;
await call('POST', '/pos/turno/abrir', {}, C);
const ced = String(Date.now()).slice(-8);
const nuevoSocio = async (n, i) => (await call('POST', '/socios', { nombre: n, apellido: `Cl ${sfx}`, telefono: '04141112233', cedula: `V${Number(ced) + i}` }, C)).j;
const cobrarClase = (socioId, claseId, monto = 10000) => call('POST', '/pos/ventas', { socioId, items: [{ tipo: 'clase', claseId }], pagos: [{ metodo: 'efectivo', moneda: 'COP', monto }] }, C);

console.log('\n── Clase con precio');
const cl = await call('POST', '/clases', { nombre: `Bailoterapia ${sfx}`, fecha: manana, hora: '19:00', duracionMin: 60, cupo: 2, precio: 10000, moneda: 'COP' }, C);
check(cl.s === 201 && Number(cl.j.precio) === 10000 && cl.j.moneda === 'COP', 'la recepción crea Bailoterapia a $10.000', cl.j);
const clase = cl.j;
const sinPrecio = (await call('POST', '/clases', { nombre: `Funcional ${sfx}`, fecha: manana, hora: '07:00' }, C)).j;
check(sinPrecio.precio === null, 'una clase puede no tener precio');

const pos = (await call('GET', '/pos/clases', null, C)).j;
check(pos.some((c) => c.id === clase.id) && !pos.some((c) => c.id === sinPrecio.id), 'en caja aparecen solo las clases con precio', pos.map((c) => c.nombre));

const ana = await nuevoSocio('Ana', 1);
check((await call('POST', '/pos/ventas', { socioId: null, items: [{ tipo: 'clase', claseId: clase.id }], pagos: [{ metodo: 'efectivo', moneda: 'COP', monto: 10000 }] }, C)).s === 400, 'sin persona no se cobra la clase (queda inscrita a su nombre)');
check((await cobrarClase(ana.id, clase.id, 5000)).s === 400, 'cobra el precio de la base, no el que mande la caja');
check((await cobrarClase(ana.id, sinPrecio.id)).s === 400, 'una clase sin precio no se cobra');
const v1 = await cobrarClase(ana.id, clase.id);
check(v1.s === 201 && v1.j.clases?.[0]?.nombre === clase.nombre, 'Ana (sin mensualidad) paga la bailoterapia', v1.j);
let det = (await call('GET', `/clases/${clase.id}`, null, C)).j;
const insAna = det.inscritos.find((i) => i.socioId === ana.id);
check(!!insAna?.ventaId && insAna.ticket === v1.j.numero, 'queda inscrita con su ticket', insAna);
check((await cobrarClase(ana.id, clase.id)).s === 409, 'no se le cobra dos veces');
const posAna = (await call('GET', `/pos/clases?socioId=${ana.id}`, null, C)).j.find((c) => c.id === clase.id);
check(posAna?.pagado === true, 'la caja muestra que ya la pagó', posAna);
check((await call('DELETE', `/clases/${clase.id}/inscritos/${ana.id}`, null, C)).s === 409, 'no se quita de la lista a quien pagó (hay que anular el ticket)');

console.log('\n── Quien tiene mensualidad no paga');
const cat = (await call('GET', '/pos/catalogo', null, C)).j;
const mensual = cat.planes.find((p) => p.personas === 1 && p.accesoLector && p.tipoDuracion === 'meses');
const beto = await nuevoSocio('Beto', 2);
await call('POST', '/pos/ventas', { socioId: beto.id, items: [{ tipo: 'membresia', id: mensual.id }], pagos: [{ metodo: 'efectivo', moneda: mensual.moneda, monto: Number(mensual.precio) }] }, C);
const vb = await cobrarClase(beto.id, clase.id);
check(vb.s === 409 && /incluida/.test(vb.j?.message), 'a Beto (con mensualidad) no se le cobra: le sale incluida', vb.j);
const posBeto = (await call('GET', `/pos/clases?socioId=${beto.id}`, null, C)).j.find((c) => c.id === clase.id);
check(!!posBeto?.cubierto, 'la caja lo muestra como cubierto', posBeto);

console.log('\n── Cupo');
const caro = await nuevoSocio('Caro', 3);
check((await cobrarClase(caro.id, clase.id)).s === 201, 'Caro paga (2 de 2)');
const dani = await nuevoSocio('Dani', 4);
const vd = await cobrarClase(dani.id, clase.id);
check(vd.s === 409 && /Cupo lleno/.test(vd.j?.message), 'con el cupo lleno no se cobra', vd.j);

console.log('\n── Anular el ticket');
const ventas = (await call('GET', `/caja/ventas?desde=${hoy}&hasta=${hoy}`, null, D)).j;
const lista = Array.isArray(ventas) ? ventas : (ventas.ventas ?? ventas.filas ?? []);
const ticketCaro = (await call('GET', `/clases/${clase.id}`, null, C)).j.inscritos.find((i) => i.socioId === caro.id);
const ventaCaro = lista.find((v) => v.numero === ticketCaro.ticket);
check(!!ventaCaro, 'se encuentra el ticket de Caro', { ticket: ticketCaro.ticket, n: lista.length });
if (ventaCaro) {
  const an = await call('POST', `/caja/ventas/${ventaCaro.id}/anular`, { motivo: 'se equivocó de clase' }, D);
  check(an.s === 200, 'se anula el ticket de Caro', an.j);
  const ic = (await call('GET', `/clases/${clase.id}`, null, C)).j.inscritos.find((i) => i.socioId === caro.id);
  check(ic && !ic.ventaId, 'su inscripción queda sin pago');
  check((await call('DELETE', `/clases/${clase.id}/inscritos/${caro.id}`, null, C)).s === 200, 'ya se puede quitar de la lista');
}
check((await call('DELETE', `/clases/${clase.id}`, null, D)).s === 409, 'no se borra una clase que alguien pagó');

console.log('\n── Dar entrada el día de la clase');
const hoyCl = (await call('POST', '/clases', { nombre: `Baile hoy ${sfx}`, fecha: hoy, hora: '23:00', precio: 8000, moneda: 'COP' }, C)).j;
const eva = await nuevoSocio('Eva', 5);
const fer = await nuevoSocio('Fer', 6);
await call('POST', `/clases/${hoyCl.id}/inscritos`, { socioIds: [fer.id] }, C);
const pf = await call('POST', `/clases/${hoyCl.id}/inscritos/${fer.id}/pasar`, { cobertura: 'pase' }, C);
check(pf.s === 400 && /cóbrasela en caja/.test(pf.j?.message), 'con precio, "ya pagó" sin cobro real no se acepta', pf.j);
check((await call('POST', `/clases/${hoyCl.id}/inscritos/${fer.id}/pasar`, { cobertura: 'cortesia' }, C)).s === 200, 'cortesía sí (queda en auditoría)');
check((await cobrarClase(eva.id, hoyCl.id, 8000)).s === 201, 'Eva paga la clase de hoy');
const pe = await call('POST', `/clases/${hoyCl.id}/inscritos/${eva.id}/pasar`, {}, C);
check(pe.s === 200 && pe.j.cobertura === 'pase', 'al darle entrada queda "pagó su pase" sola', pe.j);

console.log('\n── Rutina sin cliente');
const rutina = cat.planes.find((p) => p.personas === 1 && !p.accesoLector && p.tipoDuracion === 'dias' && p.cantidad === 1);
check(!!rutina, 'hay un plan de rutina / pase del día', cat.planes.map((p) => p.nombre));
if (rutina) {
  const vr = await call('POST', '/pos/ventas', { socioId: null, items: [{ tipo: 'membresia', id: rutina.id }], pagos: [{ metodo: 'efectivo', moneda: rutina.moneda, monto: Number(rutina.precio) }] }, C);
  check(vr.s === 201 && vr.j.membresias.length === 0 && /sin cliente/.test(vr.j.items[0].descripcion), 'la rutina se cobra sin elegir cliente', vr.j);
}
const vm = await call('POST', '/pos/ventas', { socioId: null, items: [{ tipo: 'membresia', id: mensual.id }], pagos: [{ metodo: 'efectivo', moneda: mensual.moneda, monto: Number(mensual.precio) }] }, C);
check(vm.s === 400, 'la mensualidad (abre el lector) sí exige cliente', vm.j);

console.log(`\n${ok} OK · ${fail} fallas`);
process.exit(fail ? 1 : 0);
