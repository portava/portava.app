\pset format unaligned
\pset tuples_only on
\set T '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''
\set T2 '''bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'''
\set O '''11111111-1111-1111-1111-111111111111'''
\set C '''33333333-3333-3333-3333-333333333333'''

-- A second trip, so "another trip's stage" and "another trip's rule" are real
-- cases and not hypotheses.
INSERT INTO public.trips (id, owner_id, title, status, visibility, version)
  VALUES (:T2, :O, 'Other', 'planning', 'private', 0);
INSERT INTO public.trip_members (trip_id, user_id, role, status) VALUES (:T2, :O, 'owner', 'accepted');

INSERT INTO public.trip_stages (trip_id, stage_type, city_id, timezone, sequence)
  VALUES (:T, 'city', :C, 'Asia/Ho_Chi_Minh', 1);
INSERT INTO public.trip_stages (trip_id, stage_type, city_id, timezone, sequence)
  VALUES (:T2, 'city', :C, 'Europe/Rome', 1);

\echo '--- ADD_RECURRING_COMMITMENT: "every weekday at 09:00, Asia/Ho_Chi_Minh", 45 days'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RECURRING_COMMITMENT','idempotency_key','R1','payload',jsonb_build_object(
  'type','event','label','Vietnamese class','timezone','Asia/Ho_Chi_Minh',
  'stage_id',(SELECT id FROM trip_stages WHERE trip_id=:T AND sequence=1),
  'freq','weekly','by_weekday',jsonb_build_array(1,2,3,4,5),'local_time','09:00',
  'duration','90 minutes','arrival_lead','10 minutes','prep_duration','20 minutes',
  'flexibility','fixed','confidence',0.9,
  'effective_from','2026-10-01','effective_until','2026-11-14')))->>'ok';
SELECT 'rules='||count(*)||' freq='||max(freq)||' days='||max(by_weekday::text)||' local='||max(local_time::text)||' tz='||max(timezone) FROM trip_commitment_recurrences;
SELECT 'family='||(payload_json->>'family')||' type='||type FROM trip_events ORDER BY sequence DESC LIMIT 1;

\echo '--- THE POINT: 45 days of a weekday routine is ONE row, and no commitment row'
SELECT 'recurrence_rows='||(SELECT count(*) FROM trip_commitment_recurrences)
     ||' commitment_rows='||(SELECT count(*) FROM trip_commitments)
     ||' span_days='||(SELECT (effective_until - effective_from) FROM trip_commitment_recurrences LIMIT 1);

\echo '--- an unresolvable zone is refused BY NAME; no CHECK can do this'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RECURRING_COMMITMENT','idempotency_key','R2','payload',jsonb_build_object(
  'type','event','timezone','Europe/Lisbob','freq','daily','local_time','09:00',
  'effective_from','2026-10-01','effective_until','2026-10-05')))->>'reason';

\echo '--- a UTC offset is not a zone (2797 CHECK), and a range over 400 days is policy'
SELECT 'offset-as-zone -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RECURRING_COMMITMENT','idempotency_key','R3','payload',jsonb_build_object('type','event','timezone','+07','freq','daily','local_time','09:00','effective_from','2026-10-01','effective_until','2026-10-05')))->>'reason');
SELECT '401 days -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RECURRING_COMMITMENT','idempotency_key','R4','payload',jsonb_build_object('type','event','timezone','Europe/Lisbon','freq','daily','local_time','09:00','effective_from','2026-01-01','effective_until','2027-02-06')))->>'reason');

\echo '--- vocabularies, weekday set and the freq/weekday agreement'
SELECT 'unknown type -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RECURRING_COMMITMENT','idempotency_key','R5','payload',jsonb_build_object('type','seance','timezone','Europe/Lisbon','freq','daily','local_time','09:00','effective_from','2026-10-01','effective_until','2026-10-05')))->>'reason');
SELECT 'unknown freq -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RECURRING_COMMITMENT','idempotency_key','R6','payload',jsonb_build_object('type','event','timezone','Europe/Lisbon','freq','fortnightly','local_time','09:00','effective_from','2026-10-01','effective_until','2026-10-05')))->>'reason');
SELECT 'weekly with no days -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RECURRING_COMMITMENT','idempotency_key','R7','payload',jsonb_build_object('type','event','timezone','Europe/Lisbon','freq','weekly','local_time','09:00','effective_from','2026-10-01','effective_until','2026-10-05')))->>'reason');
SELECT 'daily WITH days -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RECURRING_COMMITMENT','idempotency_key','R8','payload',jsonb_build_object('type','event','timezone','Europe/Lisbon','freq','daily','by_weekday',jsonb_build_array(1),'local_time','09:00','effective_from','2026-10-01','effective_until','2026-10-05')))->>'reason');
SELECT 'weekday 8 -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RECURRING_COMMITMENT','idempotency_key','R9','payload',jsonb_build_object('type','event','timezone','Europe/Lisbon','freq','weekly','by_weekday',jsonb_build_array(8),'local_time','09:00','effective_from','2026-10-01','effective_until','2026-10-05')))->>'reason');
SELECT 'duplicate weekday -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RECURRING_COMMITMENT','idempotency_key','R10','payload',jsonb_build_object('type','event','timezone','Europe/Lisbon','freq','weekly','by_weekday',jsonb_build_array(3,3),'local_time','09:00','effective_from','2026-10-01','effective_until','2026-10-05')))->>'reason');
SELECT 'inverted range -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RECURRING_COMMITMENT','idempotency_key','R11','payload',jsonb_build_object('type','event','timezone','Europe/Lisbon','freq','daily','local_time','09:00','effective_from','2026-10-05','effective_until','2026-10-01')))->>'reason');
SELECT 'another trip''s stage -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RECURRING_COMMITMENT','idempotency_key','R12','payload',jsonb_build_object('type','event','timezone','Europe/Lisbon','freq','daily','local_time','09:00','stage_id',(SELECT id FROM trip_stages WHERE trip_id=:T2 AND sequence=1),'effective_from','2026-10-01','effective_until','2026-10-05')))->>'reason');
SELECT 'rules still='||(SELECT count(*) FROM trip_commitment_recurrences);

\echo '--- an UNSORTED weekday list from the client is SORTED by the kernel, not refused'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RECURRING_COMMITMENT','idempotency_key','R13','payload',jsonb_build_object(
  'type','meeting','timezone','Europe/Lisbon','freq','weekly','by_weekday',jsonb_build_array(6,2,4),'local_time','18:30',
  'effective_from','2026-10-01','effective_until','2026-10-31')))->>'ok';
SELECT 'sorted='||by_weekday::text FROM trip_commitment_recurrences WHERE type='meeting';

\echo '--- SKIP_RECURRENCE_OCCURRENCE: the exception mechanism, and it is set-idempotent'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SKIP_RECURRENCE_OCCURRENCE','idempotency_key','S1','payload',jsonb_build_object(
  'recurrence_id',(SELECT id FROM trip_commitment_recurrences WHERE type='event'),'occurrence_date','2026-10-15')))->>'ok';
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SKIP_RECURRENCE_OCCURRENCE','idempotency_key','S2','payload',jsonb_build_object(
  'recurrence_id',(SELECT id FROM trip_commitment_recurrences WHERE type='event'),'occurrence_date','2026-10-15')))->>'ok';
SELECT 'skips='||skip_dates::text||' (one date, twice skipped)' FROM trip_commitment_recurrences WHERE type='event';
SELECT 'family='||(payload_json->>'family')||' type='||type FROM trip_events ORDER BY sequence DESC LIMIT 1;

\echo '--- a skip outside the rule''s own range is refused'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','SKIP_RECURRENCE_OCCURRENCE','idempotency_key','S3','payload',jsonb_build_object(
  'recurrence_id',(SELECT id FROM trip_commitment_recurrences WHERE type='event'),'occurrence_date','2027-01-01')))->>'reason';
SELECT 'skips unchanged='||skip_dates::text FROM trip_commitment_recurrences WHERE type='event';

\echo '--- UNSKIP restores it; a skip that cannot be undone is a trap'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UNSKIP_RECURRENCE_OCCURRENCE','idempotency_key','S4','payload',jsonb_build_object(
  'recurrence_id',(SELECT id FROM trip_commitment_recurrences WHERE type='event'),'occurrence_date','2026-10-15')))->>'ok';
SELECT 'skips='||skip_dates::text FROM trip_commitment_recurrences WHERE type='event';

\echo '--- UPDATE_RECURRING_COMMITMENT, and the 400-day cap over the range the patch LEAVES'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_RECURRING_COMMITMENT','idempotency_key','U1','payload',jsonb_build_object(
  'recurrence_id',(SELECT id FROM trip_commitment_recurrences WHERE type='event'),
  'patch',jsonb_build_object('local_time','10:00','by_weekday',jsonb_build_array(1,3,5)))))->>'ok';
SELECT 'local='||local_time::text||' days='||by_weekday::text FROM trip_commitment_recurrences WHERE type='event';
SELECT 'patch to 401 days -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_RECURRING_COMMITMENT','idempotency_key','U2','payload',jsonb_build_object(
  'recurrence_id',(SELECT id FROM trip_commitment_recurrences WHERE type='event'),
  'patch',jsonb_build_object('effective_until','2028-01-01'))))->>'reason');
SELECT 'until unchanged='||effective_until::text FROM trip_commitment_recurrences WHERE type='event';
SELECT 'bad zone in a patch -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_RECURRING_COMMITMENT','idempotency_key','U3','payload',jsonb_build_object(
  'recurrence_id',(SELECT id FROM trip_commitment_recurrences WHERE type='event'),
  'patch',jsonb_build_object('timezone','Mars/Olympus'))))->>'reason');
SELECT 'unknown id -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','UPDATE_RECURRING_COMMITMENT','idempotency_key','U4','payload',jsonb_build_object(
  'recurrence_id','99999999-9999-9999-9999-999999999999','patch',jsonb_build_object('local_time','11:00'))))->>'reason');

\echo '--- another trip''s rule is not this trip''s rule'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T2,'actor_user_id',:O,'type','UPDATE_RECURRING_COMMITMENT','idempotency_key','U5','payload',jsonb_build_object(
  'recurrence_id',(SELECT id FROM trip_commitment_recurrences WHERE type='event'),'patch',jsonb_build_object('local_time','23:00'))))->>'reason';
SELECT 'local still='||local_time::text FROM trip_commitment_recurrences WHERE type='event';

\echo '--- REMOVE_RECURRING_COMMITMENT'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','REMOVE_RECURRING_COMMITMENT','idempotency_key','D1','payload',jsonb_build_object(
  'recurrence_id',(SELECT id FROM trip_commitment_recurrences WHERE type='meeting'))))->>'ok';
SELECT 'rules='||count(*) FROM trip_commitment_recurrences;
SELECT 'remove twice -> '||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','REMOVE_RECURRING_COMMITMENT','idempotency_key','D2','payload',jsonb_build_object('recurrence_id','99999999-9999-9999-9999-999999999999')))->>'reason');

\echo '--- §22.4: a duplicate idempotency key is one transition, not two'
SELECT public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RECURRING_COMMITMENT','idempotency_key','IDEM','payload',jsonb_build_object(
  'type','other','timezone','Europe/Lisbon','freq','daily','local_time','08:00','effective_from','2026-10-01','effective_until','2026-10-10')))->>'ok';
SELECT 'duplicate='||(public.trip_kernel_execute(jsonb_build_object('command_id',gen_random_uuid(),'trip_id',:T,'actor_user_id',:O,'type','ADD_RECURRING_COMMITMENT','idempotency_key','IDEM','payload',jsonb_build_object(
  'type','other','timezone','Europe/Lisbon','freq','daily','local_time','08:00','effective_from','2026-10-01','effective_until','2026-10-10')))->>'duplicate');
SELECT 'other-type rules='||count(*)||' (must be 1)' FROM trip_commitment_recurrences WHERE type='other';

\echo '--- THE CLOSING ASSERTION: nothing in this probe materialised an occurrence'
SELECT 'commitment_rows='||(SELECT count(*) FROM trip_commitments)||' (must be 0: occurrences are computed, never written)';
