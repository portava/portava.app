-- Rollback for 3940_telegraph_member_cursor_column_privileges.sql (census-telegraph T72/T73; lane TELEGRAPH,
-- census drive 2026-10-24, PR #786).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3940 DID (one transaction, privileges only): replaced anon's and authenticated's SELECT on
-- public.message_thread_members with a COLUMN-level SELECT on the columns each could read before, minus
-- delivered_sequence and seen_sequence. No data, policy, function, trigger or flag changed. service_role was not
-- touched.
--
-- WHAT THIS DOES: grants the two cursor columns back to both roles at COLUMN level, then deletes 3940's ledger row so
-- the runner re-applies it later. It does NOT restore a table-level SELECT: that would also hand back any column
-- another migration has withheld since (3941's private member columns), so every other column keeps whatever
-- privilege it has now. RLS is unchanged throughout: rows stay exactly as visible as they were.
--
-- WHAT IT REOPENS (say it before running it): every active member of a thread can again read every co-member's
-- delivered_sequence and seen_sequence through PostgREST. Once the server release that WRITES delivered_sequence is
-- deployed, that is a presence disclosure (when a person's connection was open). Roll back the server's cursor
-- writes first, or accept the disclosure deliberately.
--
-- DATA: none is read or written apart from the ledger row. A second run is a no-op apart from the ledger delete.
-- Run it in its own session: psql -X -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regclass('public.message_thread_members') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3940 rollback): public.message_thread_members does not exist.';
  END IF;
END $pre$;

GRANT SELECT (delivered_sequence, seen_sequence) ON public.message_thread_members TO anon, authenticated;

DO $post$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT (has_column_privilege(r, 'public.message_thread_members', 'delivered_sequence', 'SELECT')
            AND has_column_privilege(r, 'public.message_thread_members', 'seen_sequence', 'SELECT')) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3940 rollback): % cannot read the cursor columns again.', r;
    END IF;
  END LOOP;
  IF NOT (has_column_privilege('service_role', 'public.message_thread_members', 'delivered_sequence', 'SELECT')
          AND has_column_privilege('service_role', 'public.message_thread_members', 'seen_sequence', 'SELECT')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3940 rollback): the API''s service role cannot read the cursors.';
  END IF;
END $post$;

DELETE FROM public.schema_migration_ledger WHERE filename = '3940_telegraph_member_cursor_column_privileges.sql';

COMMIT;
