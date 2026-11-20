// App de entrenadores y app de clientes: accesos, aislamiento de sesiones, clientes asignados,
// medidas, rutinas, notas, plantillas, clases (cupo, reservas), clave privada y enlace personal.
// Corre contra la instancia de PRUEBAS (puerto 5051, BD merkgusto_test) → node scripts/e2e-apps.mjs
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
const num = String(Date.now()).slice(-8);
const D = (await call('POST', '/auth/login', { usuario: 'dueno', password: 'Merkgusto2026*' })).j.token;
const cajera = (await call('POST', '/usuarios', { nombre: `Caja ${sfx}`, usuario: `cj${sfx}`, rol: 'cajero', password: '1234' }, D)).j;
const C = (await call('POST', '/auth/login', { usuario: `cj${sfx}`, password: '1234' })).j.token;
check(!!cajera?.id && !!C, 'cajera de prueba');

console.log('\n── Acceso del entrenador');
const ent = (await call('POST', '/entrenadores', { nombre: `Coach`, apellido: sfx, pin: '4321', especialidad: 'Funcional' }, D)).j;
const ent2 = (await call('POST', '/entrenadores', { nombre: `Otro`, apellido: sfx, pin: '4322' }, D)).j;
check((await call('PUT', `/entrenadores/${ent.id}/acceso`, { usuario: `coach${sfx}` }, D)).s === 400, 'sin contraseña no se da acceso');
check((await call('PUT', `/entrenadores/${ent.id}/acceso`, { usuario: `cj${sfx}`, password: 'clave123' }, D)).s === 400, 'no puede usar el usuario de alguien del equipo');
check((await call('PUT', `/entrenadores/${ent.id}/acceso`, { usuario: `coach${sfx}`, password: 'clave123' }, D)).s === 200, 'dueño le da usuario y contraseña');
check((await call('PUT', `/entrenadores/${ent.id}/acceso`, { usuario: `coach${sfx}`, password: 'clave123' }, C)).s === 403, 'la cajera no da accesos');
await call('PUT', `/entrenadores/${ent2.id}/acceso`, { usuario: `otro${sfx}`, password: 'clave123' }, D);
check((await call('POST', '/usuarios', { nombre: 'X', usuario: `coach${sfx}`, rol: 'cajero', password: '1234' }, D)).s === 400, 'un usuario del equipo no puede repetir el de un entrenador');
const lg = await call('POST', '/auth/login', { usuario: `COACH${sfx}`, password: 'clave123' });
check(lg.s === 200 && lg.j.tipo === 'entrenador' && lg.j.user.rol === 'entrenador', 'el entrenador entra por la misma pantalla', lg.j);
const E = lg.j.token;
const E2 = (await call('POST', '/auth/login', { usuario: `otro${sfx}`, password: 'clave123' })).j.token;
check((await call('POST', '/auth/login', { usuario: `coach${sfx}`, password: 'mala' })).s === 401, 'contraseña incorrecta rechazada');
check((await call('GET', '/socios', null, E)).s === 401, 'el token del entrenador no abre rutas del equipo');
check((await call('GET', '/caja/turnos', null, E)).s === 401, 'ni la caja');
check((await call('GET', '/coach/yo', null, D)).s === 401, 'el token del dueño no abre la app del entrenador');
const yo = await call('GET', '/coach/yo', null, E);
check(yo.s === 200 && yo.j.usuario === `coach${sfx}`, 'perfil del entrenador');
const lista = (await call('GET', '/entrenadores', null, D)).j.find((x) => x.id === ent.id);
check(lista?.tieneAcceso === true && lista.usuario === `coach${sfx}`, 'la lista del dueño muestra quién tiene acceso', lista);

console.log('\n── Clientes del entrenador');
const s1 = (await call('POST', '/socios', { nombre: 'Laura', apellido: `App ${sfx}`, telefono: '04141112233', cedula: `V${num}` }, C)).j;
const s2 = (await call('POST', '/socios', { nombre: 'Pedro', apellido: `App ${sfx}`, telefono: '04141112234', cedula: `V${Number(num) + 1}` }, C)).j;
check(!!s1?.id && !!s2?.id, 'dos clientes de prueba', s1);
check((await call('GET', `/coach/clientes/${s1.id}`, null, E)).s === 403, 'no ve clientes que no son suyos');
const bus = await call('GET', `/coach/buscar?q=App ${sfx}`, null, E);
check(bus.s === 200 && bus.j.length === 2 && bus.j.every((x) => !x.mio), 'busca en el gimnasio para asignarse', bus.j);
check((await call('POST', `/coach/clientes/${s1.id}/asignar`, {}, E)).s === 200, 'se asigna a Laura');
check((await call('POST', `/coach/clientes/${s1.id}/asignar`, {}, E2)).s === 409, 'otro entrenador no se la puede quitar');
const mis = await call('GET', '/coach/clientes', null, E);
const laura = mis.j.find((x) => x.id === s1.id);
check(laura && laura.alertas.some((a) => a.tipo === 'vencido') && laura.alertas.some((a) => a.tipo === 'sin_rutina'), 'su lista con alertas (sin plan, sin rutina)', laura);
check((await call('POST', `/coach/clientes/${s1.id}/mediciones`, { peso: 70, grasa: 25, fecha: '2026-01-10' }, E)).s === 201, 'le toma medidas');
check((await call('POST', `/coach/clientes/${s1.id}/mediciones`, {}, E)).s === 400, 'medida vacía rechazada');
const rut = await call('POST', `/coach/clientes/${s1.id}/rutinas`, { titulo: 'Fuerza 3 días', objetivo: 'Ganar fuerza', dias: [{ nombre: 'Día A', ejercicios: [{ nombre: 'Sentadilla', series: '5', reps: '5', nota: '' }] }] }, E);
check(rut.s === 201, 'le asigna una rutina');
check((await call('POST', `/coach/clientes/${s1.id}/notas`, { texto: 'Molestia en rodilla izquierda' }, E)).s === 201, 'nota privada');
const pl = await call('POST', '/coach/plantillas', { titulo: 'Full body', dias: [{ nombre: 'Día 1', ejercicios: [{ nombre: 'Burpees', series: '3', reps: '15', nota: '' }] }] }, E);
check(pl.s === 201 && (await call('GET', '/coach/plantillas', null, E)).j.length === 1, 'plantilla de rutina');
check((await call('GET', '/coach/plantillas', null, E2)).j.length === 0, 'las plantillas son de cada entrenador');
const fic = await call('GET', `/coach/clientes/${s1.id}`, null, E);
check(fic.s === 200 && fic.j.mio && fic.j.mediciones.length === 1 && fic.j.rutinas[0].entrenadorId === ent.id && fic.j.notas.length === 1, 'ficha completa del cliente', fic.j);
check((await call('GET', `/coach/clientes/${s1.id}`, null, E2)).s === 403, 'el otro entrenador no ve la ficha');
const prog = await call('GET', `/socios/${s1.id}/progreso`, null, C);
check(prog.j.entrenadorId === ent.id && prog.j.entrenadores.length >= 2 && prog.j.app.clave === false, 'recepción ve el entrenador asignado', prog.j.app);

console.log('\n── Clases');
const manana = new Date(Date.now() + 86400000).toLocaleDateString('en-CA');
const cl = (await call('POST', '/clases', { nombre: `Funcional ${sfx}`, entrenadorId: ent2.id, fecha: manana, hora: '07:00', cupo: 2 }, C)).j;
check((await call('POST', `/coach/clases/${cl.id}/inscribir`, { socioIds: [s2.id] }, E)).s === 403, 'en clases de otros solo inscribe a sus clientes');
check((await call('POST', `/coach/clases/${cl.id}/inscribir`, { socioIds: [s1.id] }, E)).s === 201, 'inscribe a Laura en la clase de otro entrenador');
const mia = await call('POST', '/coach/clases', { nombre: `Mi clase ${sfx}`, fecha: manana, hora: '18:00', cupo: 1, repetirSemanas: 1 }, E);
check(mia.s === 201 && mia.j.creadas === 2, 'programa su propia clase (2 semanas)', mia.j);
check((await call('POST', `/coach/clases/${mia.j.id}/inscribir`, { socioIds: [s2.id] }, E)).s === 201, 'en su clase inscribe a cualquiera');
const lleno = await call('POST', `/coach/clases/${mia.j.id}/inscribir`, { socioIds: [s1.id] }, E);
check(lleno.s === 409 && /Cupo lleno/.test(lleno.j.message), 'respeta el cupo', lleno.j);
const det = await call('GET', `/coach/clases/${mia.j.id}`, null, E);
check(det.j.mia && det.j.inscritos.length === 1 && det.j.inscritos[0].puedoQuitar, 've la lista de su clase');
const detOtro = await call('GET', `/coach/clases/${cl.id}`, null, E);
check(!detOtro.j.mia && detOtro.j.inscritos.every((i) => i.mio), 'en la clase de otro solo ve a sus clientes');
check((await call('POST', `/coach/clases/${mia.j.id}/pasar/${s2.id}`, {}, E)).s === 400, 'la entrada se da el día de la clase');
check((await call('DELETE', `/coach/clases/${mia.j.id}/inscritos/${s2.id}`, null, E)).s === 200, 'quita a un inscrito de su clase');
const ini = await call('GET', '/coach/inicio', null, E);
check(ini.s === 200 && ini.j.clientes.total === 1 && ini.j.semana.some((c) => c.id === mia.j.id), 'inicio: clases de la semana y resumen', ini.j.clientes);

console.log('\n── App del cliente: entrar con cédula');
const e1 = await call('POST', '/cliente/entrar', { cedula: `v-${num.slice(0, 2)}.${num.slice(2, 5)}.${num.slice(5)}` });
check(e1.s === 200 && e1.j.nombre === 'Laura' && !e1.j.privado, 'entra con su cédula escrita con puntos y guion', e1.j);
const T1 = e1.j.token;
check((await call('POST', '/cliente/entrar', { cedula: num })).s === 200, 'también solo con los números');
check((await call('POST', '/cliente/entrar', { cedula: '99999999999' })).s === 404, 'cédula que no existe');
check((await call('GET', '/socios', null, T1)).s === 401, 'el token del cliente no abre rutas del equipo');
check((await call('GET', '/coach/yo', null, T1)).s === 401, 'ni la app del entrenador');
check((await call('GET', '/cliente/yo', null, E)).s === 401, 'el entrenador no entra a la app del cliente con su token');
const yo1 = await call('GET', '/cliente/yo', null, T1);
check(yo1.s === 200 && yo1.j.entrenador?.nombre?.startsWith('Coach') && yo1.j.rutina?.titulo === 'Fuerza 3 días' && yo1.j.via === 'cedula', 've su entrenador, su rutina y su progreso', yo1.j.entrenador);
check(!yo1.j.socio.cedula.includes(num.slice(0, 4)), 'la cédula se muestra enmascarada', yo1.j.socio.cedula);
check((await call('POST', '/cliente/mediciones', { peso: 68.5 }, T1)).s === 201, 'anota su peso');
const meds = (await call('GET', '/cliente/yo', null, T1)).j.mediciones;
const delEnt = await call('DELETE', `/cliente/mediciones/${meds.find((m) => m.autor === 'entrenador').id}`, null, T1);
check(delEnt.s === 404, 'no borra las medidas del entrenador');
check((await call('DELETE', `/cliente/mediciones/${meds.find((m) => m.autor === 'cliente').id}`, null, T1)).s === 200, 'sí borra las suyas');
const rid = yo1.j.rutina.id;
check((await call('PUT', `/cliente/rutinas/${rid}`, { titulo: 'Hackeada' }, T1)).s === 404, 'no edita la rutina del entrenador');
check((await call('POST', '/cliente/entrenos', { dia: 'Día A', rutinaId: rid }, T1)).s === 201, 'marca el día A como hecho');
await call('POST', '/cliente/entrenos', { dia: 'Día A', rutinaId: rid }, T1);
const yo2 = (await call('GET', '/cliente/yo', null, T1)).j;
check(yo2.entrenos.hoy.length === 1 && yo2.entrenos.racha >= 1, 'no se duplica y cuenta la racha', yo2.entrenos);
const propia = await call('POST', '/cliente/rutinas', { titulo: 'Mi cardio', dias: [{ nombre: 'Lunes', ejercicios: [{ nombre: 'Trotar', series: '1', reps: '30 min', nota: '' }] }] }, T1);
check(propia.s === 201 && (await call('GET', '/cliente/yo', null, T1)).j.rutina.titulo === 'Mi cardio', 'crea su propia rutina');
check((await call('POST', `/cliente/rutinas/${rid}/activar`, {}, T1)).s === 200 && (await call('GET', '/cliente/yo', null, T1)).j.rutina.id === rid, 'vuelve a la rutina del entrenador');
const fic2 = (await call('GET', `/coach/clientes/${s1.id}`, null, E)).j;
check(fic2.entrenos.hoy.includes('Día A') && fic2.app.ultimoAcceso, 'el entrenador ve que entrenó y que usa la app');

console.log('\n── Clases desde la app del cliente');
const cls = await call('GET', '/cliente/clases', null, T1);
const enLaOtra = cls.j.find((c) => c.id === cl.id);
check(cls.s === 200 && enLaOtra?.inscrito && !enLaOtra.reservadoPorMi, 've la semana y en cuáles está', enLaOtra);
check((await call('DELETE', `/cliente/clases/${cl.id}/reservar`, null, T1)).s === 400, 'no se quita de una inscripción del entrenador');
const sinPlan = await call('POST', `/cliente/clases/${mia.j.id}/reservar`, {}, T1);
check(sinPlan.s === 409 && /plan vigente/.test(sinPlan.j.message), 'sin plan vigente no reserva', sinPlan.j);
// Le vendemos una mensualidad para reservar
const planes = (await call('GET', '/planes', null, C)).j.filter((p) => p.activo && !p.eliminadoEn);
const plan = planes.find((p) => p.tipoDuracion === 'meses') ?? planes[0];
await call('POST', '/pos/turno/abrir', {}, C);
const venta = await call('POST', '/pos/ventas', { socioId: s1.id, items: [{ tipo: 'membresia', id: plan.id }], pagos: [{ metodo: 'efectivo', moneda: plan.moneda, monto: Number(plan.precio) }] }, C);
check(venta.s === 201 || venta.s === 200, 'se le vende un plan', venta.j);
const otra = (await call('POST', '/clases', { nombre: `Spinning ${sfx}`, fecha: manana, hora: '09:00', cupo: 1 }, C)).j;
check((await call('POST', `/cliente/clases/${otra.id}/reservar`, {}, T1)).s === 201, 'reserva su cupo');
check((await call('POST', `/cliente/clases/${otra.id}/reservar`, {}, T1)).s === 409, 'no reserva dos veces');
const T2 = (await call('POST', '/cliente/entrar', { cedula: `V${Number(num) + 1}` })).j.token;
check((await call('POST', `/cliente/clases/${otra.id}/reservar`, {}, T2)).s === 409, 'otro cliente: cupo lleno (o sin plan)');
check((await call('DELETE', `/cliente/clases/${otra.id}/reservar`, null, T1)).s === 200, 'cancela su reserva');

console.log('\n── Información privada con clave');
check((await call('POST', '/cliente/clave', { nueva: '12' }, T1)).s === 400, 'clave muy corta');
const cv = await call('POST', '/cliente/clave', { nueva: 'laura2026' }, T1);
check(cv.s === 200 && cv.j.token, 'se pone una clave');
check((await call('GET', '/cliente/yo', null, T1)).s === 401, 'las sesiones anteriores se cierran');
const T1b = cv.j.token;
check((await call('GET', '/cliente/yo', null, T1b)).j.privado === true, 'su cuenta queda privada');
const sinClave = await call('POST', '/cliente/entrar', { cedula: num });
check(sinClave.s === 401 && sinClave.j.details?.requiereClave, 'con solo la cédula ya no entra: pide la clave', sinClave.j);
check((await call('POST', '/cliente/entrar', { cedula: num, clave: 'otra' })).s === 401, 'clave incorrecta');
const conClave = await call('POST', '/cliente/entrar', { cedula: num, clave: 'laura2026' });
check(conClave.s === 200 && conClave.j.privado, 'cédula + clave: entra');
check((await call('POST', '/cliente/clave', { nueva: 'nueva123', actual: 'mala' }, conClave.j.token)).s === 401, 'cambiar la clave exige la actual');

console.log('\n── Enlace personal (si olvidó la clave)');
const enl = await call('POST', `/coach/clientes/${s1.id}/enlace`, { baseUrl: 'http://localhost:5173', enviar: false }, E);
check(enl.s === 200 && /\/socio\//.test(enl.j.url), 'el entrenador genera su enlace', enl.j);
const tk = enl.j.url.split('/socio/')[1];
const ve = await call('POST', '/cliente/enlace', { token: tk });
check(ve.s === 200 && ve.j.privado, 'con el enlace entra sin clave');
const nueva = await call('POST', '/cliente/clave', { nueva: 'recuperada1' }, ve.j.token);
check(nueva.s === 200, 'desde el enlace se pone una clave nueva sin la anterior');
check((await call('POST', '/cliente/entrar', { cedula: num, clave: 'recuperada1' })).s === 200, 'y entra con la nueva');
check((await call('POST', '/cliente/enlace', { token: 'inventado-inventado-inventado' })).s === 404, 'enlace inventado: no entra');
check((await call('GET', `/portal/${tk}`)).s === 200, 'el enlace viejo del portal sigue funcionando');

console.log('\n── Recepción quita la clave olvidada');
check((await call('DELETE', `/socios/${s1.id}/app-clave`, null, C)).s === 200, 'recepción quita la clave');
check((await call('POST', '/cliente/entrar', { cedula: num })).s === 200, 'vuelve a entrar con su cédula');
const lc = await call('POST', '/cliente/entrar', { cedula: num });
const quitar = await call('POST', '/cliente/clave', { nueva: 'temp1234' }, lc.j.token);
check((await call('DELETE', '/cliente/clave', { actual: 'temp1234' }, quitar.j.token)).s === 200, 'el cliente también puede quitar su clave');

console.log('\n── Revocar el acceso del entrenador');
check((await call('PUT', `/socios/${s2.id}/entrenador`, { entrenadorId: ent.id }, C)).s === 200, 'recepción le asigna otro cliente');
check((await call('GET', '/coach/clientes', null, E)).j.length === 2, 'aparece en su lista');
check((await call('DELETE', `/entrenadores/${ent.id}/acceso`, null, D)).s === 200, 'el dueño le quita el acceso');
check((await call('GET', '/coach/yo', null, E)).s === 401, 'su sesión deja de funcionar al instante');
check((await call('POST', '/auth/login', { usuario: `coach${sfx}`, password: 'clave123' })).s === 401, 'y ya no puede entrar');

console.log(`\n${ok} ✓   ${fail} ✗`);
process.exit(fail ? 1 : 0);
