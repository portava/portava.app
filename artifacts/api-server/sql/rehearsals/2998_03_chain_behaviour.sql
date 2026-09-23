-- 2998_03_chain_behaviour.sql
--
-- The behavioural rehearsal, run against PRODUCTION'S REAL SCHEMA rather than a
-- hand-written subset: scripts/local-db/up.sh restores
-- baseline/20260819_baseline_structure.sql and replays the whole migration
-- chain, so `stories`, `story_views`, `story_reactions`, `story_replies`,
-- `job_health` and every constraint, index and policy on them are the ones
-- production has. 2998 arrives in that chain in its own place.
--
-- 2998_01 and 2998_02 prove the trigger and the destructive ledger on a fixture.
-- This file proves the two things a fixture CANNOT:
--
--   A. The freeze trigger survives contact with the real table — its defaults,
--      its NOT NULLs, its other triggers and its check constraints.
--   B. The SELECT the retention job actually issues picks the right rows.
--      `enqueueDueStories` sends PostgREST
--      `state=eq.deleted&deleted_at=not.is.null&or=(deleted_at.lt.X,expires_at.lt.Y)`,
--      which is the disjunction written out below. A unit test with an
--      in-memory double proves the code builds that filter; only SQL proves the
--      filter selects what it is supposed to.
--
-- Every check RAISES on failure. A rehearsal that can report success without
-- establishing it is worth nothing.
--
-- Run (after `bash scripts/local-db/up.sh`):
--   psql -X -v ON_ERROR_STOP=1 \
--     "postgresql://postgres@127.0.0.1:54329/portava_local" \
--     -f sql/rehearsals/2998_03_chain_behaviour.sql

\set ON_ERROR_STOP on

BEGIN;

-- Owners must exist: `stories.owner_id` references profiles in the real schema,
-- which is exactly the kind of thing a fixture subset lets you skip.
INSERT INTO auth.users (id, email)
VALUES ('aaaaaaaa-0000-0000-0000-00000000000a', 'rehearsal-a@example.invalid')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, handle, name)
VALUES ('aaaaaaaa-0000-0000-0000-00000000000a', 'rehearsal_a', 'Rehearsal A')
ON CONFLICT (id) DO NOTHING;

CREATE TEMP TABLE rehearsal_ids (label text PRIMARY KEY, id uuid NOT NULL);

CREATE OR REPLACE FUNCTION pg_temp.seed(
  p_label text, p_state text, p_expires interval, p_deleted interval
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.stories (id, owner_id, media_url, media_type, expires_at, state)
  VALUES (
    v_id,
    'aaaaaaaa-0000-0000-0000-00000000000a',
    'https://example.invalid/storage/v1/object/public/post-media/aaaaaaaa-0000-0000-0000-00000000000a/' || p_label || '.jpg',
    'image/jpeg',
    now() - p_expires,
    'active'
  );
  IF p_state <> 'active' THEN
    -- Reached through an UPDATE, the way the app gets there, so the trigger runs
    -- on the transition rather than on an insert that pretends to be one.
    -- Cast explicitly: `stories.state` is the enum `story_state` on the real
    -- schema, which a fixture built with a text column would not have shown.
    UPDATE public.stories SET state = p_state::story_state WHERE id = v_id;
  END IF;
  IF p_deleted IS NOT NULL THEN
    -- Backdate the frozen clock. The trigger refuses to MOVE deleted_at while
    -- the row stays deleted, so this is done with the trigger disabled — it is
    -- setting up a past, not exercising a rule.
    ALTER TABLE public.stories DISABLE TRIGGER stories_freeze_deleted_at_trg;
    UPDATE public.stories SET deleted_at = now() - p_deleted WHERE id = v_id;
    ALTER TABLE public.stories ENABLE TRIGGER stories_freeze_deleted_at_trg;
  END IF;
  INSERT INTO rehearsal_ids (label, id) VALUES (p_label, v_id);
  RETURN v_id;
END;
$$;

-- ── A. the trigger, on the real table ───────────────────────────────────────

DO $a1$
DECLARE v_id uuid; v_at timestamptz;
BEGIN
  v_id := pg_temp.seed('a1', 'active', interval '1 hour', NULL);
  UPDATE public.stories SET state = 'deleted' WHERE id = v_id;
  SELECT deleted_at INTO v_at FROM public.stories WHERE id = v_id;
  IF v_at IS NULL THEN
    RAISE EXCEPTION 'A1 FAILED: deleting a story on the real table did not start its clock';
  END IF;
  IF v_at < now() - interval '1 minute' THEN
    RAISE EXCEPTION 'A1 FAILED: the clock was not set to now (%)', v_at;
  END IF;
  RAISE NOTICE 'A1 ok — a delete starts the clock';
END;
$a1$;

DO $a2$
DECLARE v_id uuid; v_first timestamptz; v_second timestamptz;
BEGIN
  v_id := (SELECT id FROM rehearsal_ids WHERE label = 'a1');
  SELECT deleted_at INTO v_first FROM public.stories WHERE id = v_id;
  -- A second delete request, and a writer explicitly trying to push the clock
  -- forward. Decision 2: "Repeated delete requests must not reset that clock."
  UPDATE public.stories SET state = 'deleted' WHERE id = v_id;
  UPDATE public.stories SET state = 'deleted', deleted_at = now() + interval '10 days' WHERE id = v_id;
  SELECT deleted_at INTO v_second FROM public.stories WHERE id = v_id;
  IF v_second <> v_first THEN
    RAISE EXCEPTION 'A2 FAILED: a repeat delete moved the clock from % to %', v_first, v_second;
  END IF;
  RAISE NOTICE 'A2 ok — a repeat delete cannot extend the window, even when the writer names a new value';
END;
$a2$;

DO $a3$
DECLARE v_id uuid; v_at timestamptz;
BEGIN
  v_id := (SELECT id FROM rehearsal_ids WHERE label = 'a1');
  -- Recovery: POST /stories/:id/recover writes `state` ALONE and relies on the
  -- trigger for the rest. If this ever stops clearing deleted_at, a recovered
  -- story keeps a running clock and the purge takes it.
  UPDATE public.stories SET state = 'expired' WHERE id = v_id;
  SELECT deleted_at INTO v_at FROM public.stories WHERE id = v_id;
  IF v_at IS NOT NULL THEN
    RAISE EXCEPTION 'A3 FAILED: recovery left the clock running (%)', v_at;
  END IF;
  RAISE NOTICE 'A3 ok — recovery stops the clock without the route naming the column';
END;
$a3$;

DO $a4$
DECLARE v_id uuid; v_at timestamptz;
BEGIN
  v_id := (SELECT id FROM rehearsal_ids WHERE label = 'a1');
  -- Delete, recover, delete: the second delete is a NEW deletion of a row that
  -- left the deleted state in between, so it legitimately starts a fresh clock.
  -- This is what the archive-deadline cap in retentionDatesFor exists to bound;
  -- the trigger is not the wrong place for it, it is simply not that rule.
  UPDATE public.stories SET state = 'deleted' WHERE id = v_id;
  SELECT deleted_at INTO v_at FROM public.stories WHERE id = v_id;
  IF v_at IS NULL THEN
    RAISE EXCEPTION 'A4 FAILED: re-deleting a recovered story did not start a clock';
  END IF;
  RAISE NOTICE 'A4 ok — a delete after a recovery is a new deletion with its own clock';
END;
$a4$;

-- NEGATIVE CONTROL. Without this, every check above would pass on a database
-- where the trigger silently did nothing but `deleted_at` happened to be
-- written by hand.
DO $a5$
DECLARE v_id uuid; v_at timestamptz;
BEGIN
  ALTER TABLE public.stories DISABLE TRIGGER stories_freeze_deleted_at_trg;
  v_id := pg_temp.seed('a5', 'active', interval '1 hour', NULL);
  UPDATE public.stories SET state = 'deleted' WHERE id = v_id;
  SELECT deleted_at INTO v_at FROM public.stories WHERE id = v_id;
  ALTER TABLE public.stories ENABLE TRIGGER stories_freeze_deleted_at_trg;
  IF v_at IS NOT NULL THEN
    RAISE EXCEPTION 'A5 FAILED: deleted_at was set with the trigger DISABLED — something else writes it, and A1-A4 prove nothing about the trigger';
  END IF;
  RAISE NOTICE 'A5 ok — with the trigger off the clock stays null, so A1-A4 measured the trigger';
END;
$a5$;

-- ── B. the SELECT the job issues ────────────────────────────────────────────
--
-- CFG: archiveRetentionDays = 365, deletedRecoveryDays = 30.

DO $b0$
BEGIN
  PERFORM pg_temp.seed('b_archive_due',   'expired', interval '400 days', NULL);
  PERFORM pg_temp.seed('b_archive_young', 'expired', interval '10 days',  NULL);
  PERFORM pg_temp.seed('b_unswept',       'active',  interval '400 days', NULL);
  PERFORM pg_temp.seed('b_del_lapsed',    'deleted', interval '100 days', interval '31 days');
  PERFORM pg_temp.seed('b_del_fresh',     'deleted', interval '100 days', interval '2 days');
  -- Deleted YESTERDAY, but expired 400 days ago: its archive deadline went by
  -- 35 days back. Counting only from deleted_at would hold it another 28 days,
  -- which would make deleting a story a way to keep it LONGER.
  PERFORM pg_temp.seed('b_del_past_cap',  'deleted', interval '400 days', interval '1 day');
  RAISE NOTICE 'B0 ok — seeded';
END;
$b0$;

DO $b1$
DECLARE v_got text[]; v_want text[] := ARRAY['b_archive_due','b_unswept'];
BEGIN
  -- The archive half: state IN ('active','expired'), no highlight, expiry past
  -- the archive cutoff. 'active' is included on purpose — a row the sweep never
  -- flipped is still past its window, and keying retention on the flag would
  -- make it depend on a separate job having run.
  SELECT coalesce(array_agg(r.label ORDER BY r.label), ARRAY[]::text[]) INTO v_got
  FROM public.stories s JOIN rehearsal_ids r ON r.id = s.id
  WHERE s.state IN ('active','expired')
    AND s.saved_to_highlight_id IS NULL
    AND s.expires_at < now() - interval '365 days';
  IF v_got <> (SELECT array_agg(x ORDER BY x) FROM unnest(v_want) x) THEN
    RAISE EXCEPTION 'B1 FAILED: archive selection returned %, expected %', v_got, v_want;
  END IF;
  RAISE NOTICE 'B1 ok — the archive half selects by the clock, not by the flag';
END;
$b1$;

DO $b2$
DECLARE v_got text[]; v_want text[] := ARRAY['b_del_lapsed','b_del_past_cap'];
BEGIN
  -- The deleted half, INCLUDING the archive-deadline disjunct. `b_del_fresh` is
  -- inside both windows and must stay; `b_del_past_cap` is inside its 30 days
  -- but past its archive deadline and must go.
  SELECT coalesce(array_agg(r.label ORDER BY r.label), ARRAY[]::text[]) INTO v_got
  FROM public.stories s JOIN rehearsal_ids r ON r.id = s.id
  WHERE s.state = 'deleted'
    AND s.deleted_at IS NOT NULL
    AND (s.deleted_at < now() - interval '30 days'
         OR s.expires_at < now() - interval '365 days');
  IF v_got <> (SELECT array_agg(x ORDER BY x) FROM unnest(v_want) x) THEN
    RAISE EXCEPTION 'B2 FAILED: deleted selection returned %, expected %', v_got, v_want;
  END IF;
  RAISE NOTICE 'B2 ok — the cap binds past the archive deadline and nowhere else';
END;
$b2$;

DO $b3$
DECLARE v_n int;
BEGIN
  -- NEGATIVE CONTROL for B2. Drop the second disjunct — the exact regression a
  -- later edit would make — and b_del_past_cap must survive, or B2 was passing
  -- for a reason other than the predicate.
  SELECT count(*) INTO v_n
  FROM public.stories s JOIN rehearsal_ids r ON r.id = s.id
  WHERE s.state = 'deleted' AND s.deleted_at IS NOT NULL
    AND s.deleted_at < now() - interval '30 days'
    AND r.label = 'b_del_past_cap';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'B3 FAILED: b_del_past_cap was selected WITHOUT the archive disjunct, so B2 did not measure it';
  END IF;
  RAISE NOTICE 'B3 ok — without the archive disjunct the capped row is missed, so B2 measured the cap';
END;
$b3$;

-- ── C. the ledger outlives the row ──────────────────────────────────────────

DO $c1$
DECLARE v_id uuid; v_n int;
BEGIN
  -- The queue deliberately carries NO foreign key to stories. This is what lets
  -- processPurgeQueue delete the row first and still hold the object path to
  -- clean up afterwards. On the real schema, where `stories` has cascading
  -- children, a FK added by a later hand would silently destroy the ledger.
  v_id := (SELECT id FROM rehearsal_ids WHERE label = 'b_del_lapsed');
  INSERT INTO public.story_purge_queue
    (story_id, owner_id, media_url, storage_bucket, storage_path, reason, enqueued_at, attempts, next_attempt_at)
  VALUES
    (v_id, 'aaaaaaaa-0000-0000-0000-00000000000a',
     'https://example.invalid/x.jpg', 'post-media', 'aaaaaaaa-0000-0000-0000-00000000000a/x.jpg',
     'owner_deleted', now(), 0, now());

  DELETE FROM public.stories WHERE id = v_id;

  SELECT count(*) INTO v_n FROM public.story_purge_queue WHERE story_id = v_id;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'C1 FAILED: deleting the story destroyed its ledger entry — the object path is lost and the file is orphaned forever';
  END IF;
  RAISE NOTICE 'C1 ok — the ledger survives the row it describes';
END;
$c1$;

DO $c2$
DECLARE v_bad int;
BEGIN
  -- The outcome check: an entry cannot claim both that the object was deleted
  -- and that it was retained.
  BEGIN
    UPDATE public.story_purge_queue
       SET object_deleted_at = now(), object_retained_reason = 'referenced by a highlight'
     WHERE story_id = (SELECT id FROM rehearsal_ids WHERE label = 'b_del_lapsed');
    RAISE EXCEPTION 'C2 FAILED: an entry was allowed to record a deletion AND a retention at once';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'C2 ok — deleted and retained are mutually exclusive';
  END;
END;
$c2$;

ROLLBACK;
