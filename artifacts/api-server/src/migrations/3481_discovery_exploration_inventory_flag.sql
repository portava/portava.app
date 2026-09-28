-- 3481_discovery_exploration_inventory_flag.sql
-- Discovery explicit exploration (census-discovery DV-53, DC-11; §85). ONE
-- capability flag, seeded OFF. It is ranker-hold-designs.md design 1's flag,
-- renumbered from the unwritten 3370 into this lane's range.
--
-- ── WHAT IT GATES ────────────────────────────────────────────────────────────
-- `discovery_exploration_inventory_enabled`: `06` §7's reserved inventory on
--   the PDE path, OUTSIDE discovery_ranking_modifiers_enabled (2289): new
--   creators, low-exposure content, emerging places and new Trails get a
--   reserved share of a 15-25% budget, round robin across the four, and a
--   member is placed only above the list's median score (relevant, not
--   random). With it on, portavaRank's random every-7th slot and the modifiers
--   governor stand down on that page. OFF (the seed): exploration is exactly
--   what it was.
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
-- Absent and FALSE read the same, so an unapplied 3481 and an applied one behave
-- alike, and with every §85 flag off `rankForViewer` is byte-identical to the
-- tree before §85 (src/test/discoveryCandidatePipelineGolden.test.ts).
--
-- Turning a flag on in production is PRODUCTION ACTIVATION, which is the owner's
-- decision (docs/architecture/discovery-decision-register.md, W10-R3 section).
--
-- Rollback: db/rollback/2026-09-28-3481-discovery-exploration-inventory-flag-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3481): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'discovery_exploration_inventory_enabled',
    false,
    'Discovery reserved exploration inventory (census-discovery DV-53, DC-11, §85): ON: new creators, low-exposure places, emerging places and new Trails get reserved slots (15-25% budget, round robin, above the median score only), replacing the random epsilon slot and the modifiers governor on that page. OFF / absent / unreadable (the seed): exploration is unchanged. New ranking behaviour: turning it on is an owner decision.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag IN ('discovery_exploration_inventory_enabled');
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3481): expected 1 flag row(s), found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags WHERE flag IN ('discovery_exploration_inventory_enabled') AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3481): a §85 flag is ON. Each gates new ranking behaviour; turning it on is an owner decision (production activation) and this file must ship them OFF.';
  END IF;
END $post$;
