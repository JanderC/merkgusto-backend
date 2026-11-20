-- Código de barras en productos y devoluciones autorizadas por un supervisor.
--   • Cada producto puede tener su código de barras (único) para venderlo con el lector.
--   • Una devolución de productos SOLO se hace con el código (PIN) de un supervisor:
--     dueño o administrador de caja. Queda quién la pidió, quién la autorizó y por qué.
--   • El dinero devuelto sale de la caja de la cajera como egreso "Devolución"
--     (cuenta en su cierre) y la mercancía vuelve al inventario si está en buen estado.

alter table productos add column codigo_barras varchar(40);
create unique index productos_codigo_barras_idx on productos (codigo_barras) where codigo_barras is not null;

-- PIN de autorización del supervisor (hash bcrypt; distinto a su contraseña)
alter table usuarios add column pin_hash text;

create table devoluciones (
  id              integer generated always as identity primary key,
  venta_id        uuid        not null references ventas(id),
  turno_id        uuid        not null references turnos(id),
  cajero_id       uuid        not null references usuarios(id),
  autorizado_por  uuid        not null references usuarios(id),
  motivo          varchar(200) not null,
  reingresa_stock boolean     not null default true,
  metodo          varchar(20) not null references metodos_pago(codigo),
  moneda          varchar(3)  not null check (moneda in ('USD', 'VES', 'COP')),
  monto           numeric(18,2) not null check (monto >= 0),
  monto_ref       numeric(18,2) not null,
  movimiento_id   bigint references caja_movimientos(id),
  creado_en       timestamptz not null default now()
);
create index devoluciones_venta_idx on devoluciones (venta_id);
create index devoluciones_turno_idx on devoluciones (turno_id);
create index devoluciones_fecha_idx on devoluciones (creado_en);

create table devolucion_items (
  id              integer generated always as identity primary key,
  devolucion_id   integer not null references devoluciones(id) on delete cascade,
  venta_item_id   bigint  not null references venta_items(id),
  producto_id     integer not null references productos(id),
  descripcion     varchar(150) not null,
  cantidad        integer not null check (cantidad > 0),
  moneda          varchar(3) not null,
  subtotal        numeric(18,2) not null
);
create index devolucion_items_item_idx on devolucion_items (venta_item_id);
