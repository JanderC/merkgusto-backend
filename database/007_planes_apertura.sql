-- Planes de la apertura (afiche: viernes 20 de noviembre, 4:00 PM).
--   Trimestre COP 210.000 · Mensualidad COP 80.000 · Semana COP 30.000 · Día COP 8.000
-- Si ya existe un plan equivalente se actualiza (conserva sus membresías); si no, se crea.

-- Mensualidad (1 mes)
update planes set nombre = 'Mensualidad', precio = 80000, moneda = 'COP', activo = true, orden = 2,
       descripcion = coalesce(descripcion, 'Mes a mes · acceso con el lector facial')
 where eliminado_en is null and tipo_duracion = 'meses' and cantidad = 1 and personas = 1
   and lower(nombre) in ('mensual', 'mensualidad');
insert into planes (nombre, descripcion, duracion_dias, precio, moneda, tipo_duracion, cantidad, personas, congelable, max_dias_congelado, acceso_lector, color, activo, orden)
select 'Mensualidad', 'Mes a mes · acceso con el lector facial', 30, 80000, 'COP', 'meses', 1, 1, true, 30, true, '#FF8A10', true, 2
 where not exists (select 1 from planes where eliminado_en is null and lower(nombre) = 'mensualidad');

-- Trimestre (3 meses)
update planes set nombre = 'Trimestre', precio = 210000, moneda = 'COP', activo = true, orden = 1,
       descripcion = coalesce(descripcion, '3 meses · ahorras COP 30.000')
 where eliminado_en is null and tipo_duracion = 'meses' and cantidad = 3 and personas = 1
   and lower(nombre) in ('trimestral', 'trimestre');
insert into planes (nombre, descripcion, duracion_dias, precio, moneda, tipo_duracion, cantidad, personas, congelable, max_dias_congelado, acceso_lector, color, activo, orden)
select 'Trimestre', '3 meses · ahorras COP 30.000', 90, 210000, 'COP', 'meses', 3, 1, true, 45, true, '#FACC15', true, 1
 where not exists (select 1 from planes where eliminado_en is null and lower(nombre) = 'trimestre');

-- Semana (7 días, con lector)
insert into planes (nombre, descripcion, duracion_dias, precio, moneda, tipo_duracion, cantidad, personas, congelable, max_dias_congelado, acceso_lector, color, activo, orden)
select 'Semana', '7 días · acceso con el lector facial', 7, 30000, 'COP', 'semanas', 1, 1, false, 0, true, '#7DD3FC', true, 3
 where not exists (select 1 from planes where eliminado_en is null and lower(nombre) = 'semana');

-- Día (pase diario: entra por recepción)
insert into planes (nombre, descripcion, duracion_dias, precio, moneda, tipo_duracion, cantidad, personas, congelable, max_dias_congelado, acceso_lector, color, activo, orden)
select 'Día', 'Pase de un día · entra por recepción', 1, 8000, 'COP', 'dias', 1, 1, false, 0, false, '#BABFC8', true, 4
 where not exists (select 1 from planes where eliminado_en is null and lower(nombre) in ('día', 'dia'));

-- Datos del gimnasio del afiche
insert into configuracion (clave, valor)
values ('gym', '{"nombre": "MERKGUSTO GYM", "slogan": "Cuerpo sano · Mente fuerte · Vida mejor", "horario": "Todos los días de 6:00 AM a 9:00 PM"}'::jsonb)
on conflict (clave) do update
  set valor = configuracion.valor || '{"slogan": "Cuerpo sano · Mente fuerte · Vida mejor", "horario": "Todos los días de 6:00 AM a 9:00 PM"}'::jsonb,
      actualizado_en = now();

-- El asistente de WhatsApp responde con las disciplinas (solo si no hay información extra escrita)
insert into configuracion (clave, valor)
values ('whatsapp', jsonb_build_object('infoExtra', 'Disciplinas: CrossFit, Musculación, Bailoterapia y Clase Step. Apertura: viernes 20 de noviembre a las 4:00 PM. La inscripción se cobrará a partir del 2027 (por ahora no se cobra). ¡Ven y forma parte de nuestra familia! Comienza tu mejor versión.'))
on conflict (clave) do update
  set valor = case when coalesce(configuracion.valor->>'infoExtra', '') = '' then configuracion.valor || excluded.valor else configuracion.valor end,
      actualizado_en = now();
