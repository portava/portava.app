-- Rollback for artifacts/api-server/src/migrations/2741_layover_session_returning_status.sql
--
-- ORDER MATTERS. The UPDATE must run BEFORE the constraint is narrowed, or the
-- ADD CONSTRAINT will fail validation against any session already marked
-- 'returning'. Those sessions become 'cancelled', which is the same terminal
-- state DELETE /sessions/:id has always defaulted to — not 'active', because a
-- traveller who pressed RETURN TO AIRPORT is not exploring. The same applies to
-- the ledger rows: 'safe_return_aborted' events must be removed before the
-- event_type CHECK is narrowed, or the ADD will not validate.
--
-- Measured 2026-09-07 in production `ajrurzioarfkagpuxfnb`: 5 layover sessions
-- ever, 0 active, and the flag that permits the 'returning' write is seeded
-- FALSE, so the UPDATE is expected to affect 0 rows.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THREE STATEMENTS ADDED 2026-09-08 AFTER A ROLLBACK REHEARSAL ON CI
-- ══════════════════════════════════════════════════════════════════════════════
-- This file was rehearsed against a post-migration CI database and MEASURED to
-- leave residue. It reverted the session status and the flag, and left behind:
--
--   1. `layover_events.event_type` still accepting 'safe_return_aborted'.
--      The forward migration widens TWO checks; this file narrowed one. After a
--      rollback the database still admitted a value no code path could produce,
--      so a re-apply would not have been returning to a known state — it would
--      have been widening an already-widened constraint.
--   2. Any 'safe_return_aborted' ledger rows. The forward migration's own
--      "REVERSIBLE BY" header lists this DELETE; the file omitted it. With rows
--      present the narrowing in (1) could not have validated at all, so the
--      rollback would have FAILED HALFWAY on precisely the database where it
--      mattered — one where the abort had been used.
--   3. The COMMENT ON COLUMN describing 'returning'. A comment is not
--      behaviour, but after a rollback it documented a state the constraint no
--      longer permitted, which is the kind of stale note that later gets read
--      as evidence the state exists.
--
-- Nothing about the forward migration changed; the rehearsal only showed this
-- file was an incomplete inverse of it.

BEGIN;

-- ── Session status ───────────────────────────────────────────────────────────
UPDATE public.layover_sessions SET status = 'cancelled', updated_at = NOW()
  WHERE status = 'returning';

ALTER TABLE public.layover_sessions DROP CONSTRAINT IF EXISTS layover_sessions_status_check;

ALTER TABLE public.layover_sessions
  ADD CONSTRAINT layover_sessions_status_check
  CHECK (status IN ('active', 'completed', 'cancelled', 'expired'));

COMMENT ON COLUMN public.layover_sessions.status IS
  'Lifecycle: active | completed | cancelled | expired.';

-- ── Decision-ledger event type ───────────────────────────────────────────────
-- The DELETE first, for the same reason the UPDATE goes first above.
DELETE FROM public.layover_events WHERE event_type = 'safe_return_aborted';

ALTER TABLE public.layover_events DROP CONSTRAINT IF EXISTS layover_events_event_type_check;

ALTER TABLE public.layover_events
  ADD CONSTRAINT layover_events_event_type_check
  CHECK (event_type IN (
    'session_created','session_updated','session_completed',
    'session_cancelled','session_expired',
    'recommendation_generated','recommendation_saved',
    'compass_question_asked','plan_created',
    'plan_stop_added','plan_stop_updated','plan_stop_removed',
    'plan_reordered','share_toggled',
    'return_deadline_set','safe_return_suggested',
    'passport_seam_emitted','telegraph_suggestion_sent'
  ));

-- ── The gate ─────────────────────────────────────────────────────────────────
DELETE FROM public.feature_flags WHERE flag = 'layover_safe_return_status_enabled';

-- ── POSTCONDITIONS: prove the inverse is complete, not assumed ───────────────
DO $$
DECLARE
  n INTEGER;
  def TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c
  JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=t.relnamespace
  WHERE ns.nspname='public' AND t.relname='layover_sessions' AND c.contype='c'
    AND pg_get_constraintdef(c.oid) LIKE '%status%';
  IF def LIKE '%returning%' THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (2741): layover_sessions.status still accepts ''returning''';
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c
  JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=t.relnamespace
  WHERE ns.nspname='public' AND t.relname='layover_events' AND c.contype='c'
    AND pg_get_constraintdef(c.oid) LIKE '%event_type%';
  IF def LIKE '%safe_return_aborted%' THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (2741): layover_events.event_type still accepts ''safe_return_aborted''';
  END IF;
  IF def NOT LIKE '%telegraph_suggestion_sent%' THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (2741): the narrowing dropped a pre-existing event type';
  END IF;

  SELECT count(*) INTO n FROM public.feature_flags WHERE flag='layover_safe_return_status_enabled';
  IF n <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (2741): the flag row survived';
  END IF;

  SELECT count(*) INTO n FROM public.layover_sessions WHERE status='returning';
  IF n <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (2741): % session(s) still marked returning', n;
  END IF;
END $$;

COMMIT;
