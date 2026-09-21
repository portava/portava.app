-- Rollback for 2797_trip_commitment_recurrences.sql
--
-- Drops public.trip_commitment_recurrences. Safe while nothing writes it, which
-- is the state 2797 ships in (no client write grants, and the kernel family is
-- 2798). If 2798 HAS been applied, its rollback must run FIRST: this file
-- refuses otherwise, because dropping the table under a live writer turns every
-- ADD_RECURRING_COMMITMENT into a 42P01 escaping the kernel.
--
-- DATA: a rule row is the ONLY place its pattern exists — occurrences are never
-- materialised, so there is nothing else to reconstruct it from. The warning
-- below says how many are about to go.
--
-- No DROP ... CASCADE, for 2761's rollback's reason: a cascade removes things
-- you cannot see.
--
-- Rehearsed on db/harness/run.sh.

BEGIN;

DO $pre$
DECLARE n int; d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NOT NULL AND position('ADD_RECURRING_COMMITMENT' in d) > 0 THEN
    RAISE EXCEPTION 'rollback 2797: the kernel still carries the recurrence family (2798). Roll 2798 back first, or this drops the table out from under its writer.';
  END IF;

  IF to_regclass('public.trip_commitment_recurrences') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.trip_commitment_recurrences' INTO n;
    IF n > 0 THEN
      RAISE WARNING 'rollback 2797: % recurrence rule(s) are about to be dropped. Occurrences were never materialised, so no other table holds the pattern.', n;
    END IF;
  END IF;
END
$pre$;

DROP TABLE IF EXISTS public.trip_commitment_recurrences;

DO $post$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public' AND table_name='trip_commitment_recurrences';
  IF n <> 0 THEN RAISE EXCEPTION 'rollback 2797: the table survived the drop'; END IF;

  -- 2761's tables are not this rollback's business and must be untouched.
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public' AND table_name IN ('trip_commitments','trip_stages');
  IF n <> 2 THEN RAISE EXCEPTION 'rollback 2797: trip_commitments/trip_stages were removed; that is 2761''s and 2760''s rollbacks'; END IF;
END
$post$;

COMMIT;
