-- Diagnostic: does the upsert_city_stamp RPC exist in your live database?
-- The GPS city-stamp write path (lib/stampHelper.ts) calls it, but there is no
-- CREATE FUNCTION for it anywhere in the repo migrations — so it either exists
-- ad-hoc in prod, or is missing (in which case GPS city stamps silently fail
-- to write; posts/postcards are unaffected).
--
-- Run this in the Supabase SQL editor:

SELECT p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS arguments
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = 'upsert_city_stamp';

-- • One row returned  → the function EXISTS (works today). Recommended: send me
--   the `arguments` output so I can add a canonical CREATE FUNCTION migration,
--   so it's reproducible if you ever rebuild the DB from migrations.
-- • Zero rows         → the function is MISSING. GPS city stamps are silently
--   not being written. Send me the columns of your live passport_stamps table:
--     SELECT column_name, data_type FROM information_schema.columns
--     WHERE table_name = 'passport_stamps' ORDER BY ordinal_position;
--   and I'll reconstruct upsert_city_stamp to match your real table exactly
--   (reconstructing it blind risks referencing columns that don't exist).
