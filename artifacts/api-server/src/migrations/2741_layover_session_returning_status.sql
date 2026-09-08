-- 2741_layover_session_returning_status.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2741.
-- Idempotent. Widens ONE check constraint and seeds ONE feature flag, FALSE.
-- Moves no row: no existing session's status changes, and no session can hold
-- the new value until the flag is flipped by an owner.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT
-- ══════════════════════════════════════════════════════════════════════════════
-- 1. `layover_sessions.status` accepts `'returning'` in addition to
--    'active' | 'completed' | 'cancelled' | 'expired'.
-- 2. `layover_events.event_type` accepts `'safe_return_aborted'`, the decision
--    ledger row §15.1 requires ("records the transition in the decision
--    ledger"). This is NOT gated by the flag below and is a HARD prerequisite
--    for wiring the abort route at all: `event_type` carries an inline CHECK
--    (0127:198-208) over eighteen values, so the insert would be rejected in
--    full on any database that has not run this file. `check:enum-literals`
--    caught exactly that against the first draft of
--    `LayoverSafeReturnService`, before any test ran — a fake Supabase client
--    cannot see a CHECK, so the suite would have been green and the write dead.
-- 3. Seeds `layover_safe_return_status_enabled` = FALSE, the gate that
--    `LayoverSafeReturnService.abortToAirport` reads before it writes the new
--    STATUS value. It does not gate the ledger row: the ledger is the only
--    durable evidence the traveller pressed abort, and it must survive the
--    flag being off.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- Spec §15.1: "Every active landside plan must expose RETURN TO AIRPORT. The
-- action cancels optional itinerary state, MARKS THE SESSION RETURNING,
-- surfaces the fastest certified route, notifies relevant crew/buddy flows,
-- preserves offline route/deadline, and records the transition in the decision
-- ledger."
--
-- Census L147 scores all six effects NOT-BUILT and names the blocker for this
-- one: "`RETURNING` is not a representable status (L33)." 0127:85-86 is a TEXT
-- column with an inline CHECK over four values, so the write fails outright
-- with a check violation on any database that has not run this file. That is
-- exactly why the service gates the write on a flag and why the flag is seeded
-- FALSE: supabase-js sends every key in the payload, so an ungated writer
-- breaks the abort on every database that lags the migration — the same hazard
-- 2410 documents.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- READ THIS BEFORE FLIPPING THE FLAG — THE SCHEMA IS NOT THE ONLY PREREQUISITE
-- ══════════════════════════════════════════════════════════════════════════════
-- `'returning'` is NOT `'active'`, and TWELVE code sites filter on `status =
-- 'active'`. A session marked returning would, TODAY, disappear from or be
-- refused by every one of them. Measured 2026-09-08, they are:
--
--   services/airport/LayoverSessionService.ts   updateSession (:183),
--       endSession (:208), getActiveSession (:276), setShareStatus (:322),
--       setReturnReminder (:347), expireOldSessions (:362)
--   services/airport/LayoverRecommendationService.ts  :193
--   routes/airport.ts   PATCH guard (:634), cityPresence (:1234),
--       presence/buddies reads (:1747, :1877), admin sessions (:2076)
--
-- The consequences, stated plainly rather than left to be discovered: after an
-- abort, `GET /sessions/active` would answer `session: null` — which the client
-- renders as "you are not in a layover", hiding the return countdown at the
-- precise moment the traveller is running for a plane — and `endSession`,
-- `setReturnReminder` and `PATCH /sessions/:id` would all refuse.
--
-- So the ORDER IS: apply this migration → widen those twelve sites to treat
-- `('active','returning')` as the live set → THEN flip
-- `layover_safe_return_status_enabled`. Applying this file alone changes
-- nothing, and the flag being FALSE is what makes that true.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT WAS MEASURED
-- ══════════════════════════════════════════════════════════════════════════════
-- Production `ajrurzioarfkagpuxfnb`, 2026-09-07, read-only aggregates: 5
-- layover sessions ever (2 cancelled, 3 expired, 0 active), 0 plan stops, 38
-- events. There is no row this constraint change could invalidate: widening a
-- CHECK can only accept more, and every existing value stays legal. The
-- constraint is re-created rather than left alone because Postgres has no
-- "ALTER CHECK"; the drop and the add are in one transaction.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSIBLE BY
-- ══════════════════════════════════════════════════════════════════════════════
--   DELETE FROM public.layover_events WHERE event_type = 'safe_return_aborted';
--   UPDATE public.layover_sessions SET status = 'cancelled' WHERE status = 'returning';
--   ALTER TABLE public.layover_sessions DROP CONSTRAINT layover_sessions_status_check;
--   ALTER TABLE public.layover_sessions ADD CONSTRAINT layover_sessions_status_check
--     CHECK (status IN ('active','completed','cancelled','expired'));
--   DELETE FROM public.feature_flags WHERE flag = 'layover_safe_return_status_enabled';
-- The UPDATE must run first, or the narrowed constraint will not validate.
-- Rollback file: db/rollback/2026-09-08-2741-layover-session-returning-status.sql
--
-- ══════════════════════════════════════════════════════════════════════════════
-- APPLY ORDER
-- ══════════════════════════════════════════════════════════════════════════════
-- Independent of 2335 / 2410 / 2510 / 2700 / 2740. Nothing depends on it and it
-- depends on nothing but 0127.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.layover_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2741): public.layover_sessions is missing.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (2741): public.feature_flags is missing.';
  END IF;
END $$;

-- ── SECTION 1: widen the status check ────────────────────────────────────────
-- 0127 declares the CHECK inline and unnamed, so Postgres named it
-- `layover_sessions_status_check`. The lookup is by DEFINITION rather than by
-- that name, so a database where it was created under a different name (a
-- restore, a manual repair) is handled instead of silently ending up with two
-- constraints.
DO $$
DECLARE
  conname_found TEXT;
BEGIN
  SELECT c.conname INTO conname_found
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'layover_sessions'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%status%'
    AND pg_get_constraintdef(c.oid) LIKE '%expired%'
  LIMIT 1;

  IF conname_found IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.layover_sessions DROP CONSTRAINT %I', conname_found);
  END IF;
END $$;

ALTER TABLE public.layover_sessions
  ADD CONSTRAINT layover_sessions_status_check
  CHECK (status IN ('active', 'returning', 'completed', 'cancelled', 'expired'));

COMMENT ON COLUMN public.layover_sessions.status IS
  'Lifecycle. ''returning'' is spec §15.1: the traveller pressed RETURN TO AIRPORT and is heading back. It is a LIVE state, not a terminal one — every reader that treats ''active'' as "live" must treat (''active'',''returning'') as live. Written only when layover_safe_return_status_enabled is TRUE.';

-- ── SECTION 2: the decision-ledger event type ────────────────────────────────
-- Same shape as section 1 and for the same reason: the CHECK is inline and
-- unnamed in 0127, so it is located by definition, dropped and re-added with
-- one more legal value. Every existing value stays legal; widening a CHECK can
-- only accept more.
DO $$
DECLARE
  conname_found TEXT;
BEGIN
  SELECT c.conname INTO conname_found
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'layover_events'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%event_type%'
    AND pg_get_constraintdef(c.oid) LIKE '%session_created%'
  LIMIT 1;

  IF conname_found IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.layover_events DROP CONSTRAINT %I', conname_found);
  END IF;
END $$;

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
    'passport_seam_emitted','telegraph_suggestion_sent',
    'safe_return_aborted'
  ));

-- ── SECTION 3: the gate ──────────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_safe_return_status_enabled',
    FALSE,
    'CAPABILITY. Layover §15.1 one-tap abort may mark the session status ''returning''. Requires 2741 AND the twelve status=''active'' readers widened to (''active'',''returning'') — see that migration''s header. OFF = the abort still cancels landside stops, returns the certified return contract and writes the decision-ledger row, but leaves status untouched and reports status_unchanged_flag_off. SEEDED FALSE.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── POSTCONDITIONS ───────────────────────────────────────────────────────────
DO $$
DECLARE
  accepts_returning BOOLEAN;
  accepts_active BOOLEAN;
  flag_present INTEGER;
  check_count INTEGER;
BEGIN
  SELECT count(*) INTO check_count
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'layover_sessions'
    AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%status%';
  IF check_count <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2741): expected exactly 1 status check on layover_sessions, found %', check_count;
  END IF;

  SELECT pg_get_constraintdef(c.oid) LIKE '%returning%' INTO accepts_returning
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'layover_sessions'
    AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%status%';
  IF NOT accepts_returning THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2741): status check does not accept ''returning''';
  END IF;

  -- The widening must not have dropped an existing value: every legacy status
  -- is still legal, or sessions already in the table would be unwritable.
  SELECT pg_get_constraintdef(c.oid) LIKE '%active%' INTO accepts_active
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'layover_sessions'
    AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%status%';
  IF NOT accepts_active THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2741): status check no longer accepts ''active''';
  END IF;

  SELECT count(*) INTO flag_present FROM public.feature_flags
    WHERE flag = 'layover_safe_return_status_enabled';
  IF flag_present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2741): layover_safe_return_status_enabled flag row missing';
  END IF;

  -- The ledger event type, both directions: the new value is legal AND the
  -- eighteen that existed still are. A widening that dropped one would break
  -- every writer in LayoverSessionService.
  SELECT count(*) INTO check_count
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'layover_events'
    AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%event_type%';
  IF check_count <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2741): expected exactly 1 event_type check on layover_events, found %', check_count;
  END IF;

  SELECT bool_and(pg_get_constraintdef(c.oid) LIKE ('%' || v || '%')) INTO accepts_returning
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  CROSS JOIN unnest(ARRAY[
    'session_created','session_updated','session_completed','session_cancelled',
    'session_expired','recommendation_generated','recommendation_saved',
    'compass_question_asked','plan_created','plan_stop_added','plan_stop_updated',
    'plan_stop_removed','plan_reordered','share_toggled','return_deadline_set',
    'safe_return_suggested','passport_seam_emitted','telegraph_suggestion_sent',
    'safe_return_aborted'
  ]) AS v
  WHERE n.nspname = 'public' AND t.relname = 'layover_events'
    AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%event_type%';
  IF NOT accepts_returning THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2741): layover_events.event_type check lost a value or did not gain safe_return_aborted';
  END IF;
END $$;

COMMIT;
