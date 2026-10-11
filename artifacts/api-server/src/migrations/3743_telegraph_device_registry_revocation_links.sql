-- 3743_telegraph_device_registry_revocation_links.sql
--
-- Telegraph §30A.7 Device, Session and Compromise Model (census-telegraph T399,
-- T401). POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). Wave W lane
-- tg-devices, band 3743-3747.
--
-- ADDITIVE ONLY: seven nullable/defaulted columns, one CHECK, one FK, one index,
-- one flag row (FALSE), and the client roles' privileges on `devices` taken.
-- No row is written or backfilled. Idempotent (IF NOT EXISTS / catalog checks).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- DELETE /api/me/crypto-devices/:id (routes/devices.ts) deleted the `devices` row
-- and nothing else: the revoked phone kept its auth session, its SSE stream and
-- its push token. lib/deviceRevocation.ts now ends each of them, and needs two
-- LINKS that no table carried:
--
--   devices.auth_session_id            the auth session (JWT `session_id`) the
--                                      device last called from; written on
--                                      register and on the public-key call every
--                                      launch makes. Revocation lists it in the
--                                      account's app_metadata so every getUser
--                                      site refuses that session.
--   notification_devices.crypto_device_id
--                                      which device registered a push token, so
--                                      revocation drops exactly that token. FK to
--                                      devices ON DELETE CASCADE: a deleted device
--                                      can never keep a linked token, whichever
--                                      code path deletes it.
--
-- And the §30A.7 registry fields the spec names that `devices` lacked (T399):
--   push_capable, voice_video_capable, proximity_capable,
--   background_location_capable   boolean, NULL = not declared. Written only
--                                  while telegraph_device_registry_enabled is ON.
--   trust_state                    text NOT NULL DEFAULT 'unverified', CHECK
--                                  ('unverified','verified'). The spec names the
--                                  field, not its states or what moves it; nothing
--                                  in this change writes it (owner decision).
-- `platform` and last activity (`last_seen_at`, baseline) already existed.
--
-- PRIVILEGES. `devices` is server-only (2070_rls_hardening: RLS on, no client
-- policy; only routes/devices.ts and routes/keyPackages.ts touch it, through the
-- service client) but still held the baseline's GRANT ALL to anon and
-- authenticated. trust_state is an AUTHORITY column, so this file revokes every
-- client privilege on the table (rule 4's shape: PUBLIC, anon, authenticated).
-- service_role is untouched (asserted). No client tree reads or writes `devices`
-- through PostgREST.
--
-- Unapplied, the code degrades honestly: the session/push links are absent and
-- revocation reports the gaps `auth_session_link_column_absent` /
-- `push_tokens_link_column_absent` (never "complete").
--
-- ROLLBACK: db/rollback/2026-10-11-3743-telegraph-device-registry-revocation-links-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.devices') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.devices must exist.';
  END IF;
  IF to_regclass('public.notification_devices') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.notification_devices must exist.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags must exist.';
  END IF;
END $pre$;

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS auth_session_id uuid NULL,
  ADD COLUMN IF NOT EXISTS push_capable boolean NULL,
  ADD COLUMN IF NOT EXISTS voice_video_capable boolean NULL,
  ADD COLUMN IF NOT EXISTS proximity_capable boolean NULL,
  ADD COLUMN IF NOT EXISTS background_location_capable boolean NULL,
  ADD COLUMN IF NOT EXISTS trust_state text NOT NULL DEFAULT 'unverified';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.devices'::regclass AND conname = 'devices_trust_state_check'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_trust_state_check CHECK (trust_state IN ('unverified', 'verified'));
  END IF;
END $$;

ALTER TABLE public.notification_devices
  ADD COLUMN IF NOT EXISTS crypto_device_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.notification_devices'::regclass
       AND conname = 'notification_devices_crypto_device_id_fkey'
  ) THEN
    ALTER TABLE public.notification_devices
      ADD CONSTRAINT notification_devices_crypto_device_id_fkey
      FOREIGN KEY (crypto_device_id) REFERENCES public.devices(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS notification_devices_crypto_device_id_idx
  ON public.notification_devices (crypto_device_id)
  WHERE crypto_device_id IS NOT NULL;

COMMENT ON COLUMN public.devices.auth_session_id IS
  'Telegraph §30A.7 (T401): the auth session (access-token session_id claim) this device last called from. Written by the server on register / public-key heartbeat; read only by device revocation (lib/deviceRevocation.ts).';
COMMENT ON COLUMN public.devices.trust_state IS
  'Telegraph §30A.7 (T399) device trust state: unverified | verified. Nothing writes it yet; what moves a device to verified is an owner decision.';
COMMENT ON COLUMN public.notification_devices.crypto_device_id IS
  'Telegraph §30A.7 (T401): the devices row that registered this push token (x-portava-device-id, resolved against the caller''s own devices). Revoking that device deletes this row; ON DELETE CASCADE does the same for any other device deletion.';

REVOKE ALL ON TABLE public.devices FROM PUBLIC;
REVOKE ALL ON TABLE public.devices FROM anon;
REVOKE ALL ON TABLE public.devices FROM authenticated;

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('telegraph_device_registry_enabled', false,
   'CAPABILITY gate for Telegraph §30A.7 device capability fields: register / public-key calls record the client-declared push, voice/video, proximity and background-location capability on devices. OFF (the seed): those columns are never written. Device revocation and the device-session / push-token links are NOT behind this flag.')
ON CONFLICT (flag) DO NOTHING;

DO $post$
DECLARE
  v_missing text;
  r text;
BEGIN
  SELECT string_agg(c, ', ') INTO v_missing FROM (
    SELECT c FROM unnest(ARRAY['auth_session_id','push_capable','voice_video_capable','proximity_capable','background_location_capable','trust_state']) c
     WHERE NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'devices' AND column_name = c
     )
  ) q;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: column(s) not added to devices: %', v_missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'notification_devices' AND column_name = 'crypto_device_id'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: notification_devices.crypto_device_id was not added.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.devices'::regclass AND conname = 'devices_trust_state_check'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: devices_trust_state_check was not created.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.notification_devices'::regclass
       AND conname = 'notification_devices_crypto_device_id_fkey'
       AND contype = 'f' AND confdeltype = 'c'
       AND confrelid = 'public.devices'::regclass
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: notification_devices.crypto_device_id must reference devices ON DELETE CASCADE.';
  END IF;

  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) AND (
         has_table_privilege(r, 'public.devices', 'SELECT')
      OR has_table_privilege(r, 'public.devices', 'INSERT')
      OR has_table_privilege(r, 'public.devices', 'UPDATE')
      OR has_table_privilege(r, 'public.devices', 'DELETE')
    ) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: client role % still holds a privilege on public.devices.', r;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
     AND NOT (has_table_privilege('service_role', 'public.devices', 'SELECT')
          AND has_table_privilege('service_role', 'public.devices', 'INSERT')
          AND has_table_privilege('service_role', 'public.devices', 'UPDATE')
          AND has_table_privilege('service_role', 'public.devices', 'DELETE')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role lost its privileges on public.devices.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_device_registry_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_device_registry_enabled was not seeded.';
  END IF;
END $post$;

COMMIT;
