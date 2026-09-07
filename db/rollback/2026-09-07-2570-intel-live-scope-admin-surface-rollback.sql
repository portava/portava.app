-- Rollback for 2570_intel_live_scope_admin_surface_flag.sql
-- NOT applied anywhere as of 2026-09-07: 2570 itself has not been applied to
-- portava-ci (hwokxgbmezheskbzskfr) or production (ajrurzioarfkagpuxfnb).
-- It was rehearsed on portava-ci inside a transaction that ended in ROLLBACK.
--
-- WHAT 2570 DID
-- =============
--   * INSERT feature_flags ('intel_live_scope_admin_surface_enabled', false)
--   Nothing else: no table, function, policy, grant, or allowlist row.
--
-- WHAT DELETING IT DOES
-- =====================
-- Nothing a user can observe. routes/admin.ts reads the flag fail-closed, so
-- an absent row is exactly the seeded FALSE: every /admin/intel/live-scopes*
-- route answers 404 feature_disabled after requireAdmin and reads nothing
-- else. If an owner had flipped the flag ON, deleting the row closes the
-- operator surface on the next request. Rows already written to
-- intel_live_promoted_scopes through the surface are NOT touched — the
-- allowlist is the audit trail and this rollback does not erase it; withdraw
-- them through 2430's function (or the surface, before rolling back) if the
-- intent is to stop serving them.
--
-- Data loss: the one flag row (and any description edit an operator made).
--
-- Idempotent.

BEGIN;

DELETE FROM public.feature_flags WHERE flag = 'intel_live_scope_admin_surface_enabled';

COMMIT;
