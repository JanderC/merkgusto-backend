/**
 * Excel de cierres y movimientos de caja (para la administradora / contadora).
 *
 *  Cierres → hojas: Resumen · Arqueo por método · Totales por método · Ventas · Movimientos
 *  Movimientos (finanzas) → hojas: Movimientos · Totales
 *
 * Las fechas se escriben en hora de Venezuela (Excel no maneja zonas horarias).
 */
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import type { Response } from 'express';
import { db } from '../../db/index.js';
import type { Moneda } from '../../db/types.js';
import { INFO, MONEDA_REF } from '../../lib/monedas.js';
import { getConfig } from '../configuracion/config.service.js';
import { listarMovimientos } from './caja.routes.js';
import { resumenTurnos, type ResumenTurno } from './caja.service.js';

const NARANJA = 'FFFF8A10';
const GRIS = 'FF2B2F36';
const ROJO = 'FFC62828';
const VERDE = 'FF2E7D32';
const AZUL = 'FF1565C0';

const formato = (m: Moneda) => (INFO[m].decimales ? '#,##0.00' : '#,##0');
const FMT_REF = formato(MONEDA_REF);
const REF = INFO[MONEDA_REF].simbolo;
const ESTADO_TURNO: Record<ResumenTurno['estado'], string> = { abierto: 'Abierto', cerrado: 'Por revisar', revisado: 'Revisado' };

/** Fecha "de pared" en Venezuela para que Excel la muestre igual que la app. */
const local = (d: Date | string | null | undefined) => {
  if (!d) return null;
  const x = new Date(d);
  return new Date(x.getTime() - x.getTimezoneOffset() * 60_000);
};
const n = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;

interface Col {
  header: string;
  key: string;
  width: number;
  /** formato numérico / fecha */
  fmt?: string;
  /** suma en la fila de totales */
  total?: boolean;
  /** pinta rojo si < 0, verde si > 0 */
  signo?: boolean;
}

/**
 * Hoja con título, subtítulo, encabezados con estilo, filtros, fila de totales
 * y la cabecera congelada.
 */
function hoja(wb: ExcelJS.Workbook, nombre: string, titulo: string, subtitulo: string, cols: Col[], filas: Array<Record<string, unknown>>, opts: { fmtPorFila?: (f: Record<string, unknown>) => string | undefined; totales?: boolean } = {}) {
  const ws = wb.addWorksheet(nombre, { views: [{ state: 'frozen', ySplit: 4 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = cols.map((c) => ({ key: c.key, width: c.width }));
  ws.mergeCells(1, 1, 1, cols.length);
  ws.getCell(1, 1).value = titulo;
  ws.getCell(1, 1).font = { bold: true, size: 15, color: { argb: NARANJA } };
  ws.mergeCells(2, 1, 2, cols.length);
  ws.getCell(2, 1).value = subtitulo;
  ws.getCell(2, 1).font = { italic: true, size: 10, color: { argb: 'FF666666' } };

  const head = ws.getRow(4);
  cols.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRIS } };
    cell.alignment = { vertical: 'middle', horizontal: c.fmt && !c.fmt.includes('yy') ? 'right' : 'left', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: NARANJA } } };
  });
  head.height = 30;

  filas.forEach((f, idx) => {
    const row = ws.getRow(5 + idx);
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.value = (f[c.key] ?? null) as ExcelJS.CellValue;
      const fmtFila = opts.fmtPorFila?.(f);
      if (c.fmt) cell.numFmt = c.fmt === 'MONEDA' ? (fmtFila ?? FMT_REF) : c.fmt;
      if (c.signo && typeof cell.value === 'number' && cell.value !== 0) cell.font = { bold: true, color: { argb: cell.value < 0 ? ROJO : AZUL } };
      cell.alignment = { vertical: 'top', wrapText: !c.fmt };
    });
    if (f._anulado) row.font = { strike: true, color: { argb: 'FF9E9E9E' } };
    if (idx % 2) row.eachCell((cell) => (cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F7F7' } }));
  });

  const ultima = 4 + filas.length;
  if (filas.length) ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: ultima, column: cols.length } };
  if (opts.totales !== false && filas.length && cols.some((c) => c.total)) {
    const tot = ws.getRow(ultima + 1);
    tot.getCell(1).value = 'TOTAL';
    cols.forEach((c, i) => {
      if (!c.total) return;
      const letra = ws.getColumn(i + 1).letter;
      const cell = tot.getCell(i + 1);
      cell.value = { formula: `SUBTOTAL(9,${letra}5:${letra}${ultima})` };
      cell.numFmt = c.fmt === 'MONEDA' ? FMT_REF : (c.fmt ?? '#,##0');
    });
    tot.font = { bold: true };
    tot.eachCell((cell) => {
      cell.border = { top: { style: 'medium', color: { argb: NARANJA } } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3E0' } };
    });
  }
  if (!filas.length) {
    ws.getCell(5, 1).value = 'Sin registros en este periodo';
    ws.getCell(5, 1).font = { italic: true, color: { argb: 'FF999999' } };
  }
  return ws;
}

const FECHA_HORA = 'dd/mm/yyyy h:mm AM/PM';

async function ventasDeTurnos(ids: string[]) {
  if (!ids.length) return [];
  return db
    .selectFrom('ventas as v')
    .innerJoin('usuarios as u', 'u.id', 'v.cajeroId')
    .innerJoin('turnos as t', 't.id', 'v.turnoId')
    .leftJoin('socios as s', 's.id', 'v.socioId')
    .select([
      'v.numero',
      'v.creadoEn',
      'v.totalRef',
      'v.pagadoRef',
      'v.estado',
      'v.motivoAnulacion',
      'u.nombre as cajero',
      't.numero as turno',
      sql<string | null>`nullif(trim(s.nombre || ' ' || s.apellido), '')`.as('socio'),
      sql<string>`(select string_agg(i.descripcion || case when i.cantidad > 1 then ' ×' || i.cantidad else '' end, ', ' order by i.id) from venta_items i where i.venta_id = v.id)`.as('detalle'),
      sql<string>`(select string_agg(case when p.es_vuelto then 'Vuelto ' else '' end || m.nombre || ' ' || case p.moneda when 'VES' then 'Bs' when 'COP' then 'COP' else '$' end || ' ' || to_char(abs(p.monto_moneda), 'FM999G999G999G990D00') || coalesce(' (ref ' || p.referencia || ')', ''), ' · ' order by p.id) from venta_pagos p join metodos_pago m on m.codigo = p.metodo where p.venta_id = v.id)`.as('pagos'),
    ])
    .where('v.turnoId', 'in', ids)
    .orderBy('v.creadoEn')
    .execute();
}

const colsMovimientos: Col[] = [
  { header: 'Fecha', key: 'fecha', width: 20, fmt: FECHA_HORA },
  { header: 'Turno', key: 'turno', width: 8 },
  { header: 'Tipo', key: 'tipo', width: 10 },
  { header: 'Categoría', key: 'categoria', width: 16 },
  { header: 'Concepto', key: 'concepto', width: 34 },
  { header: 'Método', key: 'metodo', width: 16 },
  { header: 'Moneda', key: 'moneda', width: 9 },
  { header: 'Monto (+ ingreso / − gasto)', key: 'monto', width: 16, fmt: 'MONEDA' },
  { header: `Equivale (${REF})`, key: 'montoRef', width: 16, fmt: 'MONEDA', total: true },
  { header: 'Referencia', key: 'referencia', width: 16 },
  { header: 'Registró', key: 'usuario', width: 16 },
  { header: 'Anulado', key: 'anulado', width: 30 },
];

type Mov = Awaited<ReturnType<typeof listarMovimientos>>[number];
const filaMovimiento = (m: Mov) => {
  const signo = m.tipo === 'egreso' ? -1 : 1;
  return {
    fecha: local(m.creadoEn),
    turno: m.turno ? `#${m.turno}` : 'Admin.',
    tipo: m.tipo === 'egreso' ? 'Gasto' : 'Ingreso',
    categoria: m.categoria,
    concepto: m.concepto,
    metodo: m.metodoNombre,
    moneda: INFO[m.moneda as Moneda].simbolo,
    monto: signo * n(m.monto),
    montoRef: m.anulado ? 0 : signo * n(m.montoRef),
    referencia: m.referencia,
    usuario: m.usuario,
    anulado: m.anulado ? `Sí${m.motivoAnulacion ? ` — ${m.motivoAnulacion}` : ''}` : '',
    _moneda: m.moneda,
    _anulado: m.anulado,
  };
};
const fmtMoneda = (f: Record<string, unknown>) => (f._moneda ? formato(f._moneda as Moneda) : undefined);

function rango(desde?: string, hasta?: string) {
  const f = (s?: string) => (s ? s.split('-').reverse().join('/') : '…');
  return desde || hasta ? `del ${f(desde)} al ${f(hasta)}` : 'todas las fechas';
}

async function libro(quien: string) {
  const wb = new ExcelJS.Workbook();
  const gym = await getConfig('gym');
  wb.creator = gym.nombre;
  wb.created = new Date();
  return { wb, gym, pie: `${gym.nombre} · Generado por ${quien} el ${new Date().toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' })} · Montos de referencia en ${INFO[MONEDA_REF].nombre.toLowerCase()}` };
}

async function enviar(res: Response, wb: ExcelJS.Workbook, archivo: string) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${archivo}"`);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  await wb.xlsx.write(res);
  res.end();
}

/** Cierres de caja: un turno (ids) o un rango con filtros. */
export async function excelCierres(res: Response, filtro: { ids?: string[]; desde?: string; hasta?: string; estado?: string; cajeroId?: string }, quien: string) {
  const turnos = await resumenTurnos(filtro);
  const ids = turnos.map((t) => t.id);
  const [ventas, movs, { wb, gym, pie }] = await Promise.all([ventasDeTurnos(ids), Promise.all(ids.map((id) => listarMovimientos({ turnoId: id }))).then((l) => l.flat()), libro(quien)]);
  const uno = filtro.ids?.length === 1 ? turnos[0] : undefined;
  const titulo = uno ? `Cierre de caja · Turno #${uno.numero} · ${uno.cajero}` : `Cierres de caja · ${gym.nombre}`;
  const sub = uno ? `Abrió ${local(uno.abiertoEn)?.toISOString().slice(0, 16).replace('T', ' ')} · ${ESTADO_TURNO[uno.estado]} · ${pie}` : `${rango(filtro.desde, filtro.hasta)} · ${turnos.length} turno(s) · ${pie}`;

  // 1. Resumen por turno
  hoja(
    wb,
    'Resumen',
    titulo,
    sub,
    [
      { header: 'Turno', key: 'turno', width: 8 },
      { header: 'Cajera', key: 'cajero', width: 18 },
      { header: 'Abrió', key: 'abierto', width: 20, fmt: FECHA_HORA },
      { header: 'Cerró', key: 'cerrado', width: 20, fmt: FECHA_HORA },
      { header: 'Estado', key: 'estado', width: 12 },
      { header: 'Ventas', key: 'ops', width: 8, fmt: '0', total: true },
      { header: 'Anuladas', key: 'anuladas', width: 9, fmt: '0', total: true },
      { header: `Vendido (${REF})`, key: 'vendido', width: 15, fmt: 'MONEDA', total: true },
      { header: `Cobrado (${REF})`, key: 'cobrado', width: 15, fmt: 'MONEDA', total: true },
      { header: `Fiado (${REF})`, key: 'fiado', width: 13, fmt: 'MONEDA', total: true },
      { header: `Ingresos (${REF})`, key: 'ingresos', width: 14, fmt: 'MONEDA', total: true },
      { header: `Gastos (${REF})`, key: 'egresos', width: 14, fmt: 'MONEDA', total: true },
      { header: `Entregó (${REF})`, key: 'declarado', width: 15, fmt: 'MONEDA', total: true },
      { header: `Diferencia (${REF})`, key: 'diferencia', width: 15, fmt: 'MONEDA', total: true, signo: true },
      { header: 'Resultado', key: 'resultado', width: 12 },
      { header: 'Nota de la cajera', key: 'notaCajero', width: 28 },
      { header: 'Nota de revisión', key: 'notaDueno', width: 28 },
    ],
    turnos.map((t) => ({
      turno: `#${t.numero}`,
      cajero: t.cajero,
      abierto: local(t.abiertoEn),
      cerrado: local(t.cerradoEn),
      estado: ESTADO_TURNO[t.estado],
      ops: t.operaciones,
      anuladas: t.anuladas,
      vendido: n(t.totalVendidoRef),
      cobrado: n(t.cobradoRef),
      fiado: n(t.fiadoRef),
      ingresos: n(t.ingresosRef),
      egresos: n(t.egresosRef),
      declarado: t.estado === 'abierto' ? null : n(t.totalDeclaradoRef),
      diferencia: t.estado === 'abierto' ? null : n(t.diferencia),
      resultado: t.estado === 'abierto' ? 'Abierto' : !t.declaro ? 'Sin declarar' : t.diferencia < 0 ? 'Faltante' : t.diferencia > 0 ? 'Sobrante' : 'Cuadrado',
      notaCajero: t.notaCajero,
      notaDueno: t.notaDueno,
    })),
  );

  // 2. Arqueo por método y moneda de cada turno
  const fmtArq = (f: Record<string, unknown>) => fmtMoneda(f);
  hoja(
    wb,
    'Arqueo por método',
    'Arqueo por método y moneda',
    'Esperado = fondo + cobrado − vueltos + ingresos − gastos. Diferencia = lo que entregó − lo esperado (negativo = faltante). Montos en la moneda de cada fila.',
    [
      { header: 'Turno', key: 'turno', width: 8 },
      { header: 'Cajera', key: 'cajero', width: 18 },
      { header: 'Fecha', key: 'fecha', width: 20, fmt: FECHA_HORA },
      { header: 'Método', key: 'metodo', width: 18 },
      { header: 'Moneda', key: 'moneda', width: 9 },
      { header: 'Fondo', key: 'fondo', width: 12, fmt: 'MONEDA' },
      { header: 'Cobrado', key: 'cobrado', width: 14, fmt: 'MONEDA' },
      { header: 'Vueltos', key: 'vueltos', width: 12, fmt: 'MONEDA' },
      { header: 'Ingresos', key: 'ingresos', width: 12, fmt: 'MONEDA' },
      { header: 'Gastos', key: 'egresos', width: 12, fmt: 'MONEDA' },
      { header: 'Esperado', key: 'esperado', width: 14, fmt: 'MONEDA' },
      { header: 'Entregó', key: 'declarado', width: 14, fmt: 'MONEDA' },
      { header: 'Diferencia', key: 'diferencia', width: 13, fmt: 'MONEDA', signo: true },
      { header: `Diferencia (${REF})`, key: 'diferenciaRef', width: 15, fmt: FMT_REF, total: true, signo: true },
    ],
    turnos.flatMap((t) =>
      t.metodos.map((m) => ({
        turno: `#${t.numero}`,
        cajero: t.cajero,
        fecha: local(t.abiertoEn),
        metodo: m.nombre,
        moneda: INFO[m.moneda].simbolo,
        fondo: m.fondo || null,
        cobrado: m.cobrado,
        vueltos: m.vueltos ? -m.vueltos : null,
        ingresos: m.ingresos || null,
        egresos: m.egresos ? -m.egresos : null,
        esperado: m.esperado,
        declarado: t.estado === 'abierto' ? null : m.declarado,
        diferencia: t.estado === 'abierto' ? null : m.diferencia,
        diferenciaRef: t.estado === 'abierto' ? null : m.diferenciaRef,
        _moneda: m.moneda,
      })),
    ),
    { fmtPorFila: fmtArq },
  );

  // 3. Totales por método y moneda (suma de todos los turnos)
  const tot = new Map<string, { metodo: string; moneda: Moneda; cobrado: number; vueltos: number; ingresos: number; egresos: number; esperado: number; declarado: number; diferencia: number }>();
  for (const t of turnos)
    for (const m of t.metodos) {
      const k = `${m.nombre}|${m.moneda}`;
      const x = tot.get(k) ?? { metodo: m.nombre, moneda: m.moneda, cobrado: 0, vueltos: 0, ingresos: 0, egresos: 0, esperado: 0, declarado: 0, diferencia: 0 };
      x.cobrado += m.cobrado;
      x.vueltos += m.vueltos;
      x.ingresos += m.ingresos;
      x.egresos += m.egresos;
      x.esperado += m.esperado;
      if (t.estado !== 'abierto') {
        x.declarado += m.declarado;
        x.diferencia += m.diferencia;
      }
      tot.set(k, x);
    }
  hoja(
    wb,
    'Totales por método',
    'Totales por método y moneda',
    `${rango(filtro.desde, filtro.hasta)} · cada fila en su moneda (no se suman monedas distintas)`,
    [
      { header: 'Método', key: 'metodo', width: 20 },
      { header: 'Moneda', key: 'moneda', width: 9 },
      { header: 'Cobrado', key: 'cobrado', width: 15, fmt: 'MONEDA' },
      { header: 'Vueltos', key: 'vueltos', width: 13, fmt: 'MONEDA' },
      { header: 'Ingresos', key: 'ingresos', width: 13, fmt: 'MONEDA' },
      { header: 'Gastos', key: 'egresos', width: 13, fmt: 'MONEDA' },
      { header: 'Esperado', key: 'esperado', width: 15, fmt: 'MONEDA' },
      { header: 'Entregado', key: 'declarado', width: 15, fmt: 'MONEDA' },
      { header: 'Diferencia', key: 'diferencia', width: 14, fmt: 'MONEDA', signo: true },
    ],
    [...tot.values()].map((x) => ({ ...x, moneda: INFO[x.moneda].simbolo, vueltos: x.vueltos ? -n(x.vueltos) : null, egresos: x.egresos ? -n(x.egresos) : null, diferencia: n(x.diferencia), _moneda: x.moneda })),
    { fmtPorFila: fmtMoneda, totales: false },
  );

  // 4. Ventas
  hoja(
    wb,
    'Ventas',
    'Ventas de los turnos',
    `${ventas.length} venta(s) · las anuladas aparecen tachadas y no suman`,
    [
      { header: 'N°', key: 'numero', width: 8 },
      { header: 'Fecha', key: 'fecha', width: 20, fmt: FECHA_HORA },
      { header: 'Turno', key: 'turno', width: 8 },
      { header: 'Cajera', key: 'cajero', width: 16 },
      { header: 'Cliente', key: 'socio', width: 22 },
      { header: 'Detalle', key: 'detalle', width: 36 },
      { header: 'Pagos', key: 'pagos', width: 44 },
      { header: `Total (${REF})`, key: 'total', width: 14, fmt: 'MONEDA', total: true },
      { header: `Pagado (${REF})`, key: 'pagado', width: 14, fmt: 'MONEDA', total: true },
      { header: 'Estado', key: 'estado', width: 30 },
    ],
    ventas.map((v) => ({
      numero: v.numero,
      fecha: local(v.creadoEn),
      turno: `#${v.turno}`,
      cajero: v.cajero,
      socio: v.socio ?? 'Cliente de paso',
      detalle: v.detalle,
      pagos: v.pagos,
      total: v.estado === 'anulada' ? 0 : n(v.totalRef),
      pagado: v.estado === 'anulada' ? 0 : n(v.pagadoRef),
      estado: v.estado === 'anulada' ? `Anulada${v.motivoAnulacion ? ` — ${v.motivoAnulacion}` : ''}` : 'Pagada',
      _anulado: v.estado === 'anulada',
    })),
  );

  // 5. Movimientos de los turnos
  hoja(wb, 'Movimientos', 'Ingresos y gastos de caja', `${movs.length} movimiento(s) en los turnos · monto en su moneda; la columna de equivalencia suma todo en ${REF}`, colsMovimientos, movs.map(filaMovimiento), { fmtPorFila: fmtMoneda });

  const archivo = uno ? `cierre-turno-${uno.numero}.xlsx` : `cierres-${filtro.desde ?? 'inicio'}_a_${filtro.hasta ?? 'hoy'}.xlsx`;
  await enviar(res, wb, archivo);
}

/** Movimientos de caja y administración (finanzas) en un rango. */
export async function excelMovimientos(res: Response, filtro: { desde?: string; hasta?: string; tipo?: 'ingreso' | 'egreso' }, quien: string) {
  const [movs, { wb, gym, pie }] = await Promise.all([listarMovimientos({ ...filtro, limite: 10_000 }), libro(quien)]);
  const asc = [...movs].reverse();
  hoja(wb, 'Movimientos', `Ingresos y gastos · ${gym.nombre}`, `${rango(filtro.desde, filtro.hasta)} · ${movs.length} movimiento(s) · ${pie}`, colsMovimientos, asc.map(filaMovimiento), { fmtPorFila: fmtMoneda });

  // Totales por categoría y moneda (sin anulados)
  const tot = new Map<string, { tipo: string; categoria: string; moneda: Moneda; cantidad: number; monto: number; montoRef: number }>();
  for (const m of movs) {
    if (m.anulado) continue;
    const k = `${m.tipo}|${m.categoria}|${m.moneda}`;
    const x = tot.get(k) ?? { tipo: m.tipo === 'egreso' ? 'Gasto' : 'Ingreso', categoria: m.categoria, moneda: m.moneda as Moneda, cantidad: 0, monto: 0, montoRef: 0 };
    const s = m.tipo === 'egreso' ? -1 : 1;
    x.cantidad++;
    x.monto += s * Number(m.monto);
    x.montoRef += s * Number(m.montoRef);
    tot.set(k, x);
  }
  hoja(
    wb,
    'Totales',
    'Totales por categoría',
    'Sin movimientos anulados · gastos en negativo',
    [
      { header: 'Tipo', key: 'tipo', width: 10 },
      { header: 'Categoría', key: 'categoria', width: 22 },
      { header: 'Moneda', key: 'moneda', width: 9 },
      { header: 'Cantidad', key: 'cantidad', width: 10, fmt: '0', total: true },
      { header: 'Monto', key: 'monto', width: 16, fmt: 'MONEDA', signo: true },
      { header: `Equivale (${REF})`, key: 'montoRef', width: 16, fmt: FMT_REF, total: true, signo: true },
    ],
    [...tot.values()].sort((a, b) => a.tipo.localeCompare(b.tipo) || a.categoria.localeCompare(b.categoria)).map((x) => ({ ...x, moneda: INFO[x.moneda].simbolo, monto: n(x.monto), montoRef: n(x.montoRef), _moneda: x.moneda })),
    { fmtPorFila: fmtMoneda },
  );
  await enviar(res, wb, `movimientos-${filtro.desde ?? 'inicio'}_a_${filtro.hasta ?? 'hoy'}.xlsx`);
}
