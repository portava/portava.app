-- 3000_telegraph_unsend_authoritative.sql
--
-- Telegraph §7.4 — make the locking unsend function the whole truth about an
-- unsend, so there is one writer and one resulting row.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION. First file in the 3000-3999 range,
-- which was opened for it: 2100-2999 is full (main held up to 2997, and 2998
-- and 2999 were both claimed by unmerged branches). A dated prefix is not the
-- alternative — apply order is plain lexicographic and "20260923_…" sorts below
-- "2810_…", so a dated file authored today would run before the migrations this
-- one depends on. See src/scripts/migrationPrefixRules.ts.
--
-- WHAT WAS WRONG
-- ==============
-- Migration 2325 created telegraph_unsend_message_before_seen, which takes
-- FOR UPDATE locks on the recipient receipt rows before reading them and is the
-- only implementation in this tree that actually closes §7.4's read-vs-unsend
-- race. Nothing called it. Two route handlers did the work themselves, each
-- with a read-then-write that supabase-js issues as two separate implicit
-- transactions, and each producing a DIFFERENT row:
--
--   services/telegraph/unsend.ts (unsentPatch)  → deleted_at, body=''
--                                                 …and NOT unsent_at, so the
--                                                 "unsend" route wrote a delete
--                                                 and the outbox trigger
--                                                 published message.deleted
--   server/telegraph/commandRoute.ts            → unsent_at, lifecycle_state,
--                                                 body='' …and NOT deleted_at
--   telegraph_unsend_message_before_seen (2325) → unsent_at, deleted_at,
--                                                 body='' …and NOT
--                                                 lifecycle_state, because 2810
--                                                 had not been written yet
--
-- 2325 predates 2810, which added messages.lifecycle_state and a BEFORE INSERT
-- trigger that stamps every new message 'sent'. Nothing maintains that column
-- on UPDATE. So the 2325 function, called as it stands, would leave a row
-- carrying unsent_at AND lifecycle_state = 'sent' — a row that says two things,
-- and says the wrong one to every client reading the kernel column list in
-- services/telegraphMessageKernel.ts.
--
-- WHAT THIS CHANGES
-- =================
-- One line of behaviour and one refinement of the return value.
--
--   1. The UPDATE now also sets lifecycle_state = 'unsent'. 2810's CHECK
--      constraint already permits exactly that value.
--
--   2. 'already_gone' splits into 'already_deleted' and 'already_unsent'. The
--      command route publishes those as two different reason codes
--      (TELEGRAPH_LIFECYCLE_ALREADY_DELETED and _ALREADY_UNSENT) and could not
--      have kept them while calling a function that collapsed the two. Callers
--      that want the old single outcome map both back; the HTTP route that
--      published 'already_gone' still publishes 'already_gone'.
--
--   3. Every outcome from the message lock onwards carries 'recipientCount',
--      the number of eligible recipients. The HTTP route publishes that field
--      and used to get it from its own read of the roster. Returning it from
--      inside the lock removes that read entirely rather than leaving a second
--      one whose answer could disagree with the one the decision was made on.
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE
-- ======================================
-- deleted_at is still set alongside unsent_at. 2810's comment calls unsend
-- "distinct from deleted_at", and it is — on the record. It is not distinct to
-- the READERS: 81 non-test files read public.messages and four of them mention
-- unsent_at at all, so suppression in this codebase is deleted_at and only
-- deleted_at. Dropping it here to make the record tidier would leave an unsent
-- message visible in nearly every surface that shows one. The distinction is
-- carried by unsent_at and lifecycle_state, which is where a reader can ask for
-- it; the suppression is carried by the predicate every reader already honours.
--
-- The outbox still publishes message.unsent rather than message.deleted,
-- because 2810's trigger tests unsent_at FIRST and says so: "an unsend of an
-- edited message is an unsend". WHEN IT PUBLISHES AT ALL -- that trigger reads
-- feature_flags for telegraph_message_kernel_enabled and RETURNs NULL when it
-- is not true. 2810 itself is applied to no database, so today the trigger
-- does not exist anywhere and this write produces no outbox row; where 2810 is
-- applied, the flag decides. This migration turns nothing on and must not: the
-- flag is an owner decision, and an unsend that started writing outbox rows
-- because a migration flipped it would be a delivery change nobody asked this
-- change for.
--
-- No flag. No grant change. No new column. The function keeps 2325's
-- SECURITY DEFINER / pinned search_path / service_role-only posture, and this
-- migration asserts that it still holds afterwards rather than assuming a
-- CREATE OR REPLACE preserved it.

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.messages must exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'unsent_at'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: messages.unsent_at must exist (migration 2325/2810).';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'lifecycle_state'
  ) THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: messages.lifecycle_state must exist (migration 2810) — this migration exists to keep it consistent with unsent_at.';
  END IF;

  -- The value this function is about to write must be one the table accepts.
  -- Asserting it here turns a silent future CHECK violation at unsend time into
  -- a refusal at migrate time.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'messages_lifecycle_state_check'
       AND pg_get_constraintdef(oid) LIKE '%unsent%'
  ) THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: messages_lifecycle_state_check must permit ''unsent'' (migration 2810).';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'telegraph_unsend_message_before_seen'
  ) THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: telegraph_unsend_message_before_seen must exist (migration 2325) — this migration replaces its body, it does not introduce it.';
  END IF;
END $$;

-- ── The guarded transition, now writing the whole row ─────────────────────────
--
--   'unsent'          → the message was unsent
--   'not_found'       → no such message in that thread
--   'not_sender'      → caller does not own the message
--   'not_member'      → caller is not an active member of the thread
--   'already_deleted' → already deleted (idempotent no-op)
--   'already_unsent'  → already unsent (idempotent no-op)
--   'seen'            → an eligible recipient has seen it; the window is closed
--
-- Every outcome after the message lock also carries 'recipientCount'.
--
-- A null or absent outcome is a FAILURE. It is never a success and never a
-- refusal, and every caller must treat it that way.

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

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_prosecdef boolean;
  v_config    text[];
  v_body      text;
BEGIN
  SELECT p.prosecdef, p.proconfig, p.prosrc INTO v_prosecdef, v_config, v_body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'telegraph_unsend_message_before_seen';

  IF v_prosecdef IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_unsend_message_before_seen does not exist.';
  END IF;
  IF v_prosecdef IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_unsend_message_before_seen must be SECURITY DEFINER.';
  END IF;
  IF v_config IS NULL OR array_to_string(v_config, ',') NOT LIKE '%search_path%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_unsend_message_before_seen must pin search_path.';
  END IF;

  -- The point of this migration, asserted rather than assumed. A CREATE OR
  -- REPLACE that silently kept the old body would otherwise pass every other
  -- check here.
  IF v_body NOT LIKE '%lifecycle_state%' THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: the replaced function does not write lifecycle_state, which is the whole reason this migration exists.';
  END IF;
  IF v_body NOT LIKE '%already_unsent%' OR v_body NOT LIKE '%already_deleted%' THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: the replaced function does not distinguish already_unsent from already_deleted.';
  END IF;
  IF v_body NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: the replaced function no longer takes row locks; the §7.4 race would be open.';
  END IF;

  -- The grant posture: service_role only. authenticated/anon must NOT hold EXECUTE.
  IF has_function_privilege('authenticated',
       'public.telegraph_unsend_message_before_seen(uuid, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated must not hold EXECUTE on telegraph_unsend_message_before_seen.';
  END IF;
  IF has_function_privilege('anon',
       'public.telegraph_unsend_message_before_seen(uuid, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon must not hold EXECUTE on telegraph_unsend_message_before_seen.';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.telegraph_unsend_message_before_seen(uuid, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role must hold EXECUTE on telegraph_unsend_message_before_seen.';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual): re-run migration 2325's CREATE OR REPLACE FUNCTION block,
-- which restores the 2325 body. That body does not write lifecycle_state, so an
-- unsend performed afterwards leaves the column saying 'sent'. Nothing else in
-- this migration creates an object, so there is nothing else to drop.
