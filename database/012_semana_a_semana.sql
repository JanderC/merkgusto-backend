-- Planes por semanas "semana a semana": del lunes 23 al lunes 30 (antes vencían el domingo 29).
-- Igual que 011 para los meses: se corrigen las membresías activas que aún no vencen y que
-- fueron calculadas con la regla anterior (fin = inicio + 7·N − 1). Congeladas o editadas no se tocan.
-- Una renovación encadenada se corre un día completa para seguir cayendo el mismo día de la semana.

create temporary table _semana_a_semana on commit drop as
select m.id, m.socio_id, m.fecha_inicio, m.fecha_fin
from membresias m
join planes p on p.id = m.plan_id
where m.estado = 'activa'
  and p.tipo_duracion = 'semanas'
  and m.fecha_fin >= current_date
  and m.fecha_fin = m.fecha_inicio + p.cantidad * 7 - 1;

update membresias m
set fecha_inicio = case
      when exists (select 1 from _semana_a_semana a where a.socio_id = c.socio_id and a.fecha_fin = c.fecha_inicio - 1)
      then c.fecha_inicio + 1
      else c.fecha_inicio
    end,
    fecha_fin = c.fecha_fin + 1,
    notas = coalesce(m.notas || ' · ', '') || 'Ajustada a semana a semana (vence el mismo día de la semana)'
from _semana_a_semana c
where m.id = c.id;

insert into bio_cola (socio_id, operacion)
select distinct c.socio_id, 'sync_usuario' from _semana_a_semana c;
