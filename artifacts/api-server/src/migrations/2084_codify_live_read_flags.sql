-- 2084_codify_live_read_flags.sql
--
-- OUTCOME: KEEP — codify. Nine flags that EXIST IN PRODUCTION, ARE READ BY
-- SHIPPING CODE, AND NO MIGRATION CREATES.
--
-- These are the KEEP half of the "live but never seeded" population in
-- docs/ops/flag-disposition.md. Each entered production by an admin toggle, a
-- console insert or a script; the repository has no record it exists. The defect
-- is not that the flag is wrong — it gates a real branch — but that a restored
-- or newly provisioned environment gets NO ROW, and every one of these is read
-- through a fail-closed helper. A missing row reads `false` and the feature is
-- silently off. MEDIA_HIDDEN_GEMS_CREATE_ENABLED is the precedent: a missing row
-- made a working entry point permanently invisible and was mistaken for a
-- deliberate design choice.
--
-- WHY `ON CONFLICT DO NOTHING` AND NOT `DO UPDATE`
-- ===============================================
--
-- Against production every one of these rows already exists, so this migration
-- MUST be a no-op there — it reconciles the REPOSITORY to production, not
-- production to the repository. `DO UPDATE` would let a value written here
-- overwrite an operator's live toggle: a production write dressed as a
-- definition. `DO NOTHING` makes the statement meaningful only where the row is
-- absent, which is the entire point.
--
-- WHY THE SEEDED VALUES ARE THE LIVE VALUES
-- =========================================
--
-- Each `enabled` below is the value production held on 2026-08-12 (re-verified
-- byte-identical immediately before this migration was written), so a restored
-- environment reproduces production rather than a notional default.
--
-- Two read `true` — MEDIA_HIDDEN_GEMS_CREATE_ENABLED and
-- passport_contribution_events_enabled — and seeding them `true` is deliberate:
-- seeding them `false` would ship a fresh environment with a working surface
-- switched off, which is the exact failure this migration exists to end.
--
-- NOTE ON MEDIA_HIDDEN_GEMS_CREATE_ENABLED
-- ========================================
--
-- Its only reader is in the MOBILE APP tree
-- (src/components/media/MediaQuickCreateSheet.tsx:128), which
-- scripts/check-flag-polarity.mjs does not walk. Codifying it makes it SEEDED,
-- so rule R6 now asks whether it is read — and cannot see that it is. An
-- APP_TREE_READS entry is added in the same commit recording the app file:line;
-- rule R8 opens that file and fails if the flag literal is not in it, so the
-- declaration is verified rather than asserted.
--
-- SCOPE: this migration creates rows. It changes no reader, removes no code and
-- touches no flag outside the nine named below.

BEGIN;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('ACTIVITY_DISCOVERY_BOOST_ENABLED', false, 'Master switch: apply creator activity score boost to discovery rankings'),
  ('CREATOR_FATIGUE_ENABLED', false, 'Apply per-viewer/creator fatigue penalty to limit creator frequency'),
  ('DISCOVERY_DIVERSITY_ENABLED', false, 'Enforce creator-diversity and topic-diversity caps across the ranked feed'),
  ('MEDIA_HIDDEN_GEMS_CREATE_ENABLED', true, 'Show the Add a Gem entry in the Media tab quick-create sheet when in Gems mode.'),
  ('NEW_CONTRIBUTOR_BOOST_ENABLED', false, 'Boost content from new creators who have not yet built an audience'),
  ('passport_contribution_events_enabled', true, 'Enable recording of contribution events'),
  ('RANKING_EXPERIMENT_ENABLED', false, 'Enable A/B experiment layer for ranking algorithm variants'),
  ('RETURNING_USER_BOOST_ENABLED', false, 'Boost feed diversity for viewers returning after a long absence'),
  ('UNDEREXPOSED_CONTENT_BOOST_ENABLED', false, 'Allocate feed slots to content that has not reached fair exposure yet')
ON CONFLICT (flag) DO NOTHING;

-- ── Post-condition: all nine present ────────────────────────────────────────
-- Cheap, and it turns a silently partial insert into a rollback.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM public.feature_flags
   WHERE flag IN (
     'ACTIVITY_DISCOVERY_BOOST_ENABLED',
     'CREATOR_FATIGUE_ENABLED',
     'DISCOVERY_DIVERSITY_ENABLED',
     'MEDIA_HIDDEN_GEMS_CREATE_ENABLED',
     'NEW_CONTRIBUTOR_BOOST_ENABLED',
     'passport_contribution_events_enabled',
     'RANKING_EXPERIMENT_ENABLED',
     'RETURNING_USER_BOOST_ENABLED',
     'UNDEREXPOSED_CONTENT_BOOST_ENABLED'
   );

  IF n <> 9 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: expected 9 codified flags present, found %.', n;
  END IF;
END $$;

-- ── Post-condition: the two live-TRUE flags were not flattened ──────────────
-- If this migration ever ran against a database where these rows were absent,
-- it created them; the value it created them with is the thing worth asserting,
-- because seeding a working surface `false` is the failure mode being fixed.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(flag, ', ') INTO bad
    FROM public.feature_flags
   WHERE flag IN ('MEDIA_HIDDEN_GEMS_CREATE_ENABLED', 'passport_contribution_events_enabled')
     AND enabled IS DISTINCT FROM true;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'POST-CONDITION FAILED: % should read true (production value 2026-08-12) but does not. '
      'If an operator deliberately turned it off, remove it from this assertion; do not flip the row.', bad;
  END IF;
END $$;

COMMIT;
