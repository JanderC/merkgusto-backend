-- Sistema completo del gimnasio:
--   • Compras a proveedores con costo → costo promedio de cada producto y utilidad real.
--   • Kardex: cada unidad que entra o sale del inventario queda registrada con su motivo.
--   • Conteo físico (ciego): se cuenta lo que hay, el sistema compara y registra el faltante.
--   • Pago a entrenadores según horas marcadas, clases dictadas o monto fijo.
--   • Progreso del cliente (medidas) y rutina asignada, visibles en su portal personal.

-- ── Proveedores y compras ───────────────────────────────────────────
create table proveedores (
  id          serial primary key,
  nombre      varchar(100) not null,
  documento   varchar(30),                -- RIF / NIT
  telefono    varchar(30),
  contacto    varchar(80),
  notas       varchar(300),
  activo      boolean not null default true,
  creado_en   timestamptz not null default now()
);

create table compras (
  id               integer generated always as identity (start with 1) primary key,
  proveedor_id     integer references proveedores(id),
  factura          varchar(40),
  fecha            date not null default current_date,
  moneda           varchar(3) not null check (moneda in ('USD', 'VES', 'COP')),
  total            numeric(18,2) not null check (total >= 0),
  total_ref        numeric(18,2) not null,
  saldo            numeric(18,2) not null default 0 check (saldo >= 0),   -- lo que falta pagarle al proveedor
  tasas            jsonb,
  estado           varchar(10) not null default 'pagada' check (estado in ('pagada', 'pendiente', 'anulada')),
  nota             varchar(300),
  soporte_id       bigint references archivos(id),
  registrado_por   uuid not null references usuarios(id),
  creado_en        timestamptz not null default now(),
  anulada_por      uuid references usuarios(id),
  anulada_en       timestamptz,
  motivo_anulacion varchar(200)
);
create index compras_fecha_idx on compras (fecha desc);
create index compras_proveedor_idx on compras (proveedor_id);

create table compra_items (
  id              integer generated always as identity primary key,
  compra_id       integer not null references compras(id) on delete cascade,
  producto_id     integer not null references productos(id),
  cantidad        integer not null check (cantidad > 0),
  costo_unitario  numeric(18,4) not null check (costo_unitario >= 0),   -- en la moneda de la compra
  subtotal        numeric(18,2) not null
);

-- Cada pago al proveedor es un egreso de finanzas (categoría "Compra de mercancía")
create table compra_pagos (
  id             integer generated always as identity primary key,
  compra_id      integer not null references compras(id),
  movimiento_id  bigint references caja_movimientos(id),
  metodo         varchar(20) not null references metodos_pago(codigo),
  moneda         varchar(3) not null,
  monto          numeric(18,2) not null check (monto > 0),
  registrado_por uuid not null references usuarios(id),
  creado_en      timestamptz not null default now()
);

-- ── Kardex ──────────────────────────────────────────────────────────
create table inventario_movimientos (
  id                bigint generated always as identity primary key,
  producto_id       integer not null references productos(id),
  tipo              varchar(16) not null check (tipo in ('venta', 'anulacion', 'devolucion', 'compra', 'compra_anulada', 'ajuste', 'conteo')),
  cantidad          integer not null,           -- + entra, − sale
  stock_resultante  integer,
  referencia        varchar(150),
  usuario_id        uuid references usuarios(id),
  creado_en         timestamptz not null default now()
);
create index inv_mov_producto_idx on inventario_movimientos (producto_id, creado_en desc);
create index inv_mov_fecha_idx on inventario_movimientos (creado_en desc);

-- ── Conteo físico ───────────────────────────────────────────────────
create table conteos (
  id            integer generated always as identity (start with 1) primary key,
  estado        varchar(10) not null default 'abierto' check (estado in ('abierto', 'cerrado', 'cancelado')),
  nota          varchar(300),
  creado_por    uuid not null references usuarios(id),
  creado_en     timestamptz not null default now(),
  cerrado_por   uuid references usuarios(id),
  cerrado_en    timestamptz,
  faltante_ref  numeric(18,2) not null default 0,   -- valor a costo de lo que faltó
  sobrante_ref  numeric(18,2) not null default 0
);
-- Solo un conteo abierto a la vez
create unique index conteos_un_abierto_idx on conteos ((estado)) where estado = 'abierto';

create table conteo_items (
  id           integer generated always as identity primary key,
  conteo_id    integer not null references conteos(id) on delete cascade,
  producto_id  integer not null references productos(id),
  contado      integer not null check (contado >= 0),
  esperado     integer,          -- lo que decía el sistema al cerrar
  diferencia   integer,          -- contado − esperado
  costo        numeric(18,4),    -- costo unitario al cerrar (moneda del producto)
  moneda       varchar(3),
  contado_por  uuid references usuarios(id),
  actualizado_en timestamptz not null default now(),
  unique (conteo_id, producto_id)
);

-- ── Pago a entrenadores ─────────────────────────────────────────────
alter table entrenadores add column pago_tipo varchar(10) not null default 'ninguno' check (pago_tipo in ('ninguno', 'fijo', 'por_hora', 'por_clase'));
alter table entrenadores add column pago_tarifa numeric(18,2) not null default 0 check (pago_tarifa >= 0);
alter table entrenadores add column pago_moneda varchar(3) not null default 'USD' check (pago_moneda in ('USD', 'VES', 'COP'));

create table entrenador_pagos (
  id              integer generated always as identity primary key,
  entrenador_id   uuid not null references entrenadores(id),
  desde           date not null,
  hasta           date not null,
  pago_tipo       varchar(10) not null,
  tarifa          numeric(18,2) not null,
  horas           numeric(8,1) not null default 0,
  clases          integer not null default 0,
  monto_base      numeric(18,2) not null,
  bonos           numeric(18,2) not null default 0,
  descuentos      numeric(18,2) not null default 0,
  total           numeric(18,2) not null check (total >= 0),
  moneda          varchar(3) not null,
  metodo          varchar(20) not null references metodos_pago(codigo),
  movimiento_id   bigint references caja_movimientos(id),
  nota            varchar(300),
  registrado_por  uuid not null references usuarios(id),
  creado_en       timestamptz not null default now(),
  anulado         boolean not null default false,
  check (hasta >= desde)
);
create index ent_pagos_idx on entrenador_pagos (entrenador_id, hasta desc);

-- ── Progreso y rutina del cliente ───────────────────────────────────
create table socio_mediciones (
  id              integer generated always as identity primary key,
  socio_id        uuid not null references socios(id) on delete cascade,
  fecha           date not null default current_date,
  peso            numeric(5,1),
  grasa           numeric(4,1),
  musculo         numeric(4,1),
  cintura         numeric(5,1),
  cadera          numeric(5,1),
  pecho           numeric(5,1),
  brazo           numeric(5,1),
  pierna          numeric(5,1),
  nota            varchar(300),
  registrado_por  uuid references usuarios(id),
  creado_en       timestamptz not null default now()
);
create index socio_med_idx on socio_mediciones (socio_id, fecha desc);

create table socio_rutinas (
  id              integer generated always as identity primary key,
  socio_id        uuid not null references socios(id) on delete cascade,
  titulo          varchar(100) not null,
  objetivo        varchar(150),
  -- [{ "nombre": "Día 1 · Pecho y tríceps", "ejercicios": [{ "nombre": "Press banca", "series": "4", "reps": "10", "nota": "" }] }]
  dias            jsonb not null default '[]',
  entrenador_id   uuid references entrenadores(id),
  activa          boolean not null default true,
  creado_por      uuid references usuarios(id),
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);
create index socio_rut_idx on socio_rutinas (socio_id, activa);

-- Enlace personal del cliente (se guarda solo el hash; regenerarlo invalida el anterior)
alter table socios add column portal_token_hash varchar(64);
alter table socios add column portal_creado_en timestamptz;
create unique index socios_portal_idx on socios (portal_token_hash) where portal_token_hash is not null;
