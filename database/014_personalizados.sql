-- Entrenamiento personalizado:
--   • Cada entrenador tiene su tarifa de personalizado (mensual y, si quiere, semanal) y
--     el porcentaje que le corresponde de lo que paga el cliente.
--   • Se cobra en caja como un renglón más del ticket: queda el periodo pagado, el cliente
--     queda asignado a ese entrenador (lo ve en su app) y se sabe quién pagó y quién no.
--   • Lo que le toca al entrenador entra a su pago (nómina) una sola vez: al pagarle, cada
--     personalizado queda marcado con ese pago; si el pago se anula, vuelve a quedar pendiente.

alter table entrenadores add column personalizado_precio numeric(12, 2);
alter table entrenadores add column personalizado_semanal numeric(12, 2);
alter table entrenadores add column personalizado_moneda varchar(3) not null default 'USD' check (personalizado_moneda in ('USD', 'VES', 'COP'));
alter table entrenadores add column personalizado_comision numeric(5, 2) not null default 100 check (personalizado_comision between 0 and 100);

alter table venta_items alter column tipo type varchar(15);
alter table venta_items drop constraint venta_items_tipo_check;
alter table venta_items add constraint venta_items_tipo_check check (tipo in ('membresia', 'producto', 'abono', 'personalizado'));

-- Parte del pago que corresponde a personalizados (ya convertida a la moneda del pago)
alter table entrenador_pagos add column personalizados numeric(18, 2) not null default 0;

create table personalizados (
  id                 integer generated always as identity primary key,
  socio_id           uuid not null references socios(id) on delete cascade,
  entrenador_id      uuid not null references entrenadores(id) on delete restrict,
  venta_id           uuid references ventas(id) on delete set null,
  fecha_inicio       date not null,
  fecha_fin          date not null,
  tipo_duracion      varchar(10) not null check (tipo_duracion in ('semanas', 'meses')),
  cantidad           integer not null check (cantidad between 1 and 12),
  precio             numeric(14, 2) not null,
  moneda             varchar(3) not null check (moneda in ('USD', 'VES', 'COP')),
  comision_pct       numeric(5, 2) not null,
  -- Lo que le toca al entrenador, en la moneda del personalizado
  monto_entrenador   numeric(14, 2) not null,
  estado             varchar(10) not null default 'activa' check (estado in ('activa', 'anulada')),
  entrenador_pago_id integer references entrenador_pagos(id) on delete set null,
  creado_por         uuid references usuarios(id) on delete set null,
  creado_en          timestamptz not null default now(),
  check (fecha_fin >= fecha_inicio)
);
create index personalizados_socio_idx on personalizados (socio_id, fecha_fin desc) where estado = 'activa';
create index personalizados_entrenador_idx on personalizados (entrenador_id, fecha_fin desc) where estado = 'activa';
create index personalizados_venta_idx on personalizados (venta_id);
create index personalizados_liquidar_idx on personalizados (entrenador_id) where estado = 'activa' and entrenador_pago_id is null;
