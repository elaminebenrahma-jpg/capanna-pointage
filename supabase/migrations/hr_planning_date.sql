-- =====================================================================
-- PLANNING DATÉ — KeyNet / Capanna
-- * hr_creneaux reste la « semaine type » actuelle (rien ne change pour l'appli en production)
-- * hr_creneaux_archives : anciennes semaines types, avec la date jusqu'à laquelle elles s'appliquaient
--   -> modifier la semaine type ne recalcule plus jamais le passé
-- * hr_planning_jours : modifications d'un seul jour (« seulement cette semaine »)
-- * hr_planning_effectif(debut, fin) : planning réellement prévu, jour par jour (source unique)
-- =====================================================================

create table if not exists public.hr_creneaux_archives (
  id bigserial primary key,
  employe_id int not null references public.hr_employes(id),
  jour smallint not null check (jour between 1 and 7),
  jusqu_au date not null,
  creneaux jsonb not null default '[]'::jsonb,
  actif boolean not null default true,
  cree_le timestamptz not null default now()
);
create index if not exists hr_creneaux_archives_idx on public.hr_creneaux_archives (employe_id, jour, jusqu_au) where actif;

create table if not exists public.hr_planning_jours (
  id bigserial primary key,
  employe_id int not null references public.hr_employes(id),
  jour date not null,
  creneaux jsonb not null default '[]'::jsonb,
  actif boolean not null default true,
  motif text,
  cree_le timestamptz not null default now()
);
create unique index if not exists hr_planning_jours_actif_uk on public.hr_planning_jours (employe_id, jour) where actif;

alter table public.hr_creneaux_archives enable row level security;
alter table public.hr_planning_jours enable row level security;
revoke all on public.hr_creneaux_archives, public.hr_planning_jours from anon, authenticated;

-- aucune suppression : on désactive
create or replace function public.hr_planning_sans_suppression() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'Suppression interdite : désactiver la ligne (actif = false).';
end $$;
drop trigger if exists hr_creneaux_archives_nodel on public.hr_creneaux_archives;
create trigger hr_creneaux_archives_nodel before delete on public.hr_creneaux_archives for each row execute function public.hr_planning_sans_suppression();
drop trigger if exists hr_planning_jours_nodel on public.hr_planning_jours;
create trigger hr_planning_jours_nodel before delete on public.hr_planning_jours for each row execute function public.hr_planning_sans_suppression();
drop trigger if exists hr_creneaux_nodel on public.hr_creneaux;
create trigger hr_creneaux_nodel before delete on public.hr_creneaux for each row execute function public.hr_planning_sans_suppression();

-- jour de service courant (bascule à 05h00, heure du Maroc)
create or replace function public.hr_jour_service_actuel() returns date
language sql stable set search_path = public, pg_temp as $$
  select ((now() at time zone 'Africa/Casablanca')
          - make_interval(hours => coalesce((select valeur::int from public.hr_parametres where cle = 'bascule_heure'), 5)))::date
$$;

-- semaine type actuelle d'un employé pour un jour de la semaine, en jsonb
create or replace function public.hr_semaine_type_json(p_emp int, p_jour smallint) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('debut', to_char(k.debut, 'HH24:MI'), 'fin', to_char(k.fin, 'HH24:MI'), 'pause_min', k.pause_min) order by k.ordre), '[]'::jsonb)
  from public.hr_creneaux k where k.employe_id = p_emp and k.jour = p_jour and k.actif
$$;

-- La semaine type (p_emp, p_jour) va changer à partir de p_des : on fige ce qui s'appliquait avant.
create or replace function public.hr_semaine_type_archiver(p_emp int, p_jour smallint, p_des date) returns void
language plpgsql set search_path = public, pg_temp as $$
declare a record;
begin
  select * into a from public.hr_creneaux_archives
   where actif and employe_id = p_emp and jour = p_jour and jusqu_au >= p_des order by jusqu_au limit 1;
  if found then
    -- une version future existait : elle ne vaut plus qu'avant p_des
    update public.hr_creneaux_archives set actif = false
     where actif and employe_id = p_emp and jour = p_jour and jusqu_au >= p_des;
    if not exists (select 1 from public.hr_creneaux_archives where actif and employe_id = p_emp and jour = p_jour and jusqu_au = p_des - 1) then
      insert into public.hr_creneaux_archives (employe_id, jour, jusqu_au, creneaux) values (p_emp, p_jour, p_des - 1, a.creneaux);
    end if;
  elsif not exists (select 1 from public.hr_creneaux_archives where actif and employe_id = p_emp and jour = p_jour and jusqu_au = p_des - 1) then
    insert into public.hr_creneaux_archives (employe_id, jour, jusqu_au, creneaux)
    values (p_emp, p_jour, p_des - 1, public.hr_semaine_type_json(p_emp, p_jour));
  end if;
end $$;

-- Protection automatique : toute modification directe de hr_creneaux (ancienne appli, écran Horaires)
-- s'applique à partir d'aujourd'hui ; le passé garde l'ancien horaire.
create or replace function public.hr_creneaux_proteger_passe() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare d date := public.hr_jour_service_actuel();
begin
  if coalesce(current_setting('hr.planning_manuel', true), '') = '1' then return coalesce(new, old); end if;
  if tg_op in ('UPDATE', 'DELETE') then perform public.hr_semaine_type_archiver(old.employe_id, old.jour, d); end if;
  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or (old.employe_id, old.jour) is distinct from (new.employe_id, new.jour)) then
    perform public.hr_semaine_type_archiver(new.employe_id, new.jour, d);
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists hr_creneaux_proteger_passe on public.hr_creneaux;
create trigger hr_creneaux_proteger_passe before insert or update on public.hr_creneaux
  for each row execute function public.hr_creneaux_proteger_passe();

-- Planning réellement prévu, jour par jour : exception du jour > ancienne semaine type > semaine type actuelle
create or replace function public.hr_planning_effectif(p_debut date, p_fin date)
returns table(jour date, employe_id int, ordre smallint, debut time, fin time, pause_min int, source text)
language sql stable set search_path = public, pg_temp as $$
with cal as (
  select g::date jour, e.id employe_id, extract(isodow from g)::smallint dw
  from generate_series(p_debut, p_fin, interval '1 day') g cross join public.hr_employes e
),
src as (
  select c.*, x.creneaux exc,
    (select a.creneaux from public.hr_creneaux_archives a
      where a.actif and a.employe_id = c.employe_id and a.jour = c.dw and a.jusqu_au >= c.jour
      order by a.jusqu_au limit 1) arc
  from cal c left join public.hr_planning_jours x on x.actif and x.employe_id = c.employe_id and x.jour = c.jour
)
select s.jour, s.employe_id, t.n::smallint, (t.v->>'debut')::time, (t.v->>'fin')::time,
       coalesce((t.v->>'pause_min')::int, 0), case when s.exc is not null then 'jour' else 'archive' end
from src s cross join lateral jsonb_array_elements(coalesce(s.exc, s.arc)) with ordinality t(v, n)
where s.exc is not null or s.arc is not null
union all
select s.jour, s.employe_id, k.ordre, k.debut, k.fin, k.pause_min, 'semaine_type'
from src s join public.hr_creneaux k on k.actif and k.employe_id = s.employe_id and k.jour = s.dw
where s.exc is null and s.arc is null
$$;

-- Enregistrement atomique d'une série de modifications du planning (tout ou rien)
create or replace function public.hr_planning_appliquer(p jsonb, p_auteur text default 'gérant') returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_motif text := btrim(coalesce(p->>'motif', ''));
  v_portee text := coalesce(p->>'portee', 'semaine');
  v_auj date := public.hr_jour_service_actuel();
  v_refs jsonb := '{}'::jsonb;
  v_crees jsonb := '[]'::jsonb;
  n jsonb; c jsonb; x jsonb;
  v_id int; v_nom text; v_srv text; v_pin text; v_old text;
  v_emp int; v_jour date; v_dw smallint; v_new jsonb; v_avant jsonb; v_base jsonb;
  v_prev_fin int; v_d int; v_f int; v_pause int; i int; v_nb int := 0;
begin
  perform set_config('hr.planning_manuel', '1', true);
  if length(v_motif) < 3 then raise exception 'REFUS:Motif obligatoire (3 caractères minimum).'; end if;
  if v_portee not in ('semaine', 'suivantes') then raise exception 'REFUS:Portée invalide.'; end if;

  -- 1. nouveaux employés
  for n in select * from jsonb_array_elements(coalesce(p->'nouveaux', '[]'::jsonb)) loop
    v_nom := btrim(coalesce(n->>'nom', '')); v_srv := btrim(coalesce(n->>'service', ''));
    if length(v_nom) < 2 then raise exception 'REFUS:Nom d''employé trop court.'; end if;
    if v_srv = '' then raise exception 'REFUS:Choisis un poste pour %.', v_nom; end if;
    if exists (select 1 from public.hr_employes where lower(nom) = lower(v_nom)) then
      raise exception 'REFUS:Un employé s''appelle déjà « % ».', v_nom; end if;
    v_pin := (1000 + floor(random() * 9000))::int::text;
    insert into public.hr_employes (nom, service, actif, pin) values (v_nom, v_srv, true, v_pin) returning id into v_id;
    v_refs := v_refs || jsonb_build_object(n->>'ref', v_id);
    v_crees := v_crees || jsonb_build_object('ref', n->>'ref', 'id', v_id, 'nom', v_nom, 'service', v_srv, 'pin', v_pin);
    insert into public.hr_journal (auteur, objet, objet_id, action, ancienne, nouvelle, motif)
    values (p_auteur, 'employe', v_id::text, 'creation', null, jsonb_build_object('nom', v_nom, 'service', v_srv), v_motif);
    v_nb := v_nb + 1;
  end loop;

  -- 2. changements de poste (affectation)
  for x in select * from jsonb_array_elements(coalesce(p->'postes', '[]'::jsonb)) loop
    v_emp := (x->>'employe_id')::int; v_srv := btrim(coalesce(x->>'service', ''));
    if v_srv = '' then raise exception 'REFUS:Poste vide.'; end if;
    select service into v_old from public.hr_employes where id = v_emp;
    if not found then raise exception 'REFUS:Employé introuvable.'; end if;
    if v_old is distinct from v_srv then
      update public.hr_employes set service = v_srv where id = v_emp;
      insert into public.hr_journal (auteur, objet, objet_id, action, ancienne, nouvelle, motif)
      values (p_auteur, 'employe', v_emp::text, 'changement_poste', jsonb_build_object('service', v_old), jsonb_build_object('service', v_srv), v_motif);
      v_nb := v_nb + 1;
    end if;
  end loop;

  -- 3. cases du planning
  for c in select * from jsonb_array_elements(coalesce(p->'cellules', '[]'::jsonb)) loop
    if v_refs ? (c->>'employe') then v_emp := (v_refs->>(c->>'employe'))::int; else v_emp := (c->>'employe')::int; end if;
    if not exists (select 1 from public.hr_employes where id = v_emp) then raise exception 'REFUS:Employé introuvable.'; end if;
    v_jour := (c->>'jour')::date; v_dw := extract(isodow from v_jour)::smallint;
    if v_jour < v_auj then raise exception 'REFUS:Le % est passé : on ne modifie pas un planning déjà travaillé (utilise les corrections de pointage).', to_char(v_jour, 'DD/MM'); end if;
    if v_jour > v_auj + 400 then raise exception 'REFUS:Date trop lointaine.'; end if;
    if jsonb_array_length(coalesce(c->'creneaux', '[]'::jsonb)) > 4 then raise exception 'REFUS:4 services maximum par jour.'; end if;

    -- normalisation + contrôles (heures valides, pas de chevauchement)
    select coalesce(jsonb_agg(jsonb_build_object('debut', to_char(d, 'HH24:MI'), 'fin', to_char(f, 'HH24:MI'), 'pause_min', pz) order by d), '[]'::jsonb)
      into v_new
      from (select (e->>'debut')::time d, (e->>'fin')::time f, coalesce(nullif(e->>'pause_min', '')::int, 0) pz
              from jsonb_array_elements(coalesce(c->'creneaux', '[]'::jsonb)) e) q;
    v_prev_fin := null;
    for i in 0 .. jsonb_array_length(v_new) - 1 loop
      v_d := extract(epoch from (v_new->i->>'debut')::time)::int / 60;
      v_f := extract(epoch from (v_new->i->>'fin')::time)::int / 60;
      v_pause := (v_new->i->>'pause_min')::int;
      if v_f = v_d then raise exception 'REFUS:Un service commence et finit à la même heure.'; end if;
      if v_f < v_d then v_f := v_f + 1440; end if;
      if v_pause < 0 or v_pause > 240 or v_pause >= v_f - v_d then raise exception 'REFUS:Pause invalide.'; end if;
      if v_prev_fin is not null and v_d < v_prev_fin then raise exception 'REFUS:Deux services se chevauchent le %.', to_char(v_jour, 'DD/MM'); end if;
      v_prev_fin := v_f;
    end loop;

    select coalesce(jsonb_agg(jsonb_build_object('debut', to_char(k.debut, 'HH24:MI'), 'fin', to_char(k.fin, 'HH24:MI'), 'pause_min', k.pause_min) order by k.ordre), '[]'::jsonb)
      into v_avant from public.hr_planning_effectif(v_jour, v_jour) k where k.employe_id = v_emp;

    if v_portee = 'semaine' then
      update public.hr_planning_jours set actif = false where actif and employe_id = v_emp and jour = v_jour;
      -- base sans exception : ancienne semaine type ou semaine type actuelle
      select coalesce((select a.creneaux from public.hr_creneaux_archives a where a.actif and a.employe_id = v_emp and a.jour = v_dw and a.jusqu_au >= v_jour order by a.jusqu_au limit 1),
                      public.hr_semaine_type_json(v_emp, v_dw)) into v_base;
      if v_base is distinct from v_new then
        insert into public.hr_planning_jours (employe_id, jour, creneaux, motif) values (v_emp, v_jour, v_new, v_motif);
      end if;
      insert into public.hr_journal (auteur, objet, objet_id, action, ancienne, nouvelle, motif)
      values (p_auteur, 'planning', v_emp || '-' || v_jour, 'modification_jour', v_avant, v_new, v_motif);
    else
      perform public.hr_semaine_type_archiver(v_emp, v_dw, v_jour);
      for i in 0 .. jsonb_array_length(v_new) - 1 loop
        if exists (select 1 from public.hr_creneaux where employe_id = v_emp and jour = v_dw and ordre = i + 1) then
          update public.hr_creneaux set debut = (v_new->i->>'debut')::time, fin = (v_new->i->>'fin')::time,
                 pause_min = (v_new->i->>'pause_min')::int, actif = true
           where employe_id = v_emp and jour = v_dw and ordre = i + 1;
        else
          insert into public.hr_creneaux (employe_id, jour, ordre, debut, fin, pause_min, actif)
          values (v_emp, v_dw, i + 1, (v_new->i->>'debut')::time, (v_new->i->>'fin')::time, (v_new->i->>'pause_min')::int, true);
        end if;
      end loop;
      update public.hr_creneaux set actif = false where employe_id = v_emp and jour = v_dw and ordre > jsonb_array_length(v_new) and actif;
      update public.hr_planning_jours set actif = false where actif and employe_id = v_emp and jour = v_jour;
      insert into public.hr_journal (auteur, objet, objet_id, action, ancienne, nouvelle, motif)
      values (p_auteur, 'creneaux', v_emp || '-' || v_dw, 'modification_semaine_type', v_avant,
              jsonb_build_object('a_partir_du', v_jour, 'creneaux', v_new), v_motif);
    end if;
    v_nb := v_nb + 1;
  end loop;

  return jsonb_build_object('ok', true, 'modifications', v_nb, 'crees', v_crees);
end $$;

revoke execute on function public.hr_planning_effectif(date, date), public.hr_planning_appliquer(jsonb, text),
  public.hr_semaine_type_archiver(int, smallint, date), public.hr_semaine_type_json(int, smallint),
  public.hr_jour_service_actuel() from public, anon, authenticated;
grant execute on function public.hr_planning_effectif(date, date), public.hr_planning_appliquer(jsonb, text) to service_role;

-- Moteur : lit désormais le planning effectif (même résultat tant qu'il n'y a ni exception ni archive)
do $m$
declare s text := pg_get_functiondef('public.hr_journees(date,date)'::regprocedure); t text;
begin
  if position('hr_planning_effectif' in s) > 0 then return; end if;
  t := replace(s, E'cr as (\n', E'pe as materialized (select * from public.hr_planning_effectif((select d from d0), p_fin)),\ncr as (\n');
  if t = s then raise exception 'moteur: motif 1 introuvable'; end if; s := t;
  t := replace(s, E'from cal c join public.hr_creneaux k\n    on k.employe_id=c.employe_id and k.actif and k.jour = extract(isodow from c.jour)',
                  E'from cal c join pe k\n    on k.employe_id=c.employe_id and k.jour = c.jour');
  if t = s then raise exception 'moteur: motif 2 introuvable'; end if; s := t;
  t := replace(s, E'where not exists (select 1 from public.hr_creneaux k where k.employe_id=s.employe_id and k.actif\n                  and k.jour = extract(isodow from s.jour_service))',
                  E'where not exists (select 1 from pe k where k.employe_id=s.employe_id and k.jour=s.jour_service)');
  if t = s then raise exception 'moteur: motif 3 introuvable'; end if; s := t;
  execute s;
end $m$;
