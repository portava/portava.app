-- 2325_telegraph_unsend_before_seen.sql
--
-- Telegraph §7.4 "Unsend-before-seen" — the server-authoritative, race-safe half.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHY THIS EXISTS
-- ===============
-- Both Telegraph specification versions (v1 and v1_1 — v1_1 is a strict
-- superset of v1 and its shared body is byte-identical) require unsend as an
-- operation DISTINCT from delete, and both bind it to a precondition:
--
--   §7.1  lifecycle ... SENT/DELIVERED + no eligible recipient has seen → UNSENT
--   §7.4  "A sender may unsend only while no eligible recipient has seen the
--          message. In a group, one recipient seeing the message closes the
--          unseen-unsend window for everyone. The server resolves read-vs-unsend
--          races transactionally."
--   §13.1 UNSEND_MESSAGE is its own command, alongside DELETE_MESSAGE.
--   §27.1 property invariant: "message unseen → unsend may succeed;
--          any eligible recipient seen → unseen-unsend impossible"
--   §28   SLO: "unsend-after-seen violations: 0"
--
-- The repository had DELETE (routes/groupChat.ts DELETE /messages/:messageId,
-- sender-only, unconditional, any time) but NO unsend: nothing anywhere in
-- artifacts/api-server matched /unsend|unsent/. The seen precondition — the
-- entire point of the operation — did not exist in any form.
--
-- WHY A DATABASE FUNCTION AND NOT ROUTE CODE
-- ==========================================
-- §7.4 names the hazard explicitly: the read-vs-unsend race. The competing
-- writer is POST /api/threads/:threadId/read (routes/messaging.ts), which sets
-- message_thread_members.last_read_at. A route that (1) SELECTs the receipts,
-- (2) decides, then (3) UPDATEs the message cannot be made safe from Node:
-- supabase-js issues each statement in its own implicit transaction, so a
-- recipient's read landing between (1) and (2) yields an unsend of a message
-- that HAS been seen — precisely the §28 violation whose target is zero.
--
-- So the check and the write are one statement pair inside one function, and the
-- function takes FOR UPDATE row locks on the recipient receipt rows before it
-- reads them. A concurrent mark-as-read blocks until this commits, and vice
-- versa. That is what "resolves races transactionally" means here.
--
-- This mirrors the established repository pattern for a guarded state
-- transition — transition_live_place_recap (migration 2067) — including its
-- SECURITY DEFINER / pinned search_path / service_role-only grant posture.
--
-- WHAT "SEEN" MEANS HERE
-- =====================
-- Deliberately the substrate that already exists, NOT a new parallel one.
-- §7.3 sketches lastSeenSequence on conversation members; this repository has
-- no `sequence` column on public.messages and orders by created_at, and its own
-- unread-count logic (routes/messaging.ts GET /me/unread-counts) already
-- defines seen as "messages newer than last_read_at". Introducing a sequence
-- column here would be a second, competing receipt system for one behaviour.
-- So: an eligible recipient has seen the message iff
--     last_read_at IS NOT NULL AND last_read_at >= messages.created_at.
-- A member who has never read (last_read_at IS NULL) has NOT seen it.
--
-- ELIGIBLE RECIPIENT = a member of the thread with left_at IS NULL, excluding
-- the sender. A departed member cannot hold the window open, and the sender
-- reading their own message is not "a recipient has seen it".
--
-- UNSEND vs DELETE — DISTINCT OPERATION, SHARED REDACTION
-- ======================================================
-- messages.unsent_at is added (spec §12.1 names `unsentAt` on the envelope) so
-- the two operations remain distinguishable on the record, as §13.1 requires.
-- The function ALSO sets deleted_at, because every existing reader, unread
-- count, search path and content drawer in this codebase already suppresses on
-- deleted_at. §7.4 requires an unsent message to be removed from normal
-- retrieval; reusing the redaction predicate the readers already honour is how
-- that happens without a parallel second suppression path that some reader
-- would inevitably forget to consult.
--   unsent_at IS NOT NULL  → it was unsent (never seen by anyone)
--   deleted_at only        → it was deleted (ordinary delete)
--
-- body is set to '' and NOT null: public.messages.body is `text NOT NULL`, so
-- a null write raises 23502. This is the same redaction the existing group-chat
-- delete performs, for the same reason.
--
-- NO FLAG. Telegraph's existing flags are untouched by this migration. Unsend is
-- a strictly narrowing capability on a message the caller already owns.

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.messages must exist.';
  END IF;
  IF to_regclass('public.message_thread_members') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.message_thread_members must exist.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'message_thread_members'
       AND column_name = 'last_read_at'
  ) THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: message_thread_members.last_read_at must exist (migration 0016) — it is the seen substrate this function reads.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'deleted_at'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: messages.deleted_at must exist.';
  END IF;
END $$;

-- ── Envelope: unsent_at (spec §12.1 `unsentAt`) ───────────────────────────────

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS unsent_at timestamptz;

COMMENT ON COLUMN public.messages.unsent_at IS
  'Telegraph §7.4/§12.1: set when the sender unsent this message before any eligible recipient had seen it. Distinguishes UNSEND_MESSAGE from DELETE_MESSAGE (§13.1); deleted_at is set alongside it so existing readers suppress the row.';

-- Partial index: unsent rows are the rare case, and the audit/observability
-- question (§28 "unsend-after-seen violations: 0") only ever scans them.
CREATE INDEX IF NOT EXISTS messages_unsent_at_idx
  ON public.messages (unsent_at)
  WHERE unsent_at IS NOT NULL;

-- ── The guarded transition ────────────────────────────────────────────────────
--
-- Returns a jsonb envelope with a discriminating `outcome`, rather than raising,
-- so the route can map each refusal to its correct HTTP status without parsing
-- an error string. Callers MUST treat a null/absent outcome as a failure — never
-- as a success and never as a refusal.
--
--   'unsent'      → the message was unsent
--   'not_found'   → no such message in that thread
--   'not_sender'  → caller does not own the message
--   'not_member'  → caller is not an active member of the thread
--   'already_gone'→ already deleted or already unsent (idempotent no-op)
--   'seen'        → an eligible recipient has seen it; the window is closed

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

  IF v_msg.sender_id <> p_actor_id THEN
    RETURN jsonb_build_object('outcome', 'not_sender');
  END IF;

  IF v_msg.deleted_at IS NOT NULL OR v_msg.unsent_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'already_gone');
  END IF;

  -- The caller must still be an active member of the thread. Leaving a thread
  -- ends the ability to act inside it.
  SELECT EXISTS (
    SELECT 1 FROM public.message_thread_members
     WHERE thread_id = p_thread_id AND user_id = p_actor_id AND left_at IS NULL
  ) INTO v_active;

  IF NOT v_active THEN
    RETURN jsonb_build_object('outcome', 'not_member');
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
    RETURN jsonb_build_object('outcome', 'seen', 'seenBy', v_seen_count);
  END IF;

  UPDATE public.messages
     SET unsent_at  = v_now,
         deleted_at = v_now,
         body       = ''
   WHERE id = p_message_id;

  RETURN jsonb_build_object('outcome', 'unsent', 'unsentAt', v_now);
END
$fn$;

COMMENT ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) IS
  'Telegraph §7.4 unsend-before-seen. Atomically asserts that no eligible recipient (active member, not the sender) has last_read_at >= the message created_at, then marks the message unsent. Takes FOR UPDATE locks on recipient receipt rows so a concurrent mark-as-read cannot race the check. Returns a jsonb {outcome}; a null/absent outcome is a failure, never a success.';

REVOKE ALL ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) TO service_role;

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_prosecdef boolean;
  v_config    text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'unsent_at'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: messages.unsent_at was not created.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'messages_unsent_at_idx'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: messages_unsent_at_idx was not created.';
  END IF;

  SELECT p.prosecdef, p.proconfig INTO v_prosecdef, v_config
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
  -- Substring match rather than an exact array compare: Postgres preserves the
  -- SET text verbatim in proconfig and its quoting is not worth depending on.
  -- Matches the check in migration 2199.
  IF v_config IS NULL OR array_to_string(v_config, ',') NOT LIKE '%search_path%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_unsend_message_before_seen must pin search_path.';
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

-- REVERSAL (manual):
--   DROP FUNCTION IF EXISTS public.telegraph_unsend_message_before_seen(uuid, uuid, uuid);
--   DROP INDEX IF EXISTS public.messages_unsent_at_idx;
--   ALTER TABLE public.messages DROP COLUMN IF EXISTS unsent_at;
