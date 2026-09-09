\pset format unaligned
\pset tuples_only on
\set T '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''
\set T2 '''bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'''
\set O '''11111111-1111-1111-1111-111111111111'''
\set S '''22222222-2222-2222-2222-222222222222'''
\set X '''44444444-4444-4444-4444-444444444444'''
\set C '''33333333-3333-3333-3333-333333333333'''

INSERT INTO public.profiles (id, handle) VALUES (:X,'stranger2') ON CONFLICT DO NOTHING;
INSERT INTO public.trips (id, owner_id, title, status, visibility, version) VALUES (:T2,:O,'Other','planning','private',0);
INSERT INTO public.trip_members (trip_id, user_id, role, status) VALUES (:T2,:O,'owner','accepted'), (:T,:S,'member','accepted');

\echo '--- a stage on each trip, so "another trip''s stage" is a real case'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_STAGE','idempotency_key','PA0','payload',jsonb_build_object('stage_type','city','city_id',:C,'timezone','UTC','sequence',1)))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T2,'actor_user_id',:O,'type','ADD_STAGE','idempotency_key','PA1','payload',jsonb_build_object('stage_type','city','city_id',:C,'timezone','UTC','sequence',1)))->>'ok';

\echo '--- ADD_PLAN with no scope: the §6.3 default and the derived visibility'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_PLAN','idempotency_key','PA2','payload',jsonb_build_object('title','Belem')))->>'ok';
SELECT 'scope='||privacy_scope||' visibility='||visibility||' plan_scope='||plan_scope||' version='||version||' stage='||coalesce(stage_id::text,'NULL') FROM trip_plan_items WHERE title='Belem';

\echo '--- ADD_PLAN attached to a stage of ANOTHER trip is refused'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_PLAN','idempotency_key','PA3','payload',jsonb_build_object('title','Nope','stage_id',(SELECT id FROM trip_stages WHERE trip_id=:T2))))->>'reason';
SELECT 'plans='||count(*) FROM trip_plan_items;

\echo '--- ADD_PLAN with the full §5.1/§9.1 shape'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_PLAN','idempotency_key','PA4','payload',jsonb_build_object('title','Sintra','stage_id',(SELECT id FROM trip_stages WHERE trip_id=:T),'place_id','77777777-7777-7777-7777-777777777777','privacy_scope','public','plan_scope','optional')))->>'ok';
SELECT 'scope='||privacy_scope||' visibility='||visibility||' plan_scope='||plan_scope||' on_stage='||(stage_id IS NOT NULL)::text FROM trip_plan_items WHERE title='Sintra';

\echo '--- an unknown scope and an unknown plan_scope are refused by 2770''s CHECKs'
SELECT 'bad privacy_scope -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_PLAN','idempotency_key','PA5','payload',jsonb_build_object('title','X','privacy_scope','everyone')))->>'reason');
SELECT 'bad plan_scope -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_PLAN','idempotency_key','PA6','payload',jsonb_build_object('title','X','plan_scope','whoever')))->>'reason');

\echo '--- UPDATE_PLAN bumps the PLAN version, not just the trip version'
SELECT 'plan version before='||version||' trip version before='||(SELECT version FROM trips WHERE id=:T) FROM trip_plan_items WHERE title='Belem';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_PLAN','idempotency_key','PA7','payload',jsonb_build_object('item_id',(SELECT id FROM trip_plan_items WHERE title='Belem'),'patch',jsonb_build_object('title','Belem Tower','privacy_scope','trip'))))->>'ok';
SELECT 'title='||title||' scope='||privacy_scope||' visibility='||visibility||' plan version='||version FROM trip_plan_items WHERE title LIKE 'Belem%';

\echo '--- a stale expected_plan_version is refused and changes nothing'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_PLAN','idempotency_key','PA8','payload',jsonb_build_object('item_id',(SELECT id FROM trip_plan_items WHERE title LIKE 'Belem%'),'expected_plan_version',0,'patch',jsonb_build_object('title','Hijacked'))))->>'reason';
SELECT 'title still='||title||' version still='||version FROM trip_plan_items WHERE title LIKE 'Belem%';
SELECT 'the current one is accepted -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_PLAN','idempotency_key','PA9','payload',jsonb_build_object('item_id',(SELECT id FROM trip_plan_items WHERE title LIKE 'Belem%'),'expected_plan_version',1,'patch',jsonb_build_object('notes','ok'))))->>'ok');
SELECT 'version='||version FROM trip_plan_items WHERE title LIKE 'Belem%';

\echo '--- two plans in one trip do NOT conflict on each other''s plan version'
SELECT 'plan A version='||(SELECT version FROM trip_plan_items WHERE title LIKE 'Belem%')||' plan B version='||(SELECT version FROM trip_plan_items WHERE title='Sintra');
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_PLAN','idempotency_key','PB1','payload',jsonb_build_object('item_id',(SELECT id FROM trip_plan_items WHERE title='Sintra'),'expected_plan_version',0,'patch',jsonb_build_object('notes','B is still at 0'))))->>'ok';

\echo '--- JOIN_PLAN: the actor joins their own attendance'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','JOIN_PLAN','idempotency_key','PJ1','payload',jsonb_build_object('plan_id',(SELECT id FROM trip_plan_items WHERE title='Sintra'))))->>'ok';
SELECT 'user_is_actor='||(user_id = :S)::text||' state='||attendance_state FROM trip_plan_participants;
SELECT 'family='||(payload_json->>'family')||' type='||type FROM trip_events ORDER BY sequence DESC LIMIT 1;

\echo '--- a payload user_id cannot redirect the write: there is no such key'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','JOIN_PLAN','idempotency_key','PJ2','payload',jsonb_build_object('plan_id',(SELECT id FROM trip_plan_items WHERE title='Sintra'),'user_id',:O)))->>'ok';
SELECT 'rows='||count(*)||' still only the actor='||(bool_and(user_id = :S))::text FROM trip_plan_participants;

\echo '--- a non-member cannot attend'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:X,'type','JOIN_PLAN','idempotency_key','PJ3','payload',jsonb_build_object('plan_id',(SELECT id FROM trip_plan_items WHERE title='Sintra'))))->>'reason';

\echo '--- a plan of another trip is not found'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','JOIN_PLAN','idempotency_key','PJ4','payload',jsonb_build_object('plan_id','99999999-9999-9999-9999-999999999999')))->>'reason';

\echo '--- SET_PLAN_ATTENDANCE moves through the §9.1 vocabulary'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','SET_PLAN_ATTENDANCE','idempotency_key','PS1','payload',jsonb_build_object('plan_id',(SELECT id FROM trip_plan_items WHERE title='Sintra'),'attendance_state','maybe')))->>'ok';
SELECT 'state='||attendance_state FROM trip_plan_participants;
SELECT 'an unknown state -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','SET_PLAN_ATTENDANCE','idempotency_key','PS2','payload',jsonb_build_object('plan_id',(SELECT id FROM trip_plan_items WHERE title='Sintra'),'attendance_state','vibes')))->>'reason');
SELECT 'state unchanged='||attendance_state FROM trip_plan_participants;
SELECT 'with no row at all -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SET_PLAN_ATTENDANCE','idempotency_key','PS3','payload',jsonb_build_object('plan_id',(SELECT id FROM trip_plan_items WHERE title='Sintra'),'attendance_state','going')))->>'reason');

\echo '--- LEAVE_PLAN is a TRANSITION, because §9.1 has a ''left'' state'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','LEAVE_PLAN','idempotency_key','PL1','payload',jsonb_build_object('plan_id',(SELECT id FROM trip_plan_items WHERE title='Sintra'))))->>'ok';
SELECT 'rows='||count(*)||' state='||max(attendance_state)||'  <- the row survives, so "was going, is not" is still a fact' FROM trip_plan_participants;
SELECT 'leaving again -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','LEAVE_PLAN','idempotency_key','PL2','payload',jsonb_build_object('plan_id',(SELECT id FROM trip_plan_items WHERE title='Sintra'))))->>'ok');

\echo '--- but a merely-interested actor leaves no trace, because there is none to keep'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','JOIN_PLAN','idempotency_key','PL3','payload',jsonb_build_object('plan_id',(SELECT id FROM trip_plan_items WHERE title='Sintra'),'attendance_state','interested')))->>'ok';
SELECT 'rows='||count(*) FROM trip_plan_participants;
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','LEAVE_PLAN','idempotency_key','PL4','payload',jsonb_build_object('plan_id',(SELECT id FROM trip_plan_items WHERE title='Sintra'))))->>'ok';
SELECT 'rows='||count(*)||' (the interested row was removed, the left row kept)' FROM trip_plan_participants;

\echo '--- 2771 cascade: removing the PLAN takes its attendance with it'
SELECT 'before: attendance rows='||(SELECT count(*) FROM trip_plan_participants);
DELETE FROM public.trip_plan_items WHERE title='Sintra';
SELECT 'after a hard plan delete: attendance rows='||(SELECT count(*) FROM trip_plan_participants)||'  (§: "going to nothing" is not a state)';

\echo '--- ledger agreement'
SELECT (SELECT count(*) FROM trip_events)||' events / '||(SELECT count(*) FROM trip_outbox)||' outbox / '||(SELECT count(*) FROM trip_command_receipts)||' receipts';
SELECT 'families: '||string_agg(DISTINCT payload_json->>'family', ', ') FROM trip_events;
