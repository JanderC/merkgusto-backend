// Entrenamiento personalizado: tarifa del entrenador, cobro en caja, quién pagó, comisión en su pago y su app.
// Corre contra la instancia de PRUEBAS (puerto 5051, BD merkgusto_test) → node scripts/e2e-personalizados.mjs
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
const sumarMeses = (f, n) => {
  const [y, m, dd] = f.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  const ny = Math.floor(t / 12);
  const nm = t % 12;
  const ult = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(dd, ult))}`;
};
const num = (t) => Number(String(t).replace(/[^\d,-]/g, '').replace(/\./g, '').replace(',', '.'));

const sfx = Date.now().toString(36).slice(-5);
const D = (await call('POST', '/auth/login', { usuario: 'dueno', password: 'Merkgusto2026*' })).j.token;
await call('POST', '/usuarios', { nombre: `Caja pz ${sfx}`, usuario: `pz${sfx}`, rol: 'cajero', password: '1234' }, D);
const C = (await call('POST', '/auth/login', { usuario: `pz${sfx}`, password: '1234' })).j.token;
await call('POST', '/pos/turno/abrir', {}, C);
const ced = String(Date.now()).slice(-8);
const nuevoSocio = async (n, i) => (await call('POST', '/socios', { nombre: n, apellido: `Pz ${sfx}`, telefono: '04141112233', cedula: `V${Number(ced) + i}` }, C)).j;

console.log('\n── Tarifa del entrenador');
const ent = (await call('POST', '/entrenadores', { nombre: `Personal ${sfx}`, pin: '4321', pagoTipo: 'ninguno', pagoMoneda: 'COP', personalizadoPrecio: 40, personalizadoSemanal: 12, personalizadoMoneda: 'USD', personalizadoComision: 70 }, D)).j;
const sinTarifa = (await call('POST', '/entrenadores', { nombre: `Sin tarifa ${sfx}`, pin: '4322' }, D)).j;
check(!!ent?.id && !!sinTarifa?.id, 'dueño crea entrenador con tarifa de personalizado ($40 mes, $12 semana, 70% para él)', ent);
check((await call('PUT', `/entrenadores/${ent.id}`, { personalizadoPrecio: 1 }, C)).s === 403, 'la cajera no puede cambiar la tarifa');
const lista = (await call('GET', '/entrenadores', null, D)).j.find((e) => e.id === ent.id);
check(Number(lista.personalizadoPrecio) === 40 && Number(lista.personalizadoComision) === 70, 'la tarifa queda guardada', lista);
const cat = (await call('GET', '/pos/catalogo', null, C)).j;
const ec = cat.entrenadores?.find((e) => e.id === ent.id);
check(ec?.mensual === 40 && ec.semanal === 12 && ec.moneda === 'USD', 'la caja ve al entrenador con su tarifa', ec);
check(!cat.entrenadores.some((e) => e.id === sinTarifa.id), 'el entrenador sin tarifa no aparece para cobrar');
const t = cat.tasas;

console.log('\n── Cobro en caja');
const ana = await nuevoSocio('Ana', 1);
const beto = await nuevoSocio('Beto', 2);
const pz = (socioId, extra = {}) => ({ tipo: 'personalizado', entrenadorId: ent.id, periodo: 'meses', cantidad: 1, ...extra });
check((await call('POST', '/pos/ventas', { socioId: null, items: [pz()], pagos: [{ metodo: 'efectivo', moneda: 'USD', monto: 40 }] }, C)).s === 400, 'sin cliente no se cobra personalizado');
const st = await call('POST', '/pos/ventas', { socioId: ana.id, items: [{ ...pz(), entrenadorId: sinTarifa.id }], pagos: [{ metodo: 'efectivo', moneda: 'USD', monto: 40 }] }, C);
check(st.s === 400 && /tarifa/.test(st.j?.message), 'entrenador sin tarifa: no se puede cobrar', st.j);
const trampa = await call('POST', '/pos/ventas', { socioId: ana.id, items: [{ ...pz(), precio: 1 }], pagos: [{ metodo: 'efectivo', moneda: 'USD', monto: 1 }] }, C);
check(trampa.s === 400 && /Faltan/.test(trampa.j?.message), 'el precio sale de la tarifa, no del navegador ($1 no alcanza)', trampa.j);
check((await call('POST', '/pos/ventas', { socioId: ana.id, items: [pz(), pz()], pagos: [{ metodo: 'efectivo', moneda: 'USD', monto: 80 }] }, C)).s === 400, 'no se repite el mismo personalizado en un ticket');
const v1 = await call('POST', '/pos/ventas', { socioId: ana.id, items: [pz()], pagos: [{ metodo: 'efectivo', moneda: 'USD', monto: 40 }] }, C);
const fin1 = sumarMeses(hoy, 1);
check(v1.s === 201 && v1.j.personalizados?.[0]?.fechaInicio === hoy && v1.j.personalizados[0].fechaFin === fin1, `Ana paga $40: del ${hoy} al ${fin1}`, v1.j);
check(v1.j.items[0].descripcion.includes(`Personal ${sfx}`) && v1.j.items[0].descripcion.includes('1 mes'), 'el ticket dice con quién y cuánto tiempo', v1.j.items);
const fa = (await call('GET', `/socios/${ana.id}`, null, C)).j;
check(fa.entrenadorId === ent.id, 'Ana queda asignada al entrenador (lo ve en su app)');
check(fa.personalizados?.[0]?.estado === 'al_dia' && fa.personalizados[0].hasta === fin1, 'la ficha de Ana muestra su personalizado al día', fa.personalizados);
const v2 = await call('POST', '/pos/ventas', { socioId: ana.id, items: [pz()], pagos: [{ metodo: 'efectivo', moneda: 'USD', monto: 40 }] }, C);
const ini2 = sumarDias(fin1, 1);
const fin2 = sumarMeses(fin1, 1);
check(v2.s === 201 && v2.j.personalizados[0].fechaInicio === ini2 && v2.j.personalizados[0].fechaFin === fin2, `renueva: sigue desde su vencimiento (${ini2} → ${fin2}), no pierde días`, v2.j.personalizados);
// Beto: 2 semanas ($24), paga solo $10 → queda debiendo
const v3 = await call('POST', '/pos/ventas', { socioId: beto.id, items: [pz(beto.id, { periodo: 'semanas', cantidad: 2 })], pagos: [{ metodo: 'efectivo', moneda: 'USD', monto: 10 }], pagoParcial: true }, C);
check(v3.s === 201 && v3.j.deuda && v3.j.personalizados[0].fechaFin === sumarDias(hoy, 14), 'Beto: 2 semanas, paga una parte y queda debiendo', v3.j);
// Carla: asignada al entrenador pero nunca ha pagado personalizado
const carla = await nuevoSocio('Carla', 3);
check((await call('PUT', `/socios/${carla.id}/entrenador`, { entrenadorId: ent.id }, C)).s === 200, 'recepción le asigna entrenador a Carla');

console.log('\n── Quién pagó y quién no');
const tc = (await call('GET', `/personalizados?entrenadorId=${ent.id}`, null, C)).j;
const fila = (id) => tc.filas.find((f) => f.socioId === id);
check(fila(ana.id)?.estado === 'al_dia' && fila(ana.id).hasta === fin2 && fila(ana.id).pagos === 2, 'Ana: al día hasta el vencimiento de su renovación', fila(ana.id));
check(fila(beto.id)?.estado === 'debe' && /Debe/.test(fila(beto.id).estadoTexto), 'Beto: aparece debiendo', fila(beto.id));
const carlaF = fila(carla.id);
check(!carlaF || carlaF.estado === 'sin_pago', 'Carla: asignada, sin personalizado pagado', carlaF);
const re = tc.entrenadores.find((e) => e.id === ent.id);
check(re?.alDia === 1 && re.deben === 1 && re.tarifaTexto?.includes('40'), 'resumen del entrenador: 1 al día, 1 debe', re);
check(tc.totales === null && !('porPagarTexto' in re) && !('cobradoMesTexto' in re), 'la cajera no ve totales de dinero (caja ciega)', re);
const td = (await call('GET', `/personalizados?entrenadorId=${ent.id}`, null, D)).j;
const rd = td.entrenadores.find((e) => e.id === ent.id);
const cobradoRef = rd.cobradoMes;
check(td.totales && cobradoRef > 0, 'el dueño ve lo cobrado en el mes', rd);

console.log('\n── Lo que le toca al entrenador');
const nomina = async () => (await call('GET', `/entrenadores/nomina?desde=${sumarDias(hoy, -30)}&hasta=${hoy}`, null, D)).j.find((n) => n.id === ent.id);
const n1 = await nomina();
const esperado = Math.round(2 * 40 * 0.7 * t.usdCop);
check(n1?.personalizados.cantidad === 2 && n1.personalizados.retenidos === 1, 'entran los 2 de Ana; el de Beto se retiene porque debe', n1?.personalizados);
check(Math.abs(n1.personalizados.monto - esperado) <= 1 && n1.total === n1.personalizados.monto, `70% de $80 = $56 → COP ${esperado} (en la moneda de su pago)`, { monto: n1.personalizados.monto, esperado });
const pago = await call('POST', '/entrenadores/pagos', { entrenadorId: ent.id, desde: sumarDias(hoy, -30), hasta: hoy, metodo: 'efectivo' }, D);
check(pago.s === 201 && Math.abs(pago.j.total - esperado) <= 1, 'se le paga (aunque no tenga sueldo fijo, solo personalizados)', pago.j);
const hp = (await call('GET', `/entrenadores/pagos?entrenadorId=${ent.id}`, null, D)).j;
check(hp[0]?.personalizadosTexto && Math.abs(num(hp[0].personalizadosTexto) - esperado) <= 1, 'el historial muestra la parte de personalizados', hp[0]);
check((await nomina()).personalizados.cantidad === 0, 'ya pagados: no vuelven a aparecer (nadie cobra dos veces)');
const idV1 = (await call('GET', `/caja/ventas?desde=${hoy}&hasta=${hoy}&buscar=${v1.j.numero}`, null, D)).j.find((v) => v.numero === v1.j.numero)?.id;
const an1 = await call('POST', `/caja/ventas/${idV1}/anular`, { motivo: 'Cliente se arrepintió' }, D);
check(an1.s === 409 && /ya se le pagó/.test(an1.j?.message), 'no se anula un ticket cuyo personalizado ya se le pagó al entrenador', { an1: an1.j, idV1 });
check((await call('POST', `/entrenadores/pagos/${pago.j.id}/anular`, { motivo: 'monto equivocado' }, D)).s === 200, 'se anula el pago al entrenador');
check((await nomina()).personalizados.cantidad === 2, 'sus personalizados vuelven a quedar por pagar');
const an2 = await call('POST', `/caja/ventas/${idV1}/anular`, { motivo: 'Cliente se arrepintió' }, D);
check(an2.s === 200, 'ahora sí se anula el primer ticket de Ana', an2.j);
const n3 = await nomina();
check(n3.personalizados.cantidad === 1 && Math.abs(n3.personalizados.monto - esperado / 2) <= 1, 'el anulado ya no cuenta para el entrenador', n3.personalizados);
// Beto termina de pagar → su comisión se libera
const deudaB = (await call('GET', `/socios/${beto.id}`, null, C)).j.deudas[0];
const ab = await call('POST', '/pos/ventas', { socioId: beto.id, items: [{ tipo: 'abono', deudaId: deudaB.id, monto: Number(deudaB.saldo) }], pagos: [{ metodo: 'efectivo', moneda: deudaB.moneda, monto: Number(deudaB.saldo) }] }, C);
check(ab.s === 201, 'Beto abona lo que debía', ab.j);
const n4 = await nomina();
check(n4.personalizados.cantidad === 2 && n4.personalizados.retenidos === 0, 'al pagar completo, el de Beto entra al pago del entrenador', n4.personalizados);
check((await call('GET', `/personalizados?entrenadorId=${ent.id}`, null, C)).j.filas.find((f) => f.socioId === beto.id)?.estado === 'al_dia', 'Beto pasa a "al día"');

console.log('\n── App del entrenador');
await call('PUT', `/entrenadores/${ent.id}/acceso`, { usuario: `pz${sfx}e`, password: 'clave123' }, D);
const E = (await call('POST', '/auth/login', { usuario: `pz${sfx}e`, password: 'clave123' })).j.token;
const mis = (await call('GET', '/coach/clientes', null, E)).j;
const anaC = mis.find((c) => c.id === ana.id);
check(anaC?.personalizado?.estado === 'por_empezar' && anaC.personalizado.desde === ini2, 'en su app ve a Ana: anulado su 1er mes, le queda pagado desde su renovación', anaC?.personalizado);
check(mis.find((c) => c.id === carla.id)?.personalizado === null, 'Carla aparece sin personalizado');
const mp = (await call('GET', '/coach/personalizados', null, E)).j;
check(mp.filas.length >= 2 && mp.tarifa.mensual?.includes('40') && mp.tarifa.comision === 70, 've su lista de personalizados y su tarifa', mp.tarifa);
check(mp.porCobrar.cantidad === 2 && num(mp.porCobrar.texto) > 0, `ve lo que le toca en su próximo pago (${mp.porCobrar.texto})`, mp.porCobrar);
const ini = (await call('GET', '/coach/inicio', null, E)).j;
check(ini.personalizados?.alDia === 2 && ini.personalizados.sinPago >= 1, 'el inicio de su app resume quién está al día', ini.personalizados);

console.log(`\n${ok} OK · ${fail} fallos`);
process.exit(fail ? 1 : 0);
