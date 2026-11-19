-- Clases grupales (CrossFit, funcional, funcional avanzada…) ancladas a un plan.
-- La cajera las crea, inscribe a la gente (con o sin mensualidad) y les da entrada.
create table clases (
  id              serial primary key,
  nombre          varchar(80)  not null,
  descripcion     varchar(400),
  plan_id         integer references planes(id),           -- plan que la incluye (opcional)
  entrenador_id   uuid references entrenadores(id),
  inicio          timestamptz  not null,
  duracion_min    integer      not null default 60 check (duracion_min between 10 and 300),
  cupo            integer check (cupo is null or cupo > 0),  -- null = sin límite
  nivel           varchar(12) check (nivel in ('principiante', 'intermedio', 'avanzado', 'todos')),
  -- { "movilidad": 0-5, "fuerza": 0-5, "cardio": 0-5, "resistencia": 0-5, "potencia": 0-5, "desplazamiento": 0-5 }
  caracteristicas jsonb        not null default '{}',
  color           varchar(9)   not null default '#FF8A10',
  estado          varchar(10)  not null default 'programada' check (estado in ('programada', 'cancelada')),
  motivo_cancelacion varchar(200),
  serie_id        uuid,                                     -- clases creadas juntas (repetir cada semana)
  creado_por      uuid references usuarios(id),
  creado_en       timestamptz  not null default now()
);
create index clases_inicio_idx on clases (inicio);

create table clase_inscritos (
  id              bigint generated always as identity primary key,
  clase_id        integer not null references clases(id) on delete cascade,
  socio_id        uuid    not null references socios(id),
  -- Al dejarlo pasar: cómo quedó cubierto
  --   plan        → tiene vigente el plan de la clase
  --   mensualidad → tiene otra membresía vigente
  --   pase        → pagó su pase en caja
  --   cortesia    → la cajera lo dejó pasar sin mensualidad
  cobertura       varchar(12) check (cobertura in ('plan', 'mensualidad', 'pase', 'cortesia')),
  asistio_en      timestamptz,
  asistencia_id   bigint references asistencias(id),
  nota            varchar(200),
  inscrito_por    uuid references usuarios(id),
  paso_por        uuid references usuarios(id),
  creado_en       timestamptz not null default now(),
  unique (clase_id, socio_id)
);
create index clase_inscritos_socio_idx on clase_inscritos (socio_id);
