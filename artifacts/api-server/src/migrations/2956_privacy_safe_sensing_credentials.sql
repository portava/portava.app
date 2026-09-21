-- 2956_privacy_safe_sensing_credentials.sql
--
-- IMPORTED from an out-of-band writer, RENUMBERED, and ALREADY APPLIED.
-- Arrived as 2260_privacy_safe_sensing_credentials.sql.
-- Its incoming prefix collided with this repository's APPLIED
-- 2260_availability_windows.sql, so the unapplied-here file is the one that moved.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THIS FILE IS A RECORD OF SOMETHING THAT ALREADY RAN. DO NOT REPLAY IT BY HAND.
-- ══════════════════════════════════════════════════════════════════════════════
-- Its DDL reached both databases before this repository ever saw it, applied by a
-- second writer through the Supabase CLI. That path writes
-- supabase_migrations.schema_migrations and NOT public.schema_migration_ledger,
-- which is why this repository's ledger has no row for it and why its absence
-- there is not evidence it never ran. The versions it actually ran as:
--
--   production (ajrurzioarfkagpuxfnb) .... 20260916075630
--   CI         (hwokxgbmezheskbzskfr) .... 20260916075548
--
-- Verified by reading the live schemas on 2026-09-16, not inferred: the objects
-- below are present in both. Bringing the file in under a repository number is
-- what puts it under the migration chain's governance for the first time; the
-- SQL is deliberately NOT re-executed against either database. The ledger row
-- recorded for it names this filename, its checksum, and the version above.
--
-- It stays idempotent because a fresh database — the CI kernel job replaying the
-- whole chain onto an empty Postgres — DOES need to run it, and must reach the
-- same state either way.
--
-- ── The original file's own header follows ────────────────────────────────────
-- 2260_privacy_safe_sensing_credentials.sql
-- Short-lived, revocable, purpose-scoped sensing capability tokens.
BEGIN;

CREATE TABLE IF NOT EXISTS public.intel_sensing_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  token_digest text NOT NULL UNIQUE,
  nonce_digest text NOT NULL,
  purpose text NOT NULL,
  capability_version text NOT NULL,
  precision_ceiling text NOT NULL DEFAULT 'place_level',
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  nonce_consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intel_sensing_credential_purpose CHECK (purpose = 'intel_claim'),
  CONSTRAINT intel_sensing_credential_version CHECK (capability_version = 'sensing-v1'),
  CONSTRAINT intel_sensing_credential_precision CHECK (precision_ceiling = 'place_level')
);
CREATE INDEX IF NOT EXISTS intel_sensing_credentials_actor ON public.intel_sensing_credentials(actor_id);
CREATE INDEX IF NOT EXISTS intel_sensing_credentials_expiry ON public.intel_sensing_credentials(expires_at);

CREATE TABLE IF NOT EXISTS public.intel_sensing_device_eligibility (
  actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  eligible boolean NOT NULL DEFAULT true,
  unlinked_at timestamptz,
  PRIMARY KEY (actor_id, device_id)
);
ALTER TABLE public.intel_sensing_device_eligibility ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_sensing_device_eligibility FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.intel_sensing_device_eligibility TO service_role;

CREATE OR REPLACE FUNCTION public.is_sensing_device_eligible(p_actor_id uuid, p_device_id text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.intel_sensing_device_eligibility
   WHERE actor_id = p_actor_id AND device_id = p_device_id
     AND eligible AND unlinked_at IS NULL);
$$;
REVOKE ALL ON FUNCTION public.is_sensing_device_eligible(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_sensing_device_eligible(uuid,text) TO service_role;

ALTER TABLE public.intel_sensing_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_sensing_credentials FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.intel_sensing_credentials TO service_role;

CREATE OR REPLACE FUNCTION public.consume_intel_sensing_credential(
  p_token_digest text, p_nonce_digest text, p_actor_id uuid, p_device_id text, p_purpose text,
  p_capability_version text, p_now timestamptz
) RETURNS TABLE(outcome text, id uuid, actor_id uuid, device_id text, expires_at timestamptz,
                revoked_at timestamptz, capability_version text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.intel_sensing_credentials c
  SET nonce_consumed_at = p_now
  WHERE c.token_digest = p_token_digest
    AND c.nonce_digest = p_nonce_digest
    AND c.actor_id = p_actor_id AND c.device_id = p_device_id
    AND EXISTS (SELECT 1 FROM public.intel_sensing_device_eligibility d
      WHERE d.actor_id = p_actor_id AND d.device_id = p_device_id
        AND d.eligible AND d.unlinked_at IS NULL)
    AND c.purpose = p_purpose
    AND c.capability_version = p_capability_version
    AND c.expires_at > p_now
    AND c.revoked_at IS NULL
    AND c.nonce_consumed_at IS NULL
  RETURNING 'authorized', c.id, c.actor_id, c.device_id, c.expires_at, c.revoked_at, c.capability_version;
  IF FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT
    CASE WHEN c.actor_id <> p_actor_id OR c.device_id <> p_device_id THEN 'unauthorized'
         WHEN c.revoked_at IS NOT NULL THEN 'revoked'
         WHEN c.nonce_consumed_at IS NOT NULL THEN 'replay'
         WHEN c.expires_at <= p_now THEN 'expired'
         WHEN c.purpose <> p_purpose OR c.capability_version <> p_capability_version THEN 'scope_mismatch'
         ELSE 'unauthorized' END,
    c.id, c.actor_id, c.device_id, c.expires_at, c.revoked_at, c.capability_version
    FROM public.intel_sensing_credentials c
   WHERE c.token_digest = p_token_digest AND c.nonce_digest = p_nonce_digest;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unauthorized', NULL::uuid, NULL::uuid, NULL::text, NULL::timestamptz, NULL::timestamptz, NULL::text;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.consume_intel_sensing_credential(text,text,uuid,text,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_intel_sensing_credential(text,text,uuid,text,text,text,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.revoke_intel_sensing_credentials(p_actor_id uuid, p_device_id text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  UPDATE public.intel_sensing_credentials SET revoked_at = now()
   WHERE actor_id = p_actor_id AND revoked_at IS NULL
     AND (p_device_id IS NULL OR device_id = p_device_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END; $$;
REVOKE ALL ON FUNCTION public.revoke_intel_sensing_credentials(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_intel_sensing_credentials(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.unlink_intel_sensing_device(p_actor_id uuid, p_device_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed integer;
BEGIN
  UPDATE public.intel_sensing_device_eligibility
     SET eligible = false, unlinked_at = now()
   WHERE actor_id = p_actor_id AND device_id = p_device_id AND unlinked_at IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed = 0 THEN RETURN 'not_linked'; END IF;
  UPDATE public.intel_sensing_credentials
     SET revoked_at = now()
   WHERE actor_id = p_actor_id AND device_id = p_device_id AND revoked_at IS NULL;
  RETURN 'unlinked';
END; $$;
REVOKE ALL ON FUNCTION public.unlink_intel_sensing_device(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unlink_intel_sensing_device(uuid,text) TO service_role;

INSERT INTO public.feature_flags(flag, enabled, description) VALUES
 ('intel_sensing_credentials_enabled', false, 'Short-lived purpose-scoped privacy-reduced sensing credentials; disabled by default.')
 ,('intel_sensing_device_enrollment_enabled', false, 'Authenticated consented sensing-device enrollment; disabled by default.')
ON CONFLICT (flag) DO NOTHING;
COMMIT;