-- ═══════════════════════════════════════════════════════════════════
--  Multimoneda: USD (base) · VES (bolívares) · COP (pesos colombianos)
--  Los precios y totales siguen en USD. Cada pago guarda su moneda, el
--  monto en esa moneda y la tasa usada; el arqueo se hace por moneda.
-- ═══════════════════════════════════════════════════════════════════

-- Qué monedas acepta cada método
alter table metodos_pago add column monedas varchar(3)[] not null default '{USD}';
update metodos_pago set monedas = '{USD,VES,COP}' where codigo = 'efectivo';
update metodos_pago set monedas = '{VES}' where codigo in ('pago_movil', 'punto');
update metodos_pago set monedas = '{VES,COP}' where codigo = 'transferencia';
update metodos_pago set nombre = 'Zelle', monedas = '{USD}', pide_referencia = true where codigo = 'divisas';

-- Pagos en su moneda original + vuelto (línea negativa)
alter table venta_pagos add column moneda varchar(3) not null default 'USD' check (moneda in ('USD', 'VES', 'COP'));
alter table venta_pagos add column monto_moneda numeric(16,2);
alter table venta_pagos add column tasa numeric(16,4) not null default 1;
alter table venta_pagos add column es_vuelto boolean not null default false;
update venta_pagos set monto_moneda = monto;
alter table venta_pagos alter column monto_moneda set not null;
alter table venta_pagos drop constraint if exists venta_pagos_monto_check;
alter table venta_pagos add constraint venta_pagos_monto_check check (monto <> 0 and (es_vuelto = (monto < 0)));

-- Tasas usadas en la venta (comprobante)
alter table ventas add column tasas jsonb;

-- Arqueo ciego por método Y moneda
alter table turno_declaraciones add column moneda varchar(3) not null default 'USD' check (moneda in ('USD', 'VES', 'COP'));
alter table turno_declaraciones drop constraint turno_declaraciones_pkey;
alter table turno_declaraciones add primary key (turno_id, metodo, moneda);
alter table turno_declaraciones alter column monto type numeric(16,2);

-- Fondo de caja por moneda y tasas vigentes al cerrar
alter table turnos add column fondo jsonb not null default '{}';
update turnos set fondo = jsonb_build_object('USD', fondo_inicial) where fondo_inicial > 0;
alter table turnos add column tasas_cierre jsonb;
