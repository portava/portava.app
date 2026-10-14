-- Rollback for 3813_memories_client_privileges_revoked.sql (lane MEM-ACL, B58;
-- verifier V-716 fix 2, owner question OQ-716-1).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3813 DID: REVOKE ALL ON public.memories FROM PUBLIC, anon, authenticated.
-- Nothing else: no policy, row, function, trigger or service_role privilege.
--
-- WHAT THIS DOES: re-grants SELECT, INSERT, UPDATE and DELETE on public.memories
-- to anon and authenticated, and deletes 3813's ledger row so the runner
-- re-applies 3813 later. That is the state the chain left before 3813: the
-- baseline's GRANT ALL (:36638-36639) as 2490 narrowed it. It deliberately does
-- NOT re-issue the baseline's GRANT ALL: TRUNCATE, REFERENCES, TRIGGER and
-- MAINTAIN are privileges RLS never polices, and 2490 took them from every
-- table; a rollback of 3813 must not undo 2490.
--
-- ⚠ IT RE-OPENS THE DOOR 3813 CLOSED: any signed-in user reads every column of
-- another person's published public Memory through PostgREST (exact coordinates,
-- place references, the owner's audience lists), and an owner writes any column
-- of their own rows (state, location_precision, a hard DELETE). Use it only to
-- recover from a client reader 3813 broke, and re-apply 3813 as soon as that
-- reader is on the API.
--
-- Refuses unless RLS is on and both of the policies that bound the re-granted
-- privileges are present: without them the re-grant would expose every row.

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.memories') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3813 rollback): public.memories does not exist.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.memories'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3813 rollback): RLS is not enabled on public.memories; re-granting the client roles would expose every row.';
  END IF;
  IF (SELECT count(*) FROM pg_policy
       WHERE polrelid = 'public.memories'::regclass
         AND polname IN ('memories_owner_all', 'memories_public_read')) <> 2 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3813 rollback): memories_owner_all and memories_public_read are not both present; the rows the re-granted privileges reach would need re-deriving.';
  END IF;
END $pre$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.memories TO anon, authenticated;
DELETE FROM public.schema_migration_ledger WHERE filename = '3813_memories_client_privileges_revoked.sql';

COMMIT;

DO $post$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(r || ':' || p, ', ')
    INTO v_missing
    FROM unnest(ARRAY['anon', 'authenticated']) r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
   WHERE NOT has_table_privilege(r, 'public.memories', p);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3813 rollback): the pre-3813 client grants are not back: %.', v_missing;
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated']) r, unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']) p
              WHERE has_table_privilege(r, 'public.memories', p)) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3813 rollback): a client role holds a privilege RLS does not police on public.memories (2490).';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3813_memories_client_privileges_revoked.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3813 rollback): the ledger still records 3813 as applied.';
  END IF;
END $post$;
