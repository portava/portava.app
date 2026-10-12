-- 3771_notification_devices_ios_time_sensitive_capable.sql
--
-- Owner ruling OD-1012-LAY-4a (2026-10-12), on PR #701 (census-layover L41/L99):
-- PUSH_IOS_TIME_SENSITIVE_ENTITLED is approved as a server setting, default
-- off, "a rollout switch—not proof of an installed app's entitlement. Account
-- for older or unknown app builds; use ordinary notifications when capability
-- is unavailable or uncertain."
--
-- APPLIED TO NO DATABASE by the lane that wrote it (wave W, lay-return).
--
-- ADDITIVE ONLY: one nullable column, one comment. No row is written or
-- backfilled, no constraint, no grant change. Idempotent.
--
--   notification_devices.ios_time_sensitive_capable boolean NULL
--     What the build that last registered this push token REPORTED about iOS
--     time-sensitive delivery (the app's own entitlement gate,
--     travel-buddy-standalone safeNotifications.ts iosTimeSensitiveAvailable()).
--     NULL = the build reported nothing (an older build) or never registered
--     since this column existed: UNKNOWN, which the server treats as ordinary.
--     Written only by the server (routes/notifications.ts POST /me/devices,
--     lib/pushDeviceCapability.ts); read only by the router for an actionable
--     layover return warning while the rollout switch is on.
--
-- PRIVILEGES. notification_devices keeps its 0062 shape: RLS on, one client
-- policy (SELECT own rows), no client write policy — a client cannot set this
-- column; it can read its own value, which is a fact about its own install.
--
-- Unapplied, the code degrades honestly: the write reports `column_absent`
-- and every device is ordinary (lib/pushDeviceCapability.ts).
--
-- ROLLBACK: db/rollback/2026-10-12-3771-notification-devices-ios-time-sensitive-capable-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.notification_devices') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.notification_devices must exist (0062).';
  END IF;
END $pre$;

ALTER TABLE public.notification_devices
  ADD COLUMN IF NOT EXISTS ios_time_sensitive_capable boolean NULL;

COMMENT ON COLUMN public.notification_devices.ios_time_sensitive_capable IS
  'OD-1012-LAY-4a: what the build that last registered this push token reported about iOS time-sensitive delivery (true/false); NULL = not reported (older/unknown build) = ordinary delivery. Server-written at POST /me/devices; read only for actionable layover return warnings while PUSH_IOS_TIME_SENSITIVE_ENTITLED=true.';

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'notification_devices'
       AND column_name = 'ios_time_sensitive_capable' AND data_type = 'boolean' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: notification_devices.ios_time_sensitive_capable (boolean NULL) was not added.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'notification_devices'
       AND column_name = 'ios_time_sensitive_capable' AND column_default IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: ios_time_sensitive_capable must have no default (unknown stays NULL).';
  END IF;
END $post$;

COMMIT;
