-- Rollback for artifacts/api-server/src/migrations/3743_telegraph_device_registry_revocation_links.sql
-- Telegraph §30A.7 — device registry fields and the device-session / push-token links.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DESTROYS
-- ══════════════════════════════════════════════════════════════════════════════
-- Every device's recorded auth session and declared capabilities, and every
-- push token's link to the device that registered it. No device, push token,
-- message or membership row is deleted. After rollback, revoking a device can
-- no longer end its auth session or drop its push token: the API reports both
-- as gaps (`*_link_column_absent`) instead of claiming them.
--
-- It also RE-GRANTS the baseline's client privileges on public.devices (GRANT
-- ALL to anon and authenticated — baseline 20260819:35902-35903). RLS stays on
-- with no client policy (2070), so the grant gives a client nothing it can use.
--
-- The flag is almost certainly what you want instead (it gates only the
-- capability writes):
--
--     UPDATE public.feature_flags SET enabled = false
--      WHERE flag = 'telegraph_device_registry_enabled';

BEGIN;

DROP INDEX IF EXISTS public.notification_devices_crypto_device_id_idx;
ALTER TABLE public.notification_devices
  DROP CONSTRAINT IF EXISTS notification_devices_crypto_device_id_fkey;
ALTER TABLE public.notification_devices
  DROP COLUMN IF EXISTS crypto_device_id;

ALTER TABLE public.devices
  DROP CONSTRAINT IF EXISTS devices_trust_state_check;
ALTER TABLE public.devices
  DROP COLUMN IF EXISTS auth_session_id,
  DROP COLUMN IF EXISTS push_capable,
  DROP COLUMN IF EXISTS voice_video_capable,
  DROP COLUMN IF EXISTS proximity_capable,
  DROP COLUMN IF EXISTS background_location_capable,
  DROP COLUMN IF EXISTS trust_state;

GRANT ALL ON TABLE public.devices TO anon;
GRANT ALL ON TABLE public.devices TO authenticated;

DELETE FROM public.feature_flags
 WHERE flag = 'telegraph_device_registry_enabled'
   AND description LIKE 'CAPABILITY gate for Telegraph §30A.7 device capability fields:%';

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3743_telegraph_device_registry_revocation_links.sql';
  END IF;
END $$;

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND ((table_name = 'devices' AND column_name IN ('auth_session_id','push_capable','voice_video_capable','proximity_capable','background_location_capable','trust_state'))
         OR (table_name = 'notification_devices' AND column_name = 'crypto_device_id'))
  ) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: a 3743 column is still present.';
  END IF;
END $$;

COMMIT;
