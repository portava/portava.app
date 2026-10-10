-- Rollback for 3650_telegraph_unsend_blocked_reader_excluded.sql (lane T, lead ruling P-T6).
--
-- Restores migration 3000's body of telegraph_unsend_message_before_seen, which
-- counts every active recipient's last_read_at whatever the blocks. AFTER this,
-- an unsend refused because only a blocked member read the message reports
-- `seenBy` to the sender again — the leak 3650 closed.

BEGIN;

CREATE OR REPLACE FUNCTION public.telegraph_unsend_message_before_seen(
  p_message_id uuid,
  p_actor_id   uuid,
  p_thread_id  uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_msg        public.messages;
  v_now        timestamptz := now();
  v_active     boolean;
  v_seen_count integer;
  v_recipients integer := 0;
BEGIN
  IF p_message_id IS NULL OR p_actor_id IS NULL OR p_thread_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- Lock the message first. A concurrent unsend/edit/delete of the same message
  -- serialises here.
  SELECT * INTO v_msg
    FROM public.messages
   WHERE id = p_message_id AND thread_id = p_thread_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- Counted once, here, and returned with every outcome below. The route used
  -- to read the roster itself for this number; a second read could answer
  -- differently from the one the decision rests on.
  SELECT count(*) INTO v_recipients
    FROM public.message_thread_members
   WHERE thread_id = p_thread_id
     AND user_id <> p_actor_id
     AND left_at IS NULL;

  IF v_msg.sender_id <> p_actor_id THEN
    RETURN jsonb_build_object('outcome', 'not_sender', 'recipientCount', v_recipients);
  END IF;

  -- Unsent is checked BEFORE deleted, because this function sets both and an
  -- already-unsent row therefore carries both. Testing deleted first would
  -- report every repeat unsend as a delete.
  IF v_msg.unsent_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'already_unsent', 'unsentAt', v_msg.unsent_at,
                              'recipientCount', v_recipients);
  END IF;
  IF v_msg.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'already_deleted', 'recipientCount', v_recipients);
  END IF;

  -- The caller must still be an active member of the thread. Leaving a thread
  -- ends the ability to act inside it.
  SELECT EXISTS (
    SELECT 1 FROM public.message_thread_members
     WHERE thread_id = p_thread_id AND user_id = p_actor_id AND left_at IS NULL
  ) INTO v_active;

  IF NOT v_active THEN
    RETURN jsonb_build_object('outcome', 'not_member', 'recipientCount', v_recipients);
  END IF;

  -- Lock every eligible recipient's receipt row BEFORE reading last_read_at, so
  -- a concurrent POST /threads/:id/read cannot land between the read and the
  -- write. This is the §7.4 race, closed.
  PERFORM 1
     FROM public.message_thread_members
    WHERE thread_id = p_thread_id
      AND user_id <> p_actor_id
      AND left_at IS NULL
    FOR UPDATE;

  SELECT count(*) INTO v_seen_count
    FROM public.message_thread_members m
   WHERE m.thread_id = p_thread_id
     AND m.user_id <> p_actor_id
     AND m.left_at IS NULL
     AND m.last_read_at IS NOT NULL
     AND m.last_read_at >= v_msg.created_at;

  -- §7.4: in a group, ONE recipient having seen it closes the window for everyone.
  IF v_seen_count > 0 THEN
    RETURN jsonb_build_object('outcome', 'seen', 'seenBy', v_seen_count,
                              'recipientCount', v_recipients);
  END IF;

  UPDATE public.messages
     SET unsent_at       = v_now,
         deleted_at      = v_now,
         lifecycle_state = 'unsent',
         body            = ''
   WHERE id = p_message_id;

  RETURN jsonb_build_object('outcome', 'unsent', 'unsentAt', v_now,
                            'seenBy', 0, 'recipientCount', v_recipients);
END
$fn$;

COMMENT ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) IS
  'Telegraph §7.4 unsend-before-seen, and the ONLY writer of an unsend. Atomically asserts that no eligible recipient (active member, not the sender) has last_read_at >= the message created_at, then sets unsent_at, deleted_at, lifecycle_state = ''unsent'' and an empty body in one statement. Takes FOR UPDATE locks on the recipient receipt rows so a concurrent mark-as-read cannot race the check. Returns a jsonb {outcome}; a null or absent outcome is a failure, never a success.';

REVOKE ALL ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) TO service_role;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3650_telegraph_unsend_blocked_reader_excluded.sql';
  END IF;
END $$;

COMMIT;
