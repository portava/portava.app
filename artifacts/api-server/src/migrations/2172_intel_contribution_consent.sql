-- 2172_intel_contribution_consent.sql
-- Persistent, server-authoritative consent for the intel_claim purpose (D4).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
-- lib/locationPurposes.ts declares the `intel_claim` purpose with
-- lawfulBasis:"consent" and requiresSeparateControl:true, but nothing implemented
-- either. Capture was gated on the feature flag alone. The owner ruling
-- (2026-08-27): Intelligence Contributions require explicit informed consent PLUS
-- a persistent separate control, enforced SERVER-SIDE; client UI alone is not
-- sufficient and client state cannot override server state.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────
-- One authoritative row per user, keyed by profiles(id) — the same identity
-- intel_observations.actor_id references — modelled on the existing versioned
-- consent precedent circle_visibility_settings (global_enabled default-off +
-- consent_version + consented_at). Adds withdrawn_at so a withdrawal instant is
-- recorded distinctly from the original consent instant (audit evidence).
--
-- ── AUTHORITY ────────────────────────────────────────────────────────────────
-- RLS: the owner may READ their own row; only service_role WRITES. The consent
-- grant/withdraw flows through a server endpoint that stamps consent_version and
-- consented_at/withdrawn_at itself, so a client cannot forge a consent version or
-- timestamp (ruling: client-provided consent fields cannot forge server consent).
-- Deletion cascades with the profile (ON DELETE CASCADE), so account deletion
-- removes the consent row alongside erase_intel_for_actor().

BEGIN;

CREATE TABLE IF NOT EXISTS public.intel_contribution_consent (
  user_id        uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Current effective state. Default FALSE: consent is OFF until an explicit opt-in.
  enabled        boolean NOT NULL DEFAULT false,
  -- The disclosure/consent version the user agreed to (server-stamped). NULL until
  -- a first grant.
  consent_version text,
  -- When consent was (most recently) granted. NULL until a first grant.
  consented_at   timestamptz,
  -- When consent was (most recently) withdrawn. NULL while consent is active or
  -- was never granted.
  withdrawn_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- An enabled consent MUST carry the version + instant it was granted under. This
  -- makes "enabled with no recorded consent" unrepresentable — valid consent
  -- always has provable evidence behind it.
  CONSTRAINT intel_consent_enabled_requires_evidence
    CHECK (enabled = false OR (consent_version IS NOT NULL AND consented_at IS NOT NULL))
);

ALTER TABLE public.intel_contribution_consent ENABLE ROW LEVEL SECURITY;

-- Owner may read their own consent state (for the settings surface). No owner
-- INSERT/UPDATE/DELETE policy exists, so authenticated users cannot write this
-- table directly — the authoritative write is service_role only.
--
-- DROP-then-CREATE so the migration is IDEMPOTENT: it was applied to CI and
-- prod as raw SQL (2026-08-27) without a supabase_migrations ledger row, so any
-- future runner replaying it must not fail on "policy already exists".
DROP POLICY IF EXISTS intel_consent_select_own ON public.intel_contribution_consent;
CREATE POLICY intel_consent_select_own ON public.intel_contribution_consent
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS intel_consent_service_all ON public.intel_contribution_consent;
CREATE POLICY intel_consent_service_all ON public.intel_contribution_consent
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- REVOKE ALL from authenticated FIRST: ALTER DEFAULT PRIVILEGES in this database
-- grants new tables INSERT/UPDATE to authenticated by default, which would let a
-- client write its own consent row directly (forging version/timestamps) — the
-- exact blanket-grant hole to avoid. Grant back ONLY SELECT, so the sole write
-- path is service_role via the server endpoint. (RLS also denies, but the grant
-- must not exist either.)
REVOKE ALL ON public.intel_contribution_consent FROM PUBLIC;
REVOKE ALL ON public.intel_contribution_consent FROM anon;
REVOKE ALL ON public.intel_contribution_consent FROM authenticated;
GRANT SELECT ON public.intel_contribution_consent TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.intel_contribution_consent TO service_role;

COMMENT ON TABLE public.intel_contribution_consent IS
  'Server-authoritative consent for the intel_claim purpose (D4). One row per user (profiles.id). enabled default false; a grant stamps consent_version + consented_at server-side; a withdrawal sets enabled=false + withdrawn_at. writeObservation() refuses capture unless enabled=true AND withdrawn_at IS NULL. Owner reads own row; only service_role writes.';

DO $$
BEGIN
  IF to_regclass('public.intel_contribution_consent') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_contribution_consent table missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'intel_contribution_consent' AND relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: RLS not enabled on intel_contribution_consent';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP TABLE IF EXISTS public.intel_contribution_consent;
-- Dropping it re-opens the consent gap; only reverse if the consent enforcement
-- code is reverted in the same change.
