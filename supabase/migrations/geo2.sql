-- ============ Module « Présence et sorties » – v2 (verrou CNDP, consentement, simulation, justification employé) ============
-- Additif : aucune donnée supprimée, le pointage n'est pas modifié.

insert into public.hr_parametres (cle, valeur) values ('geo_cndp', 'en_attente') on conflict (cle) do nothing;
-- Tant que la CNDP n'a pas confirmé, le module reste coupé, même si quelqu'un avait coché « actif ».
update public.hr_parametres set valeur = '0' where cle = 'geo_actif' and (select valeur from public.hr_parametres where cle = 'geo_cndp') <> 'confirmee';

-- Choix de l'employé (historique conservé : le dernier choix fait foi)
create table if not exists public.hr_geo_consentements (
  id bigserial primary key,
  employe_id int not null references public.hr_employes(id),
  choix text not null check (choix in ('autorise', 'refuse')),
  version_texte text not null,
  appareil_id uuid,
  cree_le timestamptz not null default now()
);
create index if not exists hr_geo_consentements_emp on public.hr_geo_consentements (employe_id, cree_le desc);
alter table public.hr_geo_consentements enable row level security;

-- Simulation : lignes fictives, sans employé réel, jamais mélangées aux vraies données
alter table public.hr_geo_sessions add column if not exists simulation boolean not null default false;
alter table public.hr_geo_sessions add column if not exists sim_nom text;
alter table public.hr_geo_evenements add column if not exists simulation boolean not null default false;
alter table public.hr_geo_sorties add column if not exists simulation boolean not null default false;
alter table public.hr_geo_alertes add column if not exists simulation boolean not null default false;
alter table public.hr_geo_sessions alter column employe_id drop not null;
alter table public.hr_geo_evenements alter column employe_id drop not null;
alter table public.hr_geo_sorties alter column employe_id drop not null;
alter table public.hr_geo_alertes alter column employe_id drop not null;
do $$ begin
  alter table public.hr_geo_sessions add constraint hr_geo_sessions_emp_ou_sim check (simulation or employe_id is not null);
  alter table public.hr_geo_evenements add constraint hr_geo_evenements_emp_ou_sim check (simulation or employe_id is not null);
  alter table public.hr_geo_sorties add constraint hr_geo_sorties_emp_ou_sim check (simulation or employe_id is not null);
  alter table public.hr_geo_alertes add constraint hr_geo_alertes_emp_ou_sim check (simulation or employe_id is not null);
exception when duplicate_object then null; end $$;

-- Justification par l'employé (puis décision du responsable)
alter table public.hr_geo_sorties add column if not exists employe_type text;
alter table public.hr_geo_sorties add column if not exists employe_commentaire text;
alter table public.hr_geo_sorties add column if not exists employe_justifie_le timestamptz;
alter table public.hr_geo_sorties drop constraint if exists hr_geo_sorties_justification_type_check;
alter table public.hr_geo_sorties add constraint hr_geo_sorties_justification_type_check
  check (justification_type in ('livraison', 'achat', 'mission', 'pause', 'urgence', 'exceptionnelle', 'autre'));
alter table public.hr_geo_sorties drop constraint if exists hr_geo_sorties_justification_statut_check;
alter table public.hr_geo_sorties add constraint hr_geo_sorties_justification_statut_check
  check (justification_statut in ('aucune', 'explication_demandee', 'justifiee', 'acceptee', 'refusee'));
alter table public.hr_geo_sorties drop constraint if exists hr_geo_sorties_employe_type_check;
alter table public.hr_geo_sorties add constraint hr_geo_sorties_employe_type_check
  check (employe_type in ('pause', 'mission', 'achat', 'urgence', 'autre'));

-- alerte : jamais de notification réelle pour une simulation
create or replace function public.hr_geo_alerter(p_cle text, p_session bigint, p_sortie bigint, p_emp int, p_type text, p_prio text, p_msg text, p_titre text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare v_sim boolean := coalesce((select simulation from hr_geo_sessions where id = p_session), false);
begin
  insert into hr_geo_alertes (cle, session_id, sortie_id, employe_id, type, priorite, message, simulation)
  values (p_cle, p_session, p_sortie, p_emp, p_type, p_prio, case when v_sim then '[SIMULATION] ' else '' end || p_msg, v_sim) on conflict (cle) do nothing;
  if found and not v_sim and hr_geo_param('geo_actif', 0) = 1
     and (select valeur from hr_parametres where cle = 'geo_cndp') = 'confirmee' then
    insert into hr_notifications (destinataire, type, titre, message, lien, cle, details)
    values ('gerant', 'geo_' || p_type, p_titre, p_msg, 'geo', 'geo:' || p_cle,
            jsonb_build_object('employe_id', p_emp, 'sortie_id', p_sortie))
    on conflict (cle) do nothing;
  end if;
end $$;

drop function if exists public.hr_geo_evenement(int, text, text, double precision, double precision, double precision, timestamptz, boolean, text);
create or replace function public.hr_geo_evenement(p_emp int, p_client_id text, p_type text, p_lat double precision, p_lng double precision,
  p_precision double precision, p_heure_tel timestamptz, p_wifi_restaurant boolean, p_detail text, p_session bigint default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  s hr_geo_sessions; v_rayon numeric := hr_geo_param('geo_rayon_m', 30); v_pmax numeric := hr_geo_param('geo_precision_max_m', 20);
  v_conf numeric := hr_geo_param('geo_confirmation_s', 60);
  v_lat numeric := (select valeur::numeric from hr_parametres where cle = 'site_lat');
  v_lng numeric := (select valeur::numeric from hr_parametres where cle = 'site_lng');
  v_quand timestamptz; v_dist double precision; v_verdict text := 'info'; v_nb int; v_premier timestamptz; v_sortie bigint; n text;
begin
  -- p_session : session de simulation (données fictives) ; sinon la session réelle active de l'employé
  if p_session is not null then
    select * into s from hr_geo_sessions where id = p_session and simulation and statut = 'active' for update;
  else
    select * into s from hr_geo_sessions where employe_id = p_emp and not simulation and statut = 'active' for update;
  end if;
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
  insert into hr_geo_evenements (session_id, employe_id, client_id, type, lat, lng, precision_m, distance_m, wifi_restaurant, verdict, detail, heure_tel, heure_retenue, simulation)
  values (s.id, s.employe_id, p_client_id, p_type, p_lat, p_lng, p_precision, v_dist, coalesce(p_wifi_restaurant, false), v_verdict, left(p_detail, 200), p_heure_tel, v_quand, s.simulation);
  update hr_geo_sessions set derniere_vue = greatest(coalesce(derniere_vue, v_quand), v_quand), appli_vue = true,
         derniere_position_ok = case when v_verdict in ('dans', 'hors') then greatest(coalesce(derniere_position_ok, v_quand), v_quand) else derniere_position_ok end,
         permission = case when p_type = 'permission' then left(p_detail, 40) when p_type = 'gps_desactive' then 'gps_desactive' else permission end
   where id = s.id;
  n := coalesce(s.sim_nom, (select nom from hr_employes where id = s.employe_id));

  if p_type = 'permission' and p_detail in ('refusee', 'pendant_utilisation') then
    perform hr_geo_alerter('perm:' || s.id || ':' || p_detail, s.id, null, s.employe_id, 'permission_retiree', 'normale',
      n || ' : localisation ' || case when p_detail = 'refusee' then 'refusée' else 'limitée à « pendant l''utilisation »' end || ' sur son téléphone. Le suivi ne peut pas fonctionner.', 'Localisation désactivée');
  elsif p_type = 'gps_desactive' then
    perform hr_geo_alerter('gps:' || s.id || ':' || to_char(v_quand, 'YYYYMMDDHH24'), s.id, null, s.employe_id, 'gps_desactive', 'normale',
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
      insert into hr_geo_sorties (session_id, employe_id, jour_service, debut, simulation) values (s.id, s.employe_id, s.jour_service, v_premier, s.simulation) returning id into v_sortie;
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
          perform hr_geo_alerter('retour:' || v_sortie, s.id, v_sortie, s.employe_id, 'retour', 'info',
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


create or replace function public.hr_geo_evaluer() returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  a1 numeric := hr_geo_param('geo_alerte1_min', 3); a2 numeric := hr_geo_param('geo_alerte2_min', 10);
  inj numeric := hr_geo_param('geo_injoignable_min', 10); r record; n_al int := 0; v_fin_prevue timestamp;
begin
  for r in select o.*, coalesce(ss.sim_nom, e.nom) as nom from hr_geo_sorties o join hr_geo_sessions ss on ss.id = o.session_id left join hr_employes e on e.id = o.employe_id where o.fin is null loop
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
  for r in select s.*, coalesce(s.sim_nom, e.nom) as nom from hr_geo_sessions s left join hr_employes e on e.id = s.employe_id
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


-- Simulation : « avancer l'horloge » = reculer toutes les heures des lignes fictives, puis évaluer.
create or replace function public.hr_geo_sim_avancer(p_minutes int) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare d interval := make_interval(mins => greatest(1, least(p_minutes, 120)));
begin
  update hr_geo_sessions set debut = debut - d, fin = fin - d, etat_depuis = etat_depuis - d, derniere_vue = derniere_vue - d,
         derniere_position_ok = derniere_position_ok - d, cree_le = cree_le - d where simulation;
  update hr_geo_evenements set heure_tel = heure_tel - d, heure_retenue = heure_retenue - d, heure_serveur = heure_serveur - d where simulation;
  update hr_geo_sorties set debut = debut - d, fin = fin - d where simulation;
  update hr_geo_alertes set cree_le = cree_le - d where simulation;
  return hr_geo_evaluer();
end $$;

revoke all on function public.hr_geo_evenement(int, text, text, double precision, double precision, double precision, timestamptz, boolean, text, bigint) from public, anon, authenticated;
revoke all on function public.hr_geo_evaluer() from public, anon, authenticated;
revoke all on function public.hr_geo_alerter(text, bigint, bigint, int, text, text, text, text) from public, anon, authenticated;
revoke all on function public.hr_geo_sim_avancer(int) from public, anon, authenticated;
