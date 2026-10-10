-- Rollback for 3620_layover_client_write_boundary.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3620 DID: narrowed `anon` to nothing and `authenticated` to SELECT on
-- layover_sessions, layover_plan_stops, layover_events and airport_profiles
-- (owner decision L199-b). No row, policy or flag was touched.
-- WHAT THIS ROLLBACK DOES: restores the grants measured on portava-ci on
-- 2026-09-07 before 3620 — DELETE, INSERT, SELECT, UPDATE to both client roles
-- on all four — and deletes 3620's schema_migration_ledger row. TRUNCATE is NOT
-- restored: 2335 section 2 took it back, and this file undoes 3620 only.
-- DATA LOSS: none. Re-opening these grants re-opens census L200 (a traveller
-- can write their session's status, reminder and sharing columns through
-- PostgREST); that is what rolling back means.

BEGIN;

GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.layover_sessions   TO anon, authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.layover_plan_stops TO anon, authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.layover_events     TO anon, authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public.airport_profiles   TO anon, authenticated;

DELETE FROM public.schema_migration_ledger WHERE filename = '3620_layover_client_write_boundary.sql';

DO $post$
DECLARE
  t TEXT;
  v TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['layover_sessions', 'layover_plan_stops', 'layover_events', 'airport_profiles'] LOOP
    FOREACH v IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('authenticated', format('public.%I', t), v)
         OR NOT has_table_privilege('anon', format('public.%I', t), v) THEN
        RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3620): % on % was not restored to both client roles', v, t;
      END IF;
    END LOOP;
  END LOOP;
END $post$;

COMMIT;
