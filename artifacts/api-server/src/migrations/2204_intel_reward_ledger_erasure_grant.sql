-- 2204_intel_reward_ledger_erasure_grant.sql
-- Let account deletion actually erase a departed contributor's reward-ledger rows.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). CI-APPLIED ONLY.
--
-- ── THE HOLE ─────────────────────────────────────────────────────────────────
-- intel_reward_ledger (migration 2170) is keyed by profiles(id) with
-- ON DELETE CASCADE (actor_id uuid NOT NULL REFERENCES public.profiles(id)
-- ON DELETE CASCADE). That cascade never fires: executeAccountDeletion keeps an
-- ANONYMISED TOMBSTONE profile rather than deleting the profiles row, so no FK
-- cascade off profiles ever runs — the same mistake migration 2172 made for the
-- consent row (corrected by 2203) and 2187 made for derived memory (corrected by
-- 2190). The ledger rows — actor_id + qiu + earned_units + source + ledger_version
-- + timestamps — therefore SURVIVED account deletion as orphaned personal data,
-- still joinable to the departed user's uuid, while every intel_observation that
-- EARNED them was erased by erase_intel_for_actor(). Retaining a derivative of
-- erased contributions is exactly the inconsistency 2190 closed for derived memory.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────────
-- AccountDeletionService now clears the rows explicitly (step
-- `delete_intel_reward_ledger`), the same way it clears every other non-append-only
-- user-keyed table (the SECURITY DEFINER erasure RPC is only needed for the
-- append-only observations/evidence/confirmations, which carry DELETE-blocking
-- triggers; the reward ledger has no such trigger — its append-only property is
-- purely the absence of a DELETE grant). 2170 granted service_role only INSERT +
-- SELECT, so the delete would be refused at the grant layer. This adds the missing
-- DELETE grant. Nothing else may write or delete the table: the append-only INSERT
-- path is untouched and there is still no client grant.
--
-- NON-CASH, so no legal/tax retention obligation applies (cash_amount = 0 is
-- CHECK-enforced by 2170); a user's non-cash recognition credits are erased with
-- the contributions that produced them.
--
-- DRIFT-TOLERANT: guarded on the table existing, so it is correct whether or not
-- 2170 has been applied in a given environment.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.intel_reward_ledger') IS NOT NULL THEN
    GRANT DELETE ON public.intel_reward_ledger TO service_role;
  END IF;
END $$;

-- ── Postcondition ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.intel_reward_ledger') IS NOT NULL
     AND NOT has_table_privilege('service_role', 'public.intel_reward_ledger', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role still lacks DELETE on intel_reward_ledger — account deletion cannot erase the reward-ledger rows.';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   REVOKE DELETE ON public.intel_reward_ledger FROM service_role;
-- Only reverse alongside removing the delete_intel_reward_ledger deletion step, or
-- the reward-ledger rows will silently survive account deletion again.
