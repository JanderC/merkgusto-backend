-- Planes eliminados: si nunca se vendieron se borran de verdad; si tienen
-- historial se archivan (eliminado_en) para no perder las membresías pasadas.
alter table planes add column eliminado_en timestamptz;
