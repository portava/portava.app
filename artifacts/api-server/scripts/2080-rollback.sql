-- 2080-rollback.sql — restore the ten flags retired by
-- src/migrations/2080_retire_inert_seeded_flags.sql.
--
-- ⚠ THIS IS NOT A MIGRATION AND MUST NOT BE MOVED INTO src/migrations/.
-- Every `*.sql` under src/migrations/ is scanned by
-- scripts/check-flag-polarity.mjs to build the seeded-flag population. Putting
-- this file there would re-register all ten as seeded, and since none of them
-- has a reader, rule R6 would immediately fail the check — correctly. The
-- rollback path is deliberately kept outside the scanned tree.
--
-- WHAT THIS RESTORES, AND WHAT IT CANNOT
-- ======================================
--
-- The values below are production's exact state captured immediately before the
-- retirement was applied on 2026-08-12. `enabled` and `description` are
-- restored verbatim.
--
-- `updated_at` is NOT restored — it defaults to the time of the re-insert. The
-- original timestamps were 2026-07-17 07:13:54.88573+00 for the six COMPASS_*
-- and 2026-06-28 10:54:37.333397+00 for the four notification flags, and are
-- recorded here rather than written, because a restored row genuinely IS newly
-- written and backdating it would misrepresent that.
--
-- Restoring these rows does NOT restore them to the admin or client surfaces:
-- routes/admin.ts HIDDEN_INERT_FLAGS and routes/featureFlags.ts INERT_FLAGS
-- still filter all ten, by design, so that the guards hold on databases where
-- the migration has not been applied. A rollback that needs the flags visible
-- again must revert those two lists as well.
--
-- Restoring is only correct if the wire-or-drop finding was wrong — that is, if
-- one of the ten turns out to have a live reader after all. In that case fix the
-- reader question first; a restored row with still no reader is the original
-- defect back again.

BEGIN;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('COMPASS_ABUSE_DEFENSE_ENABLED', TRUE, 'Activate rate-limiting and abuse-pattern detection in Compass'),
  ('COMPASS_ACTIVE_REWARD_ENABLED', FALSE, 'Boost active-user scores in Compass ranking'),
  ('COMPASS_ADMIN_CONTROLS_ENABLED', TRUE, 'Enable admin cockpit and testing sandbox'),
  ('COMPASS_EXPLAIN_WHY_ENABLED', TRUE, 'Surface explanation cards alongside Compass results'),
  ('COMPASS_FRONTLOAD_ENABLED', TRUE, 'Pre-compute Compass profiles for active users on a background schedule'),
  ('COMPASS_NOTIFICATION_INTELLIGENCE_ENABLED', TRUE, 'Personalise push-notification timing via Compass signals'),
  ('notification_digests_enabled', TRUE, 'Enable daily notification digest batching'),
  ('notifications_enabled', TRUE, 'Master switch for the in-app notification system'),
  ('realtime_activity_enabled', TRUE, 'Enable SSE realtime activity stream'),
  ('safety_notifications_enabled', TRUE, 'Enable safety-critical notification delivery')
ON CONFLICT (flag) DO UPDATE
  SET enabled = EXCLUDED.enabled,
      description = EXCLUDED.description;

COMMIT;
