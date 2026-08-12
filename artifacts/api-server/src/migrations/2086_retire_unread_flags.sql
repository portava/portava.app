-- 2086_retire_unread_flags.sql
--
-- OUTCOMES: DROP and REMOVE-FROM-SEED. Thirty-three flags that NO CODE READS,
-- following the rule and the shape of 2080_retire_inert_seeded_flags.sql.
--
-- Three populations are retired in one statement because the DELETE is identical
-- for all three; what differs is what happens to their SEEDS, and that is done in
-- the same commit outside this file:
--
--   21  DROP  live in production, no migration seeds them, no reader anywhere.
--             Delete the row. There is no seed to neutralise.
--
--    8  DROP  seeded by 0037, ABSENT from production, no reader anywhere.
--             The seed is removed from 0037. Against production this DELETE
--             matches ZERO rows — they are not there, which is how they were
--             found — but any database built by replaying the migrations DOES
--             have them, and a retirement that skipped them would leave every
--             restored database carrying flags this commit declares dead.
--
--    4  REMOVE-FROM-SEED  seeded by 0090/2068 AND live in production, no reader.
--             Both halves are required: delete the row here, and remove the seed
--             so the seed path never auto-creates it again. Deleting without
--             neutralising would have the next restore re-create exactly what
--             this migration removed.
--
-- Full per-flag evidence, with a reader column and a file:line for every KEEP,
-- is in docs/ops/flag-disposition.md.
--
-- WHAT THIS COSTS AN OPERATOR: NOTHING THAT WORKED
-- ================================================
--
-- Nine of the twenty-five production rows read TRUE: five rent_buddy_* and four
-- trust_* capability names. An operator reading the admin list today sees trust
-- caps, trust restrictions, public trust levels, a trust admin dashboard, a
-- marketplace, tips, requests, available-now and packages-v2 all switched ON.
-- Nothing consults any of them in either position. Deleting these rows does not
-- remove a capability; it removes a claim. That is the argument 2080 made for
-- safety_notifications_enabled, unchanged.
--
-- rent_buddy_packages_v2_enabled is the sharpest: the UPPERCASE
-- RENT_BUDDY_PACKAGES_ENABLED IS read (routes/rentABuddyRollout.ts:258, gating a
-- 403) and survives. A v1/v2 split where only v1 was ever wired, and the unwired
-- half is the one reading true.
--
-- THE TWO location_* FAMILIES, RESOLVED IN ONE PLACE
-- ==================================================
--
-- Production holds location_intelligence_phase1..6 — unseeded, all false, no
-- reader. The migrations seed location_phase1_gps..location_phase6_crew — absent
-- from production, no reader. Two six-flag families describing ONE rollout under
-- two naming schemes, one on each side of the drift, neither read by anything.
-- Both are retired here. Reconciling the populations separately would have
-- invited "codify one to match the other", creating six live rows for a rollout
-- that exists in no code.
--
-- SCOPE GUARD
-- ===========
--
-- This migration deletes flag rows. It does NOT touch the readers, admin
-- surfaces or helper maps that mention the retired names. Where dropping a flag
-- leaves adjacent dead code, that is RECORDED in docs/ops/flag-disposition.md
-- under "Adjacent dead code" and deliberately NOT fixed here — the approved unit
-- is the classification, not the cleanup it makes visible.
--
-- ON DELETE CASCADE — READ THIS BEFORE RUNNING IT ANYWHERE
-- =======================================================
--
-- 0118_feature_flag_audit_log.sql:8 declares
--     flag TEXT NOT NULL REFERENCES feature_flags(flag) ON DELETE CASCADE
-- so deleting a flag row DESTROYS its toggle history: who flipped it, when, and
-- in which direction. For a flag that gated nothing that history is probably
-- uninteresting, but "probably" is not a basis for silently discarding an audit
-- trail, and the cascade gives no warning.
--
-- This migration REFUSES rather than cascading, exactly as 2080 and 0209 do. If
-- any audit rows exist it raises and rolls back, and whoever runs it decides
-- deliberately whether to archive them first.
--
-- ⚠ NINE OF THESE READ TRUE, so somebody turned them on at some point. If
-- feature_flag_audit_log was populated then, this guard WILL fire. That is the
-- guard working, not an obstacle to route around.

BEGIN;

-- ── Fail closed on audit history ────────────────────────────────────────────
DO $$
DECLARE
  n integer;
  names text;
BEGIN
  SELECT count(*), coalesce(string_agg(DISTINCT flag, ', '), '')
    INTO n, names
    FROM public.feature_flag_audit_log
   WHERE flag IN (
     'ACTIVITY_SCORE_DECAY_ENABLED',
     'ACTIVITY_SCORE_MAX_BOOST',
     'ACTIVITY_SCORE_VERSION',
     'ANTI_GAMING_RANKING_ENABLED',
     'COMPASS_V2_AB_ENABLED',
     'live_places_world_feed_enabled',
     'location_intelligence_phase1',
     'location_intelligence_phase2',
     'location_intelligence_phase3',
     'location_intelligence_phase4',
     'location_intelligence_phase5',
     'location_intelligence_phase6',
     'location_phase1_gps',
     'location_phase2_zones',
     'location_phase3_geofence',
     'location_phase4_discovery',
     'location_phase5_pulse',
     'location_phase6_crew',
     'notifications_digest_enabled',
     'place_chat_enabled',
     'rent_buddy_available_now_enabled',
     'RENT_BUDDY_CASH_BALANCE_ENABLED',
     'RENT_BUDDY_DELAYED_POSTING_REQUIRED',
     'rent_buddy_earnings_ledger_enabled',
     'rent_buddy_marketplace_enabled',
     'rent_buddy_packages_v2_enabled',
     'rent_buddy_requests_enabled',
     'rent_buddy_tips_enabled',
     'telegraph_suggestions_enabled',
     'trust_admin_dashboard_enabled',
     'trust_caps_enabled',
     'trust_public_levels_enabled',
     'trust_restrictions_enabled'
   );

  IF n > 0 THEN
    RAISE EXCEPTION
      'REFUSING: % feature_flag_audit_log row(s) reference the flags being retired (%). '
      'ON DELETE CASCADE would destroy that toggle history without warning. '
      'Archive those rows first, then re-run. This is a deliberate decision, '
      'not an error to work around.', n, names;
  END IF;
END $$;

-- ── The retirement itself ───────────────────────────────────────────────────
DELETE FROM public.feature_flags
 WHERE flag IN (
     'ACTIVITY_SCORE_DECAY_ENABLED',
     'ACTIVITY_SCORE_MAX_BOOST',
     'ACTIVITY_SCORE_VERSION',
     'ANTI_GAMING_RANKING_ENABLED',
     'COMPASS_V2_AB_ENABLED',
     'live_places_world_feed_enabled',
     'location_intelligence_phase1',
     'location_intelligence_phase2',
     'location_intelligence_phase3',
     'location_intelligence_phase4',
     'location_intelligence_phase5',
     'location_intelligence_phase6',
     'location_phase1_gps',
     'location_phase2_zones',
     'location_phase3_geofence',
     'location_phase4_discovery',
     'location_phase5_pulse',
     'location_phase6_crew',
     'notifications_digest_enabled',
     'place_chat_enabled',
     'rent_buddy_available_now_enabled',
     'RENT_BUDDY_CASH_BALANCE_ENABLED',
     'RENT_BUDDY_DELAYED_POSTING_REQUIRED',
     'rent_buddy_earnings_ledger_enabled',
     'rent_buddy_marketplace_enabled',
     'rent_buddy_packages_v2_enabled',
     'rent_buddy_requests_enabled',
     'rent_buddy_tips_enabled',
     'telegraph_suggestions_enabled',
     'trust_admin_dashboard_enabled',
     'trust_caps_enabled',
     'trust_public_levels_enabled',
     'trust_restrictions_enabled'
 );

-- ── Post-condition: none may survive ────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM public.feature_flags
   WHERE flag IN (
     'ACTIVITY_SCORE_DECAY_ENABLED',
     'ACTIVITY_SCORE_MAX_BOOST',
     'ACTIVITY_SCORE_VERSION',
     'ANTI_GAMING_RANKING_ENABLED',
     'COMPASS_V2_AB_ENABLED',
     'live_places_world_feed_enabled',
     'location_intelligence_phase1',
     'location_intelligence_phase2',
     'location_intelligence_phase3',
     'location_intelligence_phase4',
     'location_intelligence_phase5',
     'location_intelligence_phase6',
     'location_phase1_gps',
     'location_phase2_zones',
     'location_phase3_geofence',
     'location_phase4_discovery',
     'location_phase5_pulse',
     'location_phase6_crew',
     'notifications_digest_enabled',
     'place_chat_enabled',
     'rent_buddy_available_now_enabled',
     'RENT_BUDDY_CASH_BALANCE_ENABLED',
     'RENT_BUDDY_DELAYED_POSTING_REQUIRED',
     'rent_buddy_earnings_ledger_enabled',
     'rent_buddy_marketplace_enabled',
     'rent_buddy_packages_v2_enabled',
     'rent_buddy_requests_enabled',
     'rent_buddy_tips_enabled',
     'telegraph_suggestions_enabled',
     'trust_admin_dashboard_enabled',
     'trust_caps_enabled',
     'trust_public_levels_enabled',
     'trust_restrictions_enabled'
   );

  IF n <> 0 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: % retired row(s) still present after DELETE.', n;
  END IF;
END $$;

-- ── Post-condition: the wired siblings must NOT have been caught ────────────
-- Three names in this file are one token away from a flag that IS read and whose
-- loss would be silent. Asserting their survival is cheaper than trusting a
-- 33-name IN-list to have been typed correctly.
--
--   RENT_BUDDY_PACKAGES_ENABLED  vs the retired rent_buddy_packages_v2_enabled
--   shared_moments_chat_enabled  vs the retired place_chat_enabled
--   push_notifications_enabled   — the survivor 2080 asserted for the same reason
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(f, ', ')
    INTO missing
    FROM unnest(ARRAY[
      'RENT_BUDDY_PACKAGES_ENABLED',
      'shared_moments_chat_enabled',
      'push_notifications_enabled'
    ]) AS f
   WHERE NOT EXISTS (
     SELECT 1 FROM public.feature_flags ff WHERE ff.flag = f
   );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'POST-CONDITION FAILED: wired flag(s) missing after retirement: %. '
      'These are read by shipping code and must survive this migration.', missing;
  END IF;
END $$;

COMMIT;
