-- Départs anticipés : tolérance réglable, minutes exactes conservées, statut autorisé / non autorisé.
-- Le planning n'est jamais modifié ; un départ anticipé n'est jamais une absence ; aucune retenue automatique.
insert into public.hr_parametres (cle, valeur) values ('tolerance_depart_min', '5'), ('mode_depart', 'complet') on conflict (cle) do nothing;

drop function if exists public.hr_journees(date, date);
create function public.hr_journees(p_debut date, p_fin date)
 returns table(jour date, employe_id integer, nom text, service text, creneau_ordre smallint, prevu_debut time without time zone, prevu_fin time without time zone,
   pause_min integer, arrivee_min integer, depart_min integer, retard_min integer, retard_justifie_min integer, heures_sup_min integer,
   depart_anticipe_min integer, presence_min integer, travail_min integer, statut text, absence_type text, depart_autorise_min integer,
   depart_anticipe_brut_min integer, depart_anticipe_statut text)
 language sql stable set search_path to 'public', 'pg_temp'
as $function$
with p as (
  select
    coalesce(max(valeur) filter (where cle='tolerance_retard_min'),'5')::int tol,
    coalesce(max(valeur) filter (where cle='mode_retard'),'complet') mret,
    coalesce(max(valeur) filter (where cle='seuil_heures_sup_min'),'45')::int seuil,
    coalesce(max(valeur) filter (where cle='mode_heures_sup'),'complet') mhs,
    coalesce(max(valeur) filter (where cle='tolerance_depart_min'),'5')::int told,
    coalesce(max(valeur) filter (where cle='mode_depart'),'complet') mdep,
    coalesce(max(valeur) filter (where cle='bascule_heure'),'5')::int basc,
    coalesce(max(valeur) filter (where cle='debut_suivi'),'2000-01-01')::date suivi
  from public.hr_parametres
),
d0 as (select greatest(p_debut, (select suivi from p)) d),
auj as (
  select ((now() at time zone 'Africa/Casablanca') - make_interval(hours => (select basc from p)))::date d
),
pt as (
  select x.employe_id, x.jour_service, x.type, x.horodatage,
         (extract(epoch from ((x.horodatage at time zone 'Africa/Casablanca') - x.jour_service::timestamp)) / 60)::int m,
         lag(x.type) over (partition by x.employe_id, x.jour_service order by x.horodatage) prev_type
  from public.hr_pointages x
  where x.accepte and not x.annule and x.jour_service between (select d from d0) and p_fin
),
arr as (
  select a.*, lead(a.horodatage) over (partition by a.employe_id, a.jour_service order by a.horodatage) next_arr
  from pt a where a.type='arrivee' and a.prev_type is distinct from 'arrivee'
),
sess as (
  select a.employe_id, a.jour_service, a.m arr_m,
         (select min(d.m) from pt d where d.employe_id=a.employe_id and d.jour_service=a.jour_service
            and d.type='depart' and d.horodatage > a.horodatage
            and (a.next_arr is null or d.horodatage < a.next_arr)) dep_m
  from arr a
),
cal as (
  select g::date jour, e.id employe_id, e.nom, e.service
  from generate_series((select d from d0), p_fin, interval '1 day') g
  cross join public.hr_employes e where (e.actif or e.date_sortie is not null) and (e.date_sortie is null or g::date < e.date_sortie)
),
pe as materialized (select * from public.hr_planning_effectif((select d from d0), p_fin)),
cr as (
  select c.jour, c.employe_id, c.nom, c.service, k.ordre, k.debut, k.fin, k.pause_min,
         (extract(epoch from k.debut)/60)::int d_m,
         case when k.fin <= k.debut then (extract(epoch from k.fin)/60)::int + 1440 else (extract(epoch from k.fin)/60)::int end f_m
  from cal c join pe k
    on k.employe_id=c.employe_id and k.jour = c.jour
),
aff as (
  select s.*, (select k.ordre from cr k where k.employe_id=s.employe_id and k.jour=s.jour_service
               order by abs(s.arr_m - k.d_m), k.ordre limit 1) ordre
  from sess s
),
couv0 as (
  select k.jour, k.employe_id, k.ordre, s.arr_m s_arr, s.dep_m s_dep, s.ordre owner
  from cr k join aff s on s.employe_id=k.employe_id and s.jour_service=k.jour and s.ordre < k.ordre
  where s.dep_m is not null and s.arr_m < k.d_m and s.dep_m >= k.d_m + (k.f_m - k.d_m)/2
    and not exists (select 1 from aff o where o.employe_id=k.employe_id and o.jour_service=k.jour and o.ordre=k.ordre)
),
couv as (
  select c.*, max(c.ordre) over (partition by c.employe_id, c.jour, c.owner, c.s_arr) last_ord
  from (select distinct on (employe_id, jour, ordre) * from couv0 order by employe_id, jour, ordre, s_arr) c
),
owners as (select distinct employe_id, jour, owner ordre from couv),
abs_v as (
  select a.employe_id, g::date jour, a.type,
    case when a.heure_debut is null then null else (extract(epoch from a.heure_debut)/60)::int
         + case when extract(hour from a.heure_debut) < (select basc from p) then 1440 else 0 end end hd_m,
    case when a.heure_fin is null then null else (extract(epoch from a.heure_fin)/60)::int
         + case when extract(hour from a.heure_fin) < (select basc from p) then 1440 else 0 end end hf_m
  from public.hr_absences a, generate_series(a.date_debut, a.date_fin, interval '1 day') g
  where a.statut='validee'
),
base as (
  select k.jour, k.employe_id, k.nom, k.service, k.ordre, k.debut, k.fin, k.pause_min, k.d_m, k.f_m,
         min(f.arr_m) arr_m,
         case when bool_or(f.dep_m is null) then null else max(f.dep_m) end dep_m
  from cr k left join aff f on f.employe_id=k.employe_id and f.jour_service=k.jour and f.ordre=k.ordre
  group by 1,2,3,4,5,6,7,8,9,10
),
lignes as (
  select b.jour, b.employe_id, b.nom, b.service, b.ordre, b.debut, b.fin, b.pause_min, b.d_m, b.f_m,
    case when c.ordre is not null then b.d_m else b.arr_m end arr_m,
    case when o.ordre is not null then b.f_m
         when c.ordre is not null then case when c.ordre = c.last_ord then c.s_dep else b.f_m end
         else b.dep_m end dep_m,
    (c.ordre is not null or o.ordre is not null) coupure
  from base b
  left join couv c on c.employe_id=b.employe_id and c.jour=b.jour and c.ordre=b.ordre
  left join owners o on o.employe_id=b.employe_id and o.jour=b.jour and o.ordre=b.ordre
),
aut as (
  select l.*,
    (select v.type from abs_v v where v.employe_id=l.employe_id and v.jour=l.jour
       and v.type in ('conge','maladie','absence_autorisee')
       and (v.hd_m is null or v.hf_m is null or (v.hd_m < l.f_m and v.hf_m > l.d_m)) limit 1) abs_type,
    (select max(coalesce(v.hf_m, 100000)) from abs_v v where v.employe_id=l.employe_id and v.jour=l.jour
       and v.type='retard_justifie' and (v.hf_m is null or (v.hf_m > l.d_m and v.hf_m <= l.f_m))) arr_aut,
    (select min(coalesce(v.hd_m, -1)) from abs_v v where v.employe_id=l.employe_id and v.jour=l.jour
       and v.type='depart_anticipe' and (v.hd_m is null or (v.hd_m >= l.d_m and v.hd_m < l.f_m))) dep_aut
  from lignes l
),
-- minutes exactes de départ avant la fin prévue (0 si départ à l'heure ou plus tard)
da as (select a.*, case when a.dep_m is not null and a.dep_m < a.f_m then a.f_m - a.dep_m else 0 end brut from aut a)
select l.jour, l.employe_id, l.nom, l.service, l.ordre::smallint, l.debut, l.fin, l.pause_min,
  l.arr_m, l.dep_m,
  case when l.arr_m is null or l.arr_m - l.d_m <= p.tol then 0
       when l.arr_aut is null then case when p.mret='deduit' then l.arr_m - l.d_m - p.tol else l.arr_m - l.d_m end
       when l.arr_aut = 100000 then 0
       when l.arr_m - l.arr_aut <= p.tol then 0
       when p.mret='deduit' then l.arr_m - l.arr_aut - p.tol else l.arr_m - l.arr_aut end,
  case when l.arr_m is null or l.arr_m - l.d_m <= p.tol or l.arr_aut is null then 0
       when l.arr_aut = 100000 then l.arr_m - l.d_m
       else least(l.arr_m, l.arr_aut) - l.d_m end,
  case when l.dep_m is null or l.dep_m - l.f_m <= p.seuil then 0
       when p.mhs='deduit' then l.dep_m - l.f_m - p.seuil else l.dep_m - l.f_m end,
  -- départ anticipé NON autorisé (minutes comptées)
  case when l.brut <= p.told then 0
       when l.dep_aut is null then case when p.mdep='deduit' then l.brut - p.told else l.brut end
       when l.dep_aut = -1 or l.dep_m >= l.dep_aut - p.told then 0
       when p.mdep='deduit' then l.dep_aut - l.dep_m - p.told else l.dep_aut - l.dep_m end,
  case when l.arr_m is not null and l.dep_m is not null then l.dep_m - l.arr_m end,
  case when l.arr_m is not null and l.dep_m is not null then greatest(l.dep_m - l.arr_m - l.pause_min, 0) end,
  case
    when l.coupure and l.arr_m is not null then 'coupure_non_pointee'
    when l.arr_m is not null and l.dep_m is null and l.jour < (select d from auj) then 'depart_non_pointe'
    when l.arr_m is not null and l.dep_m is null then 'present'
    when l.arr_m is not null then 'travaille'
    when l.abs_type is not null then 'absence_justifiee'
    when l.jour < (select d from auj) then 'absence_injustifiee'
    when l.jour = (select d from auj) and (now() at time zone 'Africa/Casablanca') >
         (l.jour::timestamp + make_interval(mins => l.d_m + p.tol)) then 'absent_en_cours'
    else 'a_venir' end,
  l.abs_type,
  -- départ anticipé couvert par une autorisation validée (minutes conservées, non comptées)
  case when l.brut <= p.told or l.dep_aut is null then 0
       when l.dep_aut = -1 then l.brut
       else l.f_m - greatest(l.dep_m, l.dep_aut) end,
  l.brut,
  case when l.brut = 0 or l.coupure then null
       when l.brut <= p.told then 'tolere'
       when l.dep_aut is null then 'non_autorise'
       when l.dep_aut = -1 or l.dep_m >= l.dep_aut - p.told then 'autorise'
       else 'partiel' end
from da l cross join p
union all
select s.jour_service, s.employe_id, e.nom, e.service, 0::smallint, null, null, 0,
  min(s.arr_m), case when bool_or(s.dep_m is null) then null else max(s.dep_m) end,
  0, 0, 0, 0,
  sum(s.dep_m - s.arr_m)::int, sum(s.dep_m - s.arr_m)::int,
  'hors_planning', null, 0, 0, null
from sess s join public.hr_employes e on e.id=s.employe_id
where not exists (select 1 from pe k where k.employe_id=s.employe_id and k.jour=s.jour_service)
group by s.jour_service, s.employe_id, e.nom, e.service
order by 1, 3, 5;
$function$;
revoke all on function public.hr_journees(date, date) from public, anon, authenticated;
grant execute on function public.hr_journees(date, date) to service_role;
