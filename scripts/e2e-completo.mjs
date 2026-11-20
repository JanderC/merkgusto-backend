// Compras con costo, kardex, conteo físico, pago a entrenadores, progreso + portal del cliente y respaldos.
// Corre contra la instancia de PRUEBAS (puerto 5051, BD merkgusto_test) → node scripts/e2e-completo.mjs
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
const hoy = new Date().toLocaleDateString('en-CA');
const sfx = Date.now().toString(36).slice(-5);
const D = (await call('POST', '/auth/login', { usuario: 'dueno', password: 'Merkgusto2026*' })).j.token;
const cajera = (await call('POST', '/usuarios', { nombre: `Caja ${sfx}`, usuario: `cj${sfx}`, rol: 'cajero', password: '1234' }, D)).j;
const C = (await call('POST', '/auth/login', { usuario: `cj${sfx}`, password: '1234' })).j.token;
const stockDe = async (id) => (await call('GET', '/productos', null, D)).j.find((p) => p.id === id);

console.log('\n── Proveedores y compras con costo');
const prov = await call('POST', '/inventario/proveedores', { nombre: `Distribuidora ${sfx}`, documento: 'J-123', telefono: '0414' }, D);
check(prov.s === 201, 'dueño crea proveedor', prov.j);
check((await call('GET', '/inventario/proveedores', null, C)).s === 403, 'la cajera no entra a inventario');
const prod = (await call('POST', '/productos', { nombre: `Proteína ${sfx}`, precio: 5000, moneda: 'COP', stock: 5 }, D)).j;
check(prod.stock === 5, 'producto con stock inicial 5', prod);
const c1 = await call('POST', '/inventario/compras', { proveedorId: prov.j.id, factura: 'F-1', moneda: 'COP', items: [{ productoId: prod.id, cantidad: 10, costoUnitario: 3000 }], pago: { metodo: 'efectivo' } }, D);
check(c1.s === 201 && c1.j.saldo === 0, 'compra de 10 a COP 3.000 pagada', c1.j);
let p = await stockDe(prod.id);
check(p.stock === 15 && Number(p.costo) === 3000, 'stock 15 y costo 3.000', p);
const c2 = await call('POST', '/inventario/compras', { proveedorId: prov.j.id, moneda: 'COP', items: [{ productoId: prod.id, cantidad: 10, costoUnitario: 4000 }], pago: null }, D);
check(c2.s === 201 && c2.j.saldo === 40000, 'compra a crédito: queda debiendo 40.000', c2.j);
p = await stockDe(prod.id);
check(p.stock === 25 && Number(p.costo) === 3400, 'costo promedio (15×3.000 + 10×4.000)/25 = 3.400', p);
const res1 = (await call('GET', '/inventario/resumen', null, D)).j;
check(res1.porPagar.compras >= 1 && res1.valorCosto > 0, 'resumen: valor del inventario y cuentas por pagar', res1.porPagar);
check((await call('POST', `/inventario/compras/${c2.j.id}/pagos`, { metodo: 'efectivo', monto: 15000 }, D)).s === 201, 'abono de 15.000 al proveedor');
let lista = (await call('GET', '/inventario/compras', null, D)).j;
check(lista.find((x) => x.id === c2.j.id)?.saldo === 25000, 'saldo pendiente 25.000');
await call('POST', `/inventario/compras/${c2.j.id}/pagos`, { metodo: 'efectivo', monto: 99999 }, D);
lista = (await call('GET', '/inventario/compras', null, D)).j;
check(lista.find((x) => x.id === c2.j.id)?.estado === 'pagada', 'pagando el resto queda pagada (no cobra de más)');
const det = (await call('GET', `/inventario/compras/${c2.j.id}`, null, D)).j;
check(det.pagos.length === 2 && det.items[0].cantidad === 10, 'detalle con 2 pagos y sus productos', det);
const movs = (await call('GET', `/caja/movimientos?desde=${hoy}&hasta=${hoy}`, null, D)).j;
const movCompra = (Array.isArray(movs) ? movs : movs.movimientos ?? []).find((m) => m.categoria === 'Compra de mercancía');
if (movCompra) check((await call('POST', `/caja/movimientos/${movCompra.id}/anular`, { motivo: 'prueba' }, D)).s === 409, 'el pago de una compra no se anula suelto');

console.log('\n── Venta, kardex y anulación de compra');
await call('POST', '/pos/turno/abrir', {}, C);
const v = await call('POST', '/pos/ventas', { socioId: null, items: [{ tipo: 'producto', id: prod.id, cantidad: 20 }], pagos: [{ metodo: 'efectivo', moneda: 'COP', monto: 100000 }] }, C);
check(v.s === 201, 'vende 20', v.j);
check((await call('POST', `/inventario/compras/${c2.j.id}/anular`, { motivo: 'error de carga' }, D)).s === 409, 'no anula una compra cuya mercancía ya se vendió');
const k = (await call('GET', `/inventario/movimientos?productoId=${prod.id}`, null, D)).j;
check(
  ['ajuste', 'compra', 'compra', 'venta'].every((t) => k.some((x) => x.tipo === t)) && k[0].tipo === 'venta' && k[0].cantidad === -20 && k[0].stockResultante === 5 && /Ticket #/.test(k[0].referencia),
  'kardex: stock inicial, 2 compras y la venta (−20, quedan 5)',
  k,
);
const aj = await call('POST', `/productos/${prod.id}/entrada`, { cantidad: -1, motivo: 'Se rompió un envase' }, D);
check(aj.s === 200 && aj.j.stock === 4, 'salida manual con motivo');
await call('PUT', `/productos/${prod.id}`, { stock: 5 }, D);
const k2 = (await call('GET', `/inventario/movimientos?productoId=${prod.id}`, null, D)).j;
check(k2[0].tipo === 'ajuste' && k2[0].cantidad === 1 && k2[1].referencia === 'Se rompió un envase', 'editar el stock a mano también queda en el kardex', k2.slice(0, 2));
const fin = (await call('GET', `/finanzas/resumen?desde=${hoy}&hasta=${hoy}`, null, D)).j;
check(fin.totales.comprasInventario >= 70000 && fin.totales.utilidad === Math.round((fin.totales.cobrado + fin.totales.otrosIngresos - (fin.totales.egresos - fin.totales.comprasInventario) - fin.totales.costoVendido) * 100) / 100, 'finanzas: la compra de mercancía no se resta dos veces de la utilidad', fin.totales);

console.log('\n── Conteo físico ciego');
const ya = (await call('GET', '/inventario/conteos/actual', null, D)).j;
if (ya) await call('POST', `/inventario/conteos/${ya.id}/cancelar`, {}, D);
const ct = await call('POST', '/inventario/conteos', { nota: 'Conteo de prueba' }, D);
check(ct.s === 201, 'abre conteo', ct.j);
check((await call('POST', '/inventario/conteos', {}, D)).s === 409, 'solo un conteo abierto a la vez');
const act = (await call('GET', '/inventario/conteos/actual', null, D)).j;
const fila = act.productos.find((x) => x.id === prod.id);
check(fila && !('stock' in fila) && !('esperado' in fila) && fila.contado === null, 'quien cuenta NO ve lo que dice el sistema', fila);
await call('PUT', `/inventario/conteos/${ct.j.id}/items`, { productoId: prod.id, contado: 3 }, D);
const sum = await call('PUT', `/inventario/conteos/${ct.j.id}/items`, { productoId: prod.id, sumar: 1 }, D);
check(sum.j.contado === 4, 'con el lector suma de a uno (3 + 1 = 4)', sum.j);
check((await call('GET', `/inventario/conteos/${ct.j.id}`, null, D)).s === 409, 'las diferencias no se ven con el conteo abierto');
const cerr = await call('POST', `/inventario/conteos/${ct.j.id}/cerrar`, {}, D);
check(cerr.s === 200, 'cierra el conteo', cerr.j);
check((await stockDe(prod.id)).stock === 4, 'el stock queda en lo contado (4)');
const dc = (await call('GET', `/inventario/conteos/${ct.j.id}`, null, D)).j;
check(dc[0].esperado === 5 && dc[0].diferencia === -1 && dc[0].valorTexto, 'faltó 1 unidad y se valora a costo', dc[0]);
const hc = (await call('GET', '/inventario/conteos', null, D)).j.find((x) => x.id === ct.j.id);
check(hc.faltanteRef > 0 && hc.conDiferencia === 1, 'historial: faltante valorado', hc);

console.log('\n── Pago a entrenadores');
const ent = (await call('POST', '/entrenadores', { nombre: `Coach ${sfx}`, pin: '4321', pagoTipo: 'fijo', pagoTarifa: 200, pagoMoneda: 'USD' }, D)).j;
const ent2 = (await call('POST', '/entrenadores', { nombre: `Clases ${sfx}`, pin: '4322', pagoTipo: 'por_clase', pagoTarifa: 10, pagoMoneda: 'USD' }, D)).j;
const ayer = new Date(Date.now() - 86400000).toLocaleDateString('en-CA');
await call('POST', '/clases', { nombre: `Funcional ${sfx}`, entrenadorId: ent2.id, fecha: ayer, hora: '07:00', repetirSemanas: 0 }, D);
await call('POST', '/clases', { nombre: `Funcional ${sfx}`, entrenadorId: ent2.id, fecha: ayer, hora: '18:00', repetirSemanas: 0 }, D);
const desde = new Date(Date.now() - 6 * 86400000).toLocaleDateString('en-CA');
const nom = (await call('GET', `/entrenadores/nomina?desde=${desde}&hasta=${hoy}`, null, D)).j;
check(nom.find((n) => n.id === ent.id)?.montoBase === 200, 'fijo: le corresponden $200', nom.find((n) => n.id === ent.id));
const n2 = nom.find((n) => n.id === ent2.id);
check(n2?.clases === 2 && n2.montoBase === 20, 'por clase: 2 clases × $10 = $20', n2);
const pago = await call('POST', '/entrenadores/pagos', { entrenadorId: ent.id, desde, hasta: hoy, bonos: 20, descuentos: 10, metodo: 'efectivo' }, D);
check(pago.s === 201 && pago.j.total === 210, 'paga 200 + 20 bono − 10 descuento = 210', pago.j);
check((await call('POST', '/entrenadores/pagos', { entrenadorId: ent.id, desde, hasta: hoy, metodo: 'efectivo' }, D)).s === 409, 'no se paga dos veces el mismo periodo');
const hp = (await call('GET', `/entrenadores/pagos?entrenadorId=${ent.id}`, null, D)).j;
check(hp.length === 1 && hp[0].totalTexto.includes('210'), 'historial de pagos', hp[0]);
check((await call('POST', `/entrenadores/pagos/${pago.j.id}/anular`, { motivo: 'monto equivocado' }, D)).s === 200, 'anula el pago');
check((await call('POST', '/entrenadores/pagos', { entrenadorId: ent.id, desde, hasta: hoy, metodo: 'efectivo' }, D)).s === 201, 'después de anular se puede volver a pagar');
check((await call('GET', `/entrenadores/nomina?desde=${desde}&hasta=${hoy}`, null, C)).s === 403, 'la cajera no ve la nómina');

console.log('\n── Progreso, rutina y portal del cliente');
const jpeg = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7), Buffer.from([0xff, 0xd9])]).toString('base64');
const soc = (await call('POST', '/socios', { nombre: 'María', apellido: `Progreso ${sfx}`, telefono: '04141112233', foto: jpeg, cedula: `V${String(Date.now()).slice(-8)}` }, C)).j;
check((await call('POST', `/socios/${soc.id}/mediciones`, {}, C)).s === 400, 'medición vacía rechazada');
check((await call('POST', `/socios/${soc.id}/mediciones`, { fecha: desde, peso: 72.5, grasa: 28, cintura: 80 }, C)).s === 201, 'registra medidas iniciales');
check((await call('POST', `/socios/${soc.id}/mediciones`, { peso: 70.1, grasa: 26.5, cintura: 77 }, C)).s === 201, 'registra medidas de hoy');
const rut = await call('POST', `/socios/${soc.id}/rutinas`, { titulo: 'Tonificación', objetivo: 'Bajar grasa', entrenadorId: ent.id, dias: [{ nombre: 'Día 1 · Pierna', ejercicios: [{ nombre: 'Sentadilla', series: '4', reps: '12', nota: '' }] }] }, C);
check(rut.s === 201, 'asigna rutina', rut.j);
await call('POST', `/socios/${soc.id}/rutinas`, { titulo: 'Fuerza', dias: [{ nombre: 'Día A', ejercicios: [{ nombre: 'Peso muerto', series: '5', reps: '5', nota: '' }] }] }, C);
const prog = (await call('GET', `/socios/${soc.id}/progreso`, null, C)).j;
check(prog.mediciones.length === 2 && prog.mediciones[0].peso === 70.1 && prog.rutinas.filter((r) => r.activa).length === 1 && prog.rutinas[0].titulo === 'Fuerza', 'una sola rutina activa (la nueva) y la anterior queda en el historial', prog);
const link = await call('POST', `/socios/${soc.id}/portal`, { baseUrl: 'http://localhost:5173', enviar: false }, C);
check(link.s === 200 && /\/socio\/[A-Za-z0-9_-]{20,}$/.test(link.j.url), 'genera el enlace personal', link.j);
const token = link.j.url.split('/socio/')[1];
const portal = await call('GET', `/portal/${token}`);
check(portal.s === 200 && portal.j.socio.nombre === 'María' && portal.j.mediciones.length === 2 && portal.j.rutina?.titulo === 'Fuerza', 'el cliente abre su portal sin usuario ni clave', portal.j);
check(!JSON.stringify(portal.j).includes(soc.cedula) && !('telefono' in portal.j.socio), 'el portal no expone la cédula completa ni el teléfono', portal.j.socio);
check((await call('GET', '/portal/esto-no-es-un-token-valido-xx')).s === 404, 'enlace inventado: no entra');
const link2 = await call('POST', `/socios/${soc.id}/portal`, { baseUrl: 'http://localhost:5173' }, C);
check((await call('GET', `/portal/${token}`)).s === 404 && (await call('GET', `/portal/${link2.j.url.split('/socio/')[1]}`)).s === 200, 'regenerar el enlace invalida el anterior');
await call('DELETE', `/socios/${soc.id}/portal`, null, C);
check((await call('GET', `/portal/${link2.j.url.split('/socio/')[1]}`)).s === 404, 'quitar el acceso lo desactiva');

console.log('\n── Respaldos');
check((await call('POST', '/respaldos', {}, C)).s === 403, 'la cajera no hace respaldos');
const rp = await call('POST', '/respaldos', {}, D);
check(rp.s === 201 && rp.j.filas > 0 && rp.j.tablas > 20, 'el dueño hace un respaldo completo', rp.j);
const lr = (await call('GET', '/respaldos', null, D)).j;
check(lr[0]?.nombre === rp.j.nombre, 'aparece en la lista', lr[0]);
const dl = await fetch(`${B}/respaldos/${rp.j.nombre}`, { headers: { Authorization: `Bearer ${D}` } });
const bytes = Buffer.from(await dl.arrayBuffer());
check(dl.status === 200 && bytes[0] === 0x1f && bytes[1] === 0x8b, 'se descarga (archivo comprimido)');
check((await call('GET', '/respaldos/..%2F..%2Fsecretos.json', null, D)).s === 404, 'no deja descargar otros archivos del servidor');

console.log(`\n${ok} ok · ${fail} fallos\n`);
process.exit(fail ? 1 : 0);
