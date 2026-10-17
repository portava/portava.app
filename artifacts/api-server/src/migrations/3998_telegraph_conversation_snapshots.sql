-- 3998_telegraph_conversation_snapshots.sql
--
-- Telegraph §12 `conversation_snapshots` — "Rebuild/replay checkpoints where
-- useful." (census-telegraph T155.)
--
-- WHERE IT IS USEFUL. The coordination view reads a conversation's
-- COORDINATION_SESSION and COORDINATION_TRANSITION messages by kind, newest
-- first, capped at SESSION_SCAN_LIMIT (routes/telegraphCoordination.ts). A
-- thread with more session-kind rows than that loses the oldest ones from the
-- fold — a long-running session's early transitions, an earlier session — and
-- the response says `sessionScanTruncated: true`. census-telegraph §33.7 named
-- exactly that number as what would make a checkpoint worth having. This is the
-- checkpoint: the fold's input, every live session-kind row of one thread up to
-- a cursor, stored once; the read then replays only the rows after the cursor
-- through the SAME projection (projectConversationSessions).
--
-- A SECOND COPY THAT CANNOT OUTLIVE ITS SOURCE (§33.7's objection, answered).
-- A checkpoint holds message-derived content, so it must never survive a
-- change to a message it was built from — an edit, an unsend, a delete, an
-- account deletion's cascade over the sender's messages, or a row committed
-- with a timestamp at or before the cursor. Four triggers on public.messages
-- delete the thread's checkpoint in the same transaction as any such change,
-- whatever the flag says, and the thread's own deletion cascades. The writer
-- and every trigger take one per-thread advisory lock, so a checkpoint being
-- written and a message changing in the same thread serialize: whichever
-- commits second sees the other.
--
-- OFF BY DEFAULT. `telegraph_conversation_snapshots_enabled` is seeded FALSE.
-- Off, the writer writes nothing and the coordination read is byte-identical to
-- the read before this migration. Service role only: no client may read or
-- write a checkpoint.

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3998): public.messages must exist.';
  END IF;
  IF to_regclass('public.message_threads') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3998): public.message_threads must exist.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3998): public.feature_flags must exist.';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'messages'
         AND column_name IN ('id', 'thread_id', 'sender_id', 'created_at', 'msg_type', 'body', 'deleted_at')) <> 7 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3998): public.messages must carry id, thread_id, sender_id, created_at, msg_type, body and deleted_at.';
  END IF;
END $pre$;


CREATE TABLE IF NOT EXISTS public.conversation_snapshots (
  thread_id          uuid        NOT NULL REFERENCES public.message_threads(id) ON DELETE CASCADE,
  -- The projection this checkpoint feeds. One today; a closed list, so a second
  -- projection is a migration that says what invalidates it.
  projection         text        NOT NULL CHECK (projection = 'coordination_sessions'),
  projection_version integer     NOT NULL CHECK (projection_version = 1),
  -- The cursor: the last row folded in, by (created_at, id). The read replays
  -- every row strictly after it.
  through_created_at timestamptz NOT NULL,
  through_message_id uuid        NOT NULL,
  row_count          integer     NOT NULL CHECK (row_count BETWEEN 1 AND 2000),
  -- The fold's input through the cursor, oldest first: id, sender_id,
  -- created_at, msg_type and body of each live session-kind message.
  rows               jsonb       NOT NULL CHECK (jsonb_typeof(rows) = 'array'),
  written_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, projection),
  CONSTRAINT conversation_snapshots_count_matches CHECK (jsonb_array_length(rows) = row_count)
);

ALTER TABLE public.conversation_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conversation_snapshots FROM PUBLIC;
REVOKE ALL ON public.conversation_snapshots FROM anon;
REVOKE ALL ON public.conversation_snapshots FROM authenticated;
REVOKE ALL ON public.conversation_snapshots FROM service_role;
GRANT SELECT ON public.conversation_snapshots TO service_role;
DROP POLICY IF EXISTS conversation_snapshots_service_read ON public.conversation_snapshots;
CREATE POLICY conversation_snapshots_service_read ON public.conversation_snapshots
  FOR SELECT TO service_role USING (true);

COMMENT ON TABLE public.conversation_snapshots IS
  'Telegraph §12 conversation_snapshots (census-telegraph T155, migration 3998): a checkpoint of the coordination-session fold''s input (every live coordination_session / coordination_transition message of one thread through a (created_at, id) cursor). Read by the coordination view, which replays only the rows after the cursor. Written only by telegraph_write_conversation_snapshot under telegraph_conversation_snapshots_enabled. Deleted in the same transaction as any edit, unsend, delete or backdated insert of a session-kind message in the thread (four triggers on public.messages, flag-independent) and with the thread. Service role reads; nobody else.';


CREATE OR REPLACE FUNCTION public.telegraph_write_conversation_snapshot(p_thread_id uuid, p_projection text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_enabled    boolean;
  v_count      integer;
  v_rows       jsonb;
  v_through_at timestamptz;
  v_through_id uuid;
BEGIN
  IF p_projection IS DISTINCT FROM 'coordination_sessions' THEN
    RETURN jsonb_build_object('outcome', 'unknown_projection');
  END IF;
  SELECT f.enabled INTO v_enabled FROM public.feature_flags f
   WHERE f.flag = 'telegraph_conversation_snapshots_enabled';
  IF v_enabled IS NOT TRUE THEN
    RETURN jsonb_build_object('outcome', 'disabled');
  END IF;

  -- The lock every trigger below also takes. The statements after it run on a
  -- fresh snapshot, so every message change committed before the lock is seen,
  -- and a change that commits after it waits for this transaction and then
  -- deletes what is written here.
  PERFORM pg_advisory_xact_lock(hashtextextended('conversation_snapshots:' || p_thread_id::text, 0));

  SELECT count(*)::integer,
         jsonb_agg(jsonb_build_object('id', s.id, 'sender_id', s.sender_id, 'created_at', s.created_at,
                                      'msg_type', s.msg_type, 'body', s.body) ORDER BY s.created_at, s.id)
    INTO v_count, v_rows
    FROM (SELECT m.id, m.sender_id, m.created_at, m.msg_type, m.body
            FROM public.messages m
           WHERE m.thread_id = p_thread_id
             AND m.msg_type IN ('coordination_session', 'coordination_transition')
             AND m.deleted_at IS NULL
           ORDER BY m.created_at, m.id
           LIMIT 2001) s;

  IF v_count = 0 THEN
    DELETE FROM public.conversation_snapshots WHERE thread_id = p_thread_id AND projection = p_projection;
    RETURN jsonb_build_object('outcome', 'empty', 'row_count', 0);
  END IF;
  IF v_count > 2000 THEN
    RETURN jsonb_build_object('outcome', 'too_large', 'row_count', v_count);
  END IF;

  SELECT m.created_at, m.id INTO v_through_at, v_through_id
    FROM public.messages m
   WHERE m.thread_id = p_thread_id
     AND m.msg_type IN ('coordination_session', 'coordination_transition')
     AND m.deleted_at IS NULL
   ORDER BY m.created_at DESC, m.id DESC
   LIMIT 1;

  INSERT INTO public.conversation_snapshots
    (thread_id, projection, projection_version, through_created_at, through_message_id, row_count, rows, written_at)
  VALUES
    (p_thread_id, p_projection, 1, v_through_at, v_through_id, v_count, v_rows, now())
  ON CONFLICT (thread_id, projection) DO UPDATE
    SET projection_version = EXCLUDED.projection_version,
        through_created_at = EXCLUDED.through_created_at,
        through_message_id = EXCLUDED.through_message_id,
        row_count          = EXCLUDED.row_count,
        rows               = EXCLUDED.rows,
        written_at         = EXCLUDED.written_at;

  RETURN jsonb_build_object('outcome', 'written', 'row_count', v_count,
                            'through_created_at', v_through_at, 'through_message_id', v_through_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.telegraph_write_conversation_snapshot(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.telegraph_write_conversation_snapshot(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.telegraph_write_conversation_snapshot(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.telegraph_write_conversation_snapshot(uuid, text) TO service_role;

COMMENT ON FUNCTION public.telegraph_write_conversation_snapshot(uuid, text) IS
  'Telegraph §12 (3998, census-telegraph T155): writes the coordination_sessions checkpoint of one thread under the per-thread advisory lock the invalidation triggers take. Outcomes: written | empty (no live session-kind row; any checkpoint is removed) | too_large (more than 2000 rows; nothing written) | disabled (telegraph_conversation_snapshots_enabled is not TRUE) | unknown_projection. service_role only.';


CREATE OR REPLACE FUNCTION public.telegraph_conversation_snapshot_invalidate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    DELETE FROM public.conversation_snapshots;
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('conversation_snapshots:' || NEW.thread_id::text, 0));
    -- Only a row at or before the cursor changes what the checkpoint holds; a
    -- row after it is in the replayed tail.
    DELETE FROM public.conversation_snapshots s
     WHERE s.thread_id = NEW.thread_id
       AND (s.through_created_at, s.through_message_id) >= (NEW.created_at, NEW.id);
    RETURN NULL;
  END IF;
  -- UPDATE and DELETE: the checkpoint of every thread the row was or is in goes.
  PERFORM pg_advisory_xact_lock(hashtextextended('conversation_snapshots:' || OLD.thread_id::text, 0));
  DELETE FROM public.conversation_snapshots s WHERE s.thread_id = OLD.thread_id;
  IF TG_OP = 'UPDATE' AND NEW.thread_id IS DISTINCT FROM OLD.thread_id THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('conversation_snapshots:' || NEW.thread_id::text, 0));
    DELETE FROM public.conversation_snapshots s WHERE s.thread_id = NEW.thread_id;
  END IF;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.telegraph_conversation_snapshot_invalidate() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.telegraph_conversation_snapshot_invalidate() FROM anon;
REVOKE ALL ON FUNCTION public.telegraph_conversation_snapshot_invalidate() FROM authenticated;

COMMENT ON FUNCTION public.telegraph_conversation_snapshot_invalidate() IS
  'Telegraph §12 (3998, census-telegraph T155): deletes a thread''s conversation_snapshots when a session-kind message in it changes thread, sender, time, kind, body or deleted_at (edit, unsend, delete-for-everyone, any tombstone), deleted (including an account deletion''s cascade) or inserted at or before the checkpoint''s cursor; TRUNCATE of messages removes every checkpoint. Same transaction, same per-thread advisory lock as the writer. Not flag-gated.';

DROP TRIGGER IF EXISTS telegraph_conversation_snapshot_on_insert ON public.messages;
CREATE TRIGGER telegraph_conversation_snapshot_on_insert
  AFTER INSERT ON public.messages
  FOR EACH ROW
  WHEN (NEW.msg_type IN ('coordination_session', 'coordination_transition'))
  EXECUTE FUNCTION public.telegraph_conversation_snapshot_invalidate();

DROP TRIGGER IF EXISTS telegraph_conversation_snapshot_on_update ON public.messages;
-- Only the columns a checkpoint holds or filters on, and only when one of them
-- actually changed: a translation or language-detection write to a session row
-- does not touch what the fold reads and must not discard the checkpoint.
CREATE TRIGGER telegraph_conversation_snapshot_on_update
  AFTER UPDATE OF thread_id, sender_id, created_at, msg_type, body, deleted_at ON public.messages
  FOR EACH ROW
  WHEN ((OLD.msg_type IN ('coordination_session', 'coordination_transition')
         OR NEW.msg_type IN ('coordination_session', 'coordination_transition'))
        AND (OLD.thread_id, OLD.sender_id, OLD.created_at, OLD.msg_type, OLD.body, OLD.deleted_at)
            IS DISTINCT FROM (NEW.thread_id, NEW.sender_id, NEW.created_at, NEW.msg_type, NEW.body, NEW.deleted_at))
  EXECUTE FUNCTION public.telegraph_conversation_snapshot_invalidate();

DROP TRIGGER IF EXISTS telegraph_conversation_snapshot_on_delete ON public.messages;
CREATE TRIGGER telegraph_conversation_snapshot_on_delete
  AFTER DELETE ON public.messages
  FOR EACH ROW
  WHEN (OLD.msg_type IN ('coordination_session', 'coordination_transition'))
  EXECUTE FUNCTION public.telegraph_conversation_snapshot_invalidate();

DROP TRIGGER IF EXISTS telegraph_conversation_snapshot_on_truncate ON public.messages;
CREATE TRIGGER telegraph_conversation_snapshot_on_truncate
  AFTER TRUNCATE ON public.messages
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.telegraph_conversation_snapshot_invalidate();


INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('telegraph_conversation_snapshots_enabled', false,
   'CAPABILITY gate for Telegraph §12 conversation_snapshots (census-telegraph T155, migration 3998). OFF (the seed): telegraph_write_conversation_snapshot writes nothing and GET /threads/:id/coordination reads its session rows exactly as before 3998 (newest SESSION_SCAN_LIMIT, truncation stated). ON: when that read is truncated the server checkpoints the thread''s session-kind rows and the view replays only the rows after the checkpoint. The invalidation triggers run whatever this says.')
ON CONFLICT (flag) DO NOTHING;


DO $post$
DECLARE
  actual_columns text[];
BEGIN
  SELECT array_agg(column_name || ':' || data_type || ':' || is_nullable ORDER BY column_name)
    INTO actual_columns
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'conversation_snapshots';
  IF actual_columns IS DISTINCT FROM ARRAY[
    'projection:text:NO', 'projection_version:integer:NO', 'row_count:integer:NO', 'rows:jsonb:NO',
    'thread_id:uuid:NO', 'through_created_at:timestamp with time zone:NO', 'through_message_id:uuid:NO',
    'written_at:timestamp with time zone:NO'] THEN
    RAISE EXCEPTION '3998: unexpected conversation_snapshots columns: %', actual_columns;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.conversation_snapshots'::regclass
                   AND contype = 'f' AND confrelid = 'public.message_threads'::regclass AND confdeltype = 'c') THEN
    RAISE EXCEPTION '3998: conversation_snapshots must cascade with its thread';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.conversation_snapshots'::regclass
                   AND conname = 'conversation_snapshots_count_matches' AND contype = 'c' AND convalidated) THEN
    RAISE EXCEPTION '3998: conversation_snapshots row-count constraint is missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.conversation_snapshots'::regclass) THEN
    RAISE EXCEPTION '3998: conversation_snapshots RLS is disabled';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.conversation_snapshots', 'SELECT')
     OR has_table_privilege('service_role', 'public.conversation_snapshots', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
    RAISE EXCEPTION '3998: service_role must hold SELECT only on conversation_snapshots (writes go through the function)';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated']) AS r(role_name)
              WHERE has_table_privilege(r.role_name, 'public.conversation_snapshots', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) THEN
    RAISE EXCEPTION '3998: conversation_snapshots is exposed to a client role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.conversation_snapshots'::regclass
                   AND polname = 'conversation_snapshots_service_read') THEN
    RAISE EXCEPTION '3998: the service read policy is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.telegraph_write_conversation_snapshot(uuid, text)'::regprocedure
                   AND prosecdef AND proconfig @> ARRAY['search_path=pg_catalog, public'])
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.telegraph_conversation_snapshot_invalidate()'::regprocedure
                   AND prosecdef AND proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
    RAISE EXCEPTION '3998: the writer and the invalidation function must be SECURITY DEFINER with a pinned search_path';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.telegraph_write_conversation_snapshot(uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.telegraph_write_conversation_snapshot(uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.telegraph_write_conversation_snapshot(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '3998: the writer must be executable by service_role only';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'public.messages'::regclass AND NOT tgisinternal AND tgenabled <> 'D'
         AND tgfoid = 'public.telegraph_conversation_snapshot_invalidate()'::regprocedure
         AND tgname IN ('telegraph_conversation_snapshot_on_insert', 'telegraph_conversation_snapshot_on_update',
                        'telegraph_conversation_snapshot_on_delete', 'telegraph_conversation_snapshot_on_truncate')) <> 4 THEN
    RAISE EXCEPTION '3998: all four invalidation triggers must be present and enabled on public.messages';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_conversation_snapshots_enabled') THEN
    RAISE EXCEPTION '3998: telegraph_conversation_snapshots_enabled is not seeded';
  END IF;
END
$post$;

COMMIT;
