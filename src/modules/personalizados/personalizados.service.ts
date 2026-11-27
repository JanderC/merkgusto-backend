/**
 * ENTRENAMIENTO PERSONALIZADO
 *
 *  Cobro:   en caja, como un renglón más del ticket (con plan, productos o solo).
 *           El precio sale SIEMPRE de la tarifa del entrenador (mensual o semanal) × periodos.
 *           Al cobrarlo el cliente queda asignado a ese entrenador (lo ve en su app).
 *  Fechas:  igual que las membresías. Mes a mes (23 nov → 23 dic) y semana a semana.
 *           Si renueva con el mismo entrenador y aún está vigente, sigue desde su vencimiento.
 *  Estado:  al día · vence pronto · vencido · debe saldo (pagó una parte) · por empezar.
 *  Entrenador: le corresponde su % de lo cobrado. Entra a su pago una sola vez y solo cuando
 *           el cliente terminó de pagar (si quedó debiendo, se retiene hasta que abone todo).
 */
import { sql } from 'kysely';
import { db, type Db } from '../../db/index.js';
import type { Moneda } from '../../db/types.js';
import { badRequest, conflict, notFound } from '../../lib/http.js';
import { convertir, fmt, redondear, type Tasas } from '../../lib/monedas.js';
import { diasEntre, hoy, sumarDias } from '../../lib/util.js';
import { calcularFin, describirDuracion } from '../membresias/membresias.service.js';

export type PeriodoPersonalizado = 'meses' | 'semanas';
export const DIAS_AVISO = 5;

export interface ItemPersonalizado {
  entrenadorId: string;
  periodo: PeriodoPersonalizado;
  cantidad: number;
  desde?: 'continuar' | 'hoy';
}

const nombreDe = (e: { nombre: string; apellido: string }) => `${e.nombre} ${e.apellido}`.trim();
/** 2026-12-26 → "26 dic" */
const diaMes = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('es-VE', { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace('.', '');

/** Tarifa vigente del entrenador para ese periodo (desde la base de datos, nunca del navegador). */
export async function tarifaDe(dbx: Db, entrenadorId: string, periodo: PeriodoPersonalizado) {
  const e = await dbx
    .selectFrom('entrenadores')
    .select(['id', 'nombre', 'apellido', 'activo', 'personalizadoPrecio', 'personalizadoSemanal', 'personalizadoMoneda', 'personalizadoComision'])
    .where('id', '=', entrenadorId)
    .executeTakeFirst();
  if (!e || !e.activo) throw badRequest('Ese entrenador no está activo');
  const tarifa = periodo === 'meses' ? e.personalizadoPrecio : e.personalizadoSemanal;
  if (tarifa === null || Number(tarifa) <= 0) {
    throw badRequest(
      periodo === 'meses'
        ? `${nombreDe(e)} no tiene tarifa de personalizado. Se configura en Panel › Entrenadores.`
        : `${nombreDe(e)} no tiene tarifa semanal de personalizado: cobra por mes.`,
    );
  }
  return { entrenador: e, nombre: nombreDe(e), tarifa: Number(tarifa), moneda: e.personalizadoMoneda, comision: Number(e.personalizadoComision) };
}

/**
 * Prepara el renglón del ticket: precio, fechas y lo que le toca al entrenador.
 * Se llama dentro de la transacción de la venta.
 */
export async function prepararPersonalizado(trx: Db, socioId: string, it: ItemPersonalizado) {
  const t = await tarifaDe(trx, it.entrenadorId, it.periodo);
  const h = hoy();
  const precio = redondear(t.tarifa * it.cantidad, t.moneda);
  let inicio = h;
  let ancla: string | undefined;
  if ((it.desde ?? 'continuar') === 'continuar') {
    const ult = await trx
      .selectFrom('personalizados')
      .select(sql<string>`max(fecha_fin)::text`.as('fin'))
      .where('socioId', '=', socioId)
      .where('entrenadorId', '=', it.entrenadorId)
      .where('estado', '=', 'activa')
      .executeTakeFirst();
    if (ult?.fin && ult.fin >= h) {
      inicio = sumarDias(ult.fin, 1);
      ancla = ult.fin;
    }
  }
  const fin = calcularFin(inicio, { tipoDuracion: it.periodo, cantidad: it.cantidad }, ancla);
  const duracion = describirDuracion({ tipoDuracion: it.periodo, cantidad: it.cantidad });
  return {
    ...t,
    precio,
    inicio,
    fin,
    duracion,
    montoEntrenador: redondear((precio * t.comision) / 100, t.moneda),
    descripcion: `Personalizado con ${t.nombre} (${duracion})`,
  };
}

export async function crearPersonalizado(
  trx: Db,
  p: Awaited<ReturnType<typeof prepararPersonalizado>> & { socioId: string; ventaId: string; periodo: PeriodoPersonalizado; cantidad: number; usuarioId: string },
) {
  const fila = await trx
    .insertInto('personalizados')
    .values({
      socioId: p.socioId,
      entrenadorId: p.entrenador.id,
      ventaId: p.ventaId,
      fechaInicio: p.inicio,
      fechaFin: p.fin,
      tipoDuracion: p.periodo,
      cantidad: p.cantidad,
      precio: p.precio,
      moneda: p.moneda,
      comisionPct: p.comision,
      montoEntrenador: p.montoEntrenador,
      creadoPor: p.usuarioId,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  // Queda como cliente de ese entrenador: lo ve en su app
  await trx.updateTable('socios').set({ entrenadorId: p.entrenador.id }).where('id', '=', p.socioId).execute();
  return fila.id;
}

/** Al anular el ticket: el personalizado se anula, salvo que ya se le haya pagado al entrenador. */
export async function anularPersonalizadosDeVenta(trx: Db, ventaId: string) {
  const pagados = await trx
    .selectFrom('personalizados as p')
    .innerJoin('entrenadores as e', 'e.id', 'p.entrenadorId')
    .select(['e.nombre', 'e.apellido'])
    .where('p.ventaId', '=', ventaId)
    .where('p.estado', '=', 'activa')
    .where('p.entrenadorPagoId', 'is not', null)
    .executeTakeFirst();
  if (pagados) throw conflict(`Este ticket tiene un personalizado que ya se le pagó a ${nombreDe(pagados)}. Anula primero ese pago en Entrenadores › Pagos.`);
  await trx.updateTable('personalizados').set({ estado: 'anulada' }).where('ventaId', '=', ventaId).execute();
}

// ═════════════ Estado: quién pagó y quién no ═════════════

export type EstadoPersonalizado = 'al_dia' | 'vence' | 'vencido' | 'debe' | 'por_empezar' | 'sin_pago';

export interface FilaPersonalizado {
  socioId: string;
  codigo: number;
  nombre: string;
  telefono: string | null;
  tieneFoto: boolean;
  entrenadorId: string;
  entrenador: string;
  estado: EstadoPersonalizado;
  estadoTexto: string;
  /** Bloque continuo pagado */
  desde: string | null;
  hasta: string | null;
  diasRestantes: number;
  /** Último cobro (sinCobro: lo registró la administración sin pasar por caja) */
  ultimoPago: { fecha: Date; ticket: number | null; precioTexto: string; duracion: string; precio: number; moneda: Moneda; sinCobro: boolean } | null;
  /** Último periodo registrado (el que se puede editar) */
  ultimo: { id: number; fechaInicio: string; fechaFin: string } | null;
  deudaTexto: string | null;
  pagos: number;
}

/**
 * Tablero de personalizados: cada cliente con su entrenador y si está al día.
 * Incluye a los clientes asignados al entrenador que nunca han pagado personalizado.
 */
export async function tableroPersonalizados(f: { entrenadorId?: string; socioId?: string; diasVencidos?: number } = {}): Promise<FilaPersonalizado[]> {
  const h = hoy();
  const limite = sumarDias(h, -(f.diasVencidos ?? 60));
  let q = db
    .selectFrom('personalizados as p')
    .innerJoin('socios as s', 's.id', 'p.socioId')
    .innerJoin('entrenadores as e', 'e.id', 'p.entrenadorId')
    .leftJoin('ventas as v', 'v.id', 'p.ventaId')
    .select([
      'p.id',
      'p.socioId',
      'p.entrenadorId',
      'p.fechaInicio',
      'p.fechaFin',
      'p.tipoDuracion',
      'p.cantidad',
      'p.precio',
      'p.moneda',
      'p.creadoEn',
      'p.ventaId',
      'v.numero as ticket',
      's.codigo',
      's.telefono',
      sql<string>`trim(s.nombre || ' ' || s.apellido)`.as('nombre'),
      sql<boolean>`s.foto is not null`.as('tieneFoto'),
      sql<string>`trim(e.nombre || ' ' || e.apellido)`.as('entrenador'),
    ])
    .where('p.estado', '=', 'activa')
    .where('s.activo', '=', true)
    // Solo parejas cliente-entrenador con algo reciente
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom('personalizados as r')
          .select('r.id')
          .whereRef('r.socioId', '=', 'p.socioId')
          .whereRef('r.entrenadorId', '=', 'p.entrenadorId')
          .where('r.estado', '=', 'activa')
          .where('r.fechaFin', '>=', limite),
      ),
    )
    .orderBy('p.fechaFin', 'desc');
  if (f.entrenadorId) q = q.where('p.entrenadorId', '=', f.entrenadorId);
  if (f.socioId) q = q.where('p.socioId', '=', f.socioId);
  const filas = await q.execute();

  const ventaIds = [...new Set(filas.map((x) => x.ventaId).filter((x): x is string => !!x))];
  const deudas = ventaIds.length
    ? await db.selectFrom('deudas').select(['ventaId', 'saldo', 'moneda']).where('ventaId', 'in', ventaIds).where('estado', '=', 'pendiente').execute()
    : [];

  const grupos = new Map<string, typeof filas>();
  for (const x of filas) {
    const k = `${x.socioId}|${x.entrenadorId}`;
    grupos.set(k, [...(grupos.get(k) ?? []), x]);
  }

  const out: FilaPersonalizado[] = [];
  for (const rows of grupos.values()) {
    const r0 = rows[0]!;
    // Bloque continuo de días pagados que cubre hoy (o el próximo)
    const futuras = rows.filter((r) => r.fechaFin >= h).sort((a, b) => a.fechaInicio.localeCompare(b.fechaInicio));
    let desde: string | null = null;
    let hasta: string | null = null;
    if (futuras.length) {
      desde = futuras[0]!.fechaInicio;
      hasta = futuras[0]!.fechaFin;
      for (const r of futuras.slice(1)) {
        if (r.fechaInicio <= sumarDias(hasta, 1)) {
          if (r.fechaFin > hasta) hasta = r.fechaFin;
        } else break;
      }
    }
    const ultimaFin = rows.reduce((m, r) => (r.fechaFin > m ? r.fechaFin : m), rows[0]!.fechaFin);
    const ultimo = [...rows].sort((a, b) => +new Date(b.creadoEn) - +new Date(a.creadoEn))[0]!;
    const debe = rows
      .map((r) => deudas.find((d) => d.ventaId === r.ventaId))
      .filter((d): d is NonNullable<typeof d> => !!d)
      .filter((d, i, arr) => arr.findIndex((x) => x.ventaId === d.ventaId) === i);
    const deudaTexto = debe.length ? debe.map((d) => fmt(Number(d.saldo), d.moneda)).join(' + ') : null;
    const vigente = !!desde && desde <= h;
    const dias = vigente ? diasEntre(h, hasta!) + 1 : 0;
    let estado: EstadoPersonalizado;
    let estadoTexto: string;
    if (deudaTexto) {
      estado = 'debe';
      estadoTexto = `Debe ${deudaTexto}`;
    } else if (!desde) {
      estado = 'vencido';
      const hace = diasEntre(ultimaFin, h);
      estadoTexto = hace <= 0 ? 'Venció hoy' : `Venció hace ${hace} día${hace === 1 ? '' : 's'}`;
    } else if (!vigente) {
      estado = 'por_empezar';
      estadoTexto = `Pagado desde el ${diaMes(desde)}`;
    } else if (dias <= DIAS_AVISO) {
      estado = 'vence';
      estadoTexto = dias <= 1 ? 'Vence hoy' : `Le quedan ${dias} días`;
    } else {
      estado = 'al_dia';
      estadoTexto = `Al día · ${dias} días`;
    }
    out.push({
      socioId: r0.socioId,
      codigo: r0.codigo,
      nombre: r0.nombre,
      telefono: r0.telefono,
      tieneFoto: r0.tieneFoto,
      entrenadorId: r0.entrenadorId,
      entrenador: r0.entrenador,
      estado,
      estadoTexto,
      desde,
      hasta: hasta ?? ultimaFin,
      diasRestantes: dias,
      ultimoPago: {
        fecha: ultimo.creadoEn,
        ticket: ultimo.ticket,
        precio: Number(ultimo.precio),
        moneda: ultimo.moneda,
        precioTexto: ultimo.ventaId ? fmt(Number(ultimo.precio), ultimo.moneda) : 'Sin cobro',
        duracion: ultimo.ventaId ? describirDuracion({ tipoDuracion: ultimo.tipoDuracion, cantidad: ultimo.cantidad }) : `${diaMes(ultimo.fechaInicio)} → ${diaMes(ultimo.fechaFin)}`,
        sinCobro: !ultimo.ventaId,
      },
      ultimo: { id: ultimo.id, fechaInicio: ultimo.fechaInicio, fechaFin: ultimo.fechaFin },
      deudaTexto,
      pagos: rows.length,
    });
  }

  // Clientes asignados al entrenador que nunca han pagado personalizado con él
  let qa = db
    .selectFrom('socios as s')
    .innerJoin('entrenadores as e', 'e.id', 's.entrenadorId')
    .select([
      's.id',
      's.codigo',
      's.telefono',
      's.entrenadorId',
      sql<string>`trim(s.nombre || ' ' || s.apellido)`.as('nombre'),
      sql<boolean>`s.foto is not null`.as('tieneFoto'),
      sql<string>`trim(e.nombre || ' ' || e.apellido)`.as('entrenador'),
    ])
    .where('s.activo', '=', true)
    .where('e.activo', '=', true)
    // Solo entrenadores que dan personalizado: los demás clientes asignados no "deben" nada
    .where('e.personalizadoPrecio', '>', 0 as never)
    .where(({ not, exists, selectFrom }) =>
      not(exists(selectFrom('personalizados as r').select('r.id').whereRef('r.socioId', '=', 's.id').whereRef('r.entrenadorId', '=', 's.entrenadorId').where('r.estado', '=', 'activa'))),
    );
  if (f.entrenadorId) qa = qa.where('s.entrenadorId', '=', f.entrenadorId);
  if (f.socioId) qa = qa.where('s.id', '=', f.socioId);
  for (const s of await qa.execute()) {
    out.push({
      socioId: s.id,
      codigo: s.codigo,
      nombre: s.nombre,
      telefono: s.telefono,
      tieneFoto: s.tieneFoto,
      entrenadorId: s.entrenadorId!,
      entrenador: s.entrenador,
      estado: 'sin_pago',
      estadoTexto: 'Asignado, nunca ha pagado personalizado',
      desde: null,
      hasta: null,
      diasRestantes: 0,
      ultimoPago: null,
      ultimo: null,
      deudaTexto: null,
      pagos: 0,
    });
  }
  return out.sort((a, b) => ORDEN[a.estado] - ORDEN[b.estado] || (a.hasta ?? '').localeCompare(b.hasta ?? '') || a.nombre.localeCompare(b.nombre, 'es'));
}

/** Primero lo que requiere acción. */
const ORDEN: Record<EstadoPersonalizado, number> = { debe: 0, vencido: 1, vence: 2, sin_pago: 3, por_empezar: 4, al_dia: 5 };

/** Personalizados vigentes del cliente (para la caja y su ficha). */
export async function personalizadosDeSocio(socioId: string) {
  const filas = (await tableroPersonalizados({ socioId, diasVencidos: 120 })).filter((f) => f.estado !== 'sin_pago');
  return filas.map((f) => ({ entrenadorId: f.entrenadorId, entrenador: f.entrenador, estado: f.estado, estadoTexto: f.estadoTexto, desde: f.desde, hasta: f.hasta, diasRestantes: f.diasRestantes, deudaTexto: f.deudaTexto, ultimo: f.ultimo, sinCobro: f.ultimoPago?.sinCobro ?? false }));
}

// ═════════════ Ajustes de la administración (no pasan por caja) ═════════════

/**
 * Registrar un personalizado SIN cobro (ya lo había pagado antes del sistema, cortesía…).
 * No crea venta, no suma a caja y no le genera pago al entrenador (monto 0).
 */
export async function personalizadoSinCobro(a: { socioId: string; entrenadorId: string; fechaInicio: string; fechaFin: string; usuarioId: string }) {
  if (a.fechaFin < a.fechaInicio) throw badRequest('La fecha de vencimiento no puede ser antes del inicio');
  return db.transaction().execute(async (trx) => {
    const e = await trx.selectFrom('entrenadores').select(['id', 'activo', 'personalizadoMoneda', 'personalizadoComision']).where('id', '=', a.entrenadorId).executeTakeFirst();
    if (!e?.activo) throw badRequest('Ese entrenador no está activo');
    const s = await trx.selectFrom('socios').select(['id', 'activo']).where('id', '=', a.socioId).executeTakeFirst();
    if (!s?.activo) throw badRequest('Cliente no encontrado o desactivado');
    const fila = await trx
      .insertInto('personalizados')
      .values({
        socioId: a.socioId,
        entrenadorId: a.entrenadorId,
        ventaId: null,
        fechaInicio: a.fechaInicio,
        fechaFin: a.fechaFin,
        tipoDuracion: 'meses',
        cantidad: 1,
        precio: 0,
        moneda: e.personalizadoMoneda,
        comisionPct: Number(e.personalizadoComision),
        montoEntrenador: 0,
        creadoPor: a.usuarioId,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    await trx.updateTable('socios').set({ entrenadorId: a.entrenadorId }).where('id', '=', a.socioId).execute();
    return fila.id;
  });
}

/** Corregir las fechas de un personalizado. No toca lo cobrado ni lo que le toca al entrenador. */
export async function editarFechasPersonalizado(id: number, fechaInicio: string, fechaFin: string) {
  if (fechaFin < fechaInicio) throw badRequest('La fecha de vencimiento no puede ser antes del inicio');
  const p = await db.selectFrom('personalizados').select(['id', 'socioId', 'entrenadorId', 'estado', 'fechaInicio', 'fechaFin']).where('id', '=', id).executeTakeFirst();
  if (!p) throw notFound('Personalizado no encontrado');
  if (p.estado !== 'activa') throw badRequest('Ese personalizado está anulado');
  if (p.fechaInicio === fechaInicio && p.fechaFin === fechaFin) throw badRequest('No cambiaste nada');
  await db.updateTable('personalizados').set({ fechaInicio, fechaFin }).where('id', '=', id).execute();
  return { antes: { fechaInicio: p.fechaInicio, fechaFin: p.fechaFin }, socioId: p.socioId, entrenadorId: p.entrenadorId };
}

// ═════════════ Lo que le toca al entrenador ═════════════

/**
 * Personalizados del entrenador aún no liquidados hasta la fecha de corte.
 *  • listos: el cliente pagó completo → entran a su pago.
 *  • retenidos: el cliente quedó debiendo → entran cuando termine de pagar.
 */
export async function porLiquidar(dbx: Db, entrenadorIds: string[], hasta: string, monedaPago: (id: string) => Moneda, t: Tasas, bloquear = false) {
  if (!entrenadorIds.length) return new Map<string, ReturnType<typeof vacio>>();
  let q = dbx
    .selectFrom('personalizados as p')
    .innerJoin('socios as s', 's.id', 'p.socioId')
    .leftJoin('ventas as v', 'v.id', 'p.ventaId')
    .select([
      'p.id',
      'p.entrenadorId',
      'p.precio',
      'p.moneda',
      'p.comisionPct',
      'p.montoEntrenador',
      'p.fechaInicio',
      'p.fechaFin',
      'p.creadoEn',
      'v.numero as ticket',
      sql<string>`trim(s.nombre || ' ' || s.apellido)`.as('cliente'),
      sql<boolean>`exists (select 1 from deudas d where d.venta_id = p.venta_id and d.estado = 'pendiente')`.as('debe'),
    ])
    .where('p.entrenadorId', 'in', entrenadorIds)
    .where('p.estado', '=', 'activa')
    .where('p.entrenadorPagoId', 'is', null)
    // Los registrados sin cobro no generan pago al entrenador
    .where('p.ventaId', 'is not', null)
    .where(sql`p.creado_en::date`, '<=', hasta)
    .orderBy('p.creadoEn');
  if (bloquear) q = q.forUpdate(['p']) as typeof q;
  const filas = await q.execute();
  const out = new Map<string, ReturnType<typeof vacio>>();
  for (const id of entrenadorIds) out.set(id, vacio());
  for (const p of filas) {
    const r = out.get(p.entrenadorId)!;
    const m = monedaPago(p.entrenadorId);
    const enPago = convertir(Number(p.montoEntrenador), p.moneda, m, t);
    const det = {
      id: p.id,
      cliente: p.cliente,
      ticket: p.ticket,
      fecha: p.creadoEn,
      periodo: `${p.fechaInicio} → ${p.fechaFin}`,
      cobradoTexto: fmt(Number(p.precio), p.moneda),
      comision: Number(p.comisionPct),
      leTocaTexto: fmt(Number(p.montoEntrenador), p.moneda),
      enPago: redondear(enPago, m),
    };
    if (p.debe) {
      r.retenidos.push(det);
      r.retenido += enPago;
    } else {
      r.listos.push(det);
      r.monto += enPago;
    }
  }
  for (const [id, r] of out) {
    const m = monedaPago(id);
    r.monto = redondear(r.monto, m);
    r.retenido = redondear(r.retenido, m);
    r.montoTexto = fmt(r.monto, m);
    r.retenidoTexto = fmt(r.retenido, m);
  }
  return out;
}
function vacio() {
  type Det = { id: number; cliente: string; ticket: number | null; fecha: Date; periodo: string; cobradoTexto: string; comision: number; leTocaTexto: string; enPago: number };
  return { monto: 0, montoTexto: '', retenido: 0, retenidoTexto: '', listos: [] as Det[], retenidos: [] as Det[] };
}
