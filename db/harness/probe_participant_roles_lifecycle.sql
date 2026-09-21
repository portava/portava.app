-- 2769: the two ancestry defects, fixed. Each assertion here is the exact
-- inverse of one in probe_kernel_ancestry.sql, so the pair reads as a
-- before/after and neither can quietly stop testing anything.
\pset format unaligned
\pset tuples_only on
\set O '''11111111-1111-1111-1111-111111111111'''
\set S '''22222222-2222-2222-2222-222222222222'''
\set X '''44444444-4444-4444-4444-444444444444'''
\set T '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''

INSERT INTO public.profiles (id, handle) VALUES (:S,'second'), (:X,'third') ON CONFLICT DO NOTHING;
INSERT INTO public.trip_members (trip_id, user_id, role, status) VALUES (:T,:S,'member','accepted'), (:T,:X,'member','accepted');

\echo '--- the owner may now grant co_host'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SET_PARTICIPANT_ROLE','idempotency_key','R1','payload',jsonb_build_object('user_id',:S,'role','co_host')))->>'ok';
SELECT 'role='||role||' is_crew='||authz.is_accepted_trip_member(:T, :S)::text FROM trip_members WHERE user_id=:S;
SELECT 'event='||(SELECT type FROM trip_events ORDER BY sequence DESC LIMIT 1)||' from='||(SELECT payload_json->'payload'->>'role_from' FROM trip_events ORDER BY sequence DESC LIMIT 1)||' to='||(SELECT payload_json->'payload'->>'role_to' FROM trip_events ORDER BY sequence DESC LIMIT 1);

\echo '--- and viewer, which authz.accepted_trip_ids also counts as crew'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SET_PARTICIPANT_ROLE','idempotency_key','R2','payload',jsonb_build_object('user_id',:X,'role','viewer')))->>'ok';
SELECT 'role='||role||' is_crew='||authz.is_accepted_trip_member(:T, :X)::text FROM trip_members WHERE user_id=:X;

\echo '--- the co_host has the host capability: they may set a NON-co_host role'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','SET_PARTICIPANT_ROLE','idempotency_key','R3','payload',jsonb_build_object('user_id',:X,'role','member')))->>'ok';
SELECT 'role='||role FROM trip_members WHERE user_id=:X;

\echo '--- but a co_host may NOT grant co_host: privilege must not propagate sideways'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','SET_PARTICIPANT_ROLE','idempotency_key','R4','payload',jsonb_build_object('user_id',:X,'role','co_host')))->>'reason';
SELECT 'role unchanged='||role FROM trip_members WHERE user_id=:X;

\echo '--- nor may a co_host REVOKE one: that would remove the only person who could stop them'
-- The subject here is the co_host themselves, demoting themselves is still a
-- revoke and still owner-only.
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','SET_PARTICIPANT_ROLE','idempotency_key','R5','payload',jsonb_build_object('user_id',:S,'role','member')))->>'reason';
SELECT 'role still='||role FROM trip_members WHERE user_id=:S;

\echo '--- the owner may revoke it'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SET_PARTICIPANT_ROLE','idempotency_key','R6','payload',jsonb_build_object('user_id',:S,'role','member')))->>'ok';
SELECT 'role='||role FROM trip_members WHERE user_id=:S;

\echo '--- an INVITE still cannot mint a co_host: the other vocabulary was not widened'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_PARTICIPANT','idempotency_key','R7','payload',jsonb_build_object('user_id','55555555-5555-5555-5555-555555555555','role','co_host')))->>'reason';

\echo '--- an unknown role is still refused'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SET_PARTICIPANT_ROLE','idempotency_key','R8','payload',jsonb_build_object('user_id',:X,'role','admin')))->>'reason';

\echo '--- COMPLETED is now terminal for CANCEL, and still archivable'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','COMPLETE_TRIP','idempotency_key','L1','payload','{}'::jsonb))->>'ok';
SELECT 'status='||status FROM trips WHERE id=:T;
SELECT 'cancel -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','CANCEL_TRIP','idempotency_key','L2','payload','{}'::jsonb))->>'reason');
SELECT 'status still='||status FROM trips WHERE id=:T;
SELECT 'archive -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ARCHIVE_TRIP','idempotency_key','L3','payload','{}'::jsonb))->>'ok');
SELECT 'status='||status FROM trips WHERE id=:T;
SELECT 'and archived is terminal for everything -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','CANCEL_TRIP','idempotency_key','L4','payload','{}'::jsonb))->>'reason');
