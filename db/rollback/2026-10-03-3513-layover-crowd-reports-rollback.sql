-- Rollback for 3513_layover_crowd_reports_flag.sql
--
-- Removes the `layover_crowd_reports_enabled` row.
--
-- ⚠ READ THE REFUSAL CONDITION BEFORE COPYING THIS FILE. It looks like
-- db/rollback/2026-09-12-2851-layover-live-intersection-flag-rollback.sql and it
-- means something different, because 3513's seed is TRUE and 2851's is FALSE.
--
-- ── WHY DELETING THIS ROW IS NOT A RETURN TO THE STATE BEFORE 3513 ───────────
-- For every FALSE-seeded flag rollback in this directory, deleting the row is a
-- no-op: `isFlagEnabled` reads an absent row and a FALSE row identically, and
-- the seed was FALSE, so the surface was refused before the migration and after
-- the rollback.
--
-- 3513 seeds TRUE, because the traveller crowd-report channel
-- (GET/POST /api/airport/sessions/:id/observations) was ALREADY LIVE under
-- `airport_mode_enabled` when the flag was introduced. So here the arithmetic
-- inverts: deleting the row makes the fail-closed reader answer FALSE, and both
-- observation handlers begin refusing with `degraded_unavailable`. Deleting the
-- row does not restore the pre-3513 state — it CLOSES a channel that was open
-- before 3513 existed.
--
-- ── THE REFUSAL CONDITION CHOSEN, AND WHY ────────────────────────────────────
-- The sibling refuses while the flag reads TRUE, on the reasoning that a TRUE
-- row is an owner's decision that a silent DELETE would undo. Copied here
-- verbatim that sentence is wrong twice over:
--
--   • TRUE is this flag's SEED, not an owner's decision, so the sibling's
--     justification does not transfer; and
--   • if the refusal stopped there it would still be the right GUARD for the
--     wrong reason, which is how a guard rots.
--
-- The condition kept is: REFUSE WHILE THE FLAG READS TRUE — but for the
-- opposite reason. A TRUE row is the channel SERVING. Deleting it is not a
-- cleanup, it is an outage: travellers mid-connection stop being able to report
-- or read a queue time, with no audit row naming who did it and no flag left to
-- explain why. That is the single worst outcome available here, and it is the
-- one a careless `psql -f` would produce.
--
-- AND THIS REFUSAL CAN FIRE, which is the other half of the choice. A rollback
-- whose precondition can never be satisfied is worthless, and one keyed on the
-- seeded value alone would be exactly that. It is satisfied by the ordinary
-- path: turn the channel OFF first through
-- `PATCH /api/admin/feature-flags/layover_crowd_reports_enabled` (the audited
-- toggle, via `toggle_feature_flag_with_audit`), observe that the refusal is
-- the intended one, THEN run this file. In that order the DELETE is a genuine
-- no-op — the reader already answered FALSE through the row, and now answers
-- FALSE through its absence — and the closure that actually changed traveller
-- behaviour is the toggle, which left an audit row behind it.
--
-- So the two states this file distinguishes are:
--   enabled IS TRUE  → the channel is serving. REFUSED. Toggle it off first.
--   enabled IS FALSE → somebody already closed it, with an audit row. Deleting
--                      is observably nothing, and is allowed.
--
-- ── WHAT THIS FILE CANNOT DO ─────────────────────────────────────────────────
-- It cannot revert the route changes that read the flag. With the row gone, the
-- handlers in `routes/airport.ts` still read `LAYOVER_CROWD_REPORTS_FLAG` and
-- still refuse. A FULL revert of 3513's change is this file PLUS removing the
-- two gate checks from `routes/airport.ts` and
-- `LAYOVER_CROWD_REPORTS_FLAG` from
-- `services/layover/LayoverObservationService.ts`. Running this file alone and
-- calling the feature restored would be false.
--
-- It also cannot un-store an observation written while the flag was on; the
-- rows in `airport_fact_observations` are unaffected, as they must be.
--
-- Idempotent: re-running after the row is gone is a no-op.

DO $pre$
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag = 'layover_crowd_reports_enabled' AND enabled IS TRUE;
  IF FOUND THEN
    RAISE EXCEPTION '3513 rollback: layover_crowd_reports_enabled reads TRUE — the traveller crowd-report channel is SERVING. Deleting the row here would close it for every traveller with no audit row and no flag left to explain why. Turn it off first through PATCH /api/admin/feature-flags/layover_crowd_reports_enabled (audited), confirm the refusal is the intended one, then re-run this file — at which point the DELETE changes nothing observable.';
  END IF;
END
$pre$;

DELETE FROM public.feature_flags WHERE flag = 'layover_crowd_reports_enabled' AND enabled IS NOT TRUE;

DO $post$
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag = 'layover_crowd_reports_enabled';
  IF FOUND THEN
    RAISE EXCEPTION '3513 rollback: layover_crowd_reports_enabled survived';
  END IF;
END
$post$;
