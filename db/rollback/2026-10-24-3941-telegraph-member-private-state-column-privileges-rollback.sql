-- Rollback for 3941_telegraph_member_private_state_column_privileges.sql (lane TELEGRAPH, census drive
-- 2026-10-24; branch claude/telegraph-archived-write-guard-20261024).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3941 DID (one transaction, privileges only): for anon and authenticated, replaced whatever SELECT
-- they held on public.message_thread_members (a table-level grant, or 3940's column grants) with a
-- column-level SELECT on the same columns minus last_read_at, archived_at, muted_at and, where 3760 is
-- applied, notification_level and muted_until. No data, policy, function, trigger or flag changed.
-- service_role was not touched.
--
-- WHAT THIS DOES: grants SELECT on exactly those private columns (each one that exists) back to anon and
-- authenticated, at column level, then deletes 3941's ledger row so the runner re-applies it later. It
-- touches no other column: if 3940 withheld the receipt cursors, they STAY withheld (to restore the
-- baseline's table-level grant, roll back 3940 as well, with its own file). RLS is unchanged throughout:
-- rows stay exactly as visible as they were.
--
-- WHAT IT REOPENS (say it before running it): every active member of a thread can again read every
-- co-member's last_read_at (when they last read — a presence signal and a per-member read receipt in a
-- group), archived_at and muted_at (and notification_level / muted_until) through PostgREST.
--
-- DATA: none is read or written apart from the ledger row. A second run is a no-op apart from the ledger
-- delete. Run it in its own session: psql -X -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regclass('public.message_thread_members') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3941 rollback): public.message_thread_members does not exist.';
  END IF;
END $pre$;

DO $restore$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_cols
    FROM pg_attribute
   WHERE attrelid = 'public.message_thread_members'::regclass AND attnum > 0 AND NOT attisdropped
     AND attname IN ('last_read_at', 'archived_at', 'muted_at', 'notification_level', 'muted_until');
  EXECUTE format('GRANT SELECT (%s) ON public.message_thread_members TO anon, authenticated', v_cols);
END $restore$;

DO $post$
DECLARE
  r text;
  c text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH c IN ARRAY ARRAY['last_read_at', 'archived_at', 'muted_at'] LOOP
      IF NOT has_column_privilege(r, 'public.message_thread_members', c, 'SELECT') THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3941 rollback): % cannot read message_thread_members.%.', r, c;
      END IF;
    END LOOP;
  END LOOP;
END $post$;

DELETE FROM public.schema_migration_ledger WHERE filename = '3941_telegraph_member_private_state_column_privileges.sql';

COMMIT;
