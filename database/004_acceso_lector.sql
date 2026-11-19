-- El lector facial solo da acceso a planes de semanas, meses o años.
-- Pases diarios y rutinas sueltas entran por recepción (registro manual).
alter table planes add column acceso_lector boolean not null default true;
update planes set acceso_lector = false where tipo_duracion = 'dias';
