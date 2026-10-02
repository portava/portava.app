-- 3483_discovery_pipeline_stages_flags.sql
-- Discovery pipeline stages and output kinds (census-discovery DC-11, DC-01;
-- §85). THREE capability flags, seeded OFF.
--
-- ── WHAT THEY GATE ───────────────────────────────────────────────────────────
-- `discovery_integrity_stage_enabled`: `06` §1 stage 7 on the PDE path — calls
--   DV-12's engagement-integrity detector (lane W10-R2) when one is registered;
--   `withhold` removes a row from the page, `discount` sinks it. With no
--   detector registered it records detector_absent and changes nothing.
-- `discovery_outcome_learning_enabled`: `06` §1 stage 10 — a per-item outcome
--   rate over 30 days of served Discovery rows, smoothed toward the read's own
--   rate, nudges the served order by at most 3 positions, only for items with
--   20+ served rows.
-- `discovery_output_kinds_enabled`: `01` §4 — Trails, Shared Moments (only
--   the viewer's accepted memberships, under the Shared Moments capability
--   flag as well) and emerging discoveries ranked by rankForViewer. No route
--   serves them yet.
--   OFF (the seed): none of the three runs.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; census-discovery
-- §85, lane W10-R3, range 3480-3484). APPLIED TO NO DATABASE by the lane that
-- wrote it other than the local PostgreSQL 16 harness.
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr).
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- Additive + idempotent. Safe to re-run. `*_enabled` => CAPABILITY convention:
-- read fail-closed (lib/discoveryCandidates/pipelineFlags.ts reads every §85 flag in one
-- `in(flag, ...)` query; an error, an absent row or a row not naming the flag is
-- OFF). Seeded FALSE; the postcondition refuses a seed that finds any of them ON.
-- Absent and FALSE read the same, so an unapplied 3483 and an applied one behave
-- alike, and with every §85 flag off `rankForViewer` is byte-identical to the
-- tree before §85 (src/test/discoveryCandidatePipelineGolden.test.ts).
--
-- Turning a flag on in production is PRODUCTION ACTIVATION, which is the owner's
-- decision (docs/architecture/discovery-decision-register.md, W10-R3 section).
--
-- Rollback: db/rollback/2026-09-28-3483-discovery-pipeline-stages-flags-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3483): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'discovery_integrity_stage_enabled',
    false,
    'Discovery integrity-checks stage (census-discovery DC-11, DV-12, §85): ON: DV-12''s registered detector may withhold or discount rows on the PDE page; with none registered, detector_absent and no change. OFF / absent / unreadable (the seed): no stage. Turning it on is an owner decision.'
  ),
  (
    'discovery_outcome_learning_enabled',
    false,
    'Discovery learn-from-outcomes stage (census-discovery DC-11, §85): ON: a smoothed per-item outcome rate over 30 days nudges the PDE order by at most 3 positions, for items with 20+ served rows. OFF / absent / unreadable (the seed): no stage. New ranking behaviour: turning it on is an owner decision.'
  ),
  (
    'discovery_output_kinds_enabled',
    false,
    'Discovery output kinds (census-discovery DC-01, §85): ON: Trails, Shared Moments (accepted memberships only) and emerging discoveries are ranked by PDE through lib/discoveryCandidates/outputKinds.ts. OFF / absent / unreadable (the seed): nothing is ranked. Turning it on is an owner decision.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag IN ('discovery_integrity_stage_enabled', 'discovery_outcome_learning_enabled', 'discovery_output_kinds_enabled');
  IF present <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3483): expected 3 flag row(s), found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags WHERE flag IN ('discovery_integrity_stage_enabled', 'discovery_outcome_learning_enabled', 'discovery_output_kinds_enabled') AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3483): a §85 flag is ON. Each gates new ranking behaviour; turning it on is an owner decision (production activation) and this file must ship them OFF.';
  END IF;
END $post$;
