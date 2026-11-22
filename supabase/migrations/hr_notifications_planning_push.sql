-- =====================================================================
-- NOTIFICATIONS — planning personnel, centre de notifications, push
-- =====================================================================
alter table public.hr_notifications
  add column if not exists titre text,
  add column if not exists lien text,
  add column if not exists details jsonb,
  add column if not exists cle text,
  add column if not exists lu_le timestamptz,
  add column if not exists push_statut text not null default 'aucun',
  add column if not exists push_tentatives int not null default 0,
  add column if not exists push_essai_le timestamptz,
  add column if not exists push_erreur text;
-- les nouvelles notifications partent en push (les anciennes restent « aucun »)
alter table public.hr_notifications alter column push_statut set default 'a_envoyer';
create unique index if not exists hr_notifications_cle_uk on public.hr_notifications (cle) where cle is not null;
create index if not exists hr_notifications_dest_idx on public.hr_notifications (destinataire, created_at desc);
create index if not exists hr_notifications_push_idx on public.hr_notifications (push_statut) where push_statut in ('a_envoyer', 'echec_temp', 'envoi');
drop trigger if exists hr_notifications_nodel on public.hr_notifications;
create trigger hr_notifications_nodel before delete on public.hr_notifications for each row execute function public.hr_planning_sans_suppression();

create table if not exists public.hr_push_abonnements (
  id bigserial primary key,
  destinataire text not null,
  appareil_id uuid references public.hr_appareils(id),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  actif boolean not null default true,
  cree_le timestamptz not null default now(),
  maj_le timestamptz not null default now(),
  dernier_envoi timestamptz,
  echecs int not null default 0
);
create index if not exists hr_push_abonnements_dest_idx on public.hr_push_abonnements (destinataire) where actif;
alter table public.hr_push_abonnements enable row level security;
revoke all on public.hr_push_abonnements from anon, authenticated;
drop trigger if exists hr_push_abonnements_nodel on public.hr_push_abonnements;
create trigger hr_push_abonnements_nodel before delete on public.hr_push_abonnements for each row execute function public.hr_planning_sans_suppression();

create or replace function public.hr_date_fr(d date) returns text
language sql immutable set search_path = public, pg_temp as $$
  select (array['lundi','mardi','mercredi','jeudi','vendredi','samedi','dimanche'])[extract(isodow from d)::int] || ' ' ||
         extract(day from d)::int || ' ' ||
         (array['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'])[extract(month from d)::int]
$$;
create or replace function public.hr_fmt_creneaux(c jsonb) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case when jsonb_array_length(coalesce(c, '[]'::jsonb)) = 0 then 'repos'
    else (select string_agg(replace(e->>'debut', ':', 'h') || ' – ' || replace(e->>'fin', ':', 'h'), ' et ' order by o)
          from jsonb_array_elements(c) with ordinality t(e, o)) end
$$;

-- Notification à UN employé, après l'enregistrement effectif d'un changement de son planning
create or replace function public.hr_notifier_planning(p_emp int, p_jour date, p_portee text, p_avant jsonb, p_apres jsonb, p_journal bigint)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  na int := jsonb_array_length(coalesce(p_avant, '[]'::jsonb));
  nn int := jsonb_array_length(coalesce(p_apres, '[]'::jsonb));
  v_j text := public.hr_date_fr(p_jour);
  v_nature text; v_phrase text;
begin
  if coalesce(p_avant, '[]'::jsonb) = coalesce(p_apres, '[]'::jsonb) then return; end if;  -- rien n'a changé
  if nn = 0 then v_nature := 'repos'; v_phrase := 'Le ' || v_j || ' devient un jour de repos.';
  elsif na = 0 or nn > na then v_nature := 'service_ajoute'; v_phrase := 'Un service a été ajouté le ' || v_j || '.';
  elsif nn < na then v_nature := 'service_retire'; v_phrase := 'Un service a été retiré le ' || v_j || '.';
  else v_nature := 'horaire_modifie'; v_phrase := 'Votre service du ' || v_j || ' a été modifié.'; end if;
  if p_portee = 'suivantes' then
    v_phrase := v_phrase || ' Ce changement vaut aussi pour les ' ||
      (array['lundis','mardis','mercredis','jeudis','vendredis','samedis','dimanches'])[extract(isodow from p_jour)::int] || ' suivants.';
  end if;
  insert into public.hr_notifications (destinataire, type, message, titre, lien, details, cle)
  values ('employe:' || p_emp, 'planning',
          v_phrase || ' Ancien horaire : ' || public.hr_fmt_creneaux(p_avant) || '. Nouvel horaire : ' || public.hr_fmt_creneaux(p_apres) || '. Consultez votre planning mis à jour.',
          'Modification de votre planning', 'planning',
          jsonb_build_object('nature', v_nature, 'date', p_jour, 'ancien', coalesce(p_avant, '[]'::jsonb), 'nouveau', coalesce(p_apres, '[]'::jsonb), 'portee', p_portee),
          'journal:' || p_journal)
  on conflict (cle) where cle is not null do nothing;
end $$;

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
  v_prev_fin int; v_d int; v_f int; v_pause int; i int; v_nb int := 0; v_jid bigint;
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
      values (p_auteur, 'employe', v_emp::text, 'changement_poste', jsonb_build_object('service', v_old), jsonb_build_object('service', v_srv), v_motif)
      returning id into v_jid;
      -- l'employé concerné est prévenu (une seule fois par modification enregistrée)
      insert into public.hr_notifications (destinataire, type, message, titre, lien, details, cle)
      values ('employe:' || v_emp, 'planning_poste',
              'Votre affectation a changé : vous passez du poste « ' || v_old || ' » au poste « ' || v_srv || ' ». Consultez votre planning mis à jour.',
              'Changement d''affectation', 'planning',
              jsonb_build_object('nature', 'affectation', 'ancien', v_old, 'nouveau', v_srv), 'journal:' || v_jid)
      on conflict (cle) where cle is not null do nothing;
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
      values (p_auteur, 'planning', v_emp || '-' || v_jour, 'modification_jour', v_avant, v_new, v_motif)
      returning id into v_jid;
      if not (v_refs ? (c->>'employe')) then perform public.hr_notifier_planning(v_emp, v_jour, 'semaine', v_avant, v_new, v_jid); end if;
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
              jsonb_build_object('a_partir_du', v_jour, 'creneaux', v_new), v_motif)
      returning id into v_jid;
      if not (v_refs ? (c->>'employe')) then perform public.hr_notifier_planning(v_emp, v_jour, 'suivantes', v_avant, v_new, v_jid); end if;
    end if;
    v_nb := v_nb + 1;
  end loop;

  return jsonb_build_object('ok', true, 'modifications', v_nb, 'crees', v_crees);
end $$;


revoke execute on function public.hr_notifier_planning(int, date, text, jsonb, jsonb, bigint), public.hr_date_fr(date), public.hr_fmt_creneaux(jsonb) from public, anon, authenticated;
grant execute on function public.hr_notifier_planning(int, date, text, jsonb, jsonb, bigint) to service_role;
insert into public.hr_parametres (cle, valeur) values
  ('admin_vapid_public', 'BKcnvPhCbYjJxnuzGfcdNXqrR2QM-fR9dbX0KeYMN3b54rH1BF-2eBg5wWZqVQAN-SzWzCZmiIjgN_oQ3yyOSaI'),
  ('admin_vapid_prive', '(clé privée stockée en base, non publiée)')
on conflict (cle) do nothing;
