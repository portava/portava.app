-- 3482_discovery_cold_start_flag.sql
-- Discovery cold start (census-discovery DV-55; §85). ONE capability flag,
-- seeded OFF. ranker-hold-designs.md design 3's flag (was the unwritten 3372).
--
-- ── WHAT IT GATES ────────────────────────────────────────────────────────────
-- `discovery_cold_start_enabled`: for a viewer below the category-observation
--   floor, the PDE path reads profiles.interests / travel_style /
--   travel_styles (onboarding answers) and the place types of the viewer's
--   own trip ideas (trip_saved_places) and uses them as STATED interest tags.
--   Nothing is written back. OFF (the seed): the viewer is ranked exactly as
--   before.
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
-- Absent and FALSE read the same, so an unapplied 3482 and an applied one behave
-- alike, and with every §85 flag off `rankForViewer` is byte-identical to the
-- tree before §85 (src/test/discoveryCandidatePipelineGolden.test.ts).
--
-- Turning a flag on in production is PRODUCTION ACTIVATION, which is the owner's
-- decision (docs/architecture/discovery-decision-register.md, W10-R3 section).
--
-- Rollback: db/rollback/2026-09-28-3482-discovery-cold-start-flag-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3482): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'discovery_cold_start_enabled',
    false,
    'Discovery cold start (census-discovery DV-55, §85): ON: a viewer below the category-observation floor is ranked with their onboarding interests and trip-idea place types as stated interest tags; nothing is written back. OFF / absent / unreadable (the seed): unchanged. New ranking behaviour: turning it on is an owner decision.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag IN ('discovery_cold_start_enabled');
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3482): expected 1 flag row(s), found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags WHERE flag IN ('discovery_cold_start_enabled') AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3482): a §85 flag is ON. Each gates new ranking behaviour; turning it on is an owner decision (production activation) and this file must ship them OFF.';
  END IF;
END $post$;
