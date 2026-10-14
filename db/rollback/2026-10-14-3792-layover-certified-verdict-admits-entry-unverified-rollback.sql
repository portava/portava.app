-- Rollback for 3792_layover_certified_verdict_admits_entry_unverified.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3792 DID: replaced 2700's four-value CHECK on
-- `layover_certified_computations.verdict` with one admitting the engine's five
-- verdicts ('entry_unverified' added).
--
-- WHAT THIS ROLLBACK DOES: restores 2700's four-value CHECK under the same name
-- PostgreSQL gave 2700's inline CHECK (`layover_certified_computations_verdict_check`),
-- and deletes 3792's ledger row so the applier can re-apply it.
--
-- IT REFUSES, and changes nothing, in two cases:
--   * a stored computation carries a verdict outside 2700's four. The restored
--     CHECK would fail on it, and deleting certified history to make a
--     constraint fit is not a rollback.
--   * `layover_decision_persistence_enabled` is ON. Narrowing the CHECK while
--     decisions are being stored brings the defect back: every roomy layover
--     with an unconfirmed entry corridor fails to store.
--
-- ORDER: turn `layover_decision_persistence_enabled` OFF first. On a database
-- without 2700's table there is nothing 3792 could have changed; the ledger
-- delete is then the whole rollback, and a second run is a no-op.

BEGIN;

DO $pre$
DECLARE
  widened integer;
BEGIN
  IF to_regclass('public.layover_certified_computations') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.feature_flags
     WHERE flag = 'layover_decision_persistence_enabled' AND enabled = TRUE
  ) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3792): layover_decision_persistence_enabled is ON. Restoring 2700''s four-value verdict CHECK while decisions are being stored makes every roomy layover with an unconfirmed entry corridor fail to store again. Turn the flag OFF first.';
  END IF;
  SELECT count(*) INTO widened
    FROM public.layover_certified_computations
   WHERE verdict NOT IN ('yes', 'tight', 'no', 'stay_airside');
  IF widened > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3792): % stored computation(s) carry a verdict 2700''s CHECK does not admit. Restoring that CHECK would fail on them, and deleting certified history to make a constraint fit is not a rollback. Leave 3792 in place.', widened;
  END IF;
END $pre$;

DO $restore$
DECLARE
  c record;
BEGIN
  IF to_regclass('public.layover_certified_computations') IS NULL THEN
    RETURN;
  END IF;
  FOR c IN
    SELECT con.conname
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_attribute att
        ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
     WHERE con.conrelid = 'public.layover_certified_computations'::regclass
       AND con.contype = 'c'
       AND att.attname = 'verdict'
       AND cardinality(con.conkey) = 1
  LOOP
    EXECUTE format('ALTER TABLE public.layover_certified_computations DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE public.layover_certified_computations
    ADD CONSTRAINT layover_certified_computations_verdict_check
    CHECK (verdict IN ('yes', 'tight', 'no', 'stay_airside'));
END $restore$;

DELETE FROM public.schema_migration_ledger
 WHERE filename = '3792_layover_certified_verdict_admits_entry_unverified.sql';

COMMIT;

DO $post$
DECLARE
  members text[];
BEGIN
  IF to_regclass('public.layover_certified_computations') IS NULL THEN
    RETURN;
  END IF;
  -- Every member of every single-column verdict CHECK, pooled: a second CHECK
  -- left behind shows up as a duplicate and fails the comparison.
  SELECT array_agg(m.v ORDER BY m.v) INTO members
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_attribute att
      ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    LEFT JOIN LATERAL (
      SELECT x[1] AS v
        FROM regexp_matches(pg_catalog.pg_get_constraintdef(con.oid), '''([a-z_]+)''::text', 'g') AS r(x)
    ) m ON TRUE
   WHERE con.conrelid = 'public.layover_certified_computations'::regclass
     AND con.contype = 'c'
     AND att.attname = 'verdict'
     AND cardinality(con.conkey) = 1;
  IF members IS DISTINCT FROM ARRAY['no', 'stay_airside', 'tight', 'yes'] THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3792 rollback): 2700''s four-value verdict CHECK is not restored exactly; the single-column verdict CHECK(s) admit %', members;
  END IF;
END $post$;
