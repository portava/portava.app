-- Rollback for src/migrations/3000_telegraph_unsend_authoritative.sql
-- Telegraph §7.4 — the unsend RPC made the whole truth about an unsend.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- READ THIS BEFORE RUNNING IT
-- ══════════════════════════════════════════════════════════════════════════════
-- 3000 CREATEs OR REPLACEs one function and changes no table: no ALTER, no
-- CREATE TABLE/INDEX/TRIGGER/TYPE, no DROP. So this file is not a teardown. It
-- restores migration 2325's function body, which is the state 3000 replaced.
--
-- DO NOT RUN THIS WHILE THE POST-#527 APPLICATION IS DEPLOYED.
--
-- This is the trap, and it is the reason this file leads with a warning rather
-- than a DROP. 3000 split `already_gone` into `already_unsent` and
-- `already_deleted`. The deployed code validates the RPC's answer against
-- UNSEND_OUTCOMES (services/telegraph/unsend.ts), a CLOSED list holding the two
-- new values and NOT `already_gone`; an outcome outside it is read as no verdict
-- at all, so `unsendBeforeSeen` returns null and the route answers
-- `db_error / "Could not unsend that message"`.
--
-- What makes this easy to miss: `already_gone` DOES still exist in that file --
-- as the WIRE REFUSAL that `refusalForOutcome` maps `already_unsent` and
-- `already_deleted` onto (unsend.ts:254). So the string is present in the
-- codebase and still published to clients, while the FUNCTION returning it is
-- unrecognised. Seeing `already_gone` in the route is not evidence that the
-- 2325 body is compatible; it is the opposite layer.
--
-- Restoring the 2325 body therefore does not return unsend to "the old
-- behaviour". It breaks unsend for every already-deleted or already-unsent
-- message, while the other outcomes keep working. Roll the APPLICATION back
-- first, or leave 3000 in place.
--
-- WHAT THIS FILE CANNOT UNDO
-- ══════════════════════════════════════════════════════════════════════════════
-- Rows already written under 3000's rules keep `lifecycle_state = 'unsent'`
-- alongside `unsent_at`, `deleted_at` and an emptied body. 2325's body never
-- wrote `lifecycle_state`, so after this rollback those rows are indistinguishable
-- from ones 2325 would have produced except for that column — and its value is
-- CORRECT, not corrupt. Leave it. The optional repair at the end of this file
-- exists only for a caller that must not see the column populated at all; it
-- loses information and is not part of the rollback.
--
-- The emptied body is not recoverable by any rollback: 2325 and 3000 both set
-- `body = ''`, and neither retains the original. That is unsend working as
-- designed, not damage this file should try to reverse.

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'telegraph_unsend_message_before_seen'
  ) THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: telegraph_unsend_message_before_seen does not exist — 3000 was never applied, or 2325 was already reversed. Nothing to roll back.';
  END IF;
END $$;

-- ── Restore migration 2325's body, verbatim ───────────────────────────────────
--
--   'unsent'       → the message was unsent
--   'not_found'    → no such message in that thread
--   'not_sender'   → caller does not own the message
--   'not_member'   → caller is not an active member of the thread
--   'already_gone' → already deleted or already unsent (idempotent no-op)
--   'seen'         → an eligible recipient has seen it; the window is closed
--
-- Note this body does NOT write lifecycle_state and does NOT return
-- recipientCount. Both are 3000 additions.

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

  SELECT EXISTS (
    SELECT 1 FROM public.message_thread_members
     WHERE thread_id = p_thread_id AND user_id = p_actor_id AND left_at IS NULL
  ) INTO v_active;

  IF NOT v_active THEN
    RETURN jsonb_build_object('outcome', 'not_member');
  END IF;

  -- The §7.4 race, closed: lock every eligible recipient's receipt row BEFORE
  -- reading last_read_at, so a concurrent POST /threads/:id/read cannot land
  -- between the read and the write. 3000 did not introduce this ordering and
  -- this rollback must not lose it.
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

-- 3000 re-established the grant posture rather than assuming CREATE OR REPLACE
-- preserved it. Do the same on the way back.
REVOKE ALL ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.telegraph_unsend_message_before_seen(uuid, uuid, uuid) TO service_role;

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_prosecdef          boolean;
  v_config             text[];
  v_src                text;
  v_pos_seen           integer;
  v_locks_before_seen  integer;
BEGIN
  SELECT p.prosecdef, p.proconfig, p.prosrc INTO v_prosecdef, v_config, v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'telegraph_unsend_message_before_seen';

  IF v_prosecdef IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: must remain SECURITY DEFINER.';
  END IF;
  IF v_config IS NULL OR array_to_string(v_config, ',') NOT LIKE '%search_path%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: must pin search_path.';
  END IF;

  -- The point of this file, asserted rather than assumed: the 2325 vocabulary
  -- is back and 3000's is gone.
  IF v_src NOT LIKE '%already_gone%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: 2325 body not restored — already_gone absent.';
  END IF;
  IF v_src LIKE '%already_unsent%' OR v_src LIKE '%already_deleted%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: 3000 outcome vocabulary still present.';
  END IF;
  IF v_src LIKE '%lifecycle_state%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: 3000 lifecycle_state write still present.';
  END IF;

  -- The lock ordering 2325 and 3000 share must survive the round trip.
  --
  -- A bare `v_src LIKE '%FOR UPDATE%'` is NOT good enough here, and this is worth
  -- spelling out because it reads like it is. The body takes TWO row locks: one
  -- on the message and one on the recipients' receipt rows. Drop the receipt lock
  -- -- the one that actually closes the §7.4 race -- and the words `FOR UPDATE`
  -- are still in the body, because the message lock uses them too. A presence
  -- check stays green over exactly the mutation it exists to catch. (Measured by
  -- the Case B thread against the live function, not reasoned: with the receipt
  -- lock removed, the text assertion passed and only an executed pg_locks probe
  -- went red.)
  --
  -- So count them, and count them only in the part of the body that runs BEFORE
  -- the seen-check. That pins both facts at once: two locks exist, and both are
  -- taken before the read they protect. Locks taken after the check would satisfy
  -- any runtime probe and close nothing.
  --
  -- Checked against the text this file actually restores, not just reasoned:
  -- untouched -> 2 locks before the seen-check, receipt lock named, PASSES;
  -- receipt lock removed -> 1, FAILS; message lock removed -> 1, FAILS. The bare
  -- presence check returned true on all three. The same three runs against the
  -- live 3000 body on portava-ci gave the same numbers (2 / 1 / 1).
  v_pos_seen := strpos(v_src, 'INTO v_seen_count');
  IF v_pos_seen = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the seen-check is missing from the restored body.';
  END IF;

  v_locks_before_seen :=
    array_length(string_to_array(left(v_src, v_pos_seen), 'FOR UPDATE'), 1) - 1;

  IF v_locks_before_seen < 2 THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: expected 2 FOR UPDATE locks before the seen-check, found %. The §7.4 race would be open.',
      v_locks_before_seen;
  END IF;

  -- Name the second lock's target as well, so a body that locked the message
  -- row twice could not satisfy the count above.
  IF left(v_src, v_pos_seen) NOT LIKE '%message_thread_members%FOR UPDATE%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: no FOR UPDATE on message_thread_members before the seen-check.';
  END IF;

  IF has_function_privilege('authenticated',
       'public.telegraph_unsend_message_before_seen(uuid, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated must not hold EXECUTE.';
  END IF;
  IF has_function_privilege('anon',
       'public.telegraph_unsend_message_before_seen(uuid, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon must not hold EXECUTE.';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.telegraph_unsend_message_before_seen(uuid, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role must hold EXECUTE.';
  END IF;
END $$;

DELETE FROM public.schema_migration_ledger
 WHERE filename = '3000_telegraph_unsend_authoritative.sql';

COMMIT;

-- ── OPTIONAL, AND NOT PART OF THE ROLLBACK ────────────────────────────────────
-- Only for a caller that must not see lifecycle_state populated on rows 3000
-- unsent. This DISCARDS correct information; the default is to leave it.
--
--   UPDATE public.messages
--      SET lifecycle_state = NULL
--    WHERE unsent_at IS NOT NULL
--      AND lifecycle_state = 'unsent';
--
-- Count them first:
--   SELECT count(*) FROM public.messages
--    WHERE unsent_at IS NOT NULL AND lifecycle_state = 'unsent';
