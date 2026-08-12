-- 2080_retire_inert_seeded_flags.sql
--
-- Formally retire the ten feature flags surfaced by the 2026-08-12 seed-scanner
-- fix:
--
--   COMPASS_FRONTLOAD_ENABLED                  notifications_enabled
--   COMPASS_ACTIVE_REWARD_ENABLED              notification_digests_enabled
--   COMPASS_EXPLAIN_WHY_ENABLED                realtime_activity_enabled
--   COMPASS_ADMIN_CONTROLS_ENABLED             safety_notifications_enabled
--   COMPASS_ABUSE_DEFENSE_ENABLED
--   COMPASS_NOTIFICATION_INTELLIGENCE_ENABLED
--
-- WHY THEY GO RATHER THAN GET A READER
-- ====================================
--
-- The disposition rule was: keep a flag only on evidence of a LIVE READ — an
-- actual branch that consults it and changes behaviour. None of the ten has one.
--
-- For the six COMPASS_*, the near-miss is worth stating because it looks like a
-- reader and is not. compass/flags.ts loadFlags() runs
-- `.select("flag, enabled").like("flag", "COMPASS_%")` and returns every
-- matching row as a Record, so all six ARE loaded into memory on every Compass
-- request. No caller then asks isEnabled() for these six names. Every
-- isEnabled() argument in the tree is a string literal, and the only COMPASS
-- names among them are COMPASS_ENABLED, COMPASS_V1_RULE_BASED_ENABLED and
-- COMPASS_TELEGRAPH. Being loaded is not being read.
--
-- For the four notification flags the only reference in the tree was
-- routes/notifications.ts's admin flag map, where they were WRITE targets:
-- PUT /admin/notification-defaults set them and returned ok:true, and nothing
-- ever read them back. Those four fields are removed from that handler in the
-- same commit, which now rejects them with .strict() rather than accepting and
-- silently discarding them.
--
-- WHAT THIS COSTS AN OPERATOR: NOTHING THAT WORKED
-- ================================================
--
-- Four of the ten read TRUE in production while the surface each named ran
-- unconditionally. `safety_notifications_enabled` is the sharpest case: an
-- operator reading the admin list saw a control over safety-critical
-- notification delivery that did nothing in either position. Deleting it does
-- not remove a capability; it removes a claim.
--
-- push_notifications_enabled is NOT retired and is why the four notification
-- rows could go: it is read in lib/pushWithRetry.ts, lib/pushRetryQueue.ts,
-- services/notifications/NotificationRouter.ts and
-- services/passport/StampAwardEngine.ts. Push delivery keeps a real operator
-- kill switch.
--
-- WHY NOBODY CAUGHT THIS EARLIER
-- ==============================
--
-- All ten were seeded by `INSERT INTO public.feature_flags`
-- (0051_compass_foundation.sql, 0062_notifications_schema.sql). The seed scanner
-- in scripts/check-flag-polarity.mjs matched only the unqualified
-- `INSERT INTO feature_flags` until 2026-08-12, so its rule R6 — every seeded
-- flag is either read or declared inert — never saw them. A scan that misses a
-- seed does not report a gap; it reports that the population is clean.
--
-- SEEDS ARE NEUTRALISED IN THE SAME COMMIT
-- ========================================
--
-- The rows are removed from 0051_compass_foundation.sql and
-- 0062_notifications_schema.sql (and from the second-tree
-- migrations/0041_notifications.sql) so a fresh database never creates them.
-- Editing applied migrations is deliberate and is the `remove-from-seed`
-- remedy — leaving the INSERTs in place would mean a new environment re-creates
-- the exact rows this migration exists to remove. Their INERT_SEEDED_FLAGS
-- entries are removed in the same commit, as rule R7 of the polarity script
-- requires once a flag is no longer seeded.
--
-- THE ADMIN SURFACE GUARDS STAY AND MUST STAY
-- ===========================================
--
-- routes/admin.ts filters all ten from GET /admin/feature-flags and returns 400
-- not_operational from PATCH /admin/feature-flags/:flag; routes/featureFlags.ts
-- filters them from the public endpoint the mobile app fetches. Deleting the
-- rows does NOT make those guards redundant:
--   * a PATCH for a deleted flag would otherwise fall through to generic
--     not-found handling, which reads as "wrong URL" rather than "this control
--     does not exist"; and
--   * the guards keep behaviour identical on a database where this migration
--     has not been applied yet.
--
-- ON DELETE CASCADE — READ THIS BEFORE RUNNING IT ANYWHERE
-- =======================================================
--
-- 0118_feature_flag_audit_log.sql:8 declares
--     flag TEXT NOT NULL REFERENCES feature_flags(flag) ON DELETE CASCADE
-- so deleting a flag row DESTROYS its entire toggle history: who flipped it,
-- when, and in which direction. For a flag that gated nothing that history is
-- probably uninteresting, but "probably" is not a basis for silently discarding
-- an audit trail, and the cascade gives no warning.
--
-- So this migration REFUSES rather than cascading, exactly as 0209 does for the
-- freeze_* family. If any audit rows exist it raises and rolls back, and
-- whoever runs it decides deliberately whether to archive them first.
--
-- ⚠ THIS IS MORE LIKELY TO FIRE HERE THAN IT WAS FOR 0209. Four of these ten
-- were reachable from PUT /admin/notification-defaults, which wrote
-- feature_flags directly. Whether that path also wrote the audit log is not
-- assumed either way — the guard is what settles it at run time, per database.

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
     'COMPASS_FRONTLOAD_ENABLED',
     'COMPASS_ACTIVE_REWARD_ENABLED',
     'COMPASS_EXPLAIN_WHY_ENABLED',
     'COMPASS_ADMIN_CONTROLS_ENABLED',
     'COMPASS_ABUSE_DEFENSE_ENABLED',
     'COMPASS_NOTIFICATION_INTELLIGENCE_ENABLED',
     'notifications_enabled',
     'notification_digests_enabled',
     'realtime_activity_enabled',
     'safety_notifications_enabled'
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
   'COMPASS_FRONTLOAD_ENABLED',
   'COMPASS_ACTIVE_REWARD_ENABLED',
   'COMPASS_EXPLAIN_WHY_ENABLED',
   'COMPASS_ADMIN_CONTROLS_ENABLED',
   'COMPASS_ABUSE_DEFENSE_ENABLED',
   'COMPASS_NOTIFICATION_INTELLIGENCE_ENABLED',
   'notifications_enabled',
   'notification_digests_enabled',
   'realtime_activity_enabled',
   'safety_notifications_enabled'
 );

-- ── Post-condition: none may survive ────────────────────────────────────────
-- Cheap, and it turns a silently partial delete into a rollback.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM public.feature_flags
   WHERE flag IN (
     'COMPASS_FRONTLOAD_ENABLED',
     'COMPASS_ACTIVE_REWARD_ENABLED',
     'COMPASS_EXPLAIN_WHY_ENABLED',
     'COMPASS_ADMIN_CONTROLS_ENABLED',
     'COMPASS_ABUSE_DEFENSE_ENABLED',
     'COMPASS_NOTIFICATION_INTELLIGENCE_ENABLED',
     'notifications_enabled',
     'notification_digests_enabled',
     'realtime_activity_enabled',
     'safety_notifications_enabled'
   );

  IF n <> 0 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: % retired row(s) still present after DELETE.', n;
  END IF;
END $$;

-- ── Post-condition: the wired sibling must NOT have been caught ─────────────
-- push_notifications_enabled shares a prefix with two of the retired names and
-- is the one flag in this family that genuinely gates delivery. A retirement
-- that removed it would silently disable the push kill switch, so the migration
-- asserts its survival rather than trusting the IN-list to have been typed
-- correctly.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM public.feature_flags
   WHERE flag = 'push_notifications_enabled';

  IF n <> 1 THEN
    RAISE EXCEPTION
      'POST-CONDITION FAILED: push_notifications_enabled is not present exactly once '
      '(found %). It is read at four call sites and must survive this migration.', n;
  END IF;
END $$;

COMMIT;
