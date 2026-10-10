-- 3650_telegraph_unsend_blocked_reader_excluded.sql
-- Telegraph §7.4 unsend-before-seen, under lead ruling P-T6 (2026-10-07): a read
-- position never crosses a block. POST-CUTOVER CANONICAL FORWARD MIGRATION.
-- Lane T band 3650-3669.
--
-- WHAT WAS WRONG (independent verification of lane T, finding F1)
-- ===============================================================
-- Lead ruling P-T6: "in a thread both people are still in, neither receives the
-- other's typing, read markers or seen receipts, and neither's read position is in
-- the other's receipts". Lane T closed the realtime bus and both receipt routes.
-- The unsend refusal was a third door: telegraph_unsend_message_before_seen (3000)
-- counts EVERY active recipient's last_read_at, and POST
-- /threads/:id/messages/:id/unsend publishes `seenBy` and `seen_by_recipient` to
-- the sender. DM A<->B, B blocks A, B reads A's message, A unsends: 409
-- seen_by_recipient, seenBy 1 — A learns B read it, while the receipts route
-- answers the same message SENT, seenBy 0.
--
-- WHAT THIS CHANGES
-- =================
-- The function body is 3000's with ONE rule added to two counts: a member in a
-- block with the actor, in either direction, is not an eligible recipient.
--   * v_recipients (returned as recipientCount on every outcome) leaves them out,
--     matching the receipts route's recipientCount;
--   * v_seen_count (the §7.4 test, returned as seenBy) leaves them out, so their
--     read neither closes the window nor is reported.
-- The receipt-row lock is unchanged (it still locks every active recipient row
-- before the read — over-locking a blocked member's row is harmless). Every
-- outcome, its order, the write and the grants are 3000's.
--
-- The consequence, stated: a sender may now unsend a message that only a person
-- in a block with them has read. That is the ruling's trade — a refusal that
-- names their read is exactly the signal P-T6 removes — and the blocked party's
-- client already suppresses the sender.
--
-- No table, no column, no flag, no grant change. 3000's SECURITY DEFINER, pinned
-- search_path and service_role-only EXECUTE are re-asserted below.
--
-- ROLLBACK: db/rollback/2026-10-07-3650-telegraph-unsend-blocked-reader-excluded-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.blocks') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3650): public.blocks must exist.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'telegraph_unsend_message_before_seen'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3650): telegraph_unsend_message_before_seen must exist (2325, 3000).';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'telegraph_unsend_message_before_seen'
       AND p.prosrc LIKE '%lifecycle_state%'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3650): 3000 must be applied first (the function does not write lifecycle_state).';
  END IF;
END $pre$;

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

  -- 3650 (lead ruling P-T6): a member in a block with the actor, either way, is
  -- not an eligible recipient here. Their read position must not reach the
  -- sender through this answer, so it neither closes the window nor counts.
  SELECT count(*) INTO v_seen_count
    FROM public.message_thread_members m
   WHERE m.thread_id = p_thread_id
     AND m.user_id <> p_actor_id
     AND m.left_at IS NULL
     AND m.last_read_at IS NOT NULL
     AND m.last_read_at >= v_msg.created_at
     AND NOT EXISTS (
       SELECT 1 FROM public.blocks b
        WHERE (b.blocker_id = p_actor_id AND b.blocked_id = m.user_id)
           OR (b.blocker_id = m.user_id AND b.blocked_id = p_actor_id)
     );

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
  'Telegraph §7.4 unsend-before-seen, and the ONLY writer of an unsend. Atomically asserts that no eligible recipient (active member, not the sender, and — 3650, lead ruling P-T6 — not in a block with the sender in either direction) has last_read_at >= the message created_at, then sets unsent_at, deleted_at, lifecycle_state = ''unsent'' and an empty body in one statement. Takes FOR UPDATE locks on the recipient receipt rows so a concurrent mark-as-read cannot race the check. Returns a jsonb {outcome}; a null or absent outcome is a failure, never a success.';

REVOKE ALL ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) TO service_role;

DO $post$
DECLARE
  v_prosecdef boolean;
  v_config    text[];
  v_body      text;
BEGIN
  SELECT p.prosecdef, p.proconfig, p.prosrc INTO v_prosecdef, v_config, v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'telegraph_unsend_message_before_seen';
  IF v_prosecdef IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3650): telegraph_unsend_message_before_seen must be SECURITY DEFINER.';
  END IF;
  IF v_config IS NULL OR array_to_string(v_config, ',') NOT LIKE '%search_path%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3650): telegraph_unsend_message_before_seen must pin search_path.';
  END IF;
  IF v_body NOT LIKE '%public.blocks%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3650): the replaced function does not consult blocks — P-T6 would be open.';
  END IF;
  IF v_body NOT LIKE '%lifecycle_state%' OR v_body NOT LIKE '%already_unsent%' OR v_body NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3650): the replaced function lost part of 3000 (lifecycle_state, already_unsent or its locks).';
  END IF;
  IF has_function_privilege('authenticated', 'public.telegraph_unsend_message_before_seen(uuid, uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.telegraph_unsend_message_before_seen(uuid, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3650): anon/authenticated must not hold EXECUTE.';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.telegraph_unsend_message_before_seen(uuid, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3650): service_role must hold EXECUTE.';
  END IF;
END $post$;

COMMIT;
