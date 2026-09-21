\pset format unaligned
\pset tuples_only on
\set T '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''
\set O '''11111111-1111-1111-1111-111111111111'''

\set S '''22222222-2222-2222-2222-222222222222'''

\echo '--- a non-member actor is refused: authz.is_accepted_trip_member is the real rule here'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','ADD_STAGE','idempotency_key','a0','payload',jsonb_build_object('stage_type','city','city_id','33333333-3333-3333-3333-333333333333','timezone','UTC','sequence',1)))->>'reason';
SELECT 'stages after the refusal='||(SELECT count(*) FROM trip_stages)||' version='||(SELECT version FROM trips);

\echo '--- refusal vocabulary: malformed / unknown type / duplicate sequence'
SELECT 'missing timezone -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_STAGE','idempotency_key','b1','payload',jsonb_build_object('stage_type','city','city_id','33333333-3333-3333-3333-333333333333','sequence',1)))->>'reason');
SELECT 'unknown stage_type -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_STAGE','idempotency_key','b2','payload',jsonb_build_object('stage_type','teleport','city_id','33333333-3333-3333-3333-333333333333','timezone','UTC','sequence',1)))->>'reason');
SELECT 'both anchors -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_STAGE','idempotency_key','b3','payload',jsonb_build_object('stage_type','city','city_id','33333333-3333-3333-3333-333333333333','place_id','44444444-4444-4444-4444-444444444444','timezone','UTC','sequence',1)))->>'reason');
SELECT 'inverted interval -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_STAGE','idempotency_key','b4','payload',jsonb_build_object('stage_type','city','city_id','33333333-3333-3333-3333-333333333333','timezone','UTC','sequence',1,'starts_at','2026-10-02T00:00:00Z','ends_at','2026-10-01T00:00:00Z')))->>'reason');
SELECT 'sequence 0 -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_STAGE','idempotency_key','b5','payload',jsonb_build_object('stage_type','city','city_id','33333333-3333-3333-3333-333333333333','timezone','UTC','sequence',0)))->>'reason');
SELECT 'nothing was written: stages='||(SELECT count(*) FROM trip_stages)||' events='||(SELECT count(*) FROM trip_events)||' version='||(SELECT version FROM trips);

\echo '--- ADD_STAGE'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_STAGE','idempotency_key','a1','payload',jsonb_build_object('stage_type','city','city_id','33333333-3333-3333-3333-333333333333','timezone','Europe/Lisbon','sequence',1)))->>'ok';
SELECT 'family=' || (payload_json->>'family') || ' type=' || type || ' ver=' || aggregate_version FROM trip_events ORDER BY sequence DESC LIMIT 1;
SELECT 'state='||state||' tz='||timezone||' seq='||sequence||' stages='||(SELECT count(*) FROM trip_stages) FROM trip_stages;

\echo '--- UPDATE_STAGE {state:active, timezone:Europe/Porto}'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_STAGE','idempotency_key','a2','payload',jsonb_build_object('stage_id',(SELECT id FROM trip_stages LIMIT 1),'patch',jsonb_build_object('state','active','timezone','Europe/Porto'))))->>'ok';
SELECT 'state='||state||' tz='||timezone||' seq='||sequence FROM trip_stages;
SELECT 'family=' || (payload_json->>'family') || ' type=' || type || ' ver=' || aggregate_version FROM trip_events ORDER BY sequence DESC LIMIT 1;
SELECT 'trips.version='||version FROM trips;

\echo '--- UPDATE_STAGE with an inverted interval must NOT mutate'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_STAGE','idempotency_key','a3','payload',jsonb_build_object('stage_id',(SELECT id FROM trip_stages LIMIT 1),'patch',jsonb_build_object('starts_at','2026-10-05T00:00:00Z','ends_at','2026-10-01T00:00:00Z'))))->>'reason';
SELECT 'starts='||coalesce(starts_at::text,'NULL')||' state='||state||' trips.version='||(SELECT version FROM trips) FROM trip_stages;

\echo '--- REMOVE_STAGE'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','REMOVE_STAGE','idempotency_key','a4','payload',jsonb_build_object('stage_id',(SELECT id FROM trip_stages LIMIT 1))))->>'ok';
SELECT 'stages='||(SELECT count(*) FROM trip_stages)||' family='||(SELECT payload_json->>'family' FROM trip_events ORDER BY sequence DESC LIMIT 1)||' type='||(SELECT type FROM trip_events ORDER BY sequence DESC LIMIT 1)||' trips.version='||(SELECT version FROM trips);

\echo '--- duplicate sequence is refused by name'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_STAGE','idempotency_key','c1','payload',jsonb_build_object('stage_type','city','city_id','33333333-3333-3333-3333-333333333333','timezone','UTC','sequence',1)))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_STAGE','idempotency_key','c2','payload',jsonb_build_object('stage_type','transit','city_id','33333333-3333-3333-3333-333333333333','timezone','UTC','sequence',1)))->>'reason';

\echo '--- idempotent replay returns the first answer, writes nothing new'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_STAGE','idempotency_key','c1','payload',jsonb_build_object('stage_type','lodging','city_id','33333333-3333-3333-3333-333333333333','timezone','UTC','sequence',7)))->>'duplicate';
SELECT 'stages='||(SELECT count(*) FROM trip_stages)||' (the replay must not have added one)';

\echo '--- ledger agreement'
SELECT (SELECT count(*) FROM trip_events)||' events / '||(SELECT count(*) FROM trip_outbox)||' outbox / '||(SELECT count(*) FROM trip_command_receipts)||' receipts';
SELECT 'event types: '||string_agg(type, ', ' ORDER BY sequence) FROM trip_events;
SELECT 'families: '||string_agg(DISTINCT payload_json->>'family', ', ') FROM trip_events;
