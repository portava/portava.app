-- 2998_story_retention.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band), stories lane.
--
-- ═══════════════════════════════════════
-- WHAT THIS IS FOR
-- ═══════════════════════════════════════
-- Owner decisions, 2026-09-22, on what happens to a Story after its 24-hour
-- audience window closes (/mnt/project-files/story-retention-proposal-2026-09-22.md):
--
--   1. An expired Story stays in the owner's private archive until
--      expires_at + 365 days, then is permanently purged.
--   2. An owner-deleted Story leaves normal access immediately and keeps a
--      disclosed, owner-only recovery window of 30 days measured FROM
--      deleted_at. **Repeated delete requests must not reset that clock.**
--   3. Viewer lists, reactions and story-specific private replies are purged at
--      expires_at + 30 days, or earlier when the parent is permanently deleted.
--   7. Database and storage deletion must be recoverable across partial
--      failures: durable retry information is kept until BOTH deletions are
--      verified, and the object path is never lost by deleting its only record
--      before storage cleanup succeeds.
--
-- This file is the schema half. It adds the recovery clock, makes the
-- never-reset rule a property of the DATABASE rather than of one route, and
-- creates the durable purge ledger the job writes to before it destroys
-- anything.
--
-- ═══════════════════════════════════════
-- WHAT IT DOES NOT DO
-- ═══════════════════════════════════════
-- It deletes nothing, purges nothing and schedules nothing. It does not touch
-- the stories RLS policies, the expiry predicate, or any read path: an expired
-- Story is hidden from its audience by expires_at exactly as before
-- (routes/stories.ts:497-498, :600-601, 0068_stories.sql:51-53,
-- lib/mediaAccess.ts:544-549), and this migration changes none of them.
--
-- Every statement is idempotent. A build that has not applied this file still
-- runs: services/stories/storyRetention.ts refuses to purge when the ledger is
-- absent rather than proceeding without it.
--
-- ═══════════════════════════════════════
-- WHY THE FREEZE IS A TRIGGER AND NOT ROUTE CODE
-- ═══════════════════════════════════════
-- "Repeated delete requests must not reset that clock" is a guarantee about
-- every writer, present and future. DELETE /stories/:id is today's only writer
-- of state='deleted' (routes/stories.ts:628), but a guarantee enforced in one
-- handler is bypassed by the next one, by a backfill, or by a service-role
-- script — none of which is a bug in that handler. The trigger makes the clock
-- unresettable no matter who writes the row, so the route needs no change at
-- all and cannot silently lose the property later.
--
-- Recovery is the one legitimate way the clock stops: a Story that leaves
-- state='deleted' is no longer deleted, so its deleted_at is cleared. That is
-- the recovery flow, and it is why the trigger clears rather than freezes in
-- that one direction.

BEGIN;

-- ── 1. The recovery clock ────────────────────────────────────────────────────

ALTER TABLE public.stories
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.stories.deleted_at IS
  'When the owner deleted this Story. The 30-day owner-only recovery window is measured from here, and a repeat delete never moves it (trigger stories_freeze_deleted_at). NULL whenever state <> ''deleted''.';

-- Rows that were soft-deleted before this column existed have no start time.
-- Giving them now() starts their recovery window at the migration rather than
-- purging them on the retention job's first pass: nobody was told a window
-- existed, so nobody can have let one lapse.
UPDATE public.stories
   SET deleted_at = now()
 WHERE state = 'deleted' AND deleted_at IS NULL;

-- ── 2. The never-reset rule, as a property of the table ──────────────────────

CREATE OR REPLACE FUNCTION public.stories_freeze_deleted_at()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.state <> 'deleted' THEN
    -- Not deleted (including a recovery out of 'deleted'): no clock runs.
    NEW.deleted_at := NULL;
    RETURN NEW;
  END IF;

  -- state = 'deleted' from here down.
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NOT NULL THEN
    -- Already deleted. The clock started once and does not move again, whatever
    -- this statement asked for. This is the repeat-delete case.
    NEW.deleted_at := OLD.deleted_at;
  ELSIF NEW.deleted_at IS NULL THEN
    -- First transition into 'deleted' (or an insert that lands there) and the
    -- writer did not set a time: start the clock now, so a deleted Story can
    -- never sit in the archive with no purge date.
    NEW.deleted_at := now();
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS stories_freeze_deleted_at_trg ON public.stories;
CREATE TRIGGER stories_freeze_deleted_at_trg
  BEFORE INSERT OR UPDATE ON public.stories
  FOR EACH ROW EXECUTE FUNCTION public.stories_freeze_deleted_at();

-- ── 3. The durable purge ledger ──────────────────────────────────────────────
--
-- DELIBERATELY NO FOREIGN KEY on story_id. The whole point of this table is to
-- outlive the stories row: the purge writes the ledger entry FIRST, capturing
-- the storage path, and only then destroys anything. A cascading FK would
-- delete the ledger entry at the exact moment it becomes the only surviving
-- record of where the bytes are, which is the failure decision 7 names.

CREATE TABLE IF NOT EXISTS public.story_purge_queue (
  story_id          UUID        PRIMARY KEY,
  owner_id          UUID        NOT NULL,
  media_url         TEXT        NOT NULL,
  storage_bucket    TEXT        NULL,
  storage_path      TEXT        NULL,
  reason            TEXT        NOT NULL,
  enqueued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  object_deleted_at TIMESTAMPTZ NULL,
  object_retained_reason TEXT     NULL,
  row_deleted_at    TIMESTAMPTZ NULL,
  attempts          INTEGER     NOT NULL DEFAULT 0,
  last_attempt_at   TIMESTAMPTZ NULL,
  last_error        TEXT        NULL,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.story_purge_queue
  DROP CONSTRAINT IF EXISTS story_purge_queue_reason_check;
ALTER TABLE public.story_purge_queue
  ADD CONSTRAINT story_purge_queue_reason_check
  CHECK (reason IN ('archive_expired', 'owner_deleted', 'engagement_only'));

COMMENT ON TABLE public.story_purge_queue IS
  'Durable retry ledger for Story retention purges. An entry is written BEFORE any deletion and removed only once the storage object and the database row are both verified gone. Service-role only; no RLS policies by design.';
COMMENT ON COLUMN public.story_purge_queue.storage_path IS
  'Captured from stories.media_url at enqueue time. NULL means the URL did not resolve to one of this app''s buckets — the row is still purgeable, but no object is claimed.';
COMMENT ON COLUMN public.story_purge_queue.object_deleted_at IS
  'Set only after a read-back confirmed the object is absent from storage. A successful remove() call is not this.';
COMMENT ON COLUMN public.story_purge_queue.object_retained_reason IS
  'Set when the object is deliberately NOT deleted because another feature still references the same bytes (a saved Highlight, a Memory item, a passport memory). The Story row is still purged; the bytes belong to the surviving reference. Never set together with object_deleted_at.';
COMMENT ON COLUMN public.story_purge_queue.row_deleted_at IS
  'Set only after a read-back confirmed the stories row is absent.';

-- The job's own scan: due work, oldest first.
CREATE INDEX IF NOT EXISTS story_purge_queue_due_idx
  ON public.story_purge_queue (next_attempt_at)
  WHERE (object_deleted_at IS NULL AND object_retained_reason IS NULL) OR row_deleted_at IS NULL;

-- Backlog and failure counts for the health surface, without a sequential scan.
CREATE INDEX IF NOT EXISTS story_purge_queue_attempts_idx
  ON public.story_purge_queue (attempts)
  WHERE (object_deleted_at IS NULL AND object_retained_reason IS NULL) OR row_deleted_at IS NULL;

-- An entry may never claim both that the object was deleted and that it was
-- deliberately kept: the two are contradictory accounts of the same bytes.
ALTER TABLE public.story_purge_queue
  DROP CONSTRAINT IF EXISTS story_purge_queue_object_outcome_check;
ALTER TABLE public.story_purge_queue
  ADD CONSTRAINT story_purge_queue_object_outcome_check
  CHECK (object_deleted_at IS NULL OR object_retained_reason IS NULL);

ALTER TABLE public.story_purge_queue ENABLE ROW LEVEL SECURITY;
-- No policies: this ledger is operator/service-role state and is not part of
-- any user's data. It is NOT in deletionDispositions' user-data set for the
-- same reason, and account deletion removes its entries by owner_id explicitly.

-- ── 3b. job_health gains a SUCCESS timestamp ─────────────────────────────────
--
-- Decision 4: "Never report healthy before a successful run." job_health has
-- carried one column, `last_run_at`, and every writer sets it on the ATTEMPT —
-- tripCrewLiveShareScheduler.ts:195 says so in as many words ("Record the
-- ATTEMPT either way so a stalled job is still detectable"). A job that has
-- attempted a hundred times and succeeded never is therefore indistinguishable,
-- across a restart, from one that is working.
--
-- The in-process status object some schedulers keep does distinguish them, and
-- loses the distinction on every deploy — which is exactly when a never-succeeding
-- job would most like to be forgotten. So the success timestamp is persisted.
--
-- Additive and nullable: every existing writer keeps working untouched, and a
-- job that does not set it reads as "does not track success" rather than as a
-- failure.

ALTER TABLE public.job_health
  ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.job_health.last_success_at IS
  'When this job last completed a pass with no failures. NULL means it has never succeeded (or does not track success) — never read last_run_at as success, it records the attempt.';

-- ── 4. Retention scan indexes ────────────────────────────────────────────────
--
-- stories_state_expires_idx (0068) already serves the expired-archive scan
-- (state, expires_at). The deleted scan has no index: state='deleted' rows are
-- found by deleted_at, which did not exist until this file.

CREATE INDEX IF NOT EXISTS stories_deleted_at_idx
  ON public.stories (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- ── Postconditions: the end state, not the path ──────────────────────────────
DO $post$
DECLARE n int; src text;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'stories' AND column_name = 'deleted_at';
  IF n <> 1 THEN RAISE EXCEPTION '2998: stories.deleted_at missing'; END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgname = 'stories_freeze_deleted_at_trg' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION '2998: freeze trigger missing (found %)', n; END IF;

  -- The trigger must fire on UPDATE as well as INSERT, or the repeat-delete
  -- case — the one the decision names — is unguarded while the check passes.
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgname = 'stories_freeze_deleted_at_trg' AND NOT tgisinternal
     AND (tgtype & 16) <> 0 AND (tgtype & 4) <> 0;
  IF n <> 1 THEN RAISE EXCEPTION '2998: freeze trigger does not cover both INSERT and UPDATE'; END IF;

  -- Prove the freeze actually freezes, here, against this database — a trigger
  -- that exists and does nothing is indistinguishable from a correct one.
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'stories_freeze_deleted_at';
  IF src IS NULL OR position('OLD.deleted_at' IN src) = 0 THEN
    RAISE EXCEPTION '2998: freeze function does not read OLD.deleted_at';
  END IF;

  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'story_purge_queue';
  IF n <> 1 THEN RAISE EXCEPTION '2998: story_purge_queue missing'; END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'job_health' AND column_name = 'last_success_at';
  IF n <> 1 THEN RAISE EXCEPTION '2998: job_health.last_success_at missing'; END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'story_purge_queue'
     AND column_name IN ('story_id','owner_id','media_url','storage_bucket','storage_path','reason',
                         'enqueued_at','object_deleted_at','object_retained_reason','row_deleted_at',
                         'attempts','last_attempt_at','last_error','next_attempt_at');
  IF n <> 14 THEN RAISE EXCEPTION '2998: story_purge_queue is missing columns (found % of 14)', n; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'story_purge_queue' AND c.contype = 'f'
  ) THEN
    RAISE EXCEPTION '2998: story_purge_queue has a foreign key — it must outlive the stories row it describes';
  END IF;

  -- No deleted row may exist without a clock, or the retention job has a row it
  -- can never age out.
  SELECT count(*) INTO n FROM public.stories WHERE state = 'deleted' AND deleted_at IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION '2998: % deleted stories still have no deleted_at', n; END IF;
END $post$;

COMMIT;

-- ═══════════════════════════════════════
-- DOWN
-- ═══════════════════════════════════════
-- BEGIN;
-- DROP TRIGGER IF EXISTS stories_freeze_deleted_at_trg ON public.stories;
-- DROP FUNCTION IF EXISTS public.stories_freeze_deleted_at();
-- DROP INDEX IF EXISTS public.stories_deleted_at_idx;
-- DROP TABLE IF EXISTS public.story_purge_queue;
-- ALTER TABLE public.stories DROP COLUMN IF EXISTS deleted_at;
-- ALTER TABLE public.job_health DROP COLUMN IF EXISTS last_success_at;
-- COMMIT;
