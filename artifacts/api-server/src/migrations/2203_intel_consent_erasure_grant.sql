-- 2203_intel_consent_erasure_grant.sql
-- Let account deletion actually erase a user's intel contribution consent row.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). CI-APPLIED ONLY.
--
-- ── THE HOLE ─────────────────────────────────────────────────────────────────
-- intel_contribution_consent (migration 2172) is keyed by profiles(id) with
-- ON DELETE CASCADE, and 2172's header states account deletion "removes the
-- consent row alongside erase_intel_for_actor()". It does NOT: executeAccountDeletion
-- keeps an ANONYMISED TOMBSTONE profile rather than deleting the profiles row, so no
-- FK cascade off profiles ever fires (see src/services/accountDeletion — the same
-- mistake migration 2187 made for derived memory, corrected explicitly by 2190).
-- The consent row — user_id + consent_version + consent/withdrawal timestamps —
-- therefore SURVIVED account deletion as orphaned personal data, keyed to a uuid
-- that is still joinable, while every observation the consent authorised was erased.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────────
-- AccountDeletionService now clears the row explicitly (step `delete_intel_consent`),
-- the same way it clears every other non-append-only user-keyed table (the erasure
-- RPC is only needed for the append-only observations/evidence/confirmations). The
-- consent table's RLS already permits service_role every operation
-- (intel_consent_service_all FOR ALL), but 2172 granted service_role only
-- SELECT/INSERT/UPDATE — no DELETE — so the delete would be refused at the grant
-- layer. This adds the missing DELETE grant. Nothing else may write or delete the
-- table: anon/authenticated keep SELECT-only (owner reads own row).
--
-- DRIFT-TOLERANT: guarded on the table existing, so it is correct whether or not
-- 2172 has been applied in a given environment.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.intel_contribution_consent') IS NOT NULL THEN
    GRANT DELETE ON public.intel_contribution_consent TO service_role;
  END IF;
END $$;

-- ── Postcondition ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.intel_contribution_consent') IS NOT NULL
     AND NOT has_table_privilege('service_role', 'public.intel_contribution_consent', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role still lacks DELETE on intel_contribution_consent — account deletion cannot erase the consent row.';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   REVOKE DELETE ON public.intel_contribution_consent FROM service_role;
-- Only reverse alongside removing the delete_intel_consent deletion step, or the
-- consent row will silently survive account deletion again.
