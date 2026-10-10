-- 3622_layover_post_session_pseudonymisation.sql
--
-- census-layover L163, lead ruling PR-R-L163a (2026-10-07), under OD-MAP-4.
-- Written by lane R. NOT applied to any database at the time of writing:
-- not to portava-ci (hwokxgbmezheskbzskfr), not to production (ajrurzioarfkagpuxfnb).
-- DEPENDS ON 3621 (the pseudonymisation columns and the identity-or-pseudonym
-- CHECK); its precondition refuses to run without them.
--
-- ── THE RULING ───────────────────────────────────────────────────────────────
-- "30 days after a layover session ends, pseudonymise that traveller's
--  layover_events the same way account deletion does, and delete at 12 months
--  (OD-MAP-4). Because it's destructive, the scheduler sits behind a flag seeded
--  FALSE … dead-letter on failure."
--
-- A live traveller's decision ledger used to keep their uuid on every row with no
-- retention bound (census-layover §55.7). The only reader of a session's events
-- is that live session's own disruption ledger
-- (services/airport/layoverSafeReturnDisruption.ts readDisruptionState), so once
-- the layover is a month past its departure nothing needs the name.
--
-- ── WHAT THIS FILE ADDS ──────────────────────────────────────────────────────
-- 1. layover_event_pseudonymisation_dead_letters — one row per session whose
--    events the post-session pass (lib/layoverEventPseudonymisation.ts) could
--    not pseudonymise. `letters` counts consecutive failures; at the ceiling the
--    pass stops retrying that session (so it cannot starve the rest) and the
--    open letter is reported on GET /healthz/schedulers (job
--    layoverAuditRetention). A later success stamps resolved_at; a row is never
--    deleted by the service (no DELETE grant), only by the session's own cascade.
--    Ids, failure text and times only: no user id (the session row has it, and
--    the letter goes when the session goes), no event content.
-- 2. layover_events_post_session_pseudonymisation_enabled, seeded FALSE. OFF /
--    absent / unreadable: the pass reads the flag and does nothing else.
--
-- Access: RLS on, no policy, every client role revoked (rule 4 of
-- check:client-privilege-boundary), service_role SELECT/INSERT/UPDATE only.
--
-- Rollback: db/rollback/2026-10-07-3622-layover-post-session-pseudonymisation-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.layover_sessions') IS NULL OR to_regclass('public.layover_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3622): layover_sessions or layover_events is missing -- apply 0127 first.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3622): public.feature_flags does not exist.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'layover_events_identity_or_pseudonym' AND conrelid = 'public.layover_events'::regclass
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3622): 3621 is not applied (layover_events_identity_or_pseudonym is absent) -- the pass would have nowhere to write a pseudonymised row.';
  END IF;
END $pre$;

CREATE TABLE IF NOT EXISTS public.layover_event_pseudonymisation_dead_letters (
  session_id       uuid PRIMARY KEY REFERENCES public.layover_sessions(id) ON DELETE CASCADE,
  detail           text NOT NULL CHECK (char_length(detail) <= 1000),
  letters          integer NOT NULL DEFAULT 1 CHECK (letters >= 1),
  first_failed_at  timestamptz NOT NULL DEFAULT now(),
  last_failed_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  CONSTRAINT layover_event_pseudonymisation_dead_letters_times_check
    CHECK (last_failed_at >= first_failed_at)
);

CREATE INDEX IF NOT EXISTS layover_event_pseudonymisation_dead_letters_open_idx
  ON public.layover_event_pseudonymisation_dead_letters (last_failed_at)
  WHERE resolved_at IS NULL;

ALTER TABLE public.layover_event_pseudonymisation_dead_letters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_event_pseudonymisation_dead_letters FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.layover_event_pseudonymisation_dead_letters TO service_role;

COMMENT ON TABLE public.layover_event_pseudonymisation_dead_letters IS
  'PR-R-L163a dead letters: one row per layover session whose events the post-session pseudonymisation pass could not pseudonymise. Session id, failure text and times only. Erased by cascade from layover_sessions. service_role only; resolved rows are stamped, never deleted.';

-- The pass's read: named events whose session departed long enough ago.
CREATE INDEX IF NOT EXISTS layover_events_named_session_idx
  ON public.layover_events (session_id, created_at)
  WHERE pseudonymised_at IS NULL;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_events_post_session_pseudonymisation_enabled',
    false,
    'census-layover L163, lead ruling PR-R-L163a (OD-MAP-4). ON: the hourly layover audit retention pass pseudonymises the layover_events of every session whose departure is more than 30 days past, exactly as account deletion does (user and session removed, one random pseudonym per session, metadata emptied, retain_until 12 months out), and dead-letters a session it cannot. OFF / absent / unreadable (the seed): the pass reads this flag and does nothing else; named events stay named.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $post$
BEGIN
  IF to_regclass('public.layover_event_pseudonymisation_dead_letters') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3622): layover_event_pseudonymisation_dead_letters not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.layover_event_pseudonymisation_dead_letters'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3622): RLS is not enabled on layover_event_pseudonymisation_dead_letters';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.layover_event_pseudonymisation_dead_letters'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3622): layover_event_pseudonymisation_dead_letters must carry no policy';
  END IF;
  IF has_table_privilege('anon', 'public.layover_event_pseudonymisation_dead_letters', 'SELECT')
     OR has_table_privilege('anon', 'public.layover_event_pseudonymisation_dead_letters', 'INSERT')
     OR has_table_privilege('authenticated', 'public.layover_event_pseudonymisation_dead_letters', 'SELECT')
     OR has_table_privilege('authenticated', 'public.layover_event_pseudonymisation_dead_letters', 'INSERT')
     OR has_table_privilege('authenticated', 'public.layover_event_pseudonymisation_dead_letters', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3622): a client role can reach layover_event_pseudonymisation_dead_letters';
  END IF;
  IF has_table_privilege('service_role', 'public.layover_event_pseudonymisation_dead_letters', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3622): service_role must not DELETE a dead letter; a resolved one is stamped, not removed';
  END IF;
  -- Existence only: the seed is FALSE (the static suite pins it), and a re-run
  -- after an operator enabled the flag must not fail on that decision.
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags
                  WHERE flag = 'layover_events_post_session_pseudonymisation_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3622): layover_events_post_session_pseudonymisation_enabled was not seeded';
  END IF;
END $post$;

COMMIT;
