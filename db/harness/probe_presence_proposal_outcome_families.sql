\pset format unaligned
\pset tuples_only on
\set T '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''
\set O '''11111111-1111-1111-1111-111111111111'''
\set S '''22222222-2222-2222-2222-222222222222'''
\set C '''33333333-3333-3333-3333-333333333333'''

\echo '--- SET_PRESENCE: the §10.1 vocabulary, and 2763s must be refused'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SET_PRESENCE','idempotency_key','P1','payload',jsonb_build_object('presence_state','at_plan','ttl_seconds',900)))->>'ok';
SELECT 'state='||presence_state||' vis='||visibility||' source='||source||' ttl_ok='||(expires_at > observed_at)::text FROM trip_presence;
SELECT 'family='||(payload_json->>'family')||' type='||type FROM trip_events ORDER BY sequence DESC LIMIT 1;
SELECT 'pre-2767 value en_route -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SET_PRESENCE','idempotency_key','P2','payload',jsonb_build_object('presence_state','en_route','ttl_seconds',60)))->>'reason');

\echo '--- presence without a TTL is refused: a row that never goes stale is not presence'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SET_PRESENCE','idempotency_key','P3','payload',jsonb_build_object('presence_state','free')))->>'reason';

\echo '--- expires_at BEFORE observed_at is refused by the 2763 CHECK'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SET_PRESENCE','idempotency_key','P4','payload',jsonb_build_object('presence_state','free','observed_at','2026-10-01T12:00:00Z','expires_at','2026-10-01T11:00:00Z')))->>'reason';

\echo '--- nobody may set anyone elses presence'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SET_PRESENCE','idempotency_key','P5','payload',jsonb_build_object('presence_state','free','ttl_seconds',60,'user_id',:S)))->>'reason';
SELECT 'rows='||(SELECT count(*) FROM trip_presence)||' (the upsert must not have made a second)';

\echo '--- naming yourself explicitly is allowed'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SET_PRESENCE','idempotency_key','P6','payload',jsonb_build_object('presence_state','resting','ttl_seconds',300,'user_id',:O,'source','checkpoint','confidence',0.6,'visibility','participants')))->>'ok';
SELECT 'state='||presence_state||' source='||source||' conf='||confidence||' vis='||visibility||' rows='||(SELECT count(*) FROM trip_presence) FROM trip_presence;
SELECT 'unknown source -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SET_PRESENCE','idempotency_key','P7','payload',jsonb_build_object('presence_state','free','ttl_seconds',60,'source','telepathy')))->>'reason');
SELECT 'unknown visibility -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SET_PRESENCE','idempotency_key','P8','payload',jsonb_build_object('presence_state','free','ttl_seconds',60,'visibility','everyone')))->>'reason');

\echo '--- CLEAR_PRESENCE, then again'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','CLEAR_PRESENCE','idempotency_key','P9','payload','{}'::jsonb))->>'ok';
SELECT 'rows='||(SELECT count(*) FROM trip_presence)||' last='||(SELECT type FROM trip_events ORDER BY sequence DESC LIMIT 1);
SELECT 'again -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','CLEAR_PRESENCE','idempotency_key','P10','payload','{}'::jsonb))->>'reason');

\echo '--- CREATE_PROPOSAL records the version it was reasoning about'
SELECT 'trips.version before='||(SELECT version FROM trips WHERE id=:T);
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','CREATE_PROPOSAL','idempotency_key','Q1','payload',jsonb_build_object('proposal_type','move_plan','payload_json',jsonb_build_object('to','18:00'))))->>'ok';
SELECT 'type='||proposal_type||' status='||status||' affected_version='||affected_version||' payload='||payload_json::text FROM trip_proposals;
SELECT 'family='||(payload_json->>'family')||' type='||type FROM trip_events ORDER BY sequence DESC LIMIT 1;
SELECT 'unknown proposal_type -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','CREATE_PROPOSAL','idempotency_key','Q2','payload',jsonb_build_object('proposal_type','mutiny')))->>'reason');

\echo '--- ACCEPT_PROPOSAL is host-gated: an accepted member who is not host is refused'
INSERT INTO public.trip_members (trip_id, user_id, role, status) VALUES (:T, :S, 'member', 'accepted');
SELECT 'plain member -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','ACCEPT_PROPOSAL','idempotency_key','Q3','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals LIMIT 1))))->>'reason');
SELECT 'status still='||status FROM trip_proposals;
SELECT 'but that member CAN create one -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','CREATE_PROPOSAL','idempotency_key','Q4','payload',jsonb_build_object('proposal_type','add_plan')))->>'ok');

\echo '--- the owner accepts; a second decision on the same proposal is refused'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ACCEPT_PROPOSAL','idempotency_key','Q5','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE proposal_type='move_plan'))))->>'ok';
SELECT 'status='||status FROM trip_proposals WHERE proposal_type='move_plan';
SELECT 'event='||(SELECT type FROM trip_events ORDER BY sequence DESC LIMIT 1);
SELECT 'reject after accept -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','REJECT_PROPOSAL','idempotency_key','Q6','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE proposal_type='move_plan'))))->>'reason');
SELECT 'status unchanged='||status FROM trip_proposals WHERE proposal_type='move_plan';
SELECT 'reject the other one -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','REJECT_PROPOSAL','idempotency_key','Q7','payload',jsonb_build_object('proposal_id',(SELECT id FROM trip_proposals WHERE proposal_type='add_plan'))))->>'ok');
SELECT 'statuses: '||string_agg(proposal_type||'='||status, ', ' ORDER BY proposal_type) FROM trip_proposals;
SELECT 'unknown id -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ACCEPT_PROPOSAL','idempotency_key','Q8','payload',jsonb_build_object('proposal_id','99999999-9999-9999-9999-999999999999')))->>'reason');

\echo '--- RECORD_OUTCOME, append-only, with a stage that must be this trips'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_STAGE','idempotency_key','O0','payload',jsonb_build_object('stage_type','city','city_id',:C,'timezone','UTC','sequence',1)))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','RECORD_OUTCOME','idempotency_key','O1','payload',jsonb_build_object('outcome_type','completed','stage_id',(SELECT id FROM trip_stages WHERE trip_id=:T),'occurred_at','2026-10-01T20:00:00Z','evidence_json',jsonb_build_object('note','went'))))->>'ok';
SELECT 'type='||outcome_type||' evidence='||evidence_json::text||' has_stage='||(stage_id IS NOT NULL)::text FROM trip_outcomes;
SELECT 'family='||(payload_json->>'family')||' type='||type FROM trip_events ORDER BY sequence DESC LIMIT 1;
SELECT 'unknown outcome_type -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','RECORD_OUTCOME','idempotency_key','O2','payload',jsonb_build_object('outcome_type','vibes','occurred_at','2026-10-01T20:00:00Z')))->>'reason');
SELECT 'plan_id is free-form by design -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','RECORD_OUTCOME','idempotency_key','O3','payload',jsonb_build_object('outcome_type','skipped','plan_id','88888888-8888-8888-8888-888888888888','occurred_at','2026-10-01T21:00:00Z')))->>'ok');

\echo '--- 2763 cascade: removing the stage keeps the OUTCOME and nulls its stage_id'
SELECT 'before: outcomes='||(SELECT count(*) FROM trip_outcomes)||' with stage='||(SELECT count(*) FROM trip_outcomes WHERE stage_id IS NOT NULL);
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','REMOVE_STAGE','idempotency_key','O4','payload',jsonb_build_object('stage_id',(SELECT id FROM trip_stages WHERE trip_id=:T))))->>'ok';
SELECT 'after:  outcomes='||(SELECT count(*) FROM trip_outcomes)||' with stage='||(SELECT count(*) FROM trip_outcomes WHERE stage_id IS NOT NULL)||'  (§20.1: historical fact survives the plan)';

\echo '--- ledger agreement'
SELECT (SELECT count(*) FROM trip_events)||' events / '||(SELECT count(*) FROM trip_outbox)||' outbox / '||(SELECT count(*) FROM trip_command_receipts)||' receipts';
SELECT 'families: '||string_agg(DISTINCT payload_json->>'family', ', ') FROM trip_events;
