-- Carga de facturas de compra: el único camino para que entre mercancía.
--   • Cada línea guarda el costo convertido a la moneda del producto con la tasa usada.
--   • El precio de venta se fija en la misma factura (queda el anterior por si se anula).
--   • Los productos nuevos nacen en la factura (producto_nuevo = true).

alter table compra_items add column costo_convertido numeric(18,4);
alter table compra_items add column moneda_producto varchar(3) check (moneda_producto in ('USD', 'VES', 'COP'));
alter table compra_items add column precio_venta numeric(12,2);
alter table compra_items add column precio_anterior numeric(12,2);
alter table compra_items add column producto_nuevo boolean not null default false;

-- Para detectar rápido una factura cargada dos veces del mismo proveedor
create index compras_factura_idx on compras (proveedor_id, lower(factura)) where factura is not null and estado <> 'anulada';
