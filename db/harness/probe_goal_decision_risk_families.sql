\pset format unaligned
\pset tuples_only on
\set T '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''
\set O '''11111111-1111-1111-1111-111111111111'''
\set S '''22222222-2222-2222-2222-222222222222'''

\echo '--- ADD_GOAL with only the required key: the NOT NULL DEFAULTs must apply'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_GOAL','idempotency_key','G1','payload',jsonb_build_object('type','rest')))->>'ok';
SELECT 'type='||type||' priority='||priority||' status='||status||' evidence='||evidence_json::text FROM trip_goals;
SELECT 'family='||(payload_json->>'family')||' type='||type FROM trip_events ORDER BY sequence DESC LIMIT 1;

\echo '--- ADD_GOAL with every key set'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_GOAL','idempotency_key','G2','payload',jsonb_build_object('type','budget','priority','high','status','open','evidence_json',jsonb_build_object('cap',1200))))->>'ok';
SELECT 'priority='||priority||' evidence='||evidence_json::text FROM trip_goals WHERE type='budget';

\echo '--- vocabularies'
SELECT 'unknown type -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_GOAL','idempotency_key','G3','payload',jsonb_build_object('type','vibes')))->>'reason');
SELECT 'unknown priority -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_GOAL','idempotency_key','G4','payload',jsonb_build_object('type','rest','priority','urgent')))->>'reason');
SELECT 'evidence as an array -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_GOAL','idempotency_key','G5','payload',jsonb_build_object('type','rest','evidence_json',jsonb_build_array(1,2))))->>'reason');
SELECT 'missing type -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_GOAL','idempotency_key','G6','payload','{}'::jsonb))->>'reason');
SELECT 'goals still='||(SELECT count(*) FROM trip_goals);

\echo '--- UPDATE_GOAL / REMOVE_GOAL'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_GOAL','idempotency_key','G7','payload',jsonb_build_object('goal_id',(SELECT id FROM trip_goals WHERE type='rest'),'patch',jsonb_build_object('status','met'))))->>'ok';
SELECT 'status='||status FROM trip_goals WHERE type='rest';
SELECT 'unknown id -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_GOAL','idempotency_key','G8','payload',jsonb_build_object('goal_id','99999999-9999-9999-9999-999999999999','patch',jsonb_build_object('status','met'))))->>'reason');
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','REMOVE_GOAL','idempotency_key','G9','payload',jsonb_build_object('goal_id',(SELECT id FROM trip_goals WHERE type='rest'))))->>'ok';
SELECT 'goals='||(SELECT count(*) FROM trip_goals)||' last event='||(SELECT type FROM trip_events ORDER BY sequence DESC LIMIT 1);

\echo '--- ADD_DECISION_TASK assigned to a NON-member must be refused'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_DECISION_TASK','idempotency_key','D1','payload',jsonb_build_object('type','booking','assigned_user_id',:S)))->>'reason';
SELECT 'tasks='||(SELECT count(*) FROM trip_decision_tasks)||' (must be 0)';

\echo '--- ADD_DECISION_TASK assigned to the owner, who is crew'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_DECISION_TASK','idempotency_key','D2','payload',jsonb_build_object('type','booking','deadline_at','2026-09-20T00:00:00Z','consequence','the fare doubles','assigned_user_id',:O)))->>'ok';
SELECT 'type='||type||' status='||status||' assigned='||(assigned_user_id=:O)::text||' consequence='||consequence FROM trip_decision_tasks;
SELECT 'family='||(payload_json->>'family')||' type='||type FROM trip_events ORDER BY sequence DESC LIMIT 1;

\echo '--- UPDATE_DECISION_TASK cannot reassign to a non-member either'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_DECISION_TASK','idempotency_key','D3','payload',jsonb_build_object('task_id',(SELECT id FROM trip_decision_tasks LIMIT 1),'patch',jsonb_build_object('assigned_user_id',:S))))->>'reason';
SELECT 'still assigned to the owner: '||(SELECT (assigned_user_id=:O)::text FROM trip_decision_tasks);
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_DECISION_TASK','idempotency_key','D4','payload',jsonb_build_object('task_id',(SELECT id FROM trip_decision_tasks LIMIT 1),'patch',jsonb_build_object('status','done'))))->>'ok';
SELECT 'status='||status FROM trip_decision_tasks;
SELECT 'unknown status -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_DECISION_TASK','idempotency_key','D5','payload',jsonb_build_object('task_id',(SELECT id FROM trip_decision_tasks LIMIT 1),'patch',jsonb_build_object('status','maybe'))))->>'reason');
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','REMOVE_DECISION_TASK','idempotency_key','D6','payload',jsonb_build_object('task_id',(SELECT id FROM trip_decision_tasks LIMIT 1))))->>'ok';
SELECT 'tasks='||(SELECT count(*) FROM trip_decision_tasks)||' unknown -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','REMOVE_DECISION_TASK','idempotency_key','D7','payload',jsonb_build_object('task_id','99999999-9999-9999-9999-999999999999')))->>'reason');

\echo '--- ADD_RISK'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RISK','idempotency_key','R1','payload',jsonb_build_object('likelihood','high','impact','medium','trigger_json',jsonb_build_object('when','strike'),'mitigation_json',jsonb_build_object('do','book the bus'))))->>'ok';
SELECT 'likelihood='||likelihood||' impact='||impact||' status='||status||' trigger='||trigger_json::text FROM trip_risks;
SELECT 'family='||(payload_json->>'family')||' type='||type FROM trip_events ORDER BY sequence DESC LIMIT 1;
SELECT 'defaults on omit -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RISK','idempotency_key','R2','payload',jsonb_build_object('likelihood','low','impact','low')))->>'ok');
SELECT 'status='||status||' trigger='||trigger_json::text||' mitigation='||mitigation_json::text FROM trip_risks WHERE likelihood='low';
SELECT 'unknown likelihood -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RISK','idempotency_key','R3','payload',jsonb_build_object('likelihood','certain','impact','low')))->>'reason');
SELECT 'missing impact -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RISK','idempotency_key','R4','payload',jsonb_build_object('likelihood','low')))->>'reason');
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_RISK','idempotency_key','R5','payload',jsonb_build_object('risk_id',(SELECT id FROM trip_risks WHERE likelihood='high'),'patch',jsonb_build_object('status','mitigated'))))->>'ok';
SELECT 'status='||status FROM trip_risks WHERE likelihood='high';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','REMOVE_RISK','idempotency_key','R6','payload',jsonb_build_object('risk_id',(SELECT id FROM trip_risks WHERE likelihood='low'))))->>'ok';
SELECT 'risks='||(SELECT count(*) FROM trip_risks)||' unknown -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','REMOVE_RISK','idempotency_key','R7','payload',jsonb_build_object('risk_id','99999999-9999-9999-9999-999999999999')))->>'reason');

\echo '--- a non-member cannot issue any of the nine'
SELECT 'ADD_GOAL -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','ADD_GOAL','idempotency_key','Z1','payload',jsonb_build_object('type','rest')))->>'reason');
SELECT 'ADD_RISK -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','ADD_RISK','idempotency_key','Z2','payload',jsonb_build_object('likelihood','low','impact','low')))->>'reason');

\echo '--- ledger agreement'
SELECT (SELECT count(*) FROM trip_events)||' events / '||(SELECT count(*) FROM trip_outbox)||' outbox / '||(SELECT count(*) FROM trip_command_receipts)||' receipts';
SELECT 'families: '||string_agg(DISTINCT payload_json->>'family', ', ') FROM trip_events;
