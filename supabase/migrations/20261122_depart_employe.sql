-- Départ d'un employé : il disparaît des listes et du planning à partir de sa date de sortie,
-- mais tout son historique est conservé (rien n'est supprimé). Son planning peut être repris.
alter table public.hr_employes add column if not exists date_sortie date, add column if not exists sortie_motif text;

do $$ declare d text; begin
  d := pg_get_functiondef('public.hr_journees'::regproc);
  if position('cross join public.hr_employes e where e.actif' in d) = 0 then raise exception 'hr_journees : motif introuvable'; end if;
  d := replace(d, 'cross join public.hr_employes e where e.actif',
    'cross join public.hr_employes e where (e.actif or e.date_sortie is not null) and (e.date_sortie is null or g::date < e.date_sortie)');
  execute d;
  d := pg_get_functiondef('public.hr_planning_effectif'::regproc);
  if position('cross join public.hr_employes e' in d) = 0 then raise exception 'hr_planning_effectif : motif introuvable'; end if;
  d := replace(d, 'cross join public.hr_employes e',
    'cross join public.hr_employes e where e.date_sortie is null or g::date < e.date_sortie');
  execute d;
end $$;

create or replace function public.hr_employe_depart(p_emp int, p_sortie date, p_motif text, p_successeur int, p_nouveau_nom text, p_nouveau_service text, p_auteur text)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare e hr_employes; s hr_employes; v_reprise date; v_pin text; v_auj date; v_copies int := 0; v_jours int := 0; dw int;
begin
  if length(coalesce(trim(p_motif), '')) < 3 then raise exception 'REFUS:Motif obligatoire (3 caractères minimum).'; end if;
  select * into e from hr_employes where id = p_emp for update;
  if not found then raise exception 'REFUS:Employé introuvable.'; end if;
  if not e.actif then raise exception 'REFUS:% ne fait déjà plus partie de l''équipe.', e.nom; end if;
  if p_sortie is null then raise exception 'REFUS:Date de départ obligatoire.'; end if;
  v_auj := ((now() at time zone 'Africa/Casablanca') - interval '5 hours')::date;
  if p_sortie > v_auj + 365 or p_sortie < v_auj - 365 then raise exception 'REFUS:Date de départ invalide.'; end if;

  -- successeur : nouvel employé ou employé existant
  if length(coalesce(trim(p_nouveau_nom), '')) > 0 then
    if exists (select 1 from hr_employes where lower(nom) = lower(trim(p_nouveau_nom)) and actif) then
      raise exception 'REFUS:Un employé actif s''appelle déjà %.', trim(p_nouveau_nom); end if;
    v_pin := lpad((1000 + floor(random() * 9000))::int::text, 4, '0');
    insert into hr_employes (nom, service, actif, pin) values (trim(p_nouveau_nom), coalesce(nullif(trim(p_nouveau_service), ''), e.service), true, v_pin)
      returning * into s;
    insert into hr_journal (auteur, objet, objet_id, action, ancienne, nouvelle, motif)
    values (p_auteur, 'employe', s.id::text, 'creation', null, jsonb_build_object('nom', s.nom, 'service', s.service), 'Remplace ' || e.nom || ' : ' || trim(p_motif));
  elsif p_successeur is not null then
    select * into s from hr_employes where id = p_successeur and actif;
    if not found or s.id = e.id then raise exception 'REFUS:Remplaçant invalide.'; end if;
  end if;

  if s.id is not null then
    v_reprise := greatest(p_sortie, v_auj);
    -- l'ancienne semaine type du remplaçant reste valable jusqu'à la veille de la reprise (rien n'est perdu)
    for dw in 1..7 loop
      insert into hr_creneaux_archives (employe_id, jour, jusqu_au, creneaux, actif)
      select s.id, dw, v_reprise - 1,
        coalesce((select jsonb_agg(jsonb_build_object('debut', to_char(c.debut, 'HH24:MI'), 'fin', to_char(c.fin, 'HH24:MI'), 'pause_min', c.pause_min) order by c.ordre)
                  from hr_creneaux c where c.employe_id = s.id and c.jour = dw and c.actif), '[]'::jsonb), true;
    end loop;
    update hr_creneaux set actif = false where employe_id = s.id and actif;
    insert into hr_creneaux (employe_id, jour, ordre, debut, fin, pause_min)
    select s.id, c.jour, c.ordre, c.debut, c.fin, c.pause_min from hr_creneaux c where c.employe_id = e.id and c.actif;
    get diagnostics v_copies = row_count;
    -- jours déjà modifiés dans le futur
    insert into hr_planning_jours (employe_id, jour, creneaux, actif, motif)
    select s.id, x.jour, x.creneaux, true, 'Repris de ' || e.nom
    from hr_planning_jours x where x.employe_id = e.id and x.actif and x.jour >= v_reprise
      and not exists (select 1 from hr_planning_jours y where y.employe_id = s.id and y.jour = x.jour and y.actif);
    get diagnostics v_jours = row_count;
    insert into hr_journal (auteur, objet, objet_id, action, ancienne, nouvelle, motif)
    values (p_auteur, 'planning', s.id::text, 'reprise', null,
      jsonb_build_object('repris_de', e.nom, 'a_partir_du', v_reprise, 'creneaux', v_copies, 'jours_modifies', v_jours), trim(p_motif));
  end if;

  -- l'employé sortant : retiré des listes, téléphone désactivé, historique intact
  update hr_employes set actif = false, date_sortie = p_sortie, sortie_motif = trim(p_motif) where id = e.id;
  update hr_push_abonnements set actif = false, maj_le = now() where actif and appareil_id in (select id from hr_appareils where employe_id = e.id and actif);
  update hr_appareils set actif = false, revoque_le = now() where employe_id = e.id and actif;
  insert into hr_journal (auteur, objet, objet_id, action, ancienne, nouvelle, motif)
  values (p_auteur, 'employe', e.id::text, 'depart', jsonb_build_object('actif', true),
    jsonb_build_object('actif', false, 'date_sortie', p_sortie, 'remplace_par', s.nom), trim(p_motif));

  return jsonb_build_object('ok', true, 'successeur_id', s.id, 'successeur_nom', s.nom, 'pin', v_pin, 'reprise', v_reprise, 'creneaux', v_copies);
end $$;
