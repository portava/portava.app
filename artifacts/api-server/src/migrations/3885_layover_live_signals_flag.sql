-- 3885_layover_live_signals_flag.sql
--
-- Layover §10 / §6.2 / Appendix A — the LIVE-SIGNAL PRODUCER (census-layover L54, L55, L81, L180, L227, L228, L281,
-- L285, L286, L287), under the owner's decision of 2026-10-18: "Use a combination of: Official airport information;
-- Licensed or approved live feeds; Verified traveler observations; Confidence calculations; Data provenance; Freshness
-- checks; Conflict resolution; Trust weighting; Outlier detection. Traveler reports are supporting evidence, not
-- authoritative proof of safety. Unknown or conflicting critical safety information must fail closed."
--
-- APPLIED TO NO DATABASE by the lane that wrote it (layover-165 lane B2-LIVE, 2026-10-18).
--
-- ── WHAT THIS FILE IS ──────────────────────────────────────────────────────
-- ONE feature-flag row, `layover_live_signals_enabled`, seeded FALSE. Nothing else: no table, no column, no index, no
-- function, no privilege. The producer reads `airport_fact_observations` (2860 + 2982, both applied in production)
-- through its existing lookup index `airport_fact_obs_lookup_idx (airport_ref, fact_type, observed_at DESC)`, so no
-- schema is needed. Its reader is services/airport/layoverLiveSignals.ts (`liveSignalsEnabled`, the fail-closed
-- `isFlagEnabled`), called by services/airport/LayoverSnapshot.ts — the door every certified layover record comes
-- through (the snapshot's one certification, and `consumerLayoverRecord` for every legacy consumer):
--   OFF / absent / unreadable (the seed): no live conditions are resolved, nothing extra is read, and every layover
--     record certifies exactly as before — `liveConditions: null`.
--   ON: validated stored observations (official, feed and corroborated traveller readings), the licensed feed when one
--     is configured (LAYOVER_LIVE_FEED_URL + LAYOVER_LIVE_FEED_API_KEY; none is today), and the routed return traffic
--     for a planned landside stop become §10 live conditions on the certified record. They can only make an answer
--     MORE conservative: a larger buffer, an earlier return deadline, a smaller envelope, a lower confidence. A session
--     at an airport with nothing live certifies byte-for-byte as with the flag OFF.
--
-- ── ORDER INDEPENDENCE (a gap number: applied at 3885 on a fresh replay, after 3999 on portava-ci and production) ──
-- It depends only on public.feature_flags (0118 and earlier; columns flag, enabled, description), which every file
-- above 3885 leaves in place: no file numbered above 3885 alters, drops or truncates feature_flags (3932 deletes one
-- other, named rent-buddy flag; 3997 and 3999 name DELETEs only inside their rollback comments), and none names
-- `layover_live_signals_enabled` (grep, 2026-10-18). A plain INSERT writes no feature_flag_audit_log row (only
-- toggle_feature_flag_with_audit does), so applying it leaves no history behind.
--
-- Rollback: db/rollback/2026-10-18-3885-layover-live-signals-flag-rollback.sql (refuses while the flag is TRUE or while
-- feature_flag_audit_log holds a row for it — 0118's ON DELETE CASCADE would erase that history).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION '3885: public.feature_flags does not exist';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'feature_flags' AND column_name IN ('flag', 'enabled', 'description')) <> 3 THEN
    RAISE EXCEPTION '3885: public.feature_flags lacks one of flag / enabled / description';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_live_signals_enabled' AND enabled IS NOT FALSE) THEN
    RAISE EXCEPTION '3885: layover_live_signals_enabled already exists and is not FALSE; this file seeds it OFF and will not overwrite an operator''s setting';
  END IF;
END
$pre$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_live_signals_enabled',
    false,
    'Layover live airport intelligence (spec §10/§6.2/App A; census-layover L54 L55 L81 L180 L227 L228 L281 L285 L286 L287; owner decision 2026-10-18). ON: every certified layover record (the snapshot door and consumerLayoverRecord) folds §10 live conditions produced by services/airport/layoverLiveSignals.ts from VALIDATED airport_fact_observations (official/feed readings and corroborated traveller reports: trust floor, one reading per reporter, MAD outliers, two independent reporters), the licensed feed when configured (LAYOVER_LIVE_FEED_URL/LAYOVER_LIVE_FEED_API_KEY), and routed return traffic for a planned landside stop. Live terms only ever ADD to the buffer (earlier deadline, smaller envelope, lower confidence) and emit SECURITY_WAIT_HIGH / DATA_STALE / SOURCE_CONFLICT / TRAFFIC_DEGRADED. Traveller evidence is never above LOW confidence and never shortens a wait. OFF / absent / unreadable (the seed): no live conditions; records certify exactly as before.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'layover_live_signals_enabled';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3885): layover_live_signals_enabled is not present';
  END IF;
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'layover_live_signals_enabled' AND enabled IS NOT FALSE;
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3885): layover_live_signals_enabled is ON; it must ship OFF';
  END IF;
END
$post$;
