-- Generated with Supabase CLI, normalized to this repository's forward prefix.
-- No production backfill or feature activation is performed by this migration.
BEGIN;

INSERT INTO public.feature_flags(flag,enabled,description)
VALUES ('telegraph_sequence_state_enabled',false,
 'Canonical sequence pages and durable device-delivered/viewed receipts. Requires the kernel and a completed legacy sequence backfill.')
ON CONFLICT(flag) DO NOTHING;

-- Preserve every issued cursor. A retry fills only NULL rows, at most 10,000,
-- under the same thread lock used by the insert allocator. Mixed legacy rows
-- append after existing sequences; already-issued numbers are never changed.
CREATE OR REPLACE FUNCTION public.telegraph_backfill_message_sequences(p_thread_id uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE base bigint; assigned bigint;
BEGIN
 SELECT last_sequence INTO base FROM public.message_threads WHERE id=p_thread_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_found'; END IF;
 SELECT greatest(base,coalesce(max(sequence),0)) INTO base FROM public.messages WHERE thread_id=p_thread_id;
 WITH batch AS (SELECT id,created_at FROM public.messages WHERE thread_id=p_thread_id AND sequence IS NULL ORDER BY created_at,id LIMIT 10000),
 numbered AS (SELECT id,base+row_number() OVER(ORDER BY created_at,id) AS seq FROM batch)
 UPDATE public.messages m SET sequence=n.seq,
 lifecycle_state=coalesce(m.lifecycle_state,CASE WHEN m.unsent_at IS NOT NULL THEN 'unsent' WHEN m.deleted_at IS NOT NULL THEN 'deleted' WHEN m.edited_at IS NOT NULL THEN 'edited' ELSE 'sent' END)
 FROM numbered n WHERE m.id=n.id AND m.sequence IS NULL;
 GET DIAGNOSTICS assigned=ROW_COUNT;
 UPDATE public.message_threads SET last_sequence=base+assigned WHERE id=p_thread_id;
 -- Keep the timestamp predicate too: appended legacy rows may precede a join.
 IF NOT EXISTS(SELECT 1 FROM public.messages WHERE thread_id=p_thread_id AND sequence IS NULL) THEN
  UPDATE public.message_thread_members mm SET
   seen_sequence=greatest(mm.seen_sequence,(SELECT max(sequence) FROM public.messages WHERE thread_id=p_thread_id AND created_at<=mm.last_read_at)),
   delivered_sequence=greatest(mm.delivered_sequence,(SELECT max(sequence) FROM public.messages WHERE thread_id=p_thread_id AND created_at<=mm.last_read_at)),
   visible_from_sequence=CASE WHEN mm.visible_from_at IS NULL THEN NULL ELSE coalesce((SELECT min(sequence) FROM public.messages WHERE thread_id=p_thread_id AND created_at>=mm.visible_from_at),base+assigned+1) END,
   visible_until_sequence=CASE WHEN mm.left_at IS NULL THEN NULL ELSE coalesce((SELECT max(sequence) FROM public.messages WHERE thread_id=p_thread_id AND created_at<=mm.left_at),0) END
  WHERE mm.thread_id=p_thread_id;
 END IF;
 RETURN assigned;
END $$;
REVOKE ALL ON FUNCTION public.telegraph_backfill_message_sequences(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.telegraph_backfill_message_sequences(uuid) TO service_role;

-- Cutover refuses incomplete history, including tombstones; activation is an
-- explicit release operation. Turning off the allocator while canonical readers
-- are active would otherwise silently strand new NULL-sequence messages.
CREATE OR REPLACE FUNCTION public.telegraph_sequence_cutover_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.flag='telegraph_sequence_state_enabled' AND NEW.enabled THEN
  IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='telegraph_message_kernel_enabled' AND enabled)
   OR EXISTS(SELECT 1 FROM public.messages WHERE sequence IS NULL) THEN
   RAISE EXCEPTION 'telegraph_sequence_backfill_required';
  END IF;
 END IF;
 IF NEW.flag='telegraph_message_kernel_enabled' AND NOT NEW.enabled
  AND EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='telegraph_sequence_state_enabled' AND enabled) THEN
  RAISE EXCEPTION 'disable_sequence_state_before_kernel';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.telegraph_sequence_cutover_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS telegraph_sequence_cutover_guard ON public.feature_flags;
CREATE TRIGGER telegraph_sequence_cutover_guard BEFORE INSERT OR UPDATE ON public.feature_flags
 FOR EACH ROW EXECUTE FUNCTION public.telegraph_sequence_cutover_guard();

CREATE OR REPLACE FUNCTION public.telegraph_member_sequence_bounds()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE latest bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='telegraph_sequence_state_enabled' AND enabled) THEN RETURN NEW; END IF;
 -- Membership UPDATE already locks its row. Do not invert the receipt
 -- writer lock order here; the existing timestamp window remains mandatory.
 SELECT last_sequence INTO latest FROM public.message_threads WHERE id=NEW.thread_id;
 IF TG_OP='INSERT' THEN
  NEW.visible_from_sequence=CASE WHEN NEW.visible_from_at IS NULL THEN NULL ELSE latest+1 END;
  NEW.visible_until_sequence=CASE WHEN NEW.left_at IS NULL THEN NULL ELSE latest END;
 ELSE
  IF NEW.visible_from_at IS DISTINCT FROM OLD.visible_from_at THEN
   NEW.visible_from_sequence=CASE WHEN NEW.visible_from_at IS NULL THEN NULL ELSE latest+1 END;
  END IF;
  IF NEW.left_at IS DISTINCT FROM OLD.left_at THEN
   NEW.visible_until_sequence=CASE WHEN NEW.left_at IS NULL THEN NULL ELSE latest END;
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.telegraph_member_sequence_bounds() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS telegraph_member_sequence_bounds ON public.message_thread_members;
CREATE TRIGGER telegraph_member_sequence_bounds BEFORE INSERT OR UPDATE OF visible_from_at,left_at ON public.message_thread_members
 FOR EACH ROW EXECUTE FUNCTION public.telegraph_member_sequence_bounds();

-- One watermark per membership, never a row per message/recipient. The API
-- supplies its freshly authenticated actor; client roles cannot invoke this.
-- A delivery ACK means this device received the message, not a push acceptance.
CREATE OR REPLACE FUNCTION public.telegraph_ack_message(p_thread_id uuid,p_actor_id uuid,p_message_id uuid,p_kind text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE msg public.messages; member public.message_thread_members; previous bigint; current_mark bigint; advanced boolean; crossed jsonb;
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN ('delivered','seen') THEN RAISE EXCEPTION 'invalid_receipt_kind'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='telegraph_sequence_state_enabled' AND enabled) THEN
  RETURN jsonb_build_object('outcome','disabled');
 END IF;
 -- All receipt/unsend operations lock thread, message, then membership.
 PERFORM 1 FROM public.message_threads WHERE id=p_thread_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
 SELECT * INTO msg FROM public.messages WHERE id=p_message_id AND thread_id=p_thread_id FOR UPDATE;
 IF NOT FOUND OR msg.sequence IS NULL OR msg.deleted_at IS NOT NULL THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
 SELECT * INTO member FROM public.message_thread_members WHERE thread_id=p_thread_id AND user_id=p_actor_id FOR UPDATE;
 IF NOT FOUND OR member.left_at IS NOT NULL THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
 IF msg.sender_id<>p_actor_id AND ((member.visible_from_at IS NOT NULL AND msg.created_at<member.visible_from_at)
  OR (member.visible_from_sequence IS NOT NULL AND msg.sequence<member.visible_from_sequence)
  OR (member.visible_until_sequence IS NOT NULL AND msg.sequence>member.visible_until_sequence)) THEN
  RETURN jsonb_build_object('outcome','not_found');
 END IF;
 IF EXISTS(SELECT 1 FROM public.blocks WHERE (blocker_id=p_actor_id AND blocked_id=msg.sender_id) OR (blocked_id=p_actor_id AND blocker_id=msg.sender_id)) THEN
  RETURN jsonb_build_object('outcome','not_found');
 END IF;
 previous=CASE WHEN p_kind='seen' THEN member.seen_sequence ELSE member.delivered_sequence END;
 current_mark=greatest(coalesce(previous,0),msg.sequence);
 advanced=current_mark>coalesce(previous,0);
 UPDATE public.message_thread_members SET
  delivered_sequence=greatest(coalesce(delivered_sequence,0),msg.sequence),
  seen_sequence=CASE WHEN p_kind='seen' THEN current_mark ELSE seen_sequence END,
  last_read_at=CASE WHEN p_kind='seen' THEN greatest(last_read_at,msg.created_at) ELSE last_read_at END
 WHERE thread_id=p_thread_id AND user_id=p_actor_id RETURNING * INTO member;
 -- Event fanout is bounded; durable watermarks remain the authoritative answer.
 SELECT coalesce(jsonb_agg(id),'[]'::jsonb) INTO crossed FROM (
  SELECT m.id FROM public.messages m WHERE m.thread_id=p_thread_id AND m.sequence>coalesce(previous,0) AND m.sequence<=current_mark
   AND m.sender_id<>p_actor_id AND m.deleted_at IS NULL
   AND (member.visible_from_at IS NULL OR m.created_at>=member.visible_from_at)
   AND (member.visible_from_sequence IS NULL OR m.sequence>=member.visible_from_sequence)
   AND NOT EXISTS(SELECT 1 FROM public.blocks b WHERE (b.blocker_id=p_actor_id AND b.blocked_id=m.sender_id) OR (b.blocked_id=p_actor_id AND b.blocker_id=m.sender_id))
  ORDER BY m.sequence DESC LIMIT 250
 ) visible;
 RETURN jsonb_build_object('outcome','acknowledged','advanced',advanced,'sequence',current_mark::text,
  'lastReadAt',member.last_read_at,'seenMessageIds',CASE WHEN p_kind='seen' THEN crossed ELSE '[]'::jsonb END,'receiptRowsWritten',0);
END $$;
REVOKE ALL ON FUNCTION public.telegraph_ack_message(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.telegraph_ack_message(uuid,uuid,uuid,text) TO service_role;

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

COMMENT ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) IS
  'Atomic unsend-before-seen; locks conversation, message and members in receipt-writer order. Uses sequence watermarks after the explicit cutover and timestamps before it.';

REVOKE ALL ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) TO service_role;


COMMIT;
