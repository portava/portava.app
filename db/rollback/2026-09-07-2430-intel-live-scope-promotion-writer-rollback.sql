-- Rollback for 2430_intel_live_scope_promotion_writer.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
-- The owner runs all SQL by hand; nothing in the 2430 lane was applied by code.
--
-- WHAT 2430 DID
-- =============
--   * ALTER TABLE intel_live_promoted_scopes ADD COLUMN expires_at, withdrawn_at,
--     withdrawn_by, withdrawn_reason, promoted_via, evidence, updated_at
--     (+ three CHECK constraints, one partial index)
--   * CREATE FUNCTION system_promote_intel_live_scope / system_withdraw_intel_live_scope /
--     system_expire_intel_live_scopes (service_role only)
--   * INSERT feature_flags ('intel_live_scope_promotion_enabled', false)
--
-- WHAT DROPPING IT DOES
-- =====================
-- Nothing a user can observe while intel_live_scope_promotion_enabled is false,
-- which it is seeded as. lib/intelLiveScopePromotion.ts checks the flag before
-- any RPC and returns {skipped:true, reason:'disabled'}; with the flag row gone
-- isFlagEnabled reads false (fail-closed), so the service is inert.
--
-- The read path (lib/liveClaimRead.loadPromotedScopes) selects the new columns
-- and, on a 42703 "column does not exist", retries with scope_key only — the
-- pre-2430 behaviour. So after this rollback a promoted row (if any) serves
-- exactly as it did under 2179: unconditionally, with no horizon.
--
-- Data loss: the expiry/withdrawal state and the evidence on every row written
-- while the flag was on. A row that was WITHDRAWN becomes live again the moment
-- withdrawn_at is dropped — if any 'service' rows exist, DELETE the withdrawn
-- ones first (the guarded statement below does exactly that) or the rollback
-- re-exposes a scope an operator had taken down.
--
-- Idempotent: every statement is IF EXISTS.

BEGIN;

-- Refuse to silently resurrect a withdrawn scope: remove withdrawn rows BEFORE
-- the column that marks them withdrawn disappears.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'intel_live_promoted_scopes'
       AND column_name = 'withdrawn_at'
  ) THEN
    EXECUTE 'DELETE FROM public.intel_live_promoted_scopes WHERE withdrawn_at IS NOT NULL';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.system_expire_intel_live_scopes(timestamptz);
DROP FUNCTION IF EXISTS public.system_withdraw_intel_live_scope(text, text, text, uuid, timestamptz);
DROP FUNCTION IF EXISTS public.system_promote_intel_live_scope(text, text, timestamptz, uuid, text, jsonb, timestamptz);

DROP INDEX IF EXISTS public.intel_live_promoted_scopes_expiring_idx;

ALTER TABLE IF EXISTS public.intel_live_promoted_scopes
  DROP CONSTRAINT IF EXISTS intel_live_scope_expiry_after_promotion_check,
  DROP CONSTRAINT IF EXISTS intel_live_scope_withdrawal_reason_check,
  DROP CONSTRAINT IF EXISTS intel_live_scope_promoted_via_check;

ALTER TABLE IF EXISTS public.intel_live_promoted_scopes
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS evidence,
  DROP COLUMN IF EXISTS promoted_via,
  DROP COLUMN IF EXISTS withdrawn_reason,
  DROP COLUMN IF EXISTS withdrawn_by,
  DROP COLUMN IF EXISTS withdrawn_at,
  DROP COLUMN IF EXISTS expires_at;

DELETE FROM public.feature_flags WHERE flag = 'intel_live_scope_promotion_enabled';

-- The ledger exists on CI (2254) and not on production; guard so this file runs on both.
DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.schema_migration_ledger WHERE filename = ''2430_intel_live_scope_promotion_writer.sql''';
  END IF;
END $$;

COMMIT;
