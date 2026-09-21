-- 2640_collections_single_default_per_owner.sql
--
-- One default collection per owner, enforced by the database rather than by
-- hoping two requests do not arrive at once.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2640.
-- Additive: creates one partial unique index. Drops nothing, rewrites no row,
-- flips no flag, changes no policy. Idempotent (CREATE UNIQUE INDEX IF NOT
-- EXISTS).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- routes/collections.ts ensureDefaultCollection is a get-or-create. Its read
-- ignored `.error`, and supabase-js RESOLVES on a database error, so an
-- unreadable `collections` table was indistinguishable from "this user has no
-- default collection" -- and the very next statement INSERTed a second one. A
-- duplicate created BECAUSE the database was briefly unavailable, persisting
-- long after it recovered.
--
-- The application fix (checking that error, and refusing to create on an
-- unreadable lookup) closes that path. It cannot close the other one: two
-- concurrent requests for a user with no default can both read "none" and both
-- insert. No amount of checking in the application arbitrates that race --
-- only the database can.
--
-- So this index is the authority, and the application's 23505 branch is written
-- against it: losing the race is a SUCCESS for the caller, who re-reads and
-- gets the winner's row.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- BEFORE APPLYING: EXISTING DUPLICATES WILL BLOCK THE INDEX
-- ══════════════════════════════════════════════════════════════════════════════
-- If any owner already has two default collections -- which is exactly what the
-- defect produced -- CREATE UNIQUE INDEX fails. That is the correct behaviour:
-- silently choosing which duplicate to keep is a data decision this migration
-- must not take on its own. The precondition below detects it and names the
-- affected owners so the position can be resolved deliberately.
--
-- MEASURED ON PRODUCTION 2026-09-07, before writing this file:
--
--   collections rows ................................. 1
--   rows with is_default IS TRUE ..................... 0
--   owners holding more than one default ............. 0
--   collections_one_default_per_owner_idx present .... no
--
-- So there is nothing to reconcile -- and the second line matters more than the
-- third: with zero default rows in production, this index constrains nothing
-- there TODAY. It is not decoration, it is the arbiter for the race the
-- application cannot resolve, and it must exist before the rows do rather than
-- after the first duplicate appears. The postcondition says so out loud with a
-- NOTICE rather than reporting a silent success on a vacuous constraint.
--
-- ROLLBACK: db/rollback/2026-09-07-2640-collections-single-default-rollback.sql
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_dupes int;
  v_owners text;
BEGIN
  IF to_regclass('public.collections') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.collections is missing.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'collections' AND column_name = 'is_default'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: collections.is_default is missing; the index cannot be expressed.';
  END IF;

  SELECT count(*), string_agg(owner_id::text, ', ')
    INTO v_dupes, v_owners
    FROM (
      SELECT owner_id FROM public.collections
       WHERE is_default IS TRUE
       GROUP BY owner_id
      HAVING count(*) > 1
    ) d;

  IF v_dupes > 0 THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: % owner(s) already hold more than one default collection, so the unique index cannot be created. Resolve which row survives for each before re-running -- this migration will not choose for you. Owners: %',
      v_dupes, v_owners;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS collections_one_default_per_owner_idx
  ON public.collections (owner_id)
  WHERE is_default IS TRUE;

COMMENT ON INDEX public.collections_one_default_per_owner_idx IS
  'At most one default collection per owner. The authority behind ensureDefaultCollection''s get-or-create: two concurrent requests can both read "no default" and both insert, and no application-side check can arbitrate that. The loser receives 23505 and re-reads the winner''s row. See migration 2640.';

DO $$
DECLARE
  v_dupes int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'collections_one_default_per_owner_idx'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: collections_one_default_per_owner_idx was not created.';
  END IF;

  -- It must be UNIQUE and PARTIAL. A non-unique index would enforce nothing; a
  -- non-partial one would forbid a user from having more than one NON-default
  -- collection, which is the ordinary case and would break the feature.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'collections_one_default_per_owner_idx'
       AND i.indisunique
       AND i.indpred IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: collections_one_default_per_owner_idx is not both UNIQUE and PARTIAL.';
  END IF;

  -- VACUITY GUARD. The index constrains nothing if the table has no defaults to
  -- constrain; that is legal but worth saying out loud rather than reporting a
  -- silent success.
  IF (SELECT count(*) FROM public.collections WHERE is_default IS TRUE) = 0 THEN
    RAISE NOTICE '2640 OK, but VACUOUS on this database: collections holds zero default rows, so the constraint is currently unexercised.';
  END IF;

  SELECT count(*) INTO v_dupes
    FROM (SELECT owner_id FROM public.collections WHERE is_default IS TRUE GROUP BY owner_id HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % owner(s) still hold multiple defaults after the index was created, which should be impossible.', v_dupes;
  END IF;
END $$;

COMMIT;
