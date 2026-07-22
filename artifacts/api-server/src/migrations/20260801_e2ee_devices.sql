-- Migration: e2ee_devices
-- Phase E-0: E2EE prerequisites.
-- Creates the devices table for tracking per-install cryptographic identity.
-- public_key is nullable in E-0 (populated in E-1 when OpenMLS keys are generated).
-- This is separate from notification_devices (which tracks Expo push tokens).

-- UP:
CREATE TABLE IF NOT EXISTS devices (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  platform       TEXT        NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  -- Nullable until E-1. Ed25519 identity public key, base64url-encoded.
  public_key     TEXT,
  -- MLS KeyPackage pool size — updated in E-1. 0 until key material is generated.
  key_package_count INTEGER  NOT NULL DEFAULT 0,
  -- Opaque client-generated fingerprint for device correlation across re-registrations.
  -- Set to a stable hash of install-time identifiers; not user-visible.
  device_fingerprint TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_devices_user_id
  ON devices (user_id);

CREATE INDEX IF NOT EXISTS idx_devices_user_public_key
  ON devices (user_id, public_key)
  WHERE public_key IS NOT NULL;

-- DOWN:
-- DROP INDEX IF EXISTS idx_devices_user_public_key;
-- DROP INDEX IF EXISTS idx_devices_user_id;
-- DROP TABLE IF EXISTS devices;
