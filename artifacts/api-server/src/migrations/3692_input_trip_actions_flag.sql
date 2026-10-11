-- 3692 — Input Intelligence §21 Trip actions (census-input-intelligence G135), seeded OFF.
--
-- ── input_trip_actions_enabled ────────────────────────────────────────────────
-- When ON, the search field recognises four Trip commands typed as the WHOLE
-- query and offers them as propose-only action rows
-- (lib/inputAssistance/tripActions.ts):
--   "invite @maya to my trip"  → trip_action / invite_crew (the person resolved by
--                                the @mention people gate, exact handle only)
--   "reorder my trip"          → trip_action / reorder_plan
--   "add a stop in Hue"        → add_to_trip (a Trip's stops are its destinations)
--   "add Hue to my trip"       → add_to_trip (already produced, unchanged)
-- A row never names a Trip and never writes: the person picks one of their own
-- open Trips, and the invitation is POST /trips/:tripId/invite (owner-only,
-- block guard, Trust restriction gate); reorder opens the Trip's edit screen.
-- OFF / absent (the seed): none of these rows is produced.
--
-- Additive only: one row in feature_flags. Rollback:
-- db/rollback/2026-10-10-3692-input-trip-actions-flag-rollback.sql.
--
-- NOT APPLIED BY ITS AUTHOR. Application follows the repository's reviewed
-- PR/CI path; see docs/migrations.md.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3692): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'input_trip_actions_enabled',
    false,
    'Input Intelligence §21 Trip actions (census G135): the search field offers invite Crew / reorder plan / add stop for those exact typed commands, propose-only — the person picks their own Trip and the existing Trip endpoints do the write. OFF / absent (the seed): none is offered.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'input_trip_actions_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3692): input_trip_actions_enabled absent.';
  END IF;
END $post$;
