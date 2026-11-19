-- ═══════════════════════════════════════════════════════════════════
--  MERKGUSTO GYM · Esquema inicial
--  Todas las fechas/horas son timestamptz; la sesión de la BD usa la
--  zona horaria del gimnasio (TZ en .env), así current_date es "hoy".
-- ═══════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ── Equipo ───────────────────────────────────────────────────────────
create table usuarios (
  id              uuid primary key default gen_random_uuid(),
  nombre          varchar(120) not null,
  usuario         varchar(60)  not null unique,
  password_hash   varchar(120) not null,
  rol             varchar(10)  not null check (rol in ('dueno', 'cajero')),
  telefono        varchar(30),
  activo          boolean      not null default true,
  creado_en       timestamptz  not null default now(),
  ultimo_acceso   timestamptz
);

-- ── Socios ───────────────────────────────────────────────────────────
-- "codigo" es el employeeNo que se registra en el lector facial.
create table socios (
  id                    uuid primary key default gen_random_uuid(),
  codigo                integer generated always as identity (start with 1001) unique,
  cedula                varchar(20) unique,
  nombre                varchar(80)  not null,
  apellido              varchar(80)  not null default '',
  telefono              varchar(30),
  email                 varchar(120),
  fecha_nacimiento      date,
  genero                varchar(1) check (genero in ('M', 'F', 'O')),
  foto                  text,
  notas                 text,
  activo                boolean     not null default true,
  bio_estado            varchar(15) not null default 'sin_rostro'
                          check (bio_estado in ('sin_rostro', 'pendiente', 'sincronizado', 'error')),
  bio_sincronizado_en   timestamptz,
  bio_error             text,
  creado_en             timestamptz not null default now(),
  actualizado_en        timestamptz not null default now()
);
create index socios_nombre_idx on socios (lower(nombre || ' ' || apellido));
create index socios_telefono_idx on socios (telefono);

-- ── Planes y membresías ──────────────────────────────────────────────
create table planes (
  id              serial primary key,
  nombre          varchar(80)   not null,
  descripcion     varchar(250),
  duracion_dias   integer       not null check (duracion_dias > 0),
  precio          numeric(12,2) not null check (precio >= 0),
  color           varchar(9)    not null default '#FF8A10',
  activo          boolean       not null default true,
  orden           integer       not null default 0,
  creado_en       timestamptz   not null default now()
);

create table productos (
  id              serial primary key,
  nombre          varchar(100)  not null,
  categoria       varchar(40)   not null default 'General',
  precio          numeric(12,2) not null check (precio >= 0),
  stock           integer       not null default 0,
  stock_minimo    integer       not null default 5,
  controla_stock  boolean       not null default true,
  activo          boolean       not null default true,
  creado_en       timestamptz   not null default now()
);

create table metodos_pago (
  codigo          varchar(20) primary key,
  nombre          varchar(40) not null,
  pide_referencia boolean     not null default false,
  activo          boolean     not null default true,
  orden           integer     not null default 0
);

-- ── Caja ciega: turnos ───────────────────────────────────────────────
-- La cajera abre su turno, cobra y lo cierra declarando lo que entrega.
-- Nunca ve lo esperado: eso solo lo ve el dueño.
create table turnos (
  id              uuid primary key default gen_random_uuid(),
  numero          integer generated always as identity unique,
  cajero_id       uuid        not null references usuarios(id),
  abierto_en      timestamptz not null default now(),
  cerrado_en      timestamptz,
  cerrado_por     uuid references usuarios(id),
  estado          varchar(10) not null default 'abierto' check (estado in ('abierto', 'cerrado', 'revisado')),
  fondo_inicial   numeric(12,2) not null default 0,
  nota_cajero     text,
  nota_dueno      text,
  revisado_por    uuid references usuarios(id),
  revisado_en     timestamptz
);
-- Una cajera solo puede tener un turno abierto
create unique index turnos_un_abierto_por_cajero on turnos (cajero_id) where estado = 'abierto';

create table turno_declaraciones (
  turno_id        uuid        not null references turnos(id) on delete cascade,
  metodo          varchar(20) not null references metodos_pago(codigo),
  monto           numeric(12,2) not null check (monto >= 0),
  primary key (turno_id, metodo)
);

create table ventas (
  id                uuid primary key default gen_random_uuid(),
  numero            integer generated always as identity unique,
  turno_id          uuid        not null references turnos(id),
  cajero_id         uuid        not null references usuarios(id),
  socio_id          uuid references socios(id),
  total             numeric(12,2) not null check (total >= 0),
  estado            varchar(10) not null default 'pagada' check (estado in ('pagada', 'anulada')),
  nota              varchar(250),
  creado_en         timestamptz not null default now(),
  anulada_por       uuid references usuarios(id),
  anulada_en        timestamptz,
  motivo_anulacion  varchar(250)
);
create index ventas_turno_idx on ventas (turno_id);
create index ventas_fecha_idx on ventas (creado_en);

create table venta_items (
  id               bigint generated always as identity primary key,
  venta_id         uuid        not null references ventas(id) on delete cascade,
  tipo             varchar(10) not null check (tipo in ('membresia', 'producto')),
  referencia_id    integer     not null,
  descripcion      varchar(150) not null,
  cantidad         integer     not null check (cantidad > 0),
  precio_unitario  numeric(12,2) not null,
  subtotal         numeric(12,2) not null
);
create index venta_items_venta_idx on venta_items (venta_id);

create table venta_pagos (
  id          bigint generated always as identity primary key,
  venta_id    uuid        not null references ventas(id) on delete cascade,
  metodo      varchar(20) not null references metodos_pago(codigo),
  monto       numeric(12,2) not null check (monto > 0),
  referencia  varchar(60)
);
create index venta_pagos_venta_idx on venta_pagos (venta_id);

create table membresias (
  id            uuid primary key default gen_random_uuid(),
  socio_id      uuid    not null references socios(id),
  plan_id       integer not null references planes(id),
  venta_id      uuid references ventas(id),
  fecha_inicio  date    not null,
  fecha_fin     date    not null,
  precio        numeric(12,2) not null,
  estado        varchar(10) not null default 'activa' check (estado in ('activa', 'anulada')),
  creado_en     timestamptz not null default now(),
  check (fecha_fin >= fecha_inicio)
);
create index membresias_socio_idx on membresias (socio_id, fecha_fin desc);

-- ── Asistencia (lector facial + manual) ──────────────────────────────
create table asistencias (
  id              bigint generated always as identity primary key,
  socio_id        uuid references socios(id),
  employee_no     varchar(32),
  fecha_hora      timestamptz not null default now(),
  origen          varchar(12) not null check (origen in ('biometrico', 'manual', 'simulado')),
  resultado       varchar(10) not null check (resultado in ('permitido', 'denegado')),
  motivo          varchar(200),
  alerta          varchar(200),
  dispositivo     varchar(64),
  evento_serial   varchar(64),
  metodo_verif    varchar(40),
  registrado_por  uuid references usuarios(id),
  payload         jsonb,
  creado_en       timestamptz not null default now()
);
create index asistencias_fecha_idx on asistencias (fecha_hora desc);
create index asistencias_socio_idx on asistencias (socio_id, fecha_hora desc);
-- Idempotencia: el lector reenvía eventos si no recibe respuesta
create unique index asistencias_evento_unico on asistencias (dispositivo, evento_serial)
  where evento_serial is not null;

-- ── Cola de sincronización con el lector (outbox) ────────────────────
create table bio_cola (
  id                bigint generated always as identity primary key,
  socio_id          uuid references socios(id) on delete cascade,
  operacion         varchar(20) not null check (operacion in ('sync_usuario', 'sync_rostro', 'eliminar')),
  estado            varchar(12) not null default 'pendiente' check (estado in ('pendiente', 'procesando', 'ok', 'error', 'descartado')),
  intentos          integer     not null default 0,
  proximo_intento   timestamptz not null default now(),
  ultimo_error      text,
  creado_en         timestamptz not null default now(),
  actualizado_en    timestamptz not null default now()
);
create index bio_cola_pendientes_idx on bio_cola (proximo_intento) where estado in ('pendiente', 'error');

-- ── WhatsApp ─────────────────────────────────────────────────────────
create table wa_mensajes (
  id          bigint generated always as identity primary key,
  direccion   varchar(10) not null check (direccion in ('entrante', 'saliente')),
  jid         varchar(80) not null,
  nombre      varchar(120),
  texto       text        not null,
  tipo        varchar(12) not null default 'chat' check (tipo in ('chat', 'bot', 'reporte', 'aviso', 'manual')),
  creado_en   timestamptz not null default now()
);
create index wa_mensajes_fecha_idx on wa_mensajes (creado_en desc);

create table reportes_enviados (
  id          bigint generated always as identity primary key,
  tipo        varchar(20) not null,
  clave       varchar(60) not null,
  estado      varchar(10) not null check (estado in ('enviado', 'error')),
  detalle     text,
  creado_en   timestamptz not null default now(),
  unique (tipo, clave)
);

-- ── Configuración y auditoría ────────────────────────────────────────
create table configuracion (
  clave           varchar(60) primary key,
  valor           jsonb       not null,
  actualizado_en  timestamptz not null default now()
);

create table auditoria (
  id          bigint generated always as identity primary key,
  usuario_id  uuid references usuarios(id),
  accion      varchar(60) not null,
  detalle     jsonb,
  creado_en   timestamptz not null default now()
);
create index auditoria_fecha_idx on auditoria (creado_en desc);
