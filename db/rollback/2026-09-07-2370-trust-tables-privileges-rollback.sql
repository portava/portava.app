-- Rollback for 2370_trust_tables_privileges.sql
-- Applied by hand to portava-ci (hwokxgbmezheskbzskfr) on 2026-09-07.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2370 DID
-- =============
-- On the seven trust tables (trust_admin_actions, trust_caps, trust_events,
-- trust_profiles, trust_restrictions, trust_reviews, trust_settings):
--   REVOKE ALL FROM PUBLIC, anon, authenticated, service_role;
--   GRANT SELECT, INSERT, UPDATE, DELETE TO service_role;
--   ALTER TABLE ... ENABLE ROW LEVEL SECURITY (already on — a no-op).
-- No DDL beyond grants. No policy created or dropped. No rows touched.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores the MEASURED pre-2370 state, which in both databases was the
-- Supabase default-privileges grant: ALL (DELETE/INSERT/REFERENCES/SELECT/
-- TRIGGER/TRUNCATE/UPDATE) to anon, authenticated and service_role. It does
-- not touch RLS or the five own-row SELECT policies, which 2370 also did not
-- touch.
--
-- WHAT RESTORING THE GRANTS DOES TO THE PRODUCT
-- ==============================================
-- Nothing observable. The API reaches these tables only through the service
-- role (lib/http.ts:177, lib/requireAdmin.ts:125), and the mobile tree has no
-- reference to any trust_* table. The grants are a reachability surface for
-- PostgREST callers that do not exist. Running this rollback reopens that
-- surface — including TRUNCATE for anon, which RLS does not police, and the
-- anon read of trust_settings — so run it only to reproduce the pre-2370
-- state deliberately, not as a cleanup.
--
-- Idempotent: GRANT on privileges already held is a no-op.

BEGIN;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'trust_admin_actions', 'trust_caps', 'trust_events', 'trust_profiles',
    'trust_restrictions', 'trust_reviews', 'trust_settings'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('GRANT ALL ON public.%I TO anon', t);
    EXECUTE format('GRANT ALL ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;

COMMIT;
