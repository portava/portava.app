-- 2179_intel_live_promoted_scopes.sql
-- Per-scope Live promotion allowlist (fixes the single-global-flag over-exposure).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- IG-09 says Live is exposed "per environment, city, zone, claim family and
-- cohort" only after that SCOPE clears the density gate + human review. But
-- liveClaimRead gated solely on the GLOBAL intel_limited_live flag, so flipping
-- it on for one promoted scope would have exposed EVERY scope's snapshots at
-- once. This table is the per-scope allowlist the read path now also requires:
-- the global flag stays the master switch, and a scope serves Live only when a
-- row here promotes it. The table starts EMPTY, so turning the global flag on
-- exposes nothing until a scope is explicitly promoted — the correct fail-closed
-- default. scope_key is coalesce(zone_id,'') || '|' || claim_type, matching the
-- (zone, claim) granularity carried on intel_state_snapshots.

CREATE TABLE IF NOT EXISTS public.intel_live_promoted_scopes (
  scope_key   text PRIMARY KEY,
  zone_id     text,
  claim_type  text NOT NULL,
  promoted_at timestamptz NOT NULL DEFAULT now(),
  promoted_by uuid,
  note        text,
  -- Guard: scope_key must be the canonical composition so the read path's lookup
  -- and any promotion writer agree byte-for-byte.
  CONSTRAINT intel_live_scope_key_canonical
    CHECK (scope_key = coalesce(zone_id, '') || '|' || claim_type)
);

ALTER TABLE public.intel_live_promoted_scopes ENABLE ROW LEVEL SECURITY;

-- Service-role only: this is a server-authoritative pilot control, never client
-- readable/writable. ALTER DEFAULT PRIVILEGES grants authenticated on new tables,
-- so REVOKE first, then grant only service_role.
REVOKE ALL ON public.intel_live_promoted_scopes FROM PUBLIC;
REVOKE ALL ON public.intel_live_promoted_scopes FROM anon;
REVOKE ALL ON public.intel_live_promoted_scopes FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.intel_live_promoted_scopes TO service_role;

DROP POLICY IF EXISTS intel_live_promoted_scopes_service ON public.intel_live_promoted_scopes;
CREATE POLICY intel_live_promoted_scopes_service ON public.intel_live_promoted_scopes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.intel_live_promoted_scopes IS
  'Per-scope Live promotion allowlist (IG-09). A scope (coalesce(zone_id,'''')||''|''||claim_type) serves Live labels only when promoted here AND the global intel_limited_live flag is on AND disable_intel_live_labels is clear. Empty = nothing live. Server-authoritative; promote a scope by inserting a row.';

DO $$
BEGIN
  IF to_regclass('public.intel_live_promoted_scopes') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_live_promoted_scopes missing';
  END IF;
END $$;

-- REVERSAL:
--   DROP TABLE IF EXISTS public.intel_live_promoted_scopes;
-- (Only reverse alongside reverting liveClaimRead's per-scope gate, which would
--  otherwise return [] for every scope once the global flag is on.)
