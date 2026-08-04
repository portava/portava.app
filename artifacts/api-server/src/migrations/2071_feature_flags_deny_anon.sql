-- 2071_feature_flags_deny_anon.sql
-- Close the feature_flags anon-key read hole that 2070 could not.
--
-- 2070 runs `ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY`, but RLS was
-- ALREADY enabled on this table in the live DB — so that statement is a no-op
-- and the table stayed world-readable. The actual exposure is a permissive
-- policy created by migrations/0037_feature_flags.sql:
--
--   CREATE POLICY "feature_flags_public_read" ON feature_flags
--     FOR SELECT USING (true);            -- role: public
--
-- Verified against production (project ajrurzioarfkagpuxfnb, 2026-08-04):
--   GET /rest/v1/feature_flags?select=* with the shipped EXPO_PUBLIC anon key
--   returned HTTP 200 and all 177 flag rows. Anyone with the mobile app's anon
--   key could read the entire rollout roadmap.
--
-- Safe to drop:
--   * Server reads go through the SERVICE-ROLE client (lib/featureFlags.ts,
--     lib/rankLog.ts, lib/safeReturnScheduler.ts,
--     lib/creatorActivityScoreScheduler.ts, …). service_role bypasses RLS
--     entirely, so no server path is affected.
--   * Client audit (2026-08-04): zero `.from("feature_flags")` call sites in
--     travel-buddy-standalone/src or /app. The app learns flag state from API
--     responses, never by querying this table.
--
-- After this migration the table is deny-all for anon/authenticated, matching
-- every other table hardened in 2070.
--
-- Rollback (restores public read):
--   CREATE POLICY "feature_flags_public_read" ON public.feature_flags
--     FOR SELECT USING (true);

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NOT NULL THEN
    -- Idempotent: IF EXISTS makes re-runs a no-op.
    EXECUTE 'DROP POLICY IF EXISTS "feature_flags_public_read" ON public.feature_flags';
    -- 0037 also shipped a service_role ALL policy. It is harmless (service_role
    -- bypasses RLS regardless) but redundant; leave it in place so that any
    -- environment relying on it explicitly keeps working.
    EXECUTE 'ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;
