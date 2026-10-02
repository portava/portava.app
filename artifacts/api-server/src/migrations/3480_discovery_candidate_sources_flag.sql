-- 3480_discovery_candidate_sources_flag.sql
-- Discovery candidate generation (census-discovery DC-12, DV-49; §85). TWO
-- capability flags, seeded OFF.
--
-- ── WHAT THEY GATE ───────────────────────────────────────────────────────────
-- `discovery_candidate_sources_enabled`: on the PDE serve path (served:true),
--   lib/discoveryCandidates runs `06` §2's per-viewer retrievals — followed
--   creators, current Trail, related Trails, trip destination, saved-similar,
--   trending local, emerging discoveries, the exploration pool — and DV-49's
--   graph retrieval, materialises the rows they name under the route's own
--   eligibility (status, city, demo sources, blocked and inactive submitters),
--   and adds them to the candidate set the ranker orders. Every row records
--   which sources named it (rank_events.features.candidateSources).
-- `discovery_circle_candidates_enabled`: `06` §2 "social/circle context" —
--   places at least two of the viewer's circle mates PUBLICLY experienced.
--   Whether one member's public activity may generate another member's
--   candidates is a CONSENT question the lane may not decide: register entry
--   D-W10-R3-4 is APPROVAL REQUIRED. It needs 3480's first flag on as well.
--   OFF / absent / unreadable (the seed): no retrieval runs, nothing is added,
--   and every served order and row is what it was before this file.
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
-- Absent and FALSE read the same, so an unapplied 3480 and an applied one behave
-- alike, and with every §85 flag off `rankForViewer` is byte-identical to the
-- tree before §85 (src/test/discoveryCandidatePipelineGolden.test.ts).
--
-- Turning a flag on in production is PRODUCTION ACTIVATION, which is the owner's
-- decision (docs/architecture/discovery-decision-register.md, W10-R3 section).
--
-- Rollback: db/rollback/2026-09-28-3480-discovery-candidate-sources-flag-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3480): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'discovery_candidate_sources_enabled',
    false,
    'Discovery candidate generation (census-discovery DC-12, DV-49, §85): ON: the PDE serve path adds rows named by 06 §2''s per-viewer retrievals and the graph, under the route''s own eligibility, and records each row''s sources. OFF / absent / unreadable (the seed): the candidate set is the route''s two reads, unchanged. New ranking behaviour: turning it on is an owner decision.'
  ),
  (
    'discovery_circle_candidates_enabled',
    false,
    'Discovery circle-context candidates (census-discovery DC-12, §85): ON (with discovery_candidate_sources_enabled): places at least two of the viewer''s circle mates publicly experienced become candidates, never naming anyone. A consent question: register D-W10-R3-4 is APPROVAL REQUIRED. OFF (the seed): no circle read.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags WHERE flag IN ('discovery_candidate_sources_enabled', 'discovery_circle_candidates_enabled');
  IF present <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3480): expected 2 flag row(s), found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags WHERE flag IN ('discovery_candidate_sources_enabled', 'discovery_circle_candidates_enabled') AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3480): a §85 flag is ON. Each gates new ranking behaviour; turning it on is an owner decision (production activation) and this file must ship them OFF.';
  END IF;
END $post$;
