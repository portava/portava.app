-- Migration: e2ee_key_packages
-- Phase E-1: KeyPackage pool for MLS group formation.
--
-- KeyPackages are one-shot: consumed when the device is added to an MLS group.
-- The pool is replenished by the client before it runs low (threshold: 3).
-- Only PUBLIC material is stored here — private leaf keys never leave the client.

-- UP:
CREATE TABLE IF NOT EXISTS key_packages (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id      UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  -- TLS-serialised MLS KeyPackage, base64url-encoded.
  key_package_b64 TEXT       NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_key_packages_device_created
  ON key_packages (device_id, created_at ASC);

-- DOWN:
-- DROP INDEX IF EXISTS idx_key_packages_device_created;
-- DROP TABLE IF EXISTS key_packages;
