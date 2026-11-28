/**
 * CAJA CIEGA MULTIMONEDA
 *
 *  ┌─ Cajera ──────────────────────────────┐   ┌─ Dueño / Admin de caja ────────────────┐
 *  │ Abre turno → cobra → registra gastos  │   │ Esperado por método y moneda, lo        │
 *  │ → cierra declarando lo que entrega.   │   │ entregado, la diferencia, ventas,       │
 *  │ NUNCA ve totales, saldo ni esperado.  │   │ ingresos/egresos y deudas por cobrar.   │
 *  └───────────────────────────────────────┘   └────────────────────────────────────────┘
 *
 * Cómo cuadra un pago en varias monedas sin moneda puente:
 *   Cada línea del ticket tiene su precio en su moneda (agua COP 4.500, plan $25).
 *   El total se expresa en cada moneda con la tasa de cada par (regla de tres).
 *   Cada pago cubre una FRACCIÓN del total: Bs 500 de un total de Bs 1.000 = 0,5.
 *   La venta queda pagada cuando las fracciones suman 1. El vuelto es la fracción
 *   que sobra, expresada en la moneda en que se devuelve.
 *   Lo esperado en el cierre se arma con los montos REALES de cada moneda:
 *   lo que entró + ingresos − egresos − vueltos + fondo.
 */
import { sql } from 'kysely';
import { db, type Db } from '../../db/index.js';
import type { Moneda } from '../../db/types.js';
import { bus } from '../../lib/events.js';
import { hoy, sumarDias } from '../../lib/util.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/http.js';
import { convertir, fmt, fmtTodas, INFO, MONEDA_REF, MONEDAS, redondear, totalesPorMoneda, type Tasas } from '../../lib/monedas.js';
import { encolarSocio } from '../biometric/biometric-sync.service.js';
import { getConfig } from '../configuracion/config.service.js';
import { crearMembresias, describirDuracion, type DesdeRenovacion } from '../membresias/membresias.service.js';
import { moverStock } from '../inventario/kardex.js';
import { anularClasesDeVenta, inscribirPagado, prepararClase } from '../clases/clases-cobro.js';
import { anularPersonalizadosDeVenta, crearPersonalizado, prepararPersonalizado, type ItemPersonalizado } from '../personalizados/personalizados.service.js';
import { getTasas } from '../tasas/tasas.service.js';

export type ItemVentaInput =
  | { tipo: 'membresia'; id: number; acompanantes?: string[]; desde?: DesdeRenovacion; /** Se inscribió días antes: la mensualidad cuenta desde ese día */ inicio?: string }
  | { tipo: 'producto'; id: number; cantidad: number }
  | { tipo: 'abono'; deudaId: number; monto: number }
  | ({ tipo: 'personalizado' } & ItemPersonalizado)
  | { tipo: 'clase'; claseId: number };

export interface PagoInput {
  metodo: string;
  moneda: Moneda;
  monto: number;
  referencia?: string | null;
}
export interface VueltoInput {
  metodo: string;
  moneda: Moneda;
  monto: number;
}

/** Margen por redondeo entre monedas (≈ 2 centavos de dólar en la moneda de referencia). */
const tolerancia = (t: Tasas) => Math.max(convertir(0.02, 'USD', MONEDA_REF, t), 10 ** -INFO[MONEDA_REF].decimales);

export async function turnoAbierto(cajeroId: string, dbx: Db = db) {
  return dbx.selectFrom('turnos').selectAll().where('cajeroId', '=', cajeroId).where('estado', '=', 'abierto').executeTakeFirst();
}

export async function abrirTurno(cajeroId: string) {
  const ya = await turnoAbierto(cajeroId);
  if (ya) return ya;
  const { fondo } = await getConfig('caja');
  return db.insertInto('turnos').values({ cajeroId, fondoInicial: 0, fondo: JSON.stringify(fondo) }).returningAll().executeTakeFirstOrThrow();
}

export async function metodosActivos(dbx: Db) {
  const metodos = await dbx.selectFrom('metodosPago').selectAll().where('activo', '=', true).execute();
  return (codigo: string, moneda: Moneda) => {
    const m = metodos.find((x) => x.codigo === codigo);
    if (!m) throw badRequest(`Método de pago no disponible: ${codigo}`);
    if (!m.monedas.includes(moneda)) throw badRequest(`${m.nombre} no recibe ${INFO[moneda].nombre.toLowerCase()}`);
    return m;
  };
}

type Linea = {
  tipo: 'membresia' | 'producto' | 'abono' | 'personalizado' | 'clase';
  referenciaId: number;
  descripcion: string;
  cantidad: number;
  moneda: Moneda;
  precioUnitario: number;
  subtotal: number;
  datos: Record<string, unknown> | null;
};

/** Rutina / pase del día de una sola persona que entra por recepción: se vende sin elegir cliente. */
export const esPaseSinCliente = (p: { accesoLector: boolean; personas: number; tipoDuracion: string; cantidad: number }) => !p.accesoLector && p.personas === 1 && p.tipoDuracion === 'dias' && p.cantidad === 1;

export async function registrarVenta(
  cajeroId: string,
  input: { socioId: string | null; items: ItemVentaInput[]; pagos: PagoInput[]; vuelto?: VueltoInput | null; pagoParcial?: boolean; nota?: string | null },
) {
  if (!input.items.length) throw badRequest('Agrega al menos un plan, producto o abono');

  const r = await db.transaction().execute(async (trx) => {
    const turno = await turnoAbierto(cajeroId, trx);
    if (!turno) throw conflict('Abre tu turno antes de cobrar');
    if (input.socioId) {
      const s = await trx.selectFrom('socios').select(['id']).where('id', '=', input.socioId).executeTakeFirst();
      if (!s) throw notFound('Cliente no encontrado');
    }
    const t = await getTasas();

    // ── 1. Líneas: precios SIEMPRE desde la base de datos, cada una en su moneda ──
    const lineas: Linea[] = [];
    const membresiasPedidas: Array<{ planId: number; socios: string[]; desde: DesdeRenovacion; inicio?: string; idx: number }> = [];
    const abonos: Array<{ deudaId: number; monto: number }> = [];
    const personalizados: Array<{ idx: number; item: ItemPersonalizado; datos: Awaited<ReturnType<typeof prepararPersonalizado>> }> = [];
    const clases: Array<Awaited<ReturnType<typeof prepararClase>>> = [];
    for (const it of input.items) {
      if (it.tipo === 'clase') {
        if (!input.socioId) throw badRequest('Para cobrar una clase elige a la persona (o regístrala rápido): queda inscrita en la clase');
        if (clases.some((x) => x.clase.id === it.claseId)) throw badRequest('Esa clase ya está en el ticket');
        const cl = await prepararClase(trx, input.socioId, it.claseId);
        clases.push(cl);
        lineas.push({ tipo: 'clase', referenciaId: cl.clase.id, descripcion: cl.descripcion, cantidad: 1, moneda: cl.moneda, precioUnitario: cl.precio, subtotal: cl.precio, datos: { claseId: cl.clase.id, dia: cl.clase.dia, hora: cl.clase.hora } });
      } else if (it.tipo === 'personalizado') {
        if (!input.socioId) throw badRequest('Para cobrar un personalizado elige al cliente');
        if (personalizados.some((x) => x.item.entrenadorId === it.entrenadorId)) throw badRequest('Ese personalizado ya está en el ticket');
        const pz = await prepararPersonalizado(trx, input.socioId, it);
        personalizados.push({ idx: lineas.length, item: it, datos: pz });
        lineas.push({
          tipo: 'personalizado',
          // Se reemplaza por el id del personalizado al guardarlo
          referenciaId: 0,
          descripcion: pz.descripcion,
          cantidad: 1,
          moneda: pz.moneda,
          precioUnitario: pz.precio,
          subtotal: pz.precio,
          datos: { entrenadorId: pz.entrenador.id, entrenador: pz.nombre, periodo: it.periodo, cantidad: it.cantidad, inicio: pz.inicio, fin: pz.fin, comision: pz.comision },
        });
      } else if (it.tipo === 'membresia') {
        const p = await trx.selectFrom('planes').selectAll().where('id', '=', it.id).executeTakeFirst();
        if (!p || !p.activo) throw badRequest('Plan no disponible');
        if (!input.socioId) {
          // Rutina / pase del día: entra por recepción, no abre el lector → se puede cobrar sin cliente
          if (!esPaseSinCliente(p)) throw badRequest(`Para vender ${p.nombre} elige al cliente (abre el lector o dura más de un día)`);
          lineas.push({
            tipo: 'membresia',
            referenciaId: p.id,
            descripcion: `${p.nombre} (${describirDuracion(p)}) · sin cliente`,
            cantidad: 1,
            moneda: p.moneda,
            precioUnitario: Number(p.precio),
            subtotal: Number(p.precio),
            datos: { sinCliente: true },
          });
          continue;
        }
        const socios = [input.socioId, ...(it.acompanantes ?? [])];
        if (socios.length !== p.personas) throw badRequest(`El plan ${p.nombre} es para ${p.personas} persona(s): elige ${p.personas - 1} acompañante(s)`);
        if (it.inicio) {
          if (it.inicio > hoy()) throw badRequest('La fecha de inicio no puede ser futura');
          if (it.inicio < sumarDias(hoy(), -30)) throw badRequest('La fecha de inicio puede ser como máximo de hace 30 días');
        }
        membresiasPedidas.push({ planId: p.id, socios, desde: it.desde ?? 'continuar', inicio: it.inicio, idx: lineas.length });
        lineas.push({
          tipo: 'membresia',
          referenciaId: p.id,
          descripcion: `Plan ${p.nombre} (${describirDuracion(p)})`,
          cantidad: 1,
          moneda: p.moneda,
          precioUnitario: Number(p.precio),
          subtotal: Number(p.precio),
          datos: { socios, desde: it.desde ?? 'continuar', ...(it.inicio && { inicio: it.inicio }) },
        });
      } else if (it.tipo === 'producto') {
        const p = await trx.selectFrom('productos').selectAll().where('id', '=', it.id).forUpdate().executeTakeFirst();
        if (!p || !p.activo) throw badRequest('Producto no disponible');
        if (p.controlaStock && p.stock < it.cantidad) throw badRequest(`Solo quedan ${p.stock} de "${p.nombre}"`);
        lineas.push({
          tipo: 'producto',
          referenciaId: p.id,
          descripcion: p.nombre,
          cantidad: it.cantidad,
          moneda: p.moneda,
          precioUnitario: Number(p.precio),
          subtotal: redondear(Number(p.precio) * it.cantidad, p.moneda),
          datos: null,
        });
      } else {
        if (!input.socioId) throw badRequest('Elige al cliente para abonar a su deuda');
        const d = await trx.selectFrom('deudas').selectAll().where('id', '=', it.deudaId).forUpdate().executeTakeFirst();
        if (!d || d.socioId !== input.socioId || d.estado !== 'pendiente') throw badRequest('Esa deuda no está pendiente');
        const monto = redondear(Math.min(it.monto, Number(d.saldo)), d.moneda);
        if (monto <= 0) throw badRequest('El abono debe ser mayor a cero');
        abonos.push({ deudaId: d.id, monto });
        lineas.push({
          tipo: 'abono',
          referenciaId: d.id,
          descripcion: `Abono: ${d.concepto}`,
          cantidad: 1,
          moneda: d.moneda,
          precioUnitario: monto,
          subtotal: monto,
          datos: { saldoAntes: Number(d.saldo) },
        });
      }
    }

    // ── 2. Total en cada moneda (regla de tres por par) ──
    const exactos = Object.fromEntries(MONEDAS.map((m) => [m, lineas.reduce((s, l) => s + convertir(l.subtotal, l.moneda, m, t), 0)])) as Record<Moneda, number>;
    const totales = totalesPorMoneda(lineas.map((l) => ({ monto: l.subtotal, moneda: l.moneda })), t);
    const totalRef = totales[MONEDA_REF];
    const tol = tolerancia(t);

    // ── 3. Pagos: cada uno cubre una fracción del total ──
    const metodo = await metodosActivos(trx);
    const pagos = input.pagos
      .filter((p) => p.monto > 0)
      .map((p) => {
        const m = metodo(p.metodo, p.moneda);
        if (m.pideReferencia && !p.referencia?.trim()) throw badRequest(`Escribe la referencia del pago por ${m.nombre}`);
        const monto = redondear(p.monto, p.moneda);
        return { ...p, monto, fraccion: exactos[p.moneda] > 0 ? monto / exactos[p.moneda] : 0 };
      });
    const cubierto = pagos.reduce((s, p) => s + p.fraccion, 0);
    const faltaRef = (1 - cubierto) * exactos[MONEDA_REF];
    const soloAbonos = lineas.every((l) => l.tipo === 'abono');
    const parcial = faltaRef > tol;
    if (parcial && !(input.pagoParcial && input.socioId && !soloAbonos)) {
      throw badRequest(`Faltan ${fmtTodas(faltaRef, MONEDA_REF, t)}`);
    }

    // ── 4. Vuelto ──
    let vuelto: { metodo: string; moneda: Moneda; monto: number; fraccion: number } | null = null;
    const sobraRef = (cubierto - 1) * exactos[MONEDA_REF];
    if (sobraRef > tol) {
      if (!input.vuelto || input.vuelto.monto <= 0) throw badRequest(`Pagó de más: indica el vuelto (${fmtTodas(sobraRef, MONEDA_REF, t)})`);
      const v = input.vuelto;
      if (!['efectivo', 'pago_movil', 'nequi', 'bancolombia'].includes(v.metodo)) throw badRequest('El vuelto se entrega en efectivo o por transferencia');
      metodo(v.metodo, v.moneda);
      const esperado = (cubierto - 1) * exactos[v.moneda];
      const monto = redondear(v.monto, v.moneda);
      const margen = Math.max(10 ** -INFO[v.moneda].decimales, convertir(tol, MONEDA_REF, v.moneda, t));
      if (Math.abs(monto - esperado) > margen) throw badRequest(`El vuelto debe ser ${fmt(redondear(esperado, v.moneda), v.moneda)}`);
      vuelto = { metodo: v.metodo, moneda: v.moneda, monto, fraccion: -(monto / exactos[v.moneda]) };
    }

    // ── 5. Equivalente en moneda de referencia (cuadra exacto contra el total) ──
    const filas = [
      ...pagos.map((p) => ({ metodo: p.metodo, moneda: p.moneda, montoMoneda: p.monto, fraccion: p.fraccion, referencia: p.referencia?.trim() || null, esVuelto: false })),
      ...(vuelto ? [{ metodo: vuelto.metodo, moneda: vuelto.moneda, montoMoneda: -vuelto.monto, fraccion: vuelto.fraccion, referencia: 'vuelto', esVuelto: true }] : []),
    ].map((f) => ({ ...f, montoRef: redondear(f.fraccion * totalRef, MONEDA_REF) }));
    let pagadoRef = redondear(filas.reduce((s, f) => s + f.montoRef, 0), MONEDA_REF);
    if (!parcial && filas.some((f) => !f.esVuelto)) {
      // Ajuste por redondeo: lo cobrado = total de la venta, exacto
      const delta = redondear(totalRef - pagadoRef, MONEDA_REF);
      const ultima = [...filas].reverse().find((f) => !f.esVuelto)!;
      ultima.montoRef = redondear(ultima.montoRef + delta, MONEDA_REF);
      pagadoRef = totalRef;
    }
    const deudaRef = parcial ? redondear(totalRef - pagadoRef, MONEDA_REF) : 0;

    // ── 6. Guardar ──
    const venta = await trx
      .insertInto('ventas')
      .values({
        turnoId: turno.id,
        cajeroId,
        socioId: input.socioId,
        total: redondear(convertir(totalRef, MONEDA_REF, 'USD', t), 'USD'),
        monedaRef: MONEDA_REF,
        totalRef,
        pagadoRef,
        totales: JSON.stringify(totales),
        tasas: JSON.stringify(t),
        nota: input.nota?.trim() || null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const itemsGuardados = await trx
      .insertInto('ventaItems')
      .values(
        lineas.map((l) => ({
          ventaId: venta.id,
          tipo: l.tipo,
          referenciaId: l.referenciaId,
          descripcion: l.descripcion.slice(0, 150),
          cantidad: l.cantidad,
          moneda: l.moneda,
          precioUnitario: l.precioUnitario,
          subtotal: l.subtotal,
          subtotalRef: redondear(convertir(l.subtotal, l.moneda, MONEDA_REF, t), MONEDA_REF),
          datos: l.datos ? JSON.stringify(l.datos) : null,
        })),
      )
      .returning(['id'])
      .execute();
    if (filas.length) {
      await trx
        .insertInto('ventaPagos')
        .values(
          filas.map((f) => ({
            ventaId: venta.id,
            metodo: f.metodo,
            moneda: f.moneda,
            montoMoneda: f.montoMoneda,
            fraccion: f.fraccion,
            montoRef: f.montoRef,
            monto: redondear(convertir(f.montoRef, MONEDA_REF, 'USD', t), 'USD'),
            esVuelto: f.esVuelto,
            referencia: f.referencia,
          })),
        )
        .execute();
    }

    // Inventario
    for (const l of lineas.filter((x) => x.tipo === 'producto')) {
      await moverStock(trx, { productoId: l.referenciaId!, cantidad: -l.cantidad, tipo: 'venta', referencia: `Ticket #${venta.numero}`, usuarioId: cajeroId });
    }
    // Abonos a deudas
    for (const a of abonos) {
      await trx
        .updateTable('deudas')
        .set({
          saldo: sql`greatest(saldo - ${a.monto}, 0)` as never,
          estado: sql`case when saldo - ${a.monto} <= 0 then 'pagada' else 'pendiente' end` as never,
          actualizadoEn: sql`now()` as never,
        })
        .where('id', '=', a.deudaId)
        .execute();
    }
    // Membresías (una por persona en planes grupales)
    const membresias: Array<{ socioIds: string[]; inicio: string; fin: string; plan: string }> = [];
    for (const mp of membresiasPedidas) {
      const l = lineas[mp.idx]!;
      const c = await crearMembresias(trx, { socioIds: mp.socios, planId: mp.planId, ventaId: venta.id, precio: l.subtotal, moneda: l.moneda, desde: mp.desde, inicio: mp.inicio });
      membresias.push({ socioIds: mp.socios, inicio: c.inicio, fin: c.fin, plan: c.plan.nombre });
    }
    // Entrenamiento personalizado: periodo pagado y cliente asignado al entrenador
    const personalizadosHechos: Array<{ entrenador: string; inicio: string; fin: string }> = [];
    for (const pz of personalizados) {
      const id = await crearPersonalizado(trx, { ...pz.datos, socioId: input.socioId!, ventaId: venta.id, periodo: pz.item.periodo, cantidad: pz.item.cantidad, usuarioId: cajeroId });
      await trx.updateTable('ventaItems').set({ referenciaId: id }).where('id', '=', itemsGuardados[pz.idx]!.id).execute();
      personalizadosHechos.push({ entrenador: pz.datos.nombre, inicio: pz.datos.inicio, fin: pz.datos.fin });
    }
    // Clases pagadas: queda inscrito con su ticket
    for (const cl of clases) await inscribirPagado(trx, { claseId: cl.clase.id, socioId: input.socioId!, ventaId: venta.id, usuarioId: cajeroId, inscripcionId: cl.inscripcionId });
    // Pago parcial → deuda del cliente
    let deuda: { id: number; saldo: number; texto: string } | null = null;
    if (deudaRef > 0 && input.socioId) {
      const d = await trx
        .insertInto('deudas')
        .values({
          socioId: input.socioId,
          ventaId: venta.id,
          concepto: `Saldo ticket #${venta.numero}: ${lineas.map((l) => l.descripcion).join(', ')}`.slice(0, 200),
          moneda: MONEDA_REF,
          montoTotal: deudaRef,
          saldo: deudaRef,
          creadoPor: cajeroId,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      deuda = { id: d.id, saldo: deudaRef, texto: fmtTodas(deudaRef, MONEDA_REF, t) };
    }
    return { venta, lineas, totales, membresias, personalizados: personalizadosHechos, clases: clases.map((c) => ({ nombre: c.clase.nombre, dia: c.clase.dia, hora: c.clase.hora })), deuda, vuelto };
  });

  // Fuera de la transacción: el lector nunca bloquea una venta
  const sociosLector = new Set(r.membresias.flatMap((m) => m.socioIds));
  for (const id of sociosLector) await encolarSocio(id).catch((e) => console.error('✗ No se pudo encolar sincronización:', e.message));

  // Comprobante para la cajera (necesita saber cuánto cobró y cuánto devolver)
  return {
    numero: r.venta.numero,
    fecha: r.venta.creadoEn,
    totales: r.totales,
    items: r.lineas.map((l) => ({ descripcion: l.descripcion, cantidad: l.cantidad, precio: fmt(l.subtotal, l.moneda) })),
    membresias: r.membresias.map((m) => ({ plan: m.plan, fechaInicio: m.inicio, fechaFin: m.fin, personas: m.socioIds.length })),
    personalizados: r.personalizados.map((p) => ({ entrenador: p.entrenador, fechaInicio: p.inicio, fechaFin: p.fin })),
    clases: r.clases,
    vuelto: r.vuelto ? { moneda: r.vuelto.moneda, monto: r.vuelto.monto, texto: fmt(r.vuelto.monto, r.vuelto.moneda) } : null,
    deuda: r.deuda,
  };
}

// ═════════════════ Ingresos y egresos de caja ═════════════════

export async function registrarMovimiento(
  usuario: { id: string; rol: string },
  input: { tipo: 'ingreso' | 'egreso'; categoria: string; concepto: string; metodo: string; moneda: Moneda; monto: number; referencia?: string | null; comprobanteId?: number | null; sinTurno?: boolean; enTurnoId?: string },
) {
  // Administración puede registrar en la caja (turno abierto) de una cajera: retiros, sencillo…
  const turno = input.enTurnoId
    ? await db.selectFrom('turnos').selectAll().where('id', '=', input.enTurnoId).where('estado', '=', 'abierto').executeTakeFirst()
    : await turnoAbierto(usuario.id);
  if (input.enTurnoId && (!turno || usuario.rol === 'cajero')) throw conflict('Esa caja no está abierta');
  // La cajera solo registra dentro de su turno; dueño/admin pueden registrar sin turno (no afecta cierres)
  if (!turno && usuario.rol === 'cajero') throw conflict('Abre tu turno para registrar movimientos de caja');
  const turnoId = input.enTurnoId ? turno!.id : input.sinTurno && usuario.rol !== 'cajero' ? null : (turno?.id ?? null);
  const metodo = await metodosActivos(db);
  metodo(input.metodo, input.moneda);
  const t = await getTasas();
  const monto = redondear(input.monto, input.moneda);
  return db
    .insertInto('cajaMovimientos')
    .values({
      turnoId,
      usuarioId: usuario.id,
      tipo: input.tipo,
      categoria: input.categoria,
      concepto: input.concepto,
      metodo: input.metodo,
      moneda: input.moneda,
      monto,
      montoRef: redondear(convertir(monto, input.moneda, MONEDA_REF, t), MONEDA_REF),
      tasas: JSON.stringify(t),
      referencia: input.referencia?.trim() || null,
      comprobanteId: input.comprobanteId ?? null,
    })
    .returning(['id', 'tipo', 'concepto', 'creadoEn', 'turnoId'])
    .executeTakeFirstOrThrow();
}

/**
 * Egreso de administración (sin turno: no toca los cierres de las cajeras).
 * Lo usan las compras a proveedores y el pago a entrenadores, dentro de su transacción.
 */
export async function egresoAdministracion(
  dbx: Db,
  m: { usuarioId: string; categoria: string; concepto: string; metodo: string; moneda: Moneda; monto: number; referencia?: string | null; tasas?: Tasas; turnoId?: string | null },
) {
  (await metodosActivos(dbx))(m.metodo, m.moneda);
  // Pagado con el dinero de una caja abierta: sale de ese turno (lo descuenta su cierre)
  if (m.turnoId) {
    const t = await dbx.selectFrom('turnos').select('id').where('id', '=', m.turnoId).where('estado', '=', 'abierto').executeTakeFirst();
    if (!t) throw conflict('Esa caja ya no está abierta: elige otra o márcalo como pagado por administración');
  }
  const t = m.tasas ?? (await getTasas());
  const monto = redondear(m.monto, m.moneda);
  return dbx
    .insertInto('cajaMovimientos')
    .values({
      turnoId: m.turnoId ?? null,
      usuarioId: m.usuarioId,
      tipo: 'egreso',
      categoria: m.categoria,
      concepto: m.concepto.slice(0, 200),
      metodo: m.metodo,
      moneda: m.moneda,
      monto,
      montoRef: redondear(convertir(monto, m.moneda, MONEDA_REF, t), MONEDA_REF),
      tasas: JSON.stringify(t),
      referencia: m.referencia?.trim() || null,
      comprobanteId: null,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
}

export async function anularMovimiento(id: number, usuarioId: string, motivo: string) {
  const dev = await db.selectFrom('devoluciones').select('id').where('movimientoId', '=', id).executeTakeFirst();
  if (dev) throw conflict('Ese egreso es una devolución autorizada: no se puede anular (quedaría la mercancía devuelta sin su dinero)');
  const [compra, nomina] = await Promise.all([
    db.selectFrom('compraPagos').select('compraId').where('movimientoId', '=', id).executeTakeFirst(),
    db.selectFrom('entrenadorPagos').select('id').where('movimientoId', '=', id).where('anulado', '=', false).executeTakeFirst(),
  ]);
  if (compra) throw conflict(`Ese egreso es el pago de la compra #${compra.compraId}: anúlalo desde Inventario › Compras`);
  if (nomina) throw conflict('Ese egreso es un pago a entrenador: anúlalo desde Entrenadores › Pagos');
  const r = await db
    .updateTable('cajaMovimientos')
    .set({ anulado: true, anuladoPor: usuarioId, motivoAnulacion: motivo })
    .where('id', '=', id)
    .where('anulado', '=', false)
    .returning(['id'])
    .executeTakeFirst();
  if (!r) throw notFound('Movimiento no encontrado o ya anulado');
  await db.insertInto('auditoria').values({ usuarioId, accion: 'movimiento.anulado', detalle: JSON.stringify({ id, motivo }) }).execute();
  return { ok: true };
}

// ═════════════════ Vista ciega de la cajera ═════════════════

/**
 * Caja ciega total: la cajera solo sabe que su turno está abierto.
 * Nada de lo que lleva vendido (ni ventas, ni conteos, ni gastos, ni montos):
 * únicamente ve la comanda que está cobrando y al final declara lo que cuenta.
 */
export async function vistaCiegaTurno(cajeroId: string) {
  const turno = await turnoAbierto(cajeroId);
  if (!turno) return null;
  return { id: turno.id, numero: turno.numero, abiertoEn: turno.abiertoEn };
}

export async function cerrarTurno(args: {
  turnoId?: string;
  cajeroId?: string;
  cerradoPor: string;
  declaraciones: Array<{ metodo: string; moneda: Moneda; monto: number }>;
  nota?: string | null;
  forzadoPorDueno?: boolean;
}) {
  const turno = args.turnoId
    ? await db.selectFrom('turnos').selectAll().where('id', '=', args.turnoId).executeTakeFirst()
    : await turnoAbierto(args.cajeroId!);
  if (!turno) throw notFound('No tienes un turno abierto');
  if (turno.estado !== 'abierto') throw conflict('Este turno ya está cerrado');
  if (!args.forzadoPorDueno && turno.cajeroId !== args.cerradoPor) throw forbidden('Solo puedes cerrar tu propio turno');

  const metodos = await db.selectFrom('metodosPago').select(['codigo', 'monedas']).execute();
  const agrupadas = new Map<string, { metodo: string; moneda: Moneda; monto: number }>();
  for (const d of args.declaraciones.filter((x) => x.monto > 0)) {
    const m = metodos.find((x) => x.codigo === d.metodo);
    if (!m || !m.monedas.includes(d.moneda)) throw badRequest(`Método/moneda no válido: ${d.metodo} ${d.moneda}`);
    const k = `${d.metodo}|${d.moneda}`;
    agrupadas.set(k, { ...d, monto: (agrupadas.get(k)?.monto ?? 0) + d.monto });
  }
  const t = await getTasas();

  await db.transaction().execute(async (trx) => {
    const upd = await trx
      .updateTable('turnos')
      .set({
        estado: 'cerrado',
        cerradoEn: sql`now()` as never,
        cerradoPor: args.cerradoPor,
        notaCajero: args.forzadoPorDueno ? turno.notaCajero : args.nota?.trim() || null,
        notaDueno: args.forzadoPorDueno ? args.nota?.trim() || 'Cerrado por administración' : null,
        tasasCierre: JSON.stringify(t),
      })
      .where('id', '=', turno.id)
      .where('estado', '=', 'abierto')
      .executeTakeFirst();
    if (!upd.numUpdatedRows) throw conflict('Este turno ya está cerrado');
    if (agrupadas.size) {
      await trx
        .insertInto('turnoDeclaraciones')
        .values([...agrupadas.values()].map((d) => ({ turnoId: turno.id, metodo: d.metodo, moneda: d.moneda, monto: redondear(d.monto, d.moneda) })))
        .execute();
    }
  });
  bus.emitir('turno:cerrado', { turnoId: turno.id });

  // Sin conteos ni montos: el detalle del cierre solo lo ve administración
  return { numero: turno.numero, abiertoEn: turno.abiertoEn, cerradoEn: new Date() };
}

// ═════════════════ Solo dueño / administrador de caja ═════════════════

export interface FilaArqueo {
  metodo: string;
  nombre: string;
  moneda: Moneda;
  /** Desglose de lo esperado (en esa moneda) */
  cobrado: number;
  vueltos: number;
  ingresos: number;
  egresos: number;
  fondo: number;
  esperado: number;
  declarado: number;
  diferencia: number;
  diferenciaRef: number;
}

export interface ResumenTurno {
  id: string;
  numero: number;
  cajero: string;
  cajeroId: string;
  estado: 'abierto' | 'cerrado' | 'revisado';
  abiertoEn: Date;
  cerradoEn: Date | null;
  notaCajero: string | null;
  notaDueno: string | null;
  operaciones: number;
  anuladas: number;
  monedaRef: Moneda;
  totalVendidoRef: number;
  cobradoRef: number;
  fiadoRef: number;
  ingresosRef: number;
  egresosRef: number;
  totalDeclaradoRef: number;
  diferencia: number;
  declaro: boolean;
  fondo: Partial<Record<Moneda, number>>;
  metodos: FilaArqueo[];
}

export async function resumenTurnos(filtro: { ids?: string[]; desde?: string; hasta?: string; cajeroId?: string; estado?: string }): Promise<ResumenTurno[]> {
  let q = db
    .selectFrom('turnos as t')
    .innerJoin('usuarios as u', 'u.id', 't.cajeroId')
    .select(['t.id', 't.numero', 't.cajeroId', 'u.nombre as cajero', 't.estado', 't.abiertoEn', 't.cerradoEn', 't.fondo', 't.tasasCierre', 't.notaCajero', 't.notaDueno'])
    .orderBy('t.abiertoEn', 'desc');
  if (filtro.ids) q = q.where('t.id', 'in', filtro.ids.length ? filtro.ids : ['00000000-0000-0000-0000-000000000000']);
  if (filtro.desde) q = q.where(sql`t.abierto_en::date`, '>=', filtro.desde);
  if (filtro.hasta) q = q.where(sql`t.abierto_en::date`, '<=', filtro.hasta);
  if (filtro.cajeroId) q = q.where('t.cajeroId', '=', filtro.cajeroId);
  if (filtro.estado) q = q.where('t.estado', '=', filtro.estado as 'abierto');
  const turnos = await q.limit(300).execute();
  if (!turnos.length) return [];
  const ids = turnos.map((t) => t.id);

  const [pagos, movs, declarados, conteos, metodos, tasasHoy] = await Promise.all([
    db
      .selectFrom('ventaPagos as p')
      .innerJoin('ventas as v', 'v.id', 'p.ventaId')
      .select([
        'v.turnoId',
        'p.metodo',
        'p.moneda',
        sql<number>`coalesce(sum(p.monto_moneda) filter (where not p.es_vuelto), 0)`.as('cobrado'),
        sql<number>`coalesce(-sum(p.monto_moneda) filter (where p.es_vuelto), 0)`.as('vueltos'),
      ])
      .where('v.turnoId', 'in', ids)
      .where('v.estado', '=', 'pagada')
      .groupBy(['v.turnoId', 'p.metodo', 'p.moneda'])
      .execute(),
    db
      .selectFrom('cajaMovimientos')
      .select([
        'turnoId',
        'metodo',
        'moneda',
        sql<number>`coalesce(sum(monto) filter (where tipo = 'ingreso'), 0)`.as('ingresos'),
        sql<number>`coalesce(sum(monto) filter (where tipo = 'egreso'), 0)`.as('egresos'),
        sql<number>`coalesce(sum(monto_ref) filter (where tipo = 'ingreso'), 0)`.as('ingresosRef'),
        sql<number>`coalesce(sum(monto_ref) filter (where tipo = 'egreso'), 0)`.as('egresosRef'),
      ])
      .where('turnoId', 'in', ids)
      .where('anulado', '=', false)
      .groupBy(['turnoId', 'metodo', 'moneda'])
      .execute(),
    db.selectFrom('turnoDeclaraciones').selectAll().where('turnoId', 'in', ids).execute(),
    db
      .selectFrom('ventas')
      .select([
        'turnoId',
        sql<number>`count(*) filter (where estado = 'pagada')`.as('ops'),
        sql<number>`count(*) filter (where estado = 'anulada')`.as('anuladas'),
        sql<number>`coalesce(sum(total_ref) filter (where estado = 'pagada'), 0)`.as('vendido'),
        sql<number>`coalesce(sum(pagado_ref) filter (where estado = 'pagada'), 0)`.as('cobrado'),
      ])
      .where('turnoId', 'in', ids)
      .groupBy('turnoId')
      .execute(),
    db.selectFrom('metodosPago').select(['codigo', 'nombre', 'orden', 'monedas']).orderBy('orden').execute(),
    getTasas(),
  ]);

  return turnos.map((t) => {
    const tasas = (t.tasasCierre as Tasas | null) ?? tasasHoy;
    const fondo = (t.fondo ?? {}) as Partial<Record<Moneda, number>>;
    const c = conteos.find((x) => x.turnoId === t.id);
    const dec = declarados.filter((d) => d.turnoId === t.id);
    const mv = movs.filter((m) => m.turnoId === t.id);
    const filas: FilaArqueo[] = metodos
      .flatMap((m) => MONEDAS.filter((mon) => m.monedas.includes(mon) || dec.some((d) => d.metodo === m.codigo && d.moneda === mon)).map((moneda) => ({ m, moneda })))
      .map(({ m, moneda }) => {
        const p = pagos.find((x) => x.turnoId === t.id && x.metodo === m.codigo && x.moneda === moneda);
        const v = mv.find((x) => x.metodo === m.codigo && x.moneda === moneda);
        const cobrado = Number(p?.cobrado ?? 0);
        const vueltos = Number(p?.vueltos ?? 0);
        const ingresos = Number(v?.ingresos ?? 0);
        const egresos = Number(v?.egresos ?? 0);
        const f = m.codigo === 'efectivo' ? Number(fondo[moneda] ?? 0) : 0;
        const esperado = redondear(cobrado - vueltos + ingresos - egresos + f, moneda);
        const declarado = Number(dec.find((d) => d.metodo === m.codigo && d.moneda === moneda)?.monto ?? 0);
        const diferencia = redondear(declarado - esperado, moneda);
        return {
          metodo: m.codigo,
          nombre: m.nombre,
          moneda,
          cobrado: redondear(cobrado, moneda),
          vueltos: redondear(vueltos, moneda),
          ingresos,
          egresos,
          fondo: f,
          esperado,
          declarado,
          diferencia,
          diferenciaRef: redondear(convertir(diferencia, moneda, MONEDA_REF, tasas), MONEDA_REF),
        };
      })
      .filter((f) => f.esperado || f.declarado || f.cobrado || f.egresos || f.ingresos);
    const abierto = t.estado === 'abierto';
    return {
      id: t.id,
      numero: t.numero,
      cajero: t.cajero,
      cajeroId: t.cajeroId,
      estado: t.estado,
      abiertoEn: t.abiertoEn,
      cerradoEn: t.cerradoEn,
      notaCajero: t.notaCajero,
      notaDueno: t.notaDueno,
      operaciones: Number(c?.ops ?? 0),
      anuladas: Number(c?.anuladas ?? 0),
      monedaRef: MONEDA_REF,
      totalVendidoRef: Number(c?.vendido ?? 0),
      cobradoRef: Number(c?.cobrado ?? 0),
      fiadoRef: redondear(Number(c?.vendido ?? 0) - Number(c?.cobrado ?? 0), MONEDA_REF),
      ingresosRef: redondear(mv.reduce((s, x) => s + Number(x.ingresosRef), 0), MONEDA_REF),
      egresosRef: redondear(mv.reduce((s, x) => s + Number(x.egresosRef), 0), MONEDA_REF),
      totalDeclaradoRef: redondear(
        filas.reduce((s, f) => s + convertir(f.declarado, f.moneda, MONEDA_REF, tasas), 0),
        MONEDA_REF,
      ),
      diferencia: abierto ? 0 : redondear(filas.reduce((s, f) => s + f.diferenciaRef, 0), MONEDA_REF),
      declaro: dec.length > 0,
      fondo,
      metodos: filas,
    };
  });
}

export async function anularVenta(ventaId: string, usuarioId: string, motivo: string) {
  const socios = await db.transaction().execute(async (trx) => {
    const v = await trx.selectFrom('ventas').selectAll().where('id', '=', ventaId).forUpdate().executeTakeFirst();
    if (!v) throw notFound('Venta no encontrada');
    if (v.estado === 'anulada') throw conflict('La venta ya estaba anulada');
    const dev = await trx.selectFrom('devoluciones').select('id').where('ventaId', '=', ventaId).executeTakeFirst();
    if (dev) throw conflict('Este ticket ya tiene una devolución de productos: no se puede anular completo');
    await trx
      .updateTable('ventas')
      .set({ estado: 'anulada', anuladaPor: usuarioId, anuladaEn: sql`now()` as never, motivoAnulacion: motivo })
      .where('id', '=', ventaId)
      .execute();
    const items = await trx.selectFrom('ventaItems').selectAll().where('ventaId', '=', ventaId).execute();
    for (const it of items) {
      if (it.tipo === 'producto') {
        await moverStock(trx, { productoId: it.referenciaId!, cantidad: it.cantidad, tipo: 'anulacion', referencia: `Ticket #${v.numero} anulado: ${motivo}`, usuarioId });
      } else if (it.tipo === 'abono') {
        // El abono se devuelve a la deuda
        await trx
          .updateTable('deudas')
          .set({ saldo: sql`saldo + ${Number(it.subtotal)}` as never, estado: 'pendiente', actualizadoEn: sql`now()` as never })
          .where('id', '=', it.referenciaId)
          .execute();
      }
    }
    await anularPersonalizadosDeVenta(trx, ventaId);
    await anularClasesDeVenta(trx, ventaId);
    const membs = await trx.updateTable('membresias').set({ estado: 'anulada' }).where('ventaId', '=', ventaId).returning('socioId').execute();
    await trx.updateTable('deudas').set({ estado: 'anulada', actualizadoEn: sql`now()` as never }).where('ventaId', '=', ventaId).execute();
    await trx
      .insertInto('auditoria')
      .values({ usuarioId, accion: 'venta.anulada', detalle: JSON.stringify({ ventaId, numero: v.numero, totalRef: v.totalRef, motivo }) })
      .execute();
    return [...new Set(membs.map((m) => m.socioId))];
  });
  for (const s of socios) await encolarSocio(s).catch(() => undefined);
  return { ok: true };
}
