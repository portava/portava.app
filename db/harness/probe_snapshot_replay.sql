-- §22.2 deterministic replay, proven rather than asserted.
\pset format unaligned
\pset tuples_only on
\set T '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''
\set O '''11111111-1111-1111-1111-111111111111'''
\set S '''22222222-2222-2222-2222-222222222222'''
\set C '''33333333-3333-3333-3333-333333333333'''

INSERT INTO public.trip_members (trip_id, user_id, role, status) VALUES (:T,:S,'member','accepted') ON CONFLICT DO NOTHING;

\echo '--- build a trip with a real, mixed event history'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_STAGE','idempotency_key','SN1','payload',jsonb_build_object('stage_type','city','city_id',:C,'timezone','Europe/Lisbon','sequence',1)))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_STAGE','idempotency_key','SN2','payload',jsonb_build_object('stage_type','transit','city_id',:C,'timezone','Europe/Madrid','sequence',2)))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_STAGE','idempotency_key','SN3','payload',jsonb_build_object('stage_id',(SELECT id FROM trip_stages WHERE sequence=1 AND trip_id=:T),'patch',jsonb_build_object('state','active'))))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_PLAN','idempotency_key','SN4','payload',jsonb_build_object('title','Belem','privacy_scope','crew','stage_id',(SELECT id FROM trip_stages WHERE sequence=1 AND trip_id=:T))))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_COMMITMENT','idempotency_key','SN5','payload',jsonb_build_object('type','event','starts_at','2026-10-01T19:00:00Z','required_arrival_at','2026-10-01T18:45:00Z','flexibility','fixed')))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RISK','idempotency_key','SN6','payload',jsonb_build_object('likelihood','high','impact','medium')))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:S,'type','JOIN_PLAN','idempotency_key','SN7','payload',jsonb_build_object('plan_id',(SELECT id FROM trip_plan_items WHERE title='Belem'))))->>'ok';
SELECT 'events='||(SELECT count(*) FROM trip_events WHERE trip_id=:T)||' head version='||(SELECT max(aggregate_version) FROM trip_events WHERE trip_id=:T);

\echo '--- the fold reconstructs state from EVENTS ALONE, and agrees with the tables'
SELECT 'lifecycle='||coalesce(st->>'lifecycle_state','NULL')
     ||' stages='||(SELECT count(*) FROM jsonb_each(st->'stages'))
     ||' plans='||(SELECT count(*) FROM jsonb_each(st->'plans'))
     ||' commitments='||(SELECT count(*) FROM jsonb_each(st->'commitments'))
     ||' risks='||(SELECT count(*) FROM jsonb_each(st->'risk_summary'))
     ||' attendance='||(SELECT count(*) FROM jsonb_each(st->'attendance'))
FROM (SELECT public.trip_snapshot_replay(:T, public.trip_snapshot_seed(:T), 0, NULL) st) x;
SELECT 'the tables say: stages='||(SELECT count(*) FROM trip_stages WHERE trip_id=:T)
     ||' plans='||(SELECT count(*) FROM trip_plan_items WHERE trip_id=:T AND removed_at IS NULL)
     ||' commitments='||(SELECT count(*) FROM trip_commitments WHERE trip_id=:T)
     ||' risks='||(SELECT count(*) FROM trip_risks WHERE trip_id=:T)
     ||' attendance='||(SELECT count(*) FROM trip_plan_participants);

\echo '--- the derived §22.1 fields'
SELECT 'active stage is the one in state=active: '||((st->>'stage_id') = (SELECT id::text FROM trip_stages WHERE trip_id=:T AND state='active'))::text
     ||'  next_commitment='||((st->>'next_commitment_id') IS NOT NULL)::text
FROM (SELECT public.trip_snapshot_replay(:T, public.trip_snapshot_seed(:T), 0, NULL) st) x;

\echo '--- nothing was left unfolded: every event type this trip produced is known to the fold'
SELECT 'unfolded='||coalesce((public.trip_snapshot_replay(:T, public.trip_snapshot_seed(:T), 0, NULL))->>'unfolded','{} (none)');

\echo '--- §22.1: write a snapshot part-way through, then keep going'
SELECT public.trip_snapshot_write(:T, 4)->>'ok';
SELECT 'stored at version='||aggregate_version||' schema='||(snapshot_json->>'snapshot_schema_version') FROM trip_snapshots WHERE trip_id=:T;
SELECT 'writing it again -> duplicate='||(public.trip_snapshot_write(:T, 4)->>'duplicate');
SELECT 'rows='||(SELECT count(*) FROM trip_snapshots WHERE trip_id=:T)||' (the unique constraint held)';

\echo '--- §22.2 THE PROPERTY: snapshot at 4 + events 5..head == full replay from 0'
SELECT 'equal='||(public.trip_snapshot_verify_replay(:T, 4)->>'equal')
     ||' head='||(public.trip_snapshot_verify_replay(:T, 4)->>'head_version')
     ||' differing='||(public.trip_snapshot_verify_replay(:T, 4)->>'differing_keys');

\echo '--- and at EVERY cut point, so it is not one lucky version'
-- Written and verified in SEPARATE statements. A volatile write in a WHERE
-- clause is not visible to the SELECT list of the same statement, which the
-- first draft of this probe did: it reported nulls for every version but one
-- and looked like a pass.
SELECT count(*)||' snapshots written'
  FROM generate_series(1, (SELECT max(aggregate_version) FROM trip_events WHERE trip_id=:T)) v,
       LATERAL public.trip_snapshot_write(:T, v) w;
SELECT 'v='||aggregate_version||' equal='||(public.trip_snapshot_verify_replay(:T, aggregate_version)->>'equal')
  FROM trip_snapshots WHERE trip_id=:T ORDER BY aggregate_version;
SELECT 'every cut point agrees: '||bool_and((public.trip_snapshot_verify_replay(:T, aggregate_version)->>'equal')::boolean)::text
  FROM trip_snapshots WHERE trip_id=:T;

\echo '--- a snapshot at the HEAD plus an empty tail is still the same state'
SELECT 'equal='||(public.trip_snapshot_verify_replay(:T, (SELECT max(aggregate_version) FROM trip_events WHERE trip_id=:T))->>'equal');

\echo '--- the fold is deterministic: the same replay twice is byte-identical'
SELECT 'identical='||(
  public.trip_snapshot_replay(:T, public.trip_snapshot_seed(:T), 0, NULL)::text
  = public.trip_snapshot_replay(:T, public.trip_snapshot_seed(:T), 0, NULL)::text)::text;

\echo '--- a corrupted snapshot is CAUGHT, and the differing keys are named'
UPDATE public.trip_snapshots SET snapshot_json = jsonb_set(snapshot_json, '{lifecycle_state}', '"tampered"')
 WHERE trip_id=:T AND aggregate_version = 4;
SELECT 'equal='||(public.trip_snapshot_verify_replay(:T, 4)->>'equal')
     ||' differing='||(public.trip_snapshot_verify_replay(:T, 4)->>'differing_keys');

\echo '--- verify against a version that has no snapshot, and a trip with no events'
SELECT 'no snapshot -> '||(public.trip_snapshot_verify_replay(:T, 999)->>'reason');
SELECT 'no events -> '||(public.trip_snapshot_verify_replay('00000000-0000-0000-0000-000000000000', 1)->>'reason');
SELECT 'writing one for a trip with no events -> '||(public.trip_snapshot_write('00000000-0000-0000-0000-000000000000')->>'reason');
