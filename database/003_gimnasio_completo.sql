-- ═══════════════════════════════════════════════════════════════════
--  MERKGUSTO · Remodelación completa
--   • Tasas por PAR de monedas (regla de tres): $→Bs, $→COP, Bs→COP
--   • Precios en la moneda de cada plan/producto (agua 4.500 COP)
--   • Planes mes a mes (días/semanas/meses/años), grupales y congelables
--   • Pagos parciales → deudas por cobrar; abonos por caja
--   • Ingresos/egresos de caja dentro del cierre ciego
--   • Rol "administrador de caja"
--   • Entrenadores: marcaciones con foto, retiros y permisos
--   • Archivos (Supabase Storage o disco local)
-- ═══════════════════════════════════════════════════════════════════

-- ── Moneda de referencia contable (para sumar todo en un solo número) ──
-- Se fija una vez: la del .env MONEDA_REFERENCIA (por defecto COP).

-- ── Tasas: historial de versiones (la vigente es la última) ──────────
create table tasas (
  id            bigint generated always as identity primary key,
  usd_ves       numeric(18,6) not null check (usd_ves > 0),   -- bolívares por 1 dólar (BCV / paralelo / manual)
  usd_cop       numeric(18,6) not null check (usd_cop > 0),   -- pesos por 1 dólar
  ves_cop       numeric(18,6) not null check (ves_cop > 0),   -- pesos por 1 bolívar (regla de tres: 1.000 Bs × 3 = 3.000 COP)
  fuente_usd_ves varchar(12) not null default 'manual' check (fuente_usd_ves in ('manual', 'bcv', 'paralelo')),
  fuente_usd_cop varchar(12) not null default 'manual' check (fuente_usd_cop in ('manual', 'trm')),
  nota          varchar(200),
  creado_por    uuid references usuarios(id),
  creado_en     timestamptz not null default now()
);
-- Tasa inicial a partir de la configuración anterior (si existía)
insert into tasas (usd_ves, usd_cop, ves_cop, nota)
select
  coalesce((valor->'tasas'->>'VES')::numeric, 40),
  coalesce((valor->'tasas'->>'COP')::numeric, 4000),
  round(coalesce((valor->'tasas'->>'COP')::numeric, 4000) / coalesce((valor->'tasas'->>'VES')::numeric, 40), 4),
  'Migrada de la configuración anterior'
from (select valor from configuracion where clave = 'monedas' union all select null::jsonb limit 1) c
limit 1;

-- ── Usuarios: rol administrador de caja ──────────────────────────────
alter table usuarios drop constraint usuarios_rol_check;
alter table usuarios add constraint usuarios_rol_check check (rol in ('dueno', 'admin_caja', 'cajero'));

-- ── Métodos de pago: los de Venezuela y Colombia ─────────────────────
insert into metodos_pago (codigo, nombre, pide_referencia, orden, monedas) values
  ('bancolombia', 'Bancolombia', true, 6, '{COP}'),
  ('nequi', 'Nequi', true, 7, '{COP}'),
  ('daviplata', 'Daviplata', true, 8, '{COP}'),
  ('binance', 'Binance USDT', true, 9, '{USD}')
on conflict (codigo) do nothing;
update metodos_pago set monedas = '{VES}' where codigo = 'transferencia';
update metodos_pago set nombre = 'Transferencia Bs' where codigo = 'transferencia' and nombre = 'Transferencia';
alter table metodos_pago add column es_sistema boolean not null default false;
update metodos_pago set es_sistema = true where codigo = 'efectivo';

-- ── Planes: precio en su moneda, duración por unidades, grupales ────
alter table planes add column moneda varchar(3) not null default 'USD' check (moneda in ('USD', 'VES', 'COP'));
alter table planes add column tipo_duracion varchar(8) not null default 'dias' check (tipo_duracion in ('dias', 'semanas', 'meses', 'anios'));
alter table planes add column cantidad integer not null default 1 check (cantidad > 0);
alter table planes add column personas integer not null default 1 check (personas between 1 and 10);
alter table planes add column congelable boolean not null default true;
alter table planes add column max_dias_congelado integer not null default 30;
update planes set tipo_duracion = 'meses', cantidad = 1 where duracion_dias in (30, 31);
update planes set tipo_duracion = 'meses', cantidad = 3 where duracion_dias = 90;
update planes set tipo_duracion = 'meses', cantidad = 6 where duracion_dias in (180, 182);
update planes set tipo_duracion = 'anios', cantidad = 1 where duracion_dias in (365, 366);
update planes set tipo_duracion = 'semanas', cantidad = 1 where duracion_dias = 7;
update planes set tipo_duracion = 'dias', cantidad = duracion_dias where tipo_duracion = 'dias';
update planes set congelable = false where tipo_duracion = 'dias' or (tipo_duracion = 'semanas');

-- ── Productos: precio en su moneda ───────────────────────────────────
alter table productos add column moneda varchar(3) not null default 'USD' check (moneda in ('USD', 'VES', 'COP'));
alter table productos add column costo numeric(14,2) not null default 0;

-- ── Membresías: congelar, grupos, renovaciones ───────────────────────
alter table membresias drop constraint membresias_estado_check;
alter table membresias add constraint membresias_estado_check check (estado in ('activa', 'congelada', 'anulada', 'reemplazada'));
alter table membresias add column moneda varchar(3) not null default 'USD';
alter table membresias add column grupo_id uuid;
alter table membresias add column congelada_desde date;
alter table membresias add column dias_congelados integer not null default 0;
alter table membresias add column notas text;
create index membresias_grupo_idx on membresias (grupo_id) where grupo_id is not null;

-- ── Ventas multimoneda (con referencia contable) ─────────────────────
alter table ventas add column moneda_ref varchar(3) not null default 'COP';
alter table ventas add column total_ref numeric(18,2);
alter table ventas add column totales jsonb;           -- total en USD, VES y COP al momento de vender
alter table ventas add column pagado_ref numeric(18,2);
update ventas set
  total_ref = round(total * coalesce((tasas->>'COP')::numeric, 4000), 0),
  pagado_ref = round(total * coalesce((tasas->>'COP')::numeric, 4000), 0);
alter table ventas alter column total_ref set not null;
alter table ventas alter column pagado_ref set not null;
alter table ventas alter column total set default 0;

alter table venta_items drop constraint venta_items_tipo_check;
alter table venta_items add constraint venta_items_tipo_check check (tipo in ('membresia', 'producto', 'abono'));
alter table venta_items add column moneda varchar(3) not null default 'USD';
alter table venta_items add column subtotal_ref numeric(18,2);
alter table venta_items add column datos jsonb;          -- acompañantes, renovación desde, etc.
update venta_items i set subtotal_ref = round(i.subtotal * coalesce((v.tasas->>'COP')::numeric, 4000), 0) from ventas v where v.id = i.venta_id;
alter table venta_items alter column subtotal_ref set not null;

alter table venta_pagos add column fraccion numeric(14,10);
alter table venta_pagos add column monto_ref numeric(18,2);
update venta_pagos p set
  monto_ref = round(p.monto * coalesce((v.tasas->>'COP')::numeric, 4000), 0),
  fraccion = case when v.total > 0 then p.monto / v.total else 0 end
from ventas v where v.id = p.venta_id;
alter table venta_pagos alter column monto_ref set not null;
alter table venta_pagos alter column fraccion set not null;
alter table venta_pagos alter column monto set default 0;
alter table venta_pagos drop constraint if exists venta_pagos_monto_check;
alter table venta_pagos add constraint venta_pagos_monto_check check (monto_moneda <> 0 and (es_vuelto = (monto_moneda < 0)));

-- ── Deudas (cuentas por cobrar) ──────────────────────────────────────
create table deudas (
  id            bigint generated always as identity primary key,
  socio_id      uuid not null references socios(id),
  venta_id      uuid references ventas(id),
  concepto      varchar(200) not null,
  moneda        varchar(3) not null,                 -- moneda de referencia
  monto_total   numeric(18,2) not null check (monto_total > 0),
  saldo         numeric(18,2) not null check (saldo >= 0),
  estado        varchar(10) not null default 'pendiente' check (estado in ('pendiente', 'pagada', 'anulada')),
  creado_por    uuid references usuarios(id),
  creado_en     timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index deudas_socio_idx on deudas (socio_id) where estado = 'pendiente';

-- ── Movimientos de caja: ingresos y egresos ──────────────────────────
-- Si tienen turno, entran en lo esperado del cierre ciego de esa cajera.
create table caja_movimientos (
  id             bigint generated always as identity primary key,
  turno_id       uuid references turnos(id),
  usuario_id     uuid not null references usuarios(id),
  tipo           varchar(8)  not null check (tipo in ('ingreso', 'egreso')),
  categoria      varchar(40) not null,
  concepto       varchar(200) not null,
  metodo         varchar(20) not null references metodos_pago(codigo),
  moneda         varchar(3)  not null check (moneda in ('USD', 'VES', 'COP')),
  monto          numeric(18,2) not null check (monto > 0),
  monto_ref      numeric(18,2) not null,
  tasas          jsonb,
  referencia     varchar(80),
  comprobante_id bigint,
  anulado        boolean not null default false,
  anulado_por    uuid references usuarios(id),
  motivo_anulacion varchar(200),
  creado_en      timestamptz not null default now()
);
create index caja_mov_fecha_idx on caja_movimientos (creado_en desc);
create index caja_mov_turno_idx on caja_movimientos (turno_id);

-- ── Archivos (fotos de marcaciones, soportes, comprobantes) ──────────
create table archivos (
  id          bigint generated always as identity primary key,
  proveedor   varchar(10) not null check (proveedor in ('supabase', 'local')),
  bucket      varchar(60),
  ruta        varchar(300) not null,
  mime        varchar(60) not null,
  bytes       integer not null,
  creado_por  uuid references usuarios(id),
  creado_en   timestamptz not null default now()
);
alter table caja_movimientos add constraint caja_mov_comprobante_fk foreign key (comprobante_id) references archivos(id);

-- ── Entrenadores ─────────────────────────────────────────────────────
create table entrenadores (
  id            uuid primary key default gen_random_uuid(),
  codigo        integer generated always as identity (start with 1) unique,
  nombre        varchar(80) not null,
  apellido      varchar(80) not null default '',
  cedula        varchar(20) unique,
  telefono      varchar(30),
  especialidad  varchar(80),
  foto          text,                         -- rostro (JPEG base64) para el lector
  pin_hash      varchar(120) not null,
  horario       jsonb not null default '{}',  -- { "1": { "entrada": "06:00", "salida": "14:00" }, ... } (1 = lunes)
  activo        boolean not null default true,
  bio_estado    varchar(15) not null default 'sin_rostro' check (bio_estado in ('sin_rostro', 'pendiente', 'sincronizado', 'error')),
  bio_error     text,
  creado_en     timestamptz not null default now()
);

create table entrenador_marcaciones (
  id             bigint generated always as identity primary key,
  entrenador_id  uuid not null references entrenadores(id),
  tipo           varchar(8) not null check (tipo in ('entrada', 'salida', 'retiro', 'regreso')),
  fecha_hora     timestamptz not null default now(),
  origen         varchar(8) not null check (origen in ('kiosko', 'lector', 'manual')),
  foto_id        bigint references archivos(id),
  nota           varchar(250),
  minutos_tarde  integer,
  registrado_por uuid references usuarios(id),
  anulada        boolean not null default false
);
create index ent_marc_idx on entrenador_marcaciones (entrenador_id, fecha_hora desc);

create table entrenador_permisos (
  id              bigint generated always as identity primary key,
  entrenador_id   uuid not null references entrenadores(id),
  tipo            varchar(12) not null check (tipo in ('permiso', 'vacaciones', 'reposo', 'diligencia', 'otro')),
  desde           timestamptz not null,
  hasta           timestamptz not null,
  motivo          varchar(300) not null,
  soporte_id      bigint references archivos(id),
  estado          varchar(10) not null default 'pendiente' check (estado in ('pendiente', 'aprobado', 'rechazado')),
  resuelto_por    uuid references usuarios(id),
  resuelto_en     timestamptz,
  nota_resolucion varchar(250),
  creado_en       timestamptz not null default now(),
  check (hasta > desde)
);

-- Cola del lector: también sincroniza entrenadores
alter table bio_cola add column entrenador_id uuid references entrenadores(id) on delete cascade;
alter table asistencias add column entrenador_id uuid references entrenadores(id);
alter table asistencias drop constraint asistencias_origen_check;
alter table asistencias add constraint asistencias_origen_check check (origen in ('biometrico', 'manual', 'simulado'));
