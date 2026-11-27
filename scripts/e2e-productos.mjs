// Productos e inventario: crear con cantidad inicial, Entrada (como compra), Salida, Ajustar y permisos.
// Corre contra PRUEBAS (puerto 5051, BD merkgusto_test) → node scripts/e2e-productos.mjs
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

const sfx = Date.now().toString(36).slice(-5);
const D = (await call('POST', '/auth/login', { usuario: 'dueno', password: 'Merkgusto2026*' })).j.token;
await call('POST', '/usuarios', { nombre: `Caja inv ${sfx}`, usuario: `iv${sfx}`, rol: 'cajero', password: '1234' }, D);
await call('POST', '/usuarios', { nombre: `Admin inv ${sfx}`, usuario: `ia${sfx}`, rol: 'admin_caja', password: '1234' }, D);
const C = (await call('POST', '/auth/login', { usuario: `iv${sfx}`, password: '1234' })).j.token;
const A = (await call('POST', '/auth/login', { usuario: `ia${sfx}`, password: '1234' })).j.token;
const turno = (await call('POST', '/pos/turno/abrir', {}, C)).j;
const producto = async (id) => (await call('GET', '/productos', null, A)).j.find((p) => p.id === id);
const kardex = async (id) => (await call('GET', `/inventario/movimientos?productoId=${id}`, null, A)).j;
const vender = (id, cantidad) => call('POST', '/pos/ventas', { socioId: null, items: [{ tipo: 'producto', id, cantidad }], pagos: [{ metodo: 'efectivo', moneda: 'COP', monto: 3000 * cantidad }] }, C);

console.log('\n── Crear producto con lo que hay');
const agua = { nombre: `Agua E2E ${sfx}`, categoria: 'Bebidas', precio: 3000, moneda: 'COP', controlaStock: true, stock: 24, costo: 1500, stockMinimo: 5 };
check((await call('POST', '/productos', agua, C)).s === 403, 'la recepción no crea productos');
check((await call('POST', '/productos', { ...agua, costo: 0 }, A)).s === 400, 'con unidades iniciales pide el costo');
check((await call('POST', '/productos', { ...agua, precio: 1000 }, A)).s === 400, 'no deja vender por debajo del costo');
const cr = await call('POST', '/productos', agua, A);
check(cr.s === 201 && cr.j.stock === 24 && Number(cr.j.costo) === 1500, 'el administrador de caja crea el agua con 24 unidades', cr.j);
const id = cr.j.id;
const k0 = await kardex(id);
check(k0.length === 1 && k0[0].cantidad === 24 && /Inventario inicial/.test(k0[0].referencia), 'queda "Inventario inicial" en el historial', k0);
check((await call('POST', '/productos', { ...agua, nombre: `  agua e2e   ${sfx} ` }, A)).s === 409, 'no se duplica el mismo producto');
check((await vender(id, 2)).s < 300 && (await producto(id)).stock === 22, 'se vende de una en caja');

console.log('\n── Producto en 0 (el caso del agua)');
const cero = (await call('POST', '/productos', { ...agua, nombre: `Agua cero ${sfx}`, stock: 0, costo: 0 }, A)).j;
check(cero?.stock === 0, 'se puede crear en 0 (aún no llega)', cero);
check((await vender(cero.id, 1)).s === 400, 'en 0 la caja no lo vende (bloquea)');
check((await call('POST', `/productos/${cero.id}/ajuste`, { contado: 6, motivo: 'sí había en la nevera' }, C)).s === 403, 'la recepción no ajusta');
const aj = await call('POST', `/productos/${cero.id}/ajuste`, { contado: 6, motivo: 'sí había en la nevera' }, A);
check(aj.s === 200 && aj.j.stock === 6 && aj.j.ajuste.diferencia === 6, 'Ajustar: hay 6 en el estante', aj.j);
check((await vender(cero.id, 1)).s < 300, 'ahora sí se vende');
check((await call('POST', `/productos/${cero.id}/ajuste`, { contado: 5, motivo: 'igual' }, A)).s === 400, 'si ya cuadra, avisa que no hay nada que ajustar');

console.log('\n── Entrada (llegó mercancía)');
const antes = await producto(id);
check((await call('POST', `/productos/${id}/entrada`, { cantidad: 12, costoUnitario: 2000 }, C)).s === 403, 'la recepción no da entrada');
check((await call('POST', `/productos/${id}/entrada`, { cantidad: 12 }, A)).s === 400, 'pide el costo');
const en = await call('POST', `/productos/${id}/entrada`, { cantidad: 12, costoUnitario: 2000, moneda: 'COP', pago: { metodo: 'efectivo' }, motivo: 'mercado' }, A);
check(en.s === 200 && en.j.stock === antes.stock + 12, 'Entrada de 12: se suman', en.j);
const prom = (antes.stock * 1500 + 12 * 2000) / (antes.stock + 12);
check(Math.abs(Number(en.j.costo) - prom) < 0.02, 'el costo queda promediado', [en.j.costo, prom]);
const compras = (await call('GET', '/inventario/compras', null, A)).j;
const c1 = compras.find((c) => (c.items ?? []).some((x) => x.includes(agua.nombre)) && c.estado === 'pagada');
check(!!c1 && Number(c1.total) === 24000, 'queda como compra pagada por $24.000', compras.slice(0, 2));
const k1 = await kardex(id);
check(k1[0].tipo === 'compra' && k1[0].cantidad === 12, 'en el historial aparece la entrada');

const en2 = await call('POST', `/productos/${id}/entrada`, { cantidad: 6, costoUnitario: 2000, moneda: 'COP', pago: { metodo: 'efectivo', turnoId: turno.id } }, D);
check(en2.s === 200, 'Entrada pagada con el efectivo de la caja de la recepción', en2.j);
const tv = (await call('GET', `/caja/turnos/${turno.id}`, null, D)).j;
const eg = (tv.movimientos ?? []).find((m) => m.tipo === 'egreso' && /Compra #/.test(m.concepto) && Number(m.monto) === 12000);
check(!!eg, 'el pago sale de ese turno (lo descuenta su cierre)', tv.movimientos);
check((await call('POST', `/productos/${id}/entrada`, { cantidad: 1, costoUnitario: 2000, pago: { metodo: 'efectivo', turnoId: '00000000-0000-4000-8000-000000000000' } }, D)).s === 409, 'si la caja no está abierta, no deja');

const en3 = await call('POST', `/productos/${id}/entrada`, { cantidad: 10, costoUnitario: 2100, moneda: 'COP', pago: null }, A);
check(en3.s === 200, 'Entrada a crédito');
const pend = (await call('GET', '/inventario/compras?pendientes=1', null, A)).j;
check(pend.some((c) => (c.items ?? []).some((x) => x.includes(agua.nombre)) && Number(c.saldo) === 21000), 'queda por pagar al proveedor', pend.slice(0, 2));

console.log('\n── Salida y edición');
const st = (await producto(id)).stock;
check((await call('POST', `/productos/${id}/entrada`, { cantidad: -2 }, A)).s === 400, 'la salida pide motivo');
check((await call('POST', `/productos/${id}/entrada`, { cantidad: -(st + 1), motivo: 'x rotas' }, A)).s === 400, 'no saca más de lo que hay');
const sa = await call('POST', `/productos/${id}/entrada`, { cantidad: -2, motivo: 'se rompieron' }, A);
check(sa.s === 200 && sa.j.stock === st - 2, 'Salida de 2 por rotura');
check((await call('PUT', `/productos/${id}`, { stock: 999 }, A)).s === 400, 'editar no cambia las unidades a escondidas');
check((await call('PUT', `/productos/${id}`, { precio: 3500 }, A)).s === 200, 'el administrador de caja edita el precio');
check((await call('PUT', `/productos/${id}`, { precio: 3600 }, C)).s === 403, 'la recepción no edita');
const serv = (await call('POST', '/productos', { nombre: `Toalla ${sfx}`, categoria: 'Servicios', precio: 2000, moneda: 'COP', controlaStock: false }, A)).j;
check((await call('POST', `/productos/${serv.id}/entrada`, { cantidad: 3, costoUnitario: 1 }, A)).s === 400, 'un servicio no lleva entradas');

const kf = await kardex(id);
check(kf.every((k) => k.usuario), 'cada movimiento dice quién lo hizo');
check(kf[0].stockResultante === (await producto(id)).stock, 'el historial cuadra con lo que hay');

console.log(`\n${ok} OK · ${fail} fallas`);
process.exit(fail ? 1 : 0);
