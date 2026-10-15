-- Rollback for artifacts/api-server/src/migrations/3826_telegraph_context_kernel_flag.sql
-- Removes only the flag row this file seeded (nothing else was created).
-- Turning the flag off is equivalent and is almost always what is wanted:
--     UPDATE public.feature_flags SET enabled = false WHERE flag = 'telegraph_context_kernel_enabled';

BEGIN;

DELETE FROM public.feature_flags
 WHERE flag = 'telegraph_context_kernel_enabled'
   AND description LIKE 'CAPABILITY gate for the Telegraph §30A.19 Context Kernel:%';

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3826_telegraph_context_kernel_flag.sql';
  END IF;
END $$;

COMMIT;
