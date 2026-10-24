-- 3940_telegraph_member_cursor_column_privileges.sql
-- No client role can read another member's — or its own — receipt cursors (census-telegraph T72/T73,
-- verifier finding on PR #786). POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane
-- TELEGRAPH's census-drive band 3934-3949, 2026-10-24).
--
-- WRITTEN, NOT APPLIED. A privilege change on one table. No data, policy, function or flag change.
--
-- THE LEAK. Batch 2 (#786) makes the server WRITE message_thread_members.delivered_sequence (2810's
-- column): it moves when a member's open realtime connection takes a live message. On production
-- `anon` and `authenticated` hold a TABLE-level SELECT on message_thread_members, and policy
-- mtm_select lets every active member read every row of their thread. So any member of a group could
-- poll a co-member's delivered_sequence through PostgREST and learn WHEN that person was online — the
-- presence disclosure the receipt rules exist to prevent (a group receipt carries only a COUNT;
-- src/test/telegraphDeliveryReceipts.test.ts). seen_sequence is the same shape (it moves when that
-- member's read marker does). Receipts are a server answer under the DM/group rules (GET
-- /threads/:id/receipts), never a raw column.
--
-- THE FIX. A column privilege cannot be revoked from under a table-level grant, so the table-level
-- SELECT is replaced by a column-level SELECT on EVERY column except delivered_sequence and
-- seen_sequence, for exactly the two roles that held it (anon keeps exactly what it had, minus the
-- two columns; RLS still gives it no row). The list is read from the catalog so a column this table
-- has on one database and not another (removed_at, 3934) is carried as it is. INSERT, UPDATE and
-- DELETE grants are untouched (no client policy admits them). service_role — the API's client, which
-- serves receipts — keeps its full table-level privileges.
--
-- WHO READS THE CURSORS TODAY (inventoried 2026-10-24): only the API, through the service role
-- (routes/telegraphLifecycle.ts receipts; services/telegraph/unsend.ts; the definer function
-- telegraph_unsend_message_before_seen). The mobile client has no PostgREST read of
-- message_thread_members at all (removed for T295; the telegraph-slos ratchet pins it), in this tree
-- and in the owner's device build. No view depends on the table; no client-executable function reads
-- either column.
--
-- A COLUMN ADDED LATER is not client-readable until a migration grants it — the safe default for a
-- table whose rows describe other people.
--
-- ORDER: depends on 2810 (the two columns); reads 3934's removed_at only if present. Nothing numbered
-- above 3940 grants SELECT on this table.
--
-- ROLLBACK (restores the table-level SELECT; the leak returns with it):
--   BEGIN;
--   GRANT SELECT ON public.message_thread_members TO anon, authenticated;
--   DELETE FROM public.schema_migration_ledger WHERE filename = '3940_telegraph_member_cursor_column_privileges.sql';
--   COMMIT;

BEGIN;

DO $pre$
BEGIN
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.message_thread_members'::regclass AND NOT attisdropped
        AND attname IN ('delivered_sequence', 'seen_sequence')) <> 2 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3940): message_thread_members must carry 2810''s delivered_sequence and seen_sequence.';
  END IF;
END $pre$;

REVOKE SELECT ON public.message_thread_members FROM anon, authenticated;

DO $grant$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_cols
    FROM pg_attribute
   WHERE attrelid = 'public.message_thread_members'::regclass AND attnum > 0 AND NOT attisdropped
     AND attname NOT IN ('delivered_sequence', 'seen_sequence');
  EXECUTE format('GRANT SELECT (%s) ON public.message_thread_members TO anon, authenticated', v_cols);
END $grant$;

COMMIT;

DO $post$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(r, 'public.message_thread_members', 'SELECT') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3940): % still holds a table-level SELECT on message_thread_members.', r;
    END IF;
    IF has_column_privilege(r, 'public.message_thread_members', 'delivered_sequence', 'SELECT')
       OR has_column_privilege(r, 'public.message_thread_members', 'seen_sequence', 'SELECT') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3940): % can read a receipt cursor.', r;
    END IF;
    IF NOT (has_column_privilege(r, 'public.message_thread_members', 'thread_id', 'SELECT')
            AND has_column_privilege(r, 'public.message_thread_members', 'user_id', 'SELECT')
            AND has_column_privilege(r, 'public.message_thread_members', 'left_at', 'SELECT')
            AND has_column_privilege(r, 'public.message_thread_members', 'last_read_at', 'SELECT')) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3940): % lost a column it held before.', r;
    END IF;
  END LOOP;
  IF NOT (has_column_privilege('service_role', 'public.message_thread_members', 'delivered_sequence', 'SELECT')
          AND has_column_privilege('service_role', 'public.message_thread_members', 'seen_sequence', 'SELECT')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3940): the API''s service role can no longer read the cursors.';
  END IF;
END $post$;
