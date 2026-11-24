// Código de barras + devoluciones autorizadas por supervisor.
// Corre contra la instancia de PRUEBAS (puerto 5051, BD merkgusto_test) → node scripts/e2e-devoluciones.mjs
const B = process.env.E2E_URL ?? 'http://localhost:5051/api';
let ok = 0;
let fail = 0;
const check = (c, m, extra) => {
  if (c) {
    ok++;
    console.log('  ✓', m);
  } else {
    fail++;
    console.log('  ✗', m, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
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
const sfx = Date.now().toString(36).slice(-5);
const D = (await call('POST', '/auth/login', { usuario: 'dueno', password: 'Merkgusto2026*' })).j.token;
const nuevo = (u, rol) => call('POST', '/usuarios', { nombre: `${u} ${sfx}`, usuario: `${u}${sfx}`, rol, password: '1234' }, D);
const cajera = (await nuevo('dev', 'cajero')).j;
const admin = (await nuevo('sup', 'admin_caja')).j;
const C = (await call('POST', '/auth/login', { usuario: `dev${sfx}`, password: '1234' })).j.token;
const A = (await call('POST', '/auth/login', { usuario: `sup${sfx}`, password: '1234' })).j.token;
const pinSup = String(4000 + Math.floor(Math.random() * 5000)) + sfx.replace(/\D/g, '').slice(0, 2);

console.log('\n── Código de supervisor');
check((await call('PUT', `/usuarios/${cajera.id}/pin`, { pin: '1234' }, D)).s === 400, 'una cajera no puede tener código de supervisor');
check((await call('PUT', `/usuarios/${admin.id}/pin`, { pin: '12' }, D)).s === 400, 'código muy corto rechazado');
check((await call('PUT', `/usuarios/${admin.id}/pin`, { pin: pinSup }, D)).s === 200, 'dueño asigna código al admin de caja');
check((await call('PUT', `/usuarios/${admin.id}/pin`, { pin: pinSup }, C)).s === 403, 'la cajera no puede asignar códigos');
const lista = (await call('GET', '/usuarios', null, D)).j;
check(lista.find((u) => u.id === admin.id)?.tienePin === true && !('pinHash' in lista[0]), 'la lista dice quién tiene código y nunca expone el hash');

console.log('\n── Código de barras');
const barras = `77${Date.now()}`.slice(0, 13);
const compra = await call('POST', '/inventario/compras', { moneda: 'COP', items: [{ nuevo: { nombre: `Gatorade ${sfx}`, categoria: 'Bebidas', moneda: 'COP', codigoBarras: barras }, cantidad: 10, costoUnitario: 3000, precioVenta: 5000 }], pago: { metodo: 'efectivo' } }, D);
const prod = { s: compra.s, j: (await call('GET', '/productos', null, D)).j.find((p) => p.id === compra.j.productos?.[0]?.id) };
check(prod.s === 201 && prod.j?.codigoBarras === barras && prod.j.stock === 10, 'producto creado en su factura con código de barras', compra.j);
const dup = await call('POST', '/productos', { nombre: `Otro ${sfx}`, precio: 1000, moneda: 'COP', codigoBarras: barras, controlaStock: false }, D);
check(dup.s === 409 && /código de barras/.test(dup.j?.message), 'código repetido rechazado con mensaje claro', dup.j);
check((await call('POST', '/productos', { nombre: `Mal ${sfx}`, precio: 1, codigoBarras: 'ab cd$', controlaStock: false }, D)).s === 400, 'código con caracteres raros rechazado');
const sinCod = await call('POST', '/productos', { nombre: `Sin código ${sfx}`, precio: 2000, moneda: 'COP', controlaStock: false, codigoBarras: '' }, D);
check(sinCod.s === 201 && sinCod.j.codigoBarras === null, 'código vacío se guarda como "sin código"');
await call('POST', '/pos/turno/abrir', {}, C);
const cat = (await call('GET', '/pos/catalogo', null, C)).j;
check(cat.productos.find((p) => p.id === prod.j.id)?.codigoBarras === barras, 'el catálogo de caja trae el código (para la pistola)');

console.log('\n── Venta y devolución');
const venta = await call('POST', '/pos/ventas', { socioId: null, items: [{ tipo: 'producto', id: prod.j.id, cantidad: 3 }], pagos: [{ metodo: 'efectivo', moneda: 'COP', monto: 15000 }] }, C);
check(venta.s === 201, 'vende 3 Gatorade', venta.j);
const tk = (await call('GET', `/pos/devoluciones/ticket/${venta.j.numero}`, null, C)).j;
const item = tk.items[0];
check(item?.disponible === 3, 'el ticket muestra 3 para devolver', tk);
const base = { ventaId: tk.id, items: [{ ventaItemId: item.ventaItemId, cantidad: 2 }], metodo: 'efectivo', moneda: 'COP', motivo: 'Se equivocó de producto', reingresaStock: true };
const malo = await call('POST', '/pos/devoluciones', { ...base, pin: '0000' }, C);
check(malo.s === 403, 'código equivocado: no se devuelve nada', malo.j);
check((await call('POST', '/pos/devoluciones', { ...base, pin: '' }, C)).s === 400, 'sin código no se puede');
check((await call('POST', '/pos/devoluciones', { ...base, motivo: '', pin: pinSup }, C)).s === 400, 'sin motivo no se puede');
const dev = await call('POST', '/pos/devoluciones', { ...base, pin: pinSup }, C);
check(dev.s === 201 && dev.j.montoTexto.includes('10.000') && dev.j.autorizadoPor.startsWith('sup'), 'con el código del supervisor: devuelve COP 10.000', dev.j);
const p2 = (await call('GET', '/productos', null, D)).j.find((p) => p.id === prod.j.id);
check(p2.stock === 9, 'el inventario vuelve: 10 − 3 + 2 = 9', p2.stock);
const mas = await call('POST', '/pos/devoluciones', { ...base, pin: pinSup }, C);
check(mas.s === 400 && /solo se pueden devolver 1/.test(mas.j?.message), 'no deja devolver más de lo vendido', mas.j);
const merma = await call('POST', '/pos/devoluciones', { ...base, items: [{ ventaItemId: item.ventaItemId, cantidad: 1 }], motivo: 'Producto dañado', reingresaStock: false, pin: pinSup }, C);
check(merma.s === 201, 'devuelve la última unidad dañada (merma)', merma.j);
check((await call('GET', '/productos', null, D)).j.find((p) => p.id === prod.j.id).stock === 9, 'la dañada NO vuelve al inventario');

console.log('\n── El supervisor no se autoriza a sí mismo');
await call('POST', '/pos/turno/abrir', {}, A);
const v2 = await call('POST', '/pos/ventas', { socioId: null, items: [{ tipo: 'producto', id: prod.j.id, cantidad: 1 }], pagos: [{ metodo: 'efectivo', moneda: 'COP', monto: 5000 }] }, A);
const tk2 = (await call('GET', `/pos/devoluciones/ticket/${v2.j.numero}`, null, A)).j;
const self = await call('POST', '/pos/devoluciones', { ...base, ventaId: tk2.id, items: [{ ventaItemId: tk2.items[0].ventaItemId, cantidad: 1 }], pin: pinSup }, A);
check(self.s === 403 && /propia/.test(self.j?.message), 'admin de caja no autoriza su propia devolución', self.j);

console.log('\n── Caja y controles de la administración');
const t = (await call('GET', '/caja/turnos?estado=abierto', null, D)).j.find((x) => x.cajeroId === cajera.id);
const ef = t.metodos.find((m) => m.metodo === 'efectivo' && m.moneda === 'COP');
check(ef && ef.egresos === 15000 && ef.esperado === ef.fondo + 15000 - 15000, 'el cierre descuenta lo devuelto (cobró 15.000, devolvió 15.000)', ef);
const det = (await call('GET', `/caja/turnos/${t.id}`, null, D)).j;
const movDev = det.movimientos.find((m) => m.categoria === 'Devolución');
check(!!movDev, 'la devolución aparece como egreso "Devolución" en el turno');
const anM = await call('POST', `/caja/movimientos/${movDev.id}/anular`, { motivo: 'prueba' }, D);
check(anM.s === 409, 'ese egreso no se puede anular', anM.j);
const anV = await call('POST', `/caja/ventas/${tk.id}/anular`, { motivo: 'prueba' }, D);
check(anV.s === 409, 'el ticket con devolución no se anula completo', anV.j);
const hist = (await call('GET', '/caja/devoluciones', null, D)).j;
check(hist.filter((h) => h.ticket === venta.j.numero).length === 2 && hist[0].autorizo.startsWith('sup'), 'historial: quién pidió, quién autorizó, motivo', hist[0]);
check((await call('GET', '/caja/devoluciones', null, C)).s === 403, 'la cajera no ve el historial de devoluciones');

console.log('\n── Caja ciega total');
const vistaC = (await call('GET', '/pos/turno', null, C)).j;
check(Object.keys(vistaC).sort().join() === 'abiertoEn,id,numero', 'la cajera no ve ventas, conteos ni gastos de su turno', vistaC);
let bloqueo = null;
for (let i = 0; i < 10 && bloqueo === null; i++) {
  const r = await call('GET', `/pos/devoluciones/ticket/${venta.j.numero}`, null, C);
  if (r.s === 403) bloqueo = i;
}
check(bloqueo !== null && bloqueo <= 8, 'no puede revisar tickets uno tras otro para ver lo vendido', bloqueo);
check((await call('GET', `/pos/devoluciones/ticket/${venta.j.numero}`, null, A)).s === 200, 'el supervisor sí consulta sin límite');

console.log(`\n${ok} ok · ${fail} fallos\n`);
process.exit(fail ? 1 : 0);
