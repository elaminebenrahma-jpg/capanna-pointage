-- KeyNet : présence fiable (le pointage ne dépend plus d'une seule adresse de box)
-- Rien n'est supprimé : on ajoute des colonnes, des paramètres et deux fonctions.

-- 1. pointages : état de vérification + preuve GPS éventuelle
alter table hr_pointages
  add column if not exists verif text,
  add column if not exists verif_le timestamptz,
  add column if not exists verif_detail text,
  add column if not exists reseau text,
  add column if not exists lat double precision,
  add column if not exists lng double precision,
  add column if not exists precision_m double precision;

alter table hr_pointages drop constraint if exists hr_pointages_verif_check;
alter table hr_pointages add constraint hr_pointages_verif_check
  check (verif is null or verif in ('a_verifier','valide_reseau','valide_gps','valide_gerant','doublon','refuse_gerant'));

-- la source peut désormais aussi être « gps »
alter table hr_pointages drop constraint if exists hr_pointages_source_check;
alter table hr_pointages add constraint hr_pointages_source_check
  check (source in ('wifi','manuel','gps'));

create index if not exists hr_pointages_a_verifier_idx on hr_pointages (reseau, horodatage) where verif = 'a_verifier';

-- 2. réseaux : d'où vient l'autorisation
alter table hr_reseaux
  add column if not exists origine text not null default 'gerant',
  add column if not exists confirme_par text;

-- 3. position du restaurant (vide tant que le gérant ne l'a pas enregistrée)
insert into hr_parametres (cle, valeur) values ('site_rayon_m', '15') on conflict (cle) do nothing;

-- 4. valider un réseau : l'autorise et accepte, à leur heure d'origine, les pointages en attente venus de ce réseau
create or replace function hr_valider_reseau(p_reseau text, p_libelle text, p_origine text, p_motif text, p_auteur text, p_verif text default 'valide_reseau')
returns jsonb language plpgsql as $$
declare
  r record; dernier text; cle_courante text := ''; acceptes int := 0; doublons int := 0;
  noms text[] := '{}';
begin
  insert into hr_reseaux (reseau, libelle, origine, confirme_par)
  values (p_reseau, coalesce(p_libelle, 'Wi-Fi Capanna'), p_origine, p_auteur)
  on conflict (reseau) do nothing;
  if found then
    insert into hr_journal (auteur, objet, objet_id, action, ancienne, nouvelle, motif)
    values (p_auteur, 'reseau', p_reseau, 'ajout', null, jsonb_build_object('reseau', p_reseau, 'origine', p_origine), p_motif);
  end if;

  -- on rejoue chaque journée concernée dans l'ordre : pointages déjà acceptés + pointages en attente
  for r in
    select p.*, e.nom from hr_pointages p join hr_employes e on e.id = p.employe_id
    where (p.employe_id, p.jour_service) in (
            select employe_id, jour_service from hr_pointages
            where verif = 'a_verifier' and reseau = p_reseau and horodatage > now() - interval '48 hours')
      and ((p.accepte and not p.annule) or (p.verif = 'a_verifier' and p.reseau = p_reseau))
    order by p.employe_id, p.jour_service, p.horodatage
  loop
    if cle_courante <> r.employe_id || '|' || r.jour_service then
      cle_courante := r.employe_id || '|' || r.jour_service; dernier := null;
    end if;
    if r.accepte then dernier := r.type; continue; end if;
    if (r.type = 'arrivee' and dernier is distinct from 'arrivee') or (r.type = 'depart' and dernier = 'arrivee') then
      update hr_pointages set accepte = true, verif = p_verif, verif_le = now(),
        verif_detail = p_motif, motif = null
      where id = r.id;
      insert into hr_journal (auteur, objet, objet_id, action, ancienne, nouvelle, motif)
      values (p_auteur, 'pointage', r.id::text, 'validation',
        jsonb_build_object('accepte', false, 'verif', 'a_verifier'),
        jsonb_build_object('accepte', true, 'verif', p_verif, 'type', r.type, 'horodatage', r.horodatage), p_motif);
      insert into hr_notifications (destinataire, type, message, titre, lien, cle)
      values ('employe:' || r.employe_id, 'pointage_valide',
        (case when r.type = 'arrivee' then 'Ton arrivée' else 'Ton départ' end) || ' de ' ||
          to_char(r.horodatage at time zone 'Africa/Casablanca', 'HH24"h"MI') || ' est validé(e).',
        'Pointage validé', 'pointage', 'pointage_valide:' || r.id)
      on conflict (cle) do nothing;
      dernier := r.type; acceptes := acceptes + 1;
      if not (r.nom = any(noms)) then noms := noms || r.nom; end if;
    else
      update hr_pointages set verif = 'doublon', verif_le = now(), verif_detail = 'Tentative répétée' where id = r.id;
      doublons := doublons + 1;
    end if;
  end loop;
  return jsonb_build_object('acceptes', acceptes, 'doublons', doublons, 'employes', to_jsonb(noms));
end $$;

-- 5. apprendre un réseau : plusieurs employés différents (ou GPS) depuis la même adresse = ils sont au restaurant
-- (version finale appliquée par la migration hr_presence_apprendre_gps)
create or replace function hr_apprendre_reseau(p_reseau text)
returns jsonb language plpgsql as $$
declare n int; n_gps int; res jsonb;
begin
  if exists (select 1 from hr_reseaux where reseau = p_reseau) then
    return hr_valider_reseau(p_reseau, null, 'auto', 'Réseau déjà autorisé', 'système');
  end if;
  select count(distinct employe_id) filter (where verif = 'a_verifier'),
         count(distinct employe_id) filter (where verif = 'valide_gps')
    into n, n_gps
  from hr_pointages where reseau = p_reseau and verif in ('a_verifier','valide_gps') and horodatage > now() - interval '90 minutes';
  if n_gps >= 2 or n >= 3 or (n_gps >= 1 and n + n_gps >= 3) then
    res := hr_valider_reseau(p_reseau, 'Wi-Fi Capanna (appris le ' || to_char(now() at time zone 'Africa/Casablanca', 'DD/MM') || ')', 'auto',
      case when n_gps >= 1 then 'Réseau appris : présence confirmée par GPS (' || n_gps || ') et par ' || (n + n_gps) || ' employés'
           else 'Réseau appris : ' || n || ' employés différents ont pointé depuis cette adresse' end, 'système');
    insert into hr_notifications (destinataire, type, message, titre, lien, cle)
    values ('gerant', 'reseau_appris',
      'La box du restaurant a changé d''adresse (' || p_reseau || '). Le nouveau réseau a été reconnu automatiquement et '
        || (res->>'acceptes') || ' pointage(s) en attente ont été validés à leur heure. Tu peux le retirer dans Réglages si ce n''est pas le restaurant.',
      'Nouveau réseau reconnu', 'reglages', 'reseau_appris:' || p_reseau)
    on conflict (cle) do nothing;
    return res || jsonb_build_object('appris', true);
  end if;
  if n >= 2 then
    insert into hr_notifications (destinataire, type, message, titre, lien, cle)
    values ('gerant', 'reseau_inconnu',
      n || ' employés essaient de pointer depuis un réseau inconnu (' || p_reseau || '). Si vous êtes au restaurant, autorise-le en un geste depuis le tableau de bord.',
      'Pointages en attente', 'tableau', 'reseau_inconnu:' || p_reseau || ':' || to_char(now() at time zone 'Africa/Casablanca', 'YYYY-MM-DD'))
    on conflict (cle) do nothing;
  end if;
  return jsonb_build_object('appris', false, 'employes', n);
end $$;
