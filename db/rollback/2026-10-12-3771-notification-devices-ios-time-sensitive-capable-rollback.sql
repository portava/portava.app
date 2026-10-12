-- Rollback for artifacts/api-server/src/migrations/3771_notification_devices_ios_time_sensitive_capable.sql
-- OD-1012-LAY-4a — per-device iOS time-sensitive capability.
--
-- WHAT THIS DESTROYS: every push token's reported time-sensitive capability.
-- No device or token row is deleted. After rollback every device is ordinary
-- (the router reads the column, fails, and sends at the ordinary level), which
-- is also what turning the rollout switch off does — prefer that:
--     unset PUSH_IOS_TIME_SENSITIVE_ENTITLED (or set it to anything but "true").

BEGIN;

ALTER TABLE public.notification_devices
  DROP COLUMN IF EXISTS ios_time_sensitive_capable;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3771_notification_devices_ios_time_sensitive_capable.sql';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'notification_devices' AND column_name = 'ios_time_sensitive_capable'
  ) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: notification_devices.ios_time_sensitive_capable is still present.';
  END IF;
END $$;

COMMIT;
