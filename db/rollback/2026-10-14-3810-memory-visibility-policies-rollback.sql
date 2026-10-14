-- Rollback for 3810_memory_visibility_policies.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3810 DID: created public.memory_visibility_policies (the owner's per-Memory
-- ceiling on the §10 person ladder), its owner index, and the security_invoker
-- view public.memory_visibility_policy_effective over it and public.memories.
-- It changed nothing on public.memories.
-- WHAT THIS ROLLBACK DOES: drops the view, then the table — ONLY while the table
-- is empty. A row is an owner's recorded choice ("show nobody who was there");
-- dropping it silently would WIDEN what other people see on that Memory the
-- moment the API reads an absent table as "no ceiling", so the rollback RAISES
-- instead. Clear the ceilings deliberately (or decide what replaces them) first.
--
-- The emptiness check is a nested IF, not `to_regclass(...) IS NOT NULL AND
-- EXISTS (SELECT ... FROM t)`: PostgreSQL plans that whole expression, so on a
-- second run (table already gone) it fails with 42P01 instead of no-op'ing.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_visibility_policies') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.memory_visibility_policies) THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3810): memory_visibility_policies holds owners'' ceilings. Dropping them would widen who is shown on those Memories. Decide what happens to them first.';
    END IF;
  END IF;
END $$;

DROP VIEW IF EXISTS public.memory_visibility_policy_effective;
DROP TABLE IF EXISTS public.memory_visibility_policies;
DELETE FROM public.schema_migration_ledger WHERE filename = '3810_memory_visibility_policies.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.memory_visibility_policy_effective') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3810 rollback): memory_visibility_policy_effective still exists';
  END IF;
  IF to_regclass('public.memory_visibility_policies') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3810 rollback): memory_visibility_policies still exists';
  END IF;
END $post$;
