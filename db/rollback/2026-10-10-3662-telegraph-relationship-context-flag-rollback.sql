-- Rollback for artifacts/api-server/src/migrations/3662_telegraph_relationship_context_flag.sql
-- Removes only the flag row this file seeded (nothing else was created).
-- Turning the flag off is equivalent and is almost always what is wanted:
--     UPDATE public.feature_flags SET enabled = false WHERE flag = 'telegraph_relationship_context_enabled';

BEGIN;

DELETE FROM public.feature_flags
 WHERE flag = 'telegraph_relationship_context_enabled'
   AND description LIKE 'CAPABILITY gate for Telegraph §30A.1 relationship context:%';

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3662_telegraph_relationship_context_flag.sql';
  END IF;
END $$;

COMMIT;
