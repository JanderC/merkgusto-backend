-- App de entrenadores y app de clientes (web y móvil):
--   • Cada entrenador puede tener usuario y contraseña: ve a sus clientes, sus clases,
--     les asigna rutinas, toma medidas, los inscribe en clases y les envía su enlace.
--   • El cliente entra con su cédula. Si quiere su información privada, se pone una
--     clave y entonces se le pide cédula + clave. Si la olvida, entra con el enlace
--     personal que le envía su entrenador o la recepción.

-- ── Acceso de entrenadores ──
alter table entrenadores add column usuario varchar(60);
alter table entrenadores add column password_hash varchar(100);
alter table entrenadores add column ultimo_acceso timestamptz;
-- Subir el número cierra todas sus sesiones (cambio de contraseña, acceso revocado)
alter table entrenadores add column sesion_version integer not null default 0;
create unique index entrenadores_usuario_idx on entrenadores (lower(usuario)) where usuario is not null;

-- ── Cliente: entrenador asignado y su acceso a la app ──
alter table socios add column entrenador_id uuid references entrenadores(id) on delete set null;
alter table socios add column clave_hash varchar(100);
alter table socios add column clave_creada_en timestamptz;
alter table socios add column app_ultimo_acceso timestamptz;
alter table socios add column app_sesion integer not null default 0;
create index socios_entrenador_idx on socios (entrenador_id) where entrenador_id is not null;

-- Quién anotó la medida o creó la rutina
alter table socio_mediciones add column autor varchar(12) not null default 'equipo' check (autor in ('equipo', 'entrenador', 'cliente'));
alter table socio_mediciones add column entrenador_id uuid references entrenadores(id) on delete set null;
alter table socio_rutinas add column autor varchar(12) not null default 'equipo' check (autor in ('equipo', 'entrenador', 'cliente'));

-- Inscripciones hechas por el entrenador o reservadas por el propio cliente
alter table clase_inscritos add column inscrito_por_entrenador uuid references entrenadores(id) on delete set null;
alter table clase_inscritos add column paso_por_entrenador uuid references entrenadores(id) on delete set null;
alter table clase_inscritos add column reservado_por_socio boolean not null default false;

-- Plantillas de rutina del entrenador (se aplican a cualquier cliente en un toque)
create table rutina_plantillas (
  id              integer generated always as identity primary key,
  entrenador_id   uuid not null references entrenadores(id) on delete cascade,
  titulo          varchar(100) not null,
  objetivo        varchar(150),
  dias            jsonb not null default '[]',
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);
create index rutina_plantillas_idx on rutina_plantillas (entrenador_id);

-- Notas privadas del entrenador sobre su cliente (lesiones, objetivos, avances)
create table entrenador_notas (
  id              integer generated always as identity primary key,
  entrenador_id   uuid not null references entrenadores(id) on delete cascade,
  socio_id        uuid not null references socios(id) on delete cascade,
  texto           varchar(500) not null,
  creado_en       timestamptz not null default now()
);
create index entrenador_notas_idx on entrenador_notas (socio_id, entrenador_id, creado_en desc);

-- Días de rutina que el cliente marca como hechos (racha y constancia)
create table socio_entrenos (
  id              integer generated always as identity primary key,
  socio_id        uuid not null references socios(id) on delete cascade,
  fecha           date not null,
  rutina_id       integer references socio_rutinas(id) on delete set null,
  dia             varchar(80) not null default '',
  nota            varchar(200),
  creado_en       timestamptz not null default now(),
  unique (socio_id, fecha, dia)
);
create index socio_entrenos_idx on socio_entrenos (socio_id, fecha desc);
