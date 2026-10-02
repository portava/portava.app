\set ON_ERROR_STOP on
BEGIN;
INSERT INTO auth.users (id) VALUES ('11111111-1111-1111-1111-111111111111');
INSERT INTO stories (id, owner_id, media_url, media_type, expires_at)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
        'post-media/stories/11111111-1111-1111-1111-111111111111/a.jpg','image', now() - interval '2 days');

-- 1. A delete starts the clock.
UPDATE stories SET state='deleted' WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
DO $$ DECLARE d timestamptz; BEGIN
  SELECT deleted_at INTO d FROM stories WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
  IF d IS NULL THEN RAISE EXCEPTION 'T1 FAIL: delete did not start the clock'; END IF;
  RAISE NOTICE 'T1 pass: clock started at %', d;
END $$;

-- 2. A repeat delete must NOT move it, even when the statement names a new time.
DO $$ DECLARE before timestamptz; after timestamptz; BEGIN
  SELECT deleted_at INTO before FROM stories WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
  PERFORM pg_sleep(0.05);
  UPDATE stories SET state='deleted' WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
  UPDATE stories SET state='deleted', deleted_at = now() + interval '365 days'
   WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
  SELECT deleted_at INTO after FROM stories WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
  IF after <> before THEN
    RAISE EXCEPTION 'T2 FAIL: repeat delete moved the clock from % to %', before, after;
  END IF;
  RAISE NOTICE 'T2 pass: clock held at % across a repeat delete and an explicit reset attempt', after;
END $$;

-- 3. Recovery clears the clock.
UPDATE stories SET state='expired' WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
DO $$ DECLARE d timestamptz; BEGIN
  SELECT deleted_at INTO d FROM stories WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
  IF d IS NOT NULL THEN RAISE EXCEPTION 'T3 FAIL: recovery left the clock running at %', d; END IF;
  RAISE NOTICE 'T3 pass: recovery cleared the clock';
END $$;

-- 4. A genuinely NEW deletion after a recovery starts a new clock.
UPDATE stories SET state='deleted' WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
DO $$ DECLARE d timestamptz; BEGIN
  SELECT deleted_at INTO d FROM stories WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
  IF d IS NULL THEN RAISE EXCEPTION 'T4 FAIL: re-delete after recovery started no clock'; END IF;
  RAISE NOTICE 'T4 pass: re-delete after recovery started a fresh clock at %', d;
END $$;

-- 5. NEGATIVE CASE — prove the guard can fail. Drop the trigger, repeat T2, and
--    require that it DOES move. A guard indistinguishable from its absence is
--    not a guard.
DROP TRIGGER stories_freeze_deleted_at_trg ON stories;
DO $$ DECLARE before timestamptz; after timestamptz; BEGIN
  SELECT deleted_at INTO before FROM stories WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
  UPDATE stories SET state='deleted', deleted_at = now() + interval '365 days'
   WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
  SELECT deleted_at INTO after FROM stories WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
  IF after = before THEN
    RAISE EXCEPTION 'T5 FAIL: clock held with the trigger DROPPED — the test proves nothing';
  END IF;
  RAISE NOTICE 'T5 pass: without the trigger the clock moved to % — the guard is load-bearing', after;
END $$;
ROLLBACK;
