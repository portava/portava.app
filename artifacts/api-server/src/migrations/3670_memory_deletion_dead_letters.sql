-- 3670_memory_deletion_dead_letters.sql
-- Highlights/Memories spec §21: "Deletion must be observable, retryable, and
-- dead-lettered on repeated downstream failure." Census H193.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane H 3670-3689).
-- APPLIED TO NO DATABASE by the lane that wrote it. Additive and idempotent:
-- one table, two indexes, grants. No flag, no function, no trigger, no row.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- services/memory/memoryDeletionLifecycle.ts runs §21's five steps for one
-- Memory on every DELETE /memories/:id, retries a failing step, and after
-- MAX_STEP_ATTEMPTS calls the deletion dead-lettered. Until this table the
-- dead letter was a log line: nothing counted it and nothing could find it
-- again, and every report said so (`deadLetterDurable: false`). This is the
-- record. One row per Memory: a repeat dead letter for the same Memory bumps
-- `letters` and `last_failed_at`, and a later run that completes stamps
-- `resolved_at`.
--
-- ── WHAT IT HOLDS, AND WHAT IT DOES NOT ─────────────────────────────────────
-- Ids, step names, the steps' own failure text, and times. No title, caption,
-- media, place or audience — nothing the Memory said. The writer composes
-- `detail` from step reports, which carry error messages and counts only.
--
-- ── ERASURE ─────────────────────────────────────────────────────────────────
-- Both keys cascade: memory_id from public.memories (account deletion
-- hard-deletes every Memory of the account, soft-deleted ones included) and
-- owner_id from auth.users (the account deletion's final step deletes the auth
-- user). So no letter outlives the account it is about, without a service step.
--
-- ── ACCESS ──────────────────────────────────────────────────────────────────
-- RLS on with NO policy, every grant revoked from anon and authenticated, and
-- service_role given exactly what the writer needs. service_role is in the
-- REVOKE list first because Supabase's default privileges grant it ALL on a
-- new table.
--
-- Absent table (this file not applied): the writer reads 42P01 / PGRST205,
-- reports `deadLetterDurable: false` with that reason, and the deletion itself
-- is unaffected — the behaviour before this file.
--
-- Rollback: db/rollback/2026-10-07-3670-memory-deletion-dead-letters-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memories') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3670): public.memories does not exist.';
  END IF;
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3670): auth.users is missing — the erasure cascade cannot be created.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.memory_deletion_dead_letters (
  memory_id          uuid PRIMARY KEY REFERENCES public.memories(id) ON DELETE CASCADE,
  owner_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The §21 steps that exhausted their retries or failed, in §21's vocabulary.
  failed_steps       text[] NOT NULL
                       CHECK (cardinality(failed_steps) > 0
                              AND failed_steps <@ ARRAY['DELETION_REQUESTED','PUBLIC_REVOKED','DERIVATIVES_PURGED','RAW_EVIDENCE_PURGED','DELETED']::text[]),
  -- The furthest §21 state reached with no gap behind it; NULL when none was.
  reached_state      text
                       CHECK (reached_state IS NULL
                              OR reached_state IN ('DELETION_REQUESTED','PUBLIC_REVOKED','DERIVATIVES_PURGED','RAW_EVIDENCE_PURGED','DELETED')),
  detail             text NOT NULL CHECK (char_length(detail) <= 4000),
  lifecycle_version  text NOT NULL,
  letters            integer NOT NULL DEFAULT 1 CHECK (letters >= 1),
  first_failed_at    timestamptz NOT NULL DEFAULT now(),
  last_failed_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  CONSTRAINT memory_deletion_dead_letters_times_check
    CHECK (last_failed_at >= first_failed_at)
);

CREATE INDEX IF NOT EXISTS memory_deletion_dead_letters_open_idx
  ON public.memory_deletion_dead_letters (last_failed_at)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS memory_deletion_dead_letters_owner_idx
  ON public.memory_deletion_dead_letters (owner_id);

ALTER TABLE public.memory_deletion_dead_letters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_deletion_dead_letters FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.memory_deletion_dead_letters TO service_role;

COMMENT ON TABLE public.memory_deletion_dead_letters IS
  'Spec §21 dead letters: one row per Memory whose deletion lifecycle exhausted a step''s retries (memoryDeletionLifecycle.ts). Ids, step names, failure text and times only. Erased by cascade from memories and auth.users. service_role only.';

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.memory_deletion_dead_letters') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3670): memory_deletion_dead_letters not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.memory_deletion_dead_letters'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3670): RLS is not enabled on memory_deletion_dead_letters';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.memory_deletion_dead_letters'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3670): memory_deletion_dead_letters must carry no policy';
  END IF;
  IF has_table_privilege('anon', 'public.memory_deletion_dead_letters', 'SELECT')
     OR has_table_privilege('authenticated', 'public.memory_deletion_dead_letters', 'SELECT')
     OR has_table_privilege('authenticated', 'public.memory_deletion_dead_letters', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3670): a client role can reach memory_deletion_dead_letters';
  END IF;
  IF has_table_privilege('service_role', 'public.memory_deletion_dead_letters', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3670): service_role must not DELETE a dead letter; a resolved one is stamped, not removed';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.memory_deletion_dead_letters', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.memory_deletion_dead_letters', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3670): the writer (service_role) cannot record a dead letter';
  END IF;
END $$;

COMMIT;
