-- 3937_telegraph_slo_duplicate_canonical.sql
-- Telegraph §28 SLO-02 "duplicate canonical messages = 0 under the idempotency contract",
-- measured EXACTLY from the canonical store (census-telegraph T347). POST-CUTOVER CANONICAL
-- FORWARD MIGRATION (3000-3999 band; lane TELEGRAPH's census-drive band 3934-3949, 2026-10-24).
--
-- WRITTEN, NOT APPLIED. One read-only function. No table, row, policy or flag changes;
-- EXECUTE is the service role's only.
--
-- WHY. SLO-02's emitter was the request middleware: it remembers the (threadId, clientId)
-- pairs one process saw accepted, so a duplicate across two instances or a restart was never
-- seen — "a floor on the true number, never a ceiling". The exact version needed the
-- idempotency key the send path did not have (T231); it has it now (2810's columns, the
-- door writes them while telegraph_idempotent_send_enabled is ON, TRUE on production since
-- 2026-10-23). The exact count is then a property of `messages` itself: two canonical rows
-- that one sender sent into one conversation under one idempotency key (or, where an older
-- door stored only the client id, one client message id). PostgREST cannot group, so the
-- count is this function.
--
-- WHAT IT RETURNS. duplicate_rows = Σ (rows per key − 1) over keys with more than one row —
-- the number of canonical messages that should not exist — and keyed_groups, the number of
-- keys the contract covers, so a reader can tell "0 duplicates among N keyed sends" from
-- "nothing was keyed". A message with neither key (a pre-2810 send, or a client that sent
-- none) is outside the contract and is not counted either way.
--
-- COST. One pass over messages with a key, grouped; called on demand by the admin-only,
-- audited diagnostics read (routes/telegraphDiagnostics.ts), never on a traveller's path.
--
-- ORDER INDEPENDENCE: depends only on 2810's messages.idempotency_key / client_message_id.
-- Nothing numbered above 3937 defines a function of this name.
--
-- ROLLBACK:
--   BEGIN;
--   DROP FUNCTION IF EXISTS public.telegraph_duplicate_canonical_messages();
--   DELETE FROM public.schema_migration_ledger WHERE filename = '3937_telegraph_slo_duplicate_canonical.sql';
--   COMMIT;

BEGIN;

DO $pre$
BEGIN
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.messages'::regclass AND attnum > 0 AND NOT attisdropped
         AND attname IN ('idempotency_key', 'client_message_id', 'thread_id', 'sender_id')) <> 4 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3937): messages must carry thread_id, sender_id and 2810''s idempotency_key / client_message_id.';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.telegraph_duplicate_canonical_messages()
RETURNS TABLE (duplicate_rows bigint, keyed_groups bigint)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $fn$
  WITH keyed AS (
    SELECT m.thread_id, m.sender_id, COALESCE(m.idempotency_key, m.client_message_id) AS k, count(*) AS c
      FROM public.messages m
     WHERE COALESCE(m.idempotency_key, m.client_message_id) IS NOT NULL
     GROUP BY m.thread_id, m.sender_id, COALESCE(m.idempotency_key, m.client_message_id)
  )
  SELECT COALESCE(sum(c - 1) FILTER (WHERE c > 1), 0)::bigint, count(*)::bigint FROM keyed
$fn$;

COMMENT ON FUNCTION public.telegraph_duplicate_canonical_messages() IS
  'Telegraph §28 SLO-02 (census-telegraph T347, 3937): the exact count of duplicate canonical messages under the idempotency contract — rows per (thread, sender, idempotency key or client message id) beyond the first — and how many keys the contract covers. Read-only; service role only.';

REVOKE ALL ON FUNCTION public.telegraph_duplicate_canonical_messages() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.telegraph_duplicate_canonical_messages() TO service_role;

COMMIT;

DO $post$
BEGIN
  IF to_regprocedure('public.telegraph_duplicate_canonical_messages()') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3937): telegraph_duplicate_canonical_messages() is missing.';
  END IF;
  IF has_function_privilege('anon', 'public.telegraph_duplicate_canonical_messages()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.telegraph_duplicate_canonical_messages()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3937): a client role can execute telegraph_duplicate_canonical_messages().';
  END IF;
END $post$;
