\pset format unaligned
\pset tuples_only on
\set T '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''
\set T2 '''bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'''
\set O '''11111111-1111-1111-1111-111111111111'''
\set C '''33333333-3333-3333-3333-333333333333'''

-- A second trip, so "another trip's stage" is a real case and not a hypothesis.
INSERT INTO public.trips (id, owner_id, title, status, visibility, version)
  VALUES (:T2, :O, 'Other', 'planning', 'private', 0);
INSERT INTO public.trip_members (trip_id, user_id, role, status) VALUES (:T2, :O, 'owner', 'accepted');

\echo '--- two stages on trip A, one on trip B'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_STAGE','idempotency_key','L1','payload',jsonb_build_object('stage_type','city','city_id',:C,'timezone','Europe/Lisbon','sequence',1)))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_STAGE','idempotency_key','L2','payload',jsonb_build_object('stage_type','city','city_id',:C,'timezone','Europe/Madrid','sequence',2)))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T2,'actor_user_id',:O,'type','ADD_STAGE','idempotency_key','L3','payload',jsonb_build_object('stage_type','city','city_id',:C,'timezone','Europe/Rome','sequence',1)))->>'ok';
SELECT 'stages A='||(SELECT count(*) FROM trip_stages WHERE trip_id=:T)||' B='||(SELECT count(*) FROM trip_stages WHERE trip_id=:T2);

\echo '--- ADD_LEG across trips must be refused: the FK would accept it'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_LEG','idempotency_key','L4','payload',jsonb_build_object(
  'from_stage_id',(SELECT id FROM trip_stages WHERE trip_id=:T AND sequence=1),
  'to_stage_id',  (SELECT id FROM trip_stages WHERE trip_id=:T2 AND sequence=1),
  'leg_type','train')))->>'reason';
SELECT 'legs='||(SELECT count(*) FROM trip_legs)||' (must be 0)';

\echo '--- ADD_LEG within trip A'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_LEG','idempotency_key','L5','payload',jsonb_build_object(
  'from_stage_id',(SELECT id FROM trip_stages WHERE trip_id=:T AND sequence=1),
  'to_stage_id',  (SELECT id FROM trip_stages WHERE trip_id=:T AND sequence=2),
  'leg_type','train','starts_at','2026-10-01T08:00:00Z','ends_at','2026-10-01T11:00:00Z')))->>'ok';
SELECT 'legs='||count(*)||' type='||max(leg_type) FROM trip_legs;
SELECT 'family='||(payload_json->>'family')||' type='||type FROM trip_events ORDER BY sequence DESC LIMIT 1;

\echo '--- a leg whose endpoints are the same stage is refused by trip_legs_distinct_stages'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_LEG','idempotency_key','L6','payload',jsonb_build_object(
  'from_stage_id',(SELECT id FROM trip_stages WHERE trip_id=:T AND sequence=1),
  'to_stage_id',  (SELECT id FROM trip_stages WHERE trip_id=:T AND sequence=1),
  'leg_type','walk')))->>'reason';

\echo '--- unknown leg_type, and an inverted interval'
SELECT 'unknown leg_type -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_LEG','idempotency_key','L7','payload',jsonb_build_object('from_stage_id',(SELECT id FROM trip_stages WHERE trip_id=:T AND sequence=1),'to_stage_id',(SELECT id FROM trip_stages WHERE trip_id=:T AND sequence=2),'leg_type','teleport')))->>'reason');
SELECT 'inverted interval -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_LEG','idempotency_key','L8','payload',jsonb_build_object('from_stage_id',(SELECT id FROM trip_stages WHERE trip_id=:T AND sequence=1),'to_stage_id',(SELECT id FROM trip_stages WHERE trip_id=:T AND sequence=2),'leg_type','bus','starts_at','2026-10-02T00:00:00Z','ends_at','2026-10-01T00:00:00Z')))->>'reason');
SELECT 'legs still='||(SELECT count(*) FROM trip_legs);

\echo '--- UPDATE_LEG cannot move an endpoint onto another trip'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_LEG','idempotency_key','L9','payload',jsonb_build_object(
  'leg_id',(SELECT id FROM trip_legs LIMIT 1),
  'patch', jsonb_build_object('to_stage_id',(SELECT id FROM trip_stages WHERE trip_id=:T2 AND sequence=1)))))->>'reason';
SELECT 'to_stage still on trip A: '||(SELECT (s.trip_id = :T)::text FROM trip_legs l JOIN trip_stages s ON s.id=l.to_stage_id LIMIT 1);

\echo '--- UPDATE_LEG legitimate patch, then REMOVE_LEG'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_LEG','idempotency_key','L10','payload',jsonb_build_object('leg_id',(SELECT id FROM trip_legs LIMIT 1),'patch',jsonb_build_object('leg_type','ferry'))))->>'ok';
SELECT 'leg_type='||leg_type FROM trip_legs;
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_LEG','idempotency_key','L11','payload',jsonb_build_object('leg_id','99999999-9999-9999-9999-999999999999','patch',jsonb_build_object('leg_type','bus'))))->>'reason';

\echo '--- ADD_COMMITMENT: the §7.1 columns TR123/TR126/TR127 are about'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_COMMITMENT','idempotency_key','C1','payload',jsonb_build_object(
  'type','event','stage_id',(SELECT id FROM trip_stages WHERE trip_id=:T AND sequence=1),
  'starts_at','2026-10-01T19:00:00Z','required_arrival_at','2026-10-01T18:45:00Z',
  'lateness_tolerance','10 minutes','prep_duration','25 minutes',
  'flexibility','fixed','confidence',0.85)))->>'ok';
SELECT 'type='||type||' arrival='||required_arrival_at||' tol='||lateness_tolerance||' prep='||prep_duration||' flex='||flexibility||' conf='||confidence FROM trip_commitments;
SELECT 'family='||(payload_json->>'family')||' type='||type FROM trip_events ORDER BY sequence DESC LIMIT 1;

\echo '--- arrival AFTER start is not a requirement; the CHECK refuses it'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_COMMITMENT','idempotency_key','C2','payload',jsonb_build_object('type','event','starts_at','2026-10-01T19:00:00Z','required_arrival_at','2026-10-01T19:30:00Z')))->>'reason';

\echo '--- vocabularies and ranges'
SELECT 'unknown type -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_COMMITMENT','idempotency_key','C3','payload',jsonb_build_object('type','seance')))->>'reason');
SELECT 'unknown flexibility -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_COMMITMENT','idempotency_key','C4','payload',jsonb_build_object('type','event','flexibility','whenever')))->>'reason');
SELECT 'confidence 1.5 -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_COMMITMENT','idempotency_key','C5','payload',jsonb_build_object('type','event','confidence',1.5)))->>'reason');
SELECT 'negative prep -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_COMMITMENT','idempotency_key','C6','payload',jsonb_build_object('type','event','prep_duration','-5 minutes')))->>'reason');
SELECT 'another trip''s stage -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_COMMITMENT','idempotency_key','C7','payload',jsonb_build_object('type','event','stage_id',(SELECT id FROM trip_stages WHERE trip_id=:T2 AND sequence=1))))->>'reason');
SELECT 'commitments still='||(SELECT count(*) FROM trip_commitments);

\echo '--- UPDATE_COMMITMENT, then REMOVE_COMMITMENT'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_COMMITMENT','idempotency_key','C8','payload',jsonb_build_object('commitment_id',(SELECT id FROM trip_commitments LIMIT 1),'patch',jsonb_build_object('flexibility','shiftable','confidence',0.4))))->>'ok';
SELECT 'flex='||flexibility||' conf='||confidence FROM trip_commitments;
SELECT 'unknown id -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_COMMITMENT','idempotency_key','C9','payload',jsonb_build_object('commitment_id','99999999-9999-9999-9999-999999999999','patch',jsonb_build_object('flexibility','fixed'))))->>'reason');

\echo '--- REMOVE_LEG'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','REMOVE_LEG','idempotency_key','L12','payload',jsonb_build_object('leg_id',(SELECT id FROM trip_legs LIMIT 1))))->>'ok';
SELECT 'legs='||(SELECT count(*) FROM trip_legs)||' family='||(SELECT payload_json->>'family' FROM trip_events ORDER BY sequence DESC LIMIT 1)||' type='||(SELECT type FROM trip_events ORDER BY sequence DESC LIMIT 1);
SELECT 'again -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','REMOVE_LEG','idempotency_key','L13','payload',jsonb_build_object('leg_id','99999999-9999-9999-9999-999999999999')))->>'reason');

\echo '--- 2761 cascade: deleting a stage takes its LEGS and NULLs its commitments'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_LEG','idempotency_key','X1','payload',jsonb_build_object('from_stage_id',(SELECT id FROM trip_stages WHERE trip_id=:T AND sequence=1),'to_stage_id',(SELECT id FROM trip_stages WHERE trip_id=:T AND sequence=2),'leg_type','car')))->>'ok';
SELECT 'before: legs='||(SELECT count(*) FROM trip_legs)||' commitments='||(SELECT count(*) FROM trip_commitments)||' with stage='||(SELECT count(*) FROM trip_commitments WHERE stage_id IS NOT NULL);
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','REMOVE_STAGE','idempotency_key','X2','payload',jsonb_build_object('stage_id',(SELECT id FROM trip_stages WHERE trip_id=:T AND sequence=1))))->>'ok';
SELECT 'after:  legs='||(SELECT count(*) FROM trip_legs)||' commitments='||(SELECT count(*) FROM trip_commitments)||' with stage='||(SELECT count(*) FROM trip_commitments WHERE stage_id IS NOT NULL);

\echo '--- ledger agreement across both families'
SELECT (SELECT count(*) FROM trip_events)||' events / '||(SELECT count(*) FROM trip_outbox)||' outbox / '||(SELECT count(*) FROM trip_command_receipts)||' receipts';
SELECT 'families: '||string_agg(DISTINCT payload_json->>'family', ', ') FROM trip_events;
