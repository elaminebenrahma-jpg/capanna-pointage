-- Anti-fraude sans matériel : détails GPS des pointages + code de présence entre collègues
alter table public.hr_pointages add column if not exists gps_detail jsonb;
create index if not exists hr_pointages_latlng on public.hr_pointages (lat, lng) where lat is not null;
alter table public.hr_pointages drop constraint hr_pointages_source_check,
  add constraint hr_pointages_source_check check (source = any (array['wifi','manuel','gps','collegue']));
alter table public.hr_pointages drop constraint hr_pointages_verif_check,
  add constraint hr_pointages_verif_check check (verif is null or verif = any (array['a_verifier','valide_reseau','valide_gps','valide_gerant','valide_collegue','doublon','refuse_gerant']));
create table if not exists public.hr_codes_presence (
  id bigserial primary key, emetteur_id int not null references public.hr_employes(id), code text not null, preuve text not null,
  expire timestamptz not null, utilise_par int references public.hr_employes(id), utilise_le timestamptz, pointage_id bigint,
  cree_le timestamptz not null default now());
alter table public.hr_codes_presence enable row level security;
create index if not exists hr_codes_presence_code on public.hr_codes_presence (code, expire);
-- (fonction hr_code_utiliser : voir la base ; consommation atomique, usage unique, jamais par l'émetteur)
