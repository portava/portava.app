-- Behavioural proof of the CANONICAL ANCESTRY itself — 2450's trip and
-- participant families, 2500's JOIN_VIA_LINK and host capability, 2590's
-- ADD_PLAN attachment columns. Runs against the ancestry alone, before any
-- 276x transform, so a failure here is the ancestry's and not a family's.
\pset format unaligned
\pset tuples_only on
\set O '''11111111-1111-1111-1111-111111111111'''
\set S '''22222222-2222-2222-2222-222222222222'''
\set X '''44444444-4444-4444-4444-444444444444'''
\set NT '''cccccccc-cccc-cccc-cccc-cccccccccccc'''
\set LK '''dddddddd-dddd-dddd-dddd-dddddddddddd'''

TRUNCATE public.trip_events, public.trip_outbox, public.trip_command_receipts,
         public.trip_invite_link_attempts, public.trip_invite_links,
         public.trip_plan_items, public.trip_members, public.trips, public.profiles CASCADE;
INSERT INTO public.profiles (id, handle) VALUES (:O,'owner'), (:S,'second'), (:X,'stranger');

\echo '--- 2450 CREATE_TRIP needs no capability, and refuses an owner_id that is not the actor'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_user_id',:O,'type','CREATE_TRIP','idempotency_key','A1','payload',jsonb_build_object('title','Lisbon','owner_id',:S)))->>'reason';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_user_id',:O,'type','CREATE_TRIP','idempotency_key','A2','payload',jsonb_build_object('title','Lisbon','start_date','2026-10-05','end_date','2026-10-01')))->>'reason';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_user_id',:O,'type','CREATE_TRIP','idempotency_key','A3','payload',jsonb_build_object('title','Lisbon','start_date','2026-10-01','end_date','2026-10-05','visibility','public')))->>'ok';
SELECT 'title='||title||' status='||status||' vis='||visibility||' header_public='||show_header_publicly::text||' version='||version FROM trips;
SELECT 'family='||(payload_json->>'family')||' type='||type||' actor_role='||actor_role FROM trip_events ORDER BY sequence DESC LIMIT 1;
SELECT 'creating it twice -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_user_id',:O,'type','CREATE_TRIP','idempotency_key','A4','payload',jsonb_build_object('title','again')))->>'reason');

\echo '--- 2450 UPDATE_TRIP is owner-gated; a stranger is refused and changes nothing'
SELECT 'stranger -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_user_id',:X,'type','UPDATE_TRIP','idempotency_key','B1','payload',jsonb_build_object('patch',jsonb_build_object('title','hijacked'))))->>'reason');
SELECT 'title still='||title FROM trips;
SELECT 'owner -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_user_id',:O,'type','UPDATE_TRIP','idempotency_key','B2','payload',jsonb_build_object('patch',jsonb_build_object('title','Lisbon & Porto','trip_notes','bring rain gear'))))->>'ok');
SELECT 'title='||title||' notes='||trip_notes||' version='||version FROM trips;
SELECT 'an unknown patch key -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_user_id',:O,'type','UPDATE_TRIP','idempotency_key','B3','payload',jsonb_build_object('patch',jsonb_build_object('owner_id',:X))))->>'reason');
SELECT 'owner still='||(owner_id = :O)::text FROM trips;

\echo '--- 2450 participant family: invite, accept, role, remove'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_user_id',:O,'type','INVITE_PARTICIPANT','idempotency_key','C1','payload',jsonb_build_object('user_id',:S)))->>'ok';
-- role 'invited', status left at the table default 'accepted'. That is 2450's
-- stated intent -- "Legacy row shape, exactly" -- and it is safe because
-- authz.accepted_trip_ids gates on ROLE: 'invited' is not in
-- ('owner','co_host','member','viewer'), so an invitee is not crew whatever the
-- status column says. A reader that lists pending invites by status='invited'
-- alone would miss these, and would have missed the legacy writer's too.
SELECT 'role='||role||' status='||status||' is_crew='||authz.is_accepted_trip_member(:NT, :S)::text FROM trip_members WHERE user_id = :S;
SELECT 'a stranger cannot accept someone elses invite -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_user_id',:X,'type','ACCEPT_INVITE','idempotency_key','C2','payload','{}'::jsonb))->>'reason');
SELECT 'the invitee accepts -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_user_id',:S,'type','ACCEPT_INVITE','idempotency_key','C3','payload','{}'::jsonb))->>'ok');
SELECT 'status='||status FROM trip_members WHERE user_id = :S;
SELECT 'event='||(SELECT type FROM trip_events ORDER BY sequence DESC LIMIT 1)||' family='||(SELECT payload_json->>'family' FROM trip_events ORDER BY sequence DESC LIMIT 1);
SELECT 'now that they are crew they may add a plan -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_user_id',:S,'type','ADD_PLAN','idempotency_key','C4','payload',jsonb_build_object('title','Belem')))->>'ok');

\echo '--- 2500 host: the ancestry ALONE cannot make a co_host (fixed by 2769)'
-- 2500 added the `host` capability as "owner OR an accepted co_host row" and
-- gated SET_PARTICIPANT_ROLE on it, but the ancestry's role vocabulary is
-- ('member','invited'). So in a kernel-only world no co_host can ever exist and
-- `host` collapses into `owner`. This probe pins that as the ANCESTRY's
-- behaviour; probe_participant_roles_lifecycle.sql pins 2769's fix.
SELECT 'promote to co_host -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_user_id',:O,'type','SET_PARTICIPANT_ROLE','idempotency_key','D1','payload',jsonb_build_object('user_id',:S,'role','co_host')))->>'reason');
SELECT 'role still='||role FROM trip_members WHERE user_id = :S;

\echo '--- 2500 JOIN_VIA_LINK requires a claimed attempt row; without one it is refused'
INSERT INTO public.trip_invite_links (id, trip_id, token, created_by, max_uses) VALUES (:LK, :NT, 'tok-1', :O, 10);
SELECT 'no attempt row -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_user_id',:X,'type','JOIN_VIA_LINK','idempotency_key','E1','payload',jsonb_build_object('invite_link_id',:LK)))->>'reason');
SELECT 'still not a member: '||(SELECT count(*) FROM trip_members WHERE user_id = :X)::text;
INSERT INTO public.trip_invite_link_attempts (link_id, user_id) VALUES (:LK, :X);
SELECT 'with the attempt row -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_user_id',:X,'type','JOIN_VIA_LINK','idempotency_key','E2','payload',jsonb_build_object('invite_link_id',:LK)))->>'ok');
SELECT 'role='||role||' status='||status||' via_link='||(invite_link_id = :LK)::text FROM trip_members WHERE user_id = :X;
SELECT 'event='||(SELECT type FROM trip_events ORDER BY sequence DESC LIMIT 1)||' via='||(SELECT payload_json->'payload'->>'via' FROM trip_events ORDER BY sequence DESC LIMIT 1);

\echo '--- 2590 ADD_PLAN writes the four attachment columns, and refuses third-party attribution'
SELECT 'added_by must be the actor -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_user_id',:O,'type','ADD_PLAN','idempotency_key','F1','payload',jsonb_build_object('title','Sintra','added_by',:S)))->>'reason');
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_user_id',:O,'type','ADD_PLAN','idempotency_key','F2','payload',jsonb_build_object('title','Sintra','added_by',:O,'description','day trip','city','Sintra','country','PT')))->>'ok';
SELECT 'desc='||description||' city='||city||' country='||country||' added_by_owner='||(added_by = :O)::text||' private='||location_is_private::text FROM trip_plan_items WHERE title='Sintra';

\echo '--- 2450 system actor: SET_TRIP_COVER with no user, and a user actor refused'
SELECT 'as a user -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_user_id',:O,'type','SET_TRIP_COVER','idempotency_key','G1','payload',jsonb_build_object('cover_url','https://x/y.jpg')))->>'reason');
SELECT 'as system -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_role','system','type','SET_TRIP_COVER','idempotency_key','G2','payload',jsonb_build_object('cover_url','https://x/y.jpg')))->>'ok');
SELECT 'cover='||cover_url FROM trips;
SELECT 'actor_role on that event='||actor_role||' actor_is_null='||(actor_user_id IS NULL)::text FROM trip_events ORDER BY sequence DESC LIMIT 1;

\echo '--- 2450 lifecycle: complete, then refuse a transition out of a terminal state'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_user_id',:O,'type','COMPLETE_TRIP','idempotency_key','H1','payload','{}'::jsonb))->>'ok';
SELECT 'status='||status FROM trips;
SELECT 'event='||(SELECT type FROM trip_events ORDER BY sequence DESC LIMIT 1);
-- The ancestry allows CANCEL out of COMPLETED. A trip cannot both have happened
-- and have been called off; 2769 refuses this edge and
-- probe_participant_roles_lifecycle.sql pins the refusal. Here it succeeds, and
-- saying so is the point of the probe.
SELECT 'cancel a completed trip -> ok='||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:NT,'actor_user_id',:O,'type','CANCEL_TRIP','idempotency_key','H2','payload','{}'::jsonb))->>'ok');
SELECT 'status is now='||status||'  <- the defect 2769 fixes' FROM trips;

\echo '--- the ancestry ledger: events, outbox and receipts agree, versions are dense'
SELECT (SELECT count(*) FROM trip_events)||' events / '||(SELECT count(*) FROM trip_outbox)||' outbox / '||(SELECT count(*) FROM trip_command_receipts)||' receipts';
SELECT 'families: '||string_agg(DISTINCT payload_json->>'family', ', ') FROM trip_events;
SELECT 'aggregate_version is dense 1..n: '||(count(*) = max(aggregate_version) AND min(aggregate_version) = 1)::text FROM trip_events;
SELECT 'sequence is dense 1..n: '||(count(*) = max(sequence) AND min(sequence) = 1)::text FROM trip_events;
SELECT 'trips.version equals the last event version: '||((SELECT version FROM trips) = (SELECT max(aggregate_version) FROM trip_events))::text;
SELECT 'trip_events refuses UPDATE (2420 trigger): '||(
  SELECT CASE WHEN count(*) = 1 THEN 'trigger present' ELSE 'MISSING' END
  FROM pg_trigger WHERE tgrelid='public.trip_events'::regclass AND tgname='trg_trip_events_append_only');
