-- Tâche planifiée chaque minute : évaluation des sorties et envoi des notifications (fonction geo-v1, action « tick »)
create extension if not exists pg_cron;
insert into public.hr_parametres (cle, valeur) values ('admin_geo_tick', encode(gen_random_bytes(24), 'hex')) on conflict (cle) do nothing;
-- select cron.schedule('keynet_geo_tick', '* * * * *', $$ select net.http_post(url := '<projet>/functions/v1/geo-v1', body := jsonb_build_object('action','tick','secret',(select valeur from public.hr_parametres where cle='admin_geo_tick')), headers := '{"Content-Type":"application/json"}'::jsonb) $$);
-- Retour arrière : select cron.unschedule('keynet_geo_tick'); drop trigger hr_pointages_geo on hr_pointages; drop table hr_geo_alertes, hr_geo_sorties, hr_geo_evenements, hr_geo_sessions;
