\pset format unaligned
\pset tuples_only on
\set T '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''
\set O '''11111111-1111-1111-1111-111111111111'''
\set C '''33333333-3333-3333-3333-333333333333'''

-- §22.2 with a recurrence in the history. 2799's own postconditions fold a
-- SYNTHETIC event; this folds the events the KERNEL actually wrote, which is
-- the only way to catch a payload shape the fold's branch does not match.

\echo '--- a trip whose history mixes a stage, a plan, a commitment and a recurrence'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_STAGE','idempotency_key','F1','payload',jsonb_build_object('stage_type','city','city_id',:C,'timezone','Asia/Ho_Chi_Minh','sequence',1)))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_COMMITMENT','idempotency_key','F2','payload',jsonb_build_object('type','lodging','starts_at','2026-10-01T15:00:00Z')))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RECURRING_COMMITMENT','idempotency_key','F3','payload',jsonb_build_object(
  'type','event','label','Vietnamese class','timezone','Asia/Ho_Chi_Minh','freq','weekly',
  'by_weekday',jsonb_build_array(1,2,3,4,5),'local_time','09:00',
  'effective_from','2026-10-01','effective_until','2026-11-14')))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SKIP_RECURRENCE_OCCURRENCE','idempotency_key','F4','payload',jsonb_build_object(
  'recurrence_id',(SELECT id FROM trip_commitment_recurrences LIMIT 1),'occurrence_date','2026-10-15')))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','REMOVE_RECURRING_COMMITMENT','idempotency_key','F5','payload',jsonb_build_object(
  'recurrence_id',(SELECT id FROM trip_commitment_recurrences LIMIT 1))))->>'ok';
SELECT 'events='||count(*)||' head='||max(aggregate_version) FROM trip_events WHERE trip_id=:T;

\echo '--- THE ASSERTION: no recurrence event landed in unfolded'
SELECT 'unfolded='||coalesce((public.trip_snapshot_fold_all(
          '{"stages":{},"plans":{},"commitments":{},"risks":{},"attendance":{}}'::jsonb,
          (SELECT array_agg(jsonb_build_object('type',e.type,'aggregate_version',e.aggregate_version,'payload_json',e.payload_json)
                              ORDER BY e.sequence)
             FROM trip_events e WHERE e.trip_id=:T))->'unfolded')::text, 'null')
     ||' (must be null: every recurrence event is named)';

\echo '--- and the §22.2 property still holds over a history containing them'
SELECT public.trip_snapshot_write(:T, 3)->>'ok';
SELECT 'equal='||(public.trip_snapshot_verify_replay(:T, 3)->>'equal')
     ||' differing='||(public.trip_snapshot_verify_replay(:T, 3)->>'differing_keys');

\echo '--- the commitment the trip really has is still folded; the recurrence is not a commitment'
SELECT 'commitments_in_fold='||jsonb_object_keys_count
  FROM (SELECT count(*) AS jsonb_object_keys_count
          FROM jsonb_object_keys((public.trip_snapshot_fold_all(
                 '{"stages":{},"plans":{},"commitments":{},"risks":{},"attendance":{}}'::jsonb,
                 (SELECT array_agg(jsonb_build_object('type',e.type,'aggregate_version',e.aggregate_version,'payload_json',e.payload_json)
                                     ORDER BY e.sequence)
                    FROM trip_events e WHERE e.trip_id=:T))->'commitments'))) q;
