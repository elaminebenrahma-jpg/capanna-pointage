-- ============ Module « Géolocalisation & présences » (KeyNet) ============
-- Additif et réversible : rien d'existant n'est modifié, sauf l'ajout d'un déclencheur sur hr_pointages.
-- Le module est désactivé par défaut (geo_actif = 0) tant que l'autorisation CNDP n'est pas obtenue.

insert into public.hr_parametres (cle, valeur) values
  ('geo_actif', '0'), ('geo_rayon_m', '30'), ('geo_alerte1_min', '3'), ('geo_alerte2_min', '10'),
  ('geo_precision_max_m', '20'), ('geo_confirmation_s', '60'), ('geo_injoignable_min', '10'),
  ('geo_conservation_jours', '90')
on conflict (cle) do nothing;

-- Une session = un service, du pointage d'arrivée au pointage de départ. Aucun suivi hors session.
create table if not exists public.hr_geo_sessions (
  id bigserial primary key,
  employe_id int not null references public.hr_employes(id),
  jour_service date not null,
  pointage_arrivee_id bigint,
  pointage_depart_id bigint,
  debut timestamptz not null,
  fin timestamptz,
  statut text not null default 'active' check (statut in ('active', 'fermee', 'fermee_auto')),
  etat text not null default 'inconnu' check (etat in ('dans', 'a_verifier', 'hors', 'inconnu')),
  etat_depuis timestamptz not null default now(),
  derniere_vue timestamptz,
  derniere_position_ok timestamptz,
  appli_vue boolean not null default false,
  permission text,               -- toujours | pendant_utilisation | refusee | gps_desactive
  cree_le timestamptz not null default now()
);
create unique index if not exists hr_geo_sessions_une_active on public.hr_geo_sessions (employe_id) where statut = 'active';
create index if not exists hr_geo_sessions_jour on public.hr_geo_sessions (jour_service);

-- Événements reçus du téléphone (positions, Wi-Fi, permissions). client_id empêche les doublons.
create table if not exists public.hr_geo_evenements (
  id bigserial primary key,
  session_id bigint not null references public.hr_geo_sessions(id),
  employe_id int not null references public.hr_employes(id),
  client_id text not null unique,
  type text not null check (type in ('position', 'permission', 'gps_desactive', 'appli')),
  lat double precision, lng double precision, precision_m double precision,
  distance_m double precision,
  wifi_restaurant boolean not null default false,
  verdict text not null check (verdict in ('dans', 'hors', 'imprecis', 'info')),
  detail text,
  heure_tel timestamptz,
  heure_retenue timestamptz not null,
  heure_serveur timestamptz not null default now(),
  coordonnees_effacees boolean not null default false
);
create index if not exists hr_geo_evenements_session on public.hr_geo_evenements (session_id, heure_retenue);

-- Sorties confirmées (au-delà du rayon, plusieurs mesures précises).
create table if not exists public.hr_geo_sorties (
  id bigserial primary key,
  session_id bigint not null references public.hr_geo_sessions(id),
  employe_id int not null references public.hr_employes(id),
  jour_service date not null,
  debut timestamptz not null,
  fin timestamptz,
  niveau smallint not null default 0,            -- 0 confirmée, 1 > alerte 1, 2 > alerte 2
  cloture text,                                  -- retour | depart | fin_session
  justification_type text check (justification_type in ('livraison', 'achat', 'mission', 'pause', 'exceptionnelle', 'autre')),
  justification_statut text not null default 'aucune' check (justification_statut in ('aucune', 'explication_demandee', 'acceptee', 'refusee')),
  commentaire text,
  decide_par text, decide_le timestamptz,
  cree_le timestamptz not null default now()
);
create index if not exists hr_geo_sorties_jour on public.hr_geo_sorties (jour_service, employe_id);

create table if not exists public.hr_geo_alertes (
  id bigserial primary key,
  cle text not null unique,
  session_id bigint references public.hr_geo_sessions(id),
  sortie_id bigint references public.hr_geo_sorties(id),
  employe_id int not null references public.hr_employes(id),
  type text not null check (type in ('sortie', 'sortie_prolongee', 'retour', 'gps_desactive', 'permission_retiree', 'injoignable')),
  priorite text not null default 'normale' check (priorite in ('info', 'normale', 'haute')),
  statut text not null default 'nouvelle' check (statut in ('nouvelle', 'en_cours', 'traitee', 'cloturee')),
  message text not null,
  cree_le timestamptz not null default now(),
  traite_par text, traite_le timestamptz
);
create index if not exists hr_geo_alertes_statut on public.hr_geo_alertes (statut, cree_le desc);

alter table public.hr_geo_sessions enable row level security;
alter table public.hr_geo_evenements enable row level security;
alter table public.hr_geo_sorties enable row level security;
alter table public.hr_geo_alertes enable row level security;

create or replace function public.hr_geo_param(p_cle text, p_defaut numeric) returns numeric
language sql stable set search_path = public, pg_temp as $$
  select coalesce((select nullif(valeur, '')::numeric from hr_parametres where cle = p_cle), p_defaut)
$$;

-- alerte + notification du gérant (une seule fois par clé)
create or replace function public.hr_geo_alerter(p_cle text, p_session bigint, p_sortie bigint, p_emp int, p_type text, p_prio text, p_msg text, p_titre text)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  insert into hr_geo_alertes (cle, session_id, sortie_id, employe_id, type, priorite, message)
  values (p_cle, p_session, p_sortie, p_emp, p_type, p_prio, p_msg) on conflict (cle) do nothing;
  if found and hr_geo_param('geo_actif', 0) = 1 then
    insert into hr_notifications (destinataire, type, titre, message, lien, cle, details)
    values ('gerant', 'geo_' || p_type, p_titre, p_msg, 'geo', 'geo:' || p_cle,
            jsonb_build_object('employe_id', p_emp, 'sortie_id', p_sortie))
    on conflict (cle) do nothing;
  end if;
end $$;

-- ouverture / fermeture des sessions avec les pointages (arrivée ouvre, départ ferme)
create or replace function public.hr_geo_suivre_pointage() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare s hr_geo_sessions;
begin
  if not new.accepte or new.annule then return new; end if;
  if tg_op = 'UPDATE' and old.accepte and not old.annule then return new; end if;  -- déjà pris en compte
  select * into s from hr_geo_sessions where employe_id = new.employe_id and statut = 'active';
  if new.type = 'arrivee' then
    if s.id is not null then
      perform hr_geo_fermer(s.id, new.horodatage, 'fermee_auto', null);
    end if;
    insert into hr_geo_sessions (employe_id, jour_service, pointage_arrivee_id, debut, etat, etat_depuis)
    values (new.employe_id, new.jour_service, new.id, new.horodatage, 'inconnu', new.horodatage);
  elsif s.id is not null and new.horodatage >= s.debut then
    perform hr_geo_fermer(s.id, new.horodatage, 'fermee', new.id);
  end if;
  return new;
end $$;

create or replace function public.hr_geo_fermer(p_session bigint, p_quand timestamptz, p_statut text, p_depart bigint)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  update hr_geo_sorties set fin = greatest(p_quand, debut), cloture = case when p_statut = 'fermee' then 'depart' else 'fin_session' end
   where session_id = p_session and fin is null;
  update hr_geo_alertes set statut = 'cloturee' where session_id = p_session and statut in ('nouvelle', 'en_cours') and type in ('injoignable', 'gps_desactive', 'permission_retiree');
  update hr_geo_sessions set statut = p_statut, fin = p_quand, pointage_depart_id = p_depart where id = p_session and statut = 'active';
end $$;

drop trigger if exists hr_pointages_geo on public.hr_pointages;
create trigger hr_pointages_geo after insert or update of accepte, annule on public.hr_pointages
  for each row execute function public.hr_geo_suivre_pointage();

-- ============ moteur : réception d'un événement du téléphone ============
-- p_wifi_restaurant : la requête vient du Wi-Fi du restaurant (adresse reconnue par le serveur) = dans la zone.
create or replace function public.hr_geo_evenement(p_emp int, p_client_id text, p_type text, p_lat double precision, p_lng double precision,
  p_precision double precision, p_heure_tel timestamptz, p_wifi_restaurant boolean, p_detail text)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  s hr_geo_sessions; v_rayon numeric := hr_geo_param('geo_rayon_m', 30); v_pmax numeric := hr_geo_param('geo_precision_max_m', 20);
  v_conf numeric := hr_geo_param('geo_confirmation_s', 60);
  v_lat numeric := (select valeur::numeric from hr_parametres where cle = 'site_lat');
  v_lng numeric := (select valeur::numeric from hr_parametres where cle = 'site_lng');
  v_quand timestamptz; v_dist double precision; v_verdict text := 'info'; v_nb int; v_premier timestamptz; v_sortie bigint; n text;
begin
  select * into s from hr_geo_sessions where employe_id = p_emp and statut = 'active' for update;
  if s.id is null then return jsonb_build_object('ok', true, 'suivi', false); end if;   -- pas de service en cours : on ne garde rien
  if exists (select 1 from hr_geo_evenements where client_id = p_client_id) then
    return jsonb_build_object('ok', true, 'suivi', true, 'doublon', true, 'etat', s.etat);
  end if;
  -- heure : celle du téléphone seulement si plausible (événement mis en file hors connexion), sinon celle du serveur
  v_quand := case when p_heure_tel is not null and p_heure_tel between greatest(s.debut, now() - interval '6 hours') and now() + interval '1 minute'
                  then least(p_heure_tel, now()) else now() end;
  if p_type = 'position' then
    if p_wifi_restaurant then v_verdict := 'dans';
    elsif p_lat is null or v_lat is null then v_verdict := 'imprecis';
    else
      v_dist := 2 * 6371000 * asin(sqrt(power(sin(radians(p_lat - v_lat::float) / 2), 2)
                + cos(radians(v_lat::float)) * cos(radians(p_lat)) * power(sin(radians(p_lng - v_lng::float) / 2), 2)));
      if p_precision is null or p_precision > v_pmax then v_verdict := 'imprecis';
      elsif v_dist <= v_rayon then v_verdict := 'dans';
      elsif v_dist - p_precision > v_rayon then v_verdict := 'hors';          -- dehors même en comptant la marge d'erreur
      else v_verdict := 'imprecis'; end if;                                    -- à la limite : on ne conclut pas
    end if;
  end if;
  insert into hr_geo_evenements (session_id, employe_id, client_id, type, lat, lng, precision_m, distance_m, wifi_restaurant, verdict, detail, heure_tel, heure_retenue)
  values (s.id, p_emp, p_client_id, p_type, p_lat, p_lng, p_precision, v_dist, coalesce(p_wifi_restaurant, false), v_verdict, left(p_detail, 200), p_heure_tel, v_quand);
  update hr_geo_sessions set derniere_vue = greatest(coalesce(derniere_vue, v_quand), v_quand), appli_vue = true,
         derniere_position_ok = case when v_verdict in ('dans', 'hors') then greatest(coalesce(derniere_position_ok, v_quand), v_quand) else derniere_position_ok end,
         permission = case when p_type = 'permission' then left(p_detail, 40) when p_type = 'gps_desactive' then 'gps_desactive' else permission end
   where id = s.id;
  select nom into n from hr_employes where id = p_emp;

  if p_type = 'permission' and p_detail in ('refusee', 'pendant_utilisation') then
    perform hr_geo_alerter('perm:' || s.id || ':' || p_detail, s.id, null, p_emp, 'permission_retiree', 'normale',
      n || ' : localisation ' || case when p_detail = 'refusee' then 'refusée' else 'limitée à « pendant l''utilisation »' end || ' sur son téléphone. Le suivi ne peut pas fonctionner.', 'Localisation désactivée');
  elsif p_type = 'gps_desactive' then
    perform hr_geo_alerter('gps:' || s.id || ':' || to_char(v_quand, 'YYYYMMDDHH24'), s.id, null, p_emp, 'gps_desactive', 'normale',
      n || ' : la localisation du téléphone est coupée. Position inconnue (ce n''est pas une sortie).', 'Localisation coupée');
  end if;

  -- machine d'état : dans → à vérifier → hors (confirmée) → dans ; « imprécis » ne change jamais l'état
  if v_verdict = 'hors' and s.etat in ('dans', 'inconnu') then
    update hr_geo_sessions set etat = 'a_verifier', etat_depuis = v_quand where id = s.id;
    s.etat := 'a_verifier'; s.etat_depuis := v_quand;
  end if;
  if v_verdict = 'hors' and s.etat = 'a_verifier' then
    select count(*), min(heure_retenue) into v_nb, v_premier from hr_geo_evenements
     where session_id = s.id and verdict = 'hors' and heure_retenue >= s.etat_depuis;
    if v_nb >= 3 and extract(epoch from (v_quand - v_premier)) >= v_conf then
      insert into hr_geo_sorties (session_id, employe_id, jour_service, debut) values (s.id, p_emp, s.jour_service, v_premier) returning id into v_sortie;
      update hr_geo_sessions set etat = 'hors', etat_depuis = v_premier where id = s.id;
      s.etat := 'hors';
    end if;
  elsif v_verdict = 'dans' then
    if s.etat = 'hors' then
      -- retour confirmé : Wi-Fi du restaurant, ou 2 positions précises dans le rayon depuis la sortie
      select count(*) into v_nb from hr_geo_evenements where session_id = s.id and verdict = 'dans' and heure_retenue >= s.etat_depuis;
      if p_wifi_restaurant or v_nb >= 2 then
        select id into v_sortie from hr_geo_sorties where session_id = s.id and fin is null order by id desc limit 1;
        update hr_geo_sorties set fin = (select min(heure_retenue) from hr_geo_evenements where session_id = s.id and verdict = 'dans' and heure_retenue >= s.etat_depuis),
               cloture = 'retour' where id = v_sortie;
        update hr_geo_sessions set etat = 'dans', etat_depuis = v_quand where id = s.id;
        if (select niveau from hr_geo_sorties where id = v_sortie) > 0 then
          perform hr_geo_alerter('retour:' || v_sortie, s.id, v_sortie, p_emp, 'retour', 'info',
            n || ' est revenu(e) au restaurant après ' || (select ceil(extract(epoch from (fin - debut)) / 60)::int from hr_geo_sorties where id = v_sortie) || ' min dehors.', 'Retour au restaurant');
        end if;
        update hr_geo_alertes set statut = 'cloturee' where sortie_id = v_sortie and statut in ('nouvelle', 'en_cours') and type <> 'retour';
        s.etat := 'dans';
      end if;
    elsif s.etat <> 'dans' then
      update hr_geo_sessions set etat = 'dans', etat_depuis = v_quand where id = s.id;
      s.etat := 'dans';
    end if;
  end if;
  return jsonb_build_object('ok', true, 'suivi', true, 'etat', s.etat, 'verdict', v_verdict, 'distance_m', round(v_dist::numeric));
end $$;

-- ============ évaluation périodique (chaque minute) ============
create or replace function public.hr_geo_evaluer() returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  a1 numeric := hr_geo_param('geo_alerte1_min', 3); a2 numeric := hr_geo_param('geo_alerte2_min', 10);
  inj numeric := hr_geo_param('geo_injoignable_min', 10); r record; n_al int := 0; v_fin_prevue timestamp;
begin
  for r in select o.*, e.nom from hr_geo_sorties o join hr_employes e on e.id = o.employe_id where o.fin is null loop
    if r.niveau < 2 and now() - r.debut >= make_interval(mins => a2::int) then
      update hr_geo_sorties set niveau = 2 where id = r.id;
      perform hr_geo_alerter('sortie:' || r.id || ':2', r.session_id, r.id, r.employe_id, 'sortie_prolongee', 'haute',
        r.nom || ' est hors du restaurant depuis ' || ceil(extract(epoch from (now() - r.debut)) / 60)::int || ' min (sortie depuis ' || to_char(r.debut at time zone 'Africa/Casablanca', 'HH24"h"MI') || ').', 'Sortie prolongée');
      update hr_geo_alertes set priorite = 'haute' where sortie_id = r.id and type = 'sortie' and statut <> 'cloturee';
      n_al := n_al + 1;
    elsif r.niveau < 1 and now() - r.debut >= make_interval(mins => a1::int) then
      update hr_geo_sorties set niveau = 1 where id = r.id;
      perform hr_geo_alerter('sortie:' || r.id || ':1', r.session_id, r.id, r.employe_id, 'sortie', 'normale',
        r.nom || ' a quitté le restaurant à ' || to_char(r.debut at time zone 'Africa/Casablanca', 'HH24"h"MI') || ' (depuis ' || ceil(extract(epoch from (now() - r.debut)) / 60)::int || ' min).', 'Sortie du restaurant');
      n_al := n_al + 1;
    end if;
  end loop;
  -- téléphone muet pendant le service (seulement si l'appli a déjà envoyé des positions)
  for r in select s.*, e.nom from hr_geo_sessions s join hr_employes e on e.id = s.employe_id
            where s.statut = 'active' and s.appli_vue and s.derniere_vue < now() - make_interval(mins => inj::int) loop
    perform hr_geo_alerter('muet:' || r.id || ':' || to_char(r.derniere_vue, 'YYYYMMDDHH24MI'), r.id, null, r.employe_id, 'injoignable', 'normale',
      r.nom || ' : aucune nouvelle du téléphone depuis ' || to_char(r.derniere_vue at time zone 'Africa/Casablanca', 'HH24"h"MI') || ' (éteint, hors connexion ou appli fermée). Position inconnue.', 'Téléphone injoignable');
    update hr_geo_sessions set etat = 'inconnu' where id = r.id and etat <> 'hors';
  end loop;
  -- départ oublié : session close 2 h après la fin du dernier service prévu (ou 16 h après l'arrivée)
  for r in select s.* from hr_geo_sessions s where s.statut = 'active' loop
    select max(k.jour + case when k.fin <= k.debut then k.fin + interval '1 day' else k.fin end)
      into v_fin_prevue from hr_planning_effectif(r.jour_service, r.jour_service) k where k.employe_id = r.employe_id;
    if now() > coalesce((v_fin_prevue at time zone 'Africa/Casablanca') + interval '2 hours', r.debut + interval '16 hours') then -- heure locale du planning convertie en instant
      perform hr_geo_fermer(r.id, now(), 'fermee_auto', null);
    end if;
  end loop;
  -- minimisation : les coordonnées brutes sont effacées après la durée de conservation (les sorties restent)
  update hr_geo_evenements set lat = null, lng = null, coordonnees_effacees = true
   where not coordonnees_effacees and heure_serveur < now() - make_interval(days => hr_geo_param('geo_conservation_jours', 90)::int);
  return jsonb_build_object('ok', true, 'alertes', n_al);
end $$;

revoke all on function public.hr_geo_evenement(int, text, text, double precision, double precision, double precision, timestamptz, boolean, text) from public, anon, authenticated;
revoke all on function public.hr_geo_evaluer() from public, anon, authenticated;
revoke all on function public.hr_geo_alerter(text, bigint, bigint, int, text, text, text, text) from public, anon, authenticated;
revoke all on function public.hr_geo_fermer(bigint, timestamptz, text, bigint) from public, anon, authenticated;
