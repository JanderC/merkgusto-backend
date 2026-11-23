-- Planes por meses y años "mes a mes": del 23 de noviembre al 23 de diciembre (antes vencían
-- el 22). Se corrigen las membresías activas que aún no vencen y que fueron calculadas con la
-- regla anterior (fin = inicio + N meses − 1 día). Las congeladas o editadas no encajan y no se tocan.
-- Si hay una renovación encadenada (empieza el día después de otra), se corre un día completa,
-- para que siga cayendo el mismo día del mes: 23 nov–23 dic, 24 dic–23 ene.

create temporary table _mes_a_mes on commit drop as
select m.id, m.socio_id, m.fecha_inicio, m.fecha_fin
from membresias m
join planes p on p.id = m.plan_id
where m.estado = 'activa'
  and p.tipo_duracion in ('meses', 'anios')
  and m.fecha_fin >= current_date
  and m.fecha_fin = (m.fecha_inicio + make_interval(months => p.cantidad * case p.tipo_duracion when 'anios' then 12 else 1 end))::date - 1;

update membresias m
set fecha_inicio = case
      when exists (select 1 from _mes_a_mes a where a.socio_id = c.socio_id and a.fecha_fin = c.fecha_inicio - 1)
      then c.fecha_inicio + 1
      else c.fecha_inicio
    end,
    fecha_fin = c.fecha_fin + 1,
    notas = coalesce(m.notas || ' · ', '') || 'Ajustada a mes a mes (vence el mismo día del mes)'
from _mes_a_mes c
where m.id = c.id;

-- El lector recibe la nueva fecha de vencimiento
insert into bio_cola (socio_id, operacion)
select distinct c.socio_id, 'sync_usuario' from _mes_a_mes c;
