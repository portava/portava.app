\pset format unaligned
\pset tuples_only on
\set T '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''
\set O '''11111111-1111-1111-1111-111111111111'''

\echo '--- §10.2 freshness derives from the row''s OWN ttl'
SELECT 'live       -> '||public.trip_presence_freshness('2026-10-01T12:00:00Z','2026-10-01T12:20:00Z','2026-10-01T12:03:00Z');
SELECT 'recent     -> '||public.trip_presence_freshness('2026-10-01T12:00:00Z','2026-10-01T12:20:00Z','2026-10-01T12:10:00Z');
SELECT 'last_known -> '||public.trip_presence_freshness('2026-10-01T12:00:00Z','2026-10-01T12:20:00Z','2026-10-01T12:30:00Z');
SELECT 'offline    -> '||public.trip_presence_freshness('2026-10-01T12:00:00Z','2026-10-01T12:20:00Z','2026-10-01T13:00:00Z');
SELECT 'a 4-minute ttl is live for 1 minute:  '||public.trip_presence_freshness('2026-10-01T12:00:00Z','2026-10-01T12:04:00Z','2026-10-01T12:00:30Z')
     ||' then '||public.trip_presence_freshness('2026-10-01T12:00:00Z','2026-10-01T12:04:00Z','2026-10-01T12:02:00Z');
SELECT 'a null observed_at is offline, never live: '||public.trip_presence_freshness(NULL,'2026-10-01T12:20:00Z','2026-10-01T12:01:00Z');

\echo '--- a fresh observation is applied'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SET_PRESENCE','idempotency_key','F1','payload',jsonb_build_object('presence_state','at_plan','observed_at','2026-10-01T12:10:00Z','expires_at','2026-10-01T12:30:00Z')))->>'ok';
SELECT 'applied='||(payload_json->'result'->>'applied')||' state='||(SELECT presence_state FROM trip_presence)||' observed='||(SELECT observed_at FROM trip_presence) FROM trip_events ORDER BY sequence DESC LIMIT 1;

\echo '--- a DELAYED observation does NOT overwrite it, and the command still succeeds'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SET_PRESENCE','idempotency_key','F2','payload',jsonb_build_object('presence_state','offline','observed_at','2026-10-01T12:00:00Z','expires_at','2026-10-01T12:20:00Z')))->>'ok';
SELECT 'applied='||(payload_json->'result'->>'applied')||' reason='||coalesce(payload_json->'result'->>'reason','-') FROM trip_events ORDER BY sequence DESC LIMIT 1;
SELECT 'state still='||presence_state||' observed still='||observed_at||'  <- the newer observation survived' FROM trip_presence;

\echo '--- a NEWER observation does'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SET_PRESENCE','idempotency_key','F3','payload',jsonb_build_object('presence_state','transiting','observed_at','2026-10-01T12:15:00Z','expires_at','2026-10-01T12:35:00Z')))->>'ok';
SELECT 'applied='||(payload_json->'result'->>'applied') FROM trip_events ORDER BY sequence DESC LIMIT 1;
SELECT 'state='||presence_state||' observed='||observed_at FROM trip_presence;

\echo '--- a SAME-INSTANT correction is applied, not silently dropped'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SET_PRESENCE','idempotency_key','F4','payload',jsonb_build_object('presence_state','resting','observed_at','2026-10-01T12:15:00Z','expires_at','2026-10-01T12:35:00Z')))->>'ok';
SELECT 'applied='||(payload_json->'result'->>'applied')||' state='||(SELECT presence_state FROM trip_presence) FROM trip_events ORDER BY sequence DESC LIMIT 1;

\echo '--- the view LABELS an expired row rather than hiding it'
INSERT INTO public.trip_presence (trip_id, user_id, presence_state, observed_at, expires_at, source)
VALUES (:T,'22222222-2222-2222-2222-222222222222','free', now() - interval '3 hours', now() - interval '2 hours','explicit')
ON CONFLICT (trip_id, user_id) DO UPDATE SET observed_at = EXCLUDED.observed_at, expires_at = EXCLUDED.expires_at;
SELECT 'rows in the table='||(SELECT count(*) FROM trip_presence)||' rows in the view='||(SELECT count(*) FROM trip_presence_current)||'  <- nothing is filtered out';
SELECT 'user='||right(user_id::text,4)||' freshness='||freshness||' expired='||expired::text FROM trip_presence_current ORDER BY user_id;

\echo '--- "we knew an hour ago" is distinguishable from "we never knew"'
SELECT 'a row we have: '||freshness||'   vs a user with no row at all: '||coalesce((SELECT freshness FROM trip_presence_current WHERE user_id='99999999-9999-9999-9999-999999999999'),'NO ROW')
  FROM trip_presence_current WHERE user_id='22222222-2222-2222-2222-222222222222';
