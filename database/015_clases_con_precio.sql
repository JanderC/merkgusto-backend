-- Clases con precio (bailoterapia, funcional…): quien no tiene mensualidad paga la clase en caja.
-- El pago queda ligado a su inscripción (ticket), así "pagó su pase" siempre tiene dinero detrás.
alter table clases add column precio numeric(12, 2) check (precio is null or precio >= 0);
alter table clases add column moneda varchar(3) not null default 'COP' check (moneda in ('USD', 'VES', 'COP'));

alter table clase_inscritos add column venta_id uuid references ventas(id) on delete set null;
create index clase_inscritos_venta_idx on clase_inscritos (venta_id);

alter table venta_items drop constraint venta_items_tipo_check;
alter table venta_items add constraint venta_items_tipo_check check (tipo in ('membresia', 'producto', 'abono', 'personalizado', 'clase'));
