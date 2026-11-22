-- Plus aucune validation automatique d'un réseau inconnu : seul le gérant peut autoriser un nouveau réseau.
-- Le gérant est toujours prévenu dès que 2 employés pointent depuis la même adresse inconnue.
create or replace function hr_apprendre_reseau(p_reseau text)
returns jsonb language plpgsql as $$
declare n int;
begin
  if exists (select 1 from hr_reseaux where reseau = p_reseau) then
    return hr_valider_reseau(p_reseau, null, 'auto', 'Réseau déjà autorisé', 'système');
  end if;
  select count(distinct employe_id) into n
  from hr_pointages where reseau = p_reseau and verif in ('a_verifier','valide_gps') and horodatage > now() - interval '90 minutes';
  if n >= 2 then
    insert into hr_notifications (destinataire, type, message, titre, lien, cle)
    values ('gerant', 'reseau_inconnu',
      n || ' employés ont pointé depuis un réseau inconnu (' || p_reseau || '). Si vous êtes au restaurant (la box a changé d''adresse), autorise-le depuis le tableau de bord : leurs pointages seront validés à leur heure.',
      'Pointages en attente', 'tableau', 'reseau_inconnu:' || p_reseau || ':' || to_char(now() at time zone 'Africa/Casablanca', 'YYYY-MM-DD'))
    on conflict (cle) do nothing;
  end if;
  return jsonb_build_object('appris', false, 'employes', n);
end $$;
