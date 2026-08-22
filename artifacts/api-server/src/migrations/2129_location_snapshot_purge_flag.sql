-- 2129_location_snapshot_purge_flag.sql
--
-- Seeds the flag that gates the location_snapshots purge, DISABLED.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHY THIS FLAG EXISTS ────────────────────────────────────────────────────
-- public.location_snapshots takes raw lat/lng on every location update and
-- geofence check-in, with expires_at defaulting to now() + 24 hours. The
-- anti-spoof read path filters `.gt("expires_at", now)`, so the feature behaves
-- as though the rows expire — but nothing ever deleted them:
-- purgeExpiredSnapshots() had exactly one reference in the repository, its own
-- definition, and no cleanup job called it. The result was a permanent,
-- per-user, timestamped precise-coordinate trail, invisible to the code that
-- created it and absent from the account-deletion cascade.
--
-- src/lib/locationSnapshotPurgeScheduler.ts now calls it hourly. Because DELETE
-- is irreversible, the scheduler is gated behind this flag and fails closed —
-- an absent row, an unreadable table or any error means the purge does not run.
-- That mirrors 2073_account_deletion_worker_flag.sql, which gates the other
-- irreversible worker in this codebase the same way.
--
-- ── WHY ENABLING IS SAFE, AND WHY IT IS STILL THE OWNER'S CALL ──────────────
-- public.location_snapshots has three touch points, all in
-- services/location/LocationSafetyService.ts: a SELECT that already excludes
-- expired rows, an INSERT, and the purge. The only reader filters on
-- expires_at, so deleting expired rows cannot change any result — the purge
-- removes data already unreachable by every read path.
--
-- It is nonetheless seeded FALSE. The first enable deletes whatever backlog has
-- accumulated since the table was created, which may be large and is not
-- recoverable. Enable it deliberately, ideally after checking the backlog:
--
--   SELECT count(*) AS expired_rows,
--          min(expires_at) AS oldest_expiry
--     FROM public.location_snapshots
--    WHERE expires_at < now();
--
-- RUNTIME EFFECT OF THIS MIGRATION: NONE. The scheduler starts either way and
-- no-ops while the flag is false.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

-- DO NOTHING, not DO UPDATE: a re-apply must never switch the flag back off
-- after an owner has enabled it.
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'location_snapshot_purge_enabled',
    false,
    'Enables the hourly purge of public.location_snapshots rows past expires_at. Off means raw coordinates are retained indefinitely (the pre-existing defect). The table''s only reader already filters on expires_at, so purging changes no result.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE
  present int;
BEGIN
  SELECT count(*) INTO present
    FROM public.feature_flags
   WHERE flag = 'location_snapshot_purge_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: location_snapshot_purge_enabled not present after seed';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- REVERSAL
-- ═══════════════════════════════════════════════════════════════════════════
-- Disable without removing (preferred — keeps the audit trail):
--   UPDATE public.feature_flags SET enabled = false
--    WHERE flag = 'location_snapshot_purge_enabled';
-- Remove entirely:
--   DELETE FROM public.feature_flags WHERE flag = 'location_snapshot_purge_enabled';
-- Rows already purged are not recoverable by either; that is the nature of the
-- retention this flag enforces.
