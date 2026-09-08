-- Rollback for 2700_layover_certified_feasibility.sql
--
-- Applied to portava-ci (hwokxgbmezheskbzskfr) 2026-09-08 as version
-- 20260908145925. NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- ── WHAT MAKES THIS INVERSE COMPLETE, AND HOW THAT WAS ESTABLISHED ───────────
--
-- 2741's rollback taught the lesson this file is written against: a rehearsal
-- over an EMPTY table proved nothing, and three residues only appeared once a
-- `returning` session and an abort ledger row were seeded. That was a migration
-- that ALTERED live objects, so the inverse had to RESTORE a prior state, and
-- "restore" is where residue hides.
--
-- 2700 is the other shape. It creates a table that did not exist; there is no
-- prior state to restore, and the completeness question reduces to "does the
-- DROP take everything the CREATE made". Rehearsed on CI 2026-09-08 inside a
-- transaction that was ROLLED BACK, counting by NAME rather than by assumption:
--
--   before  relations 4 (table + pkey + 2 indexes), policies 1, grants ≥1
--   after   relations 0, policies 0, grants 0
--   and     layover_recommendations still 22 columns — the migration's own
--           postcondition asserts it adds no citation column there, and the
--           rollback must not remove one either
--
-- Seeding rows would not have changed that answer, and this file says so rather
-- than performing a seeding that proves nothing: DROP TABLE removes the table
-- with its contents, its indexes, its policies and its grants in one act. The
-- one thing that COULD have made the DROP incomplete is an inbound foreign key
-- from another table, which would make it fail rather than half-succeed —
-- measured as 0 before the rehearsal.
--
-- ── WHEN THIS IS NO LONGER SAFE ──────────────────────────────────────────────
--
-- While no writer exists, this discards nothing. The moment a writer lands,
-- DROP discards certified computation HISTORY — the replayable record the table
-- exists to keep. Roll the writer back first, then this.

BEGIN;

DROP TABLE IF EXISTS public.layover_certified_computations;

-- ── postconditions: residue by name, not by faith ───────────────────────────
DO $$
DECLARE
  leftover_relations INTEGER;
  leftover_policies  INTEGER;
  leftover_grants    INTEGER;
  rec_cols           INTEGER;
BEGIN
  SELECT count(*) INTO leftover_relations
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('layover_certified_computations',
                       'layover_certified_computations_pkey',
                       'layover_certcomp_session_idx',
                       'layover_certcomp_session_hash_uidx');
  IF leftover_relations <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: % relation(s) named by 2700 survive the DROP', leftover_relations;
  END IF;

  SELECT count(*) INTO leftover_policies FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'layover_certified_computations';
  IF leftover_policies <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: % policy row(s) survive', leftover_policies;
  END IF;

  SELECT count(*) INTO leftover_grants FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'layover_certified_computations';
  IF leftover_grants <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: % grant(s) survive', leftover_grants;
  END IF;

  -- The forward migration touched no existing object. Neither may this: if the
  -- rollback has somehow removed a column from layover_recommendations, the two
  -- files disagree about what 2700 did and BOTH are suspect.
  SELECT count(*) INTO rec_cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'layover_recommendations';
  IF rec_cols <> 22 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: layover_recommendations has % columns, expected the 22 it had before and after 2700', rec_cols;
  END IF;
END $$;

COMMIT;
