-- 4090_telegraph_thread_notification_policy.sql
-- Telegraph §30A.6 — per-thread notification policy: ALL / MENTIONS / IMPORTANT /
-- temporary mute / MUTED, with safety-critical delivery governed by the safety
-- policy rather than by ordinary mute.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION. Lane T2 band 4090-4119.
--
-- Spec §30A.6, verbatim:
--   "Thread notification policy may support ALL, MENTIONS, IMPORTANT, temporary
--    mute, and MUTED. Safety-critical delivery remains governed by the safety
--    policy rather than ordinary mute."
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THE CENSUS FOUND
-- ══════════════════════════════════════════════════════════════════════════════
-- T398 (BUILT-BUT-WRONG): "Two of five ... MUTED (message_thread_members.muted_at)
--   and the safety override ... No ALL/MENTIONS/IMPORTANT selector, no temporary
--   mute." Re-read before this file was written, and worse than recorded: MUTED
--   was a stored timestamp that NOTHING READ when deciding a notification — the
--   @mention notification in routes/messaging.ts was created for a member who had
--   muted the thread exactly as for one who had not. That half is fixed in code,
--   on every deployment, without this file: the dispatch now reads muted_at
--   (domain/telegraph/policies/threadNotificationPolicy.ts). This file adds the
--   two things a timestamp cannot carry.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- TWO COLUMNS
-- ══════════════════════════════════════════════════════════════════════════════
-- notification_level — 'all' | 'mentions' | 'important' | 'muted'. NOT NULL with
--   DEFAULT 'all', so every existing membership row reads as what it was: a
--   member who never chose anything gets everything. A row whose muted_at is set
--   is NOT backfilled to 'muted' — the reader treats muted_at as MUTED whatever
--   the level says, so a backfill would be a second copy of a fact that already
--   has one, and the rollback would have to decide which copy wins.
-- muted_until — a TEMPORARY mute. NULL = no temporary mute. Expiry is read, not
--   swept: a mute that has passed is simply not in force, so no job has to run
--   for it to end and a failed job cannot extend one.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE FLAG, AND WHAT IT GATES
-- ══════════════════════════════════════════════════════════════════════════════
-- telegraph_thread_notification_policy_enabled, seeded FALSE. While it is off no
-- code names either column (a database without this file is never asked for
-- them): the policy route answers MUTED and ALL through muted_at, which every
-- database has, and refuses MENTIONS, IMPORTANT and a temporary mute with
-- feature_disabled. On, it reads and writes both columns.
--
-- No table is created, no row is written, no grant changes. Columns on an
-- existing table inherit its RLS and grants unchanged.
--
-- ROLLBACK: db/rollback/2026-10-05-4090-telegraph-thread-notification-policy-rollback.sql

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF to_regclass('public.message_thread_members') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.message_thread_members must exist.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags must exist.';
  END IF;
END $pre$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. The columns
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.message_thread_members
  ADD COLUMN IF NOT EXISTS notification_level text NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS muted_until timestamptz NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.message_thread_members'::regclass
       AND conname = 'message_thread_members_notification_level_check'
  ) THEN
    ALTER TABLE public.message_thread_members
      ADD CONSTRAINT message_thread_members_notification_level_check
      CHECK (notification_level IN ('all','mentions','important','muted'));
  END IF;
END $$;

COMMENT ON COLUMN public.message_thread_members.notification_level IS
  'Telegraph §30A.6 thread notification policy: all | mentions | important | muted. Read only while telegraph_thread_notification_policy_enabled is TRUE. muted_at, when set, means MUTED whatever this says. SAFETY notifications are never suppressed by it.';
COMMENT ON COLUMN public.message_thread_members.muted_until IS
  'Telegraph §30A.6 temporary mute: notifications for this member in this thread are suppressed until this instant (SAFETY excepted). NULL = none. Expiry is read, never swept.';

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. The flag, seeded FALSE
-- ══════════════════════════════════════════════════════════════════════════════

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('telegraph_thread_notification_policy_enabled', false,
   'CAPABILITY gate for Telegraph §30A.6 per-thread notification levels. OFF (the seed): no code names notification_level or muted_until; MUTED and ALL work through muted_at on every database, and MENTIONS / IMPORTANT / temporary mute are refused with feature_disabled. ON: the policy route reads and writes both columns and every thread-scoped notification is decided by the level.')
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(c, ', ') INTO v_missing FROM (
    SELECT c FROM unnest(ARRAY['notification_level','muted_until']) c
     WHERE NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='message_thread_members' AND column_name=c
     )
  ) q;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: column(s) not added to message_thread_members: %', v_missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='message_thread_members'
       AND column_name='notification_level' AND column_default LIKE '''all''%'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: message_thread_members.notification_level must default to ''all''.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.message_thread_members'::regclass
       AND conname = 'message_thread_members_notification_level_check'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: notification_level CHECK was not created.';
  END IF;

  -- Nothing was backfilled: every existing row reads 'all' and has no temporary mute.
  IF EXISTS (SELECT 1 FROM public.message_thread_members WHERE notification_level <> 'all' OR muted_until IS NOT NULL) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a membership row carries a level or a temporary mute — this migration backfills nothing.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_thread_notification_policy_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_thread_notification_policy_enabled was not seeded.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_thread_notification_policy_enabled' AND enabled) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_thread_notification_policy_enabled must be seeded FALSE.';
  END IF;
END $post$;

COMMIT;
