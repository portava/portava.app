BEGIN;

-- 3935/3939's protected membership trigger runs later by name and sets the lower cursor from
-- the authoritative membership time window, retaining an explicit lower
-- cursor on insert. Let that writer see the value the caller actually supplied.
-- 4005 still owns the upper bound, derived from the last message by leave time.
CREATE OR REPLACE FUNCTION public.telegraph_member_sequence_bounds()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_sequence_state_enabled' AND enabled
  ) THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.left_at IS NOT DISTINCT FROM OLD.left_at THEN RETURN NEW; END IF;
  IF NEW.left_at IS NULL THEN
    NEW.visible_until_sequence := NULL;
  ELSE
    SELECT COALESCE(MAX(m.sequence), 0) INTO NEW.visible_until_sequence
      FROM public.messages m WHERE m.thread_id = NEW.thread_id AND m.created_at <= NEW.left_at;
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.telegraph_member_sequence_bounds() FROM PUBLIC, anon, authenticated;

-- 4005's thread lock, sequence acknowledgements and legacy timestamp fallback,
-- with 3650's two-direction block check on BOTH counts returned to the sender.
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

  PERFORM 1 FROM public.message_threads WHERE id=p_thread_id FOR UPDATE;

  -- Lock the message after the shared conversation lock. A concurrent unsend/edit/delete of the same message
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
    FROM public.message_thread_members mm
   WHERE mm.thread_id = p_thread_id
     AND mm.user_id <> p_actor_id
     AND mm.left_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.blocks b
       WHERE (b.blocker_id = p_actor_id AND b.blocked_id = mm.user_id)
          OR (b.blocker_id = mm.user_id AND b.blocked_id = p_actor_id)
     );

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
     AND NOT EXISTS (
       SELECT 1 FROM public.blocks b
       WHERE (b.blocker_id = p_actor_id AND b.blocked_id = m.user_id)
          OR (b.blocker_id = m.user_id AND b.blocked_id = p_actor_id)
     )
     AND CASE WHEN v_msg.sequence IS NOT NULL AND EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='telegraph_sequence_state_enabled' AND enabled)
       THEN coalesce(m.seen_sequence,0)>=v_msg.sequence
       ELSE m.last_read_at IS NOT NULL AND m.last_read_at>=v_msg.created_at END;

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
REVOKE ALL ON FUNCTION public.telegraph_unsend_message_before_seen(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.telegraph_unsend_message_before_seen(uuid,uuid,uuid) TO service_role;
COMMIT;
