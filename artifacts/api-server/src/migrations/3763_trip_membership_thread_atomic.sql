-- 3763_trip_membership_thread_atomic.sql
--
-- census-telegraph T319 (RECON-W cluster A4): trip membership and the trip's
-- chat-thread membership are TWO writes. Every writer changes `trip_members`
-- (directly, or through `trip_kernel_execute`), answers, and only then — fire
-- and forget — `syncTripChatMembers` (lib/chatSync.ts, services/groupChatSync.ts)
-- sets `message_thread_members.left_at`. Between the two, and for good if the
-- sync fails (it returns null or throws into a `.catch`, and nothing retries), a
-- member the trip REMOVED is still an active member of the crew thread, and every
-- door that authorizes on `message_thread_members` alone — the messages RLS
-- policies, realtime, the roster, unread counts — keeps treating them as crew.
--
-- ── THE FIX: one SECURITY DEFINER function, run INSIDE every membership write ─
-- `public.trip_members_end_thread_membership()` is an AFTER ROW trigger on
-- `trip_members` for DELETE and for UPDATE OF role, status, user_id, trip_id.
-- When a row stops being an accepted crew membership, the same transaction sets
-- `left_at = now()` on that person's active row in that trip's thread. If that
-- UPDATE fails, the membership write fails with it: neither happens without the
-- other.
--
-- WHY A TRIGGER RATHER THAN AN RPC EVERY WRITER CALLS. The writers are many and
-- not all of them are visible to a literal scan: the flag-off route statements
-- (routes/trips.ts, routes/requests.ts), `trip_kernel_execute`'s
-- REMOVE_PARTICIPANT / SET_PARTICIPANT_ROLE / DECLINE_INVITE, the account-
-- deletion cascades from `profiles`, and any future rpc. check:trip-kernel-writers
-- says of itself that "an `.rpc(` to a function that writes is invisible to a
-- literal scan". A trigger routes every one of them by construction, the kernel
-- included, without bypassing or wrapping it — the kernel's own statement fires
-- it. This is the shape 3972 already uses on this table for the same reason
-- (`trip_members_clear_anchor_grants`: a grant that stopped being true is cleared
-- "where the change happens ... so no writer can forget it").
--
-- WHAT COUNTS AS "STOPPED BEING CREW". The same rule 3972 uses (and
-- requireTripMember): role in owner / co_host / member / viewer AND
-- coalesce(status, 'accepted') = 'accepted'. Deliberately the WIDER set: the sync
-- helpers reconcile the thread to owner / member only, so this trigger never
-- removes anyone the sync would keep, and leaves the sync's treatment of co_host /
-- viewer exactly as it is today (an owner decision this file does not make).
--
-- WHAT IT DOES NOT DO. It never ADDS anyone to a thread (joining stays with the
-- sync, whose delay costs access, not privacy), creates no thread, touches no
-- circle or direct thread, writes no other column, and changes no row of
-- `trip_members`. It is a no-op for a person with no active thread row.
--
-- SAFE TO LEAVE UNAPPLIED. Nothing in the application calls it. Unapplied, every
-- write behaves exactly as it does today and the sync still ends the thread row
-- later. Applied, the sync finds the row already ended and does nothing new.
--
-- Rollback: db/rollback/2026-10-11-3763-trip-membership-thread-atomic-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trip_members') IS NULL OR to_regclass('public.message_thread_members') IS NULL
     OR to_regclass('public.message_threads') IS NULL THEN
    RAISE EXCEPTION '3763: trip_members, message_threads and message_thread_members are required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'message_thread_members' AND column_name = 'left_at') THEN
    RAISE EXCEPTION '3763: message_thread_members.left_at is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'message_threads' AND column_name = 'trip_id') THEN
    RAISE EXCEPTION '3763: message_threads.trip_id is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trip_members' AND column_name = 'status') THEN
    RAISE EXCEPTION '3763: trip_members.status is required (the accepted-crew rule reads it)';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.trip_members_end_thread_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  is_crew boolean;
BEGIN
  -- A DELETE always ends it. An UPDATE ends it unless the row is still accepted
  -- crew, as the same person on the same trip. `role` is the member_role ENUM:
  -- compared as text (3972 learned that coalesce(role, '') casts '' to
  -- member_role and raises 22P02 on every role/status update). There is no
  -- "was it crew before" short-cut on purpose: a person who is not crew after
  -- this write has no business on the crew thread, whatever they were before.
  IF TG_OP = 'UPDATE' THEN
    is_crew := coalesce(NEW.role::text, '') IN ('owner', 'co_host', 'member', 'viewer')
               AND coalesce(NEW.status, 'accepted') = 'accepted';
    IF is_crew AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id AND OLD.trip_id IS NOT DISTINCT FROM NEW.trip_id THEN
      RETURN NULL;
    END IF;
  END IF;

  UPDATE public.message_thread_members tm
     SET left_at = now()
    FROM public.message_threads th
   WHERE th.id = tm.thread_id
     AND th.thread_type = 'trip'
     AND th.trip_id = OLD.trip_id
     AND tm.user_id = OLD.user_id
     AND tm.left_at IS NULL;
  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION public.trip_members_end_thread_membership() IS
  'census-telegraph T319 (3763): when a trip_members row stops being accepted crew (deleted, demoted to invited, status no longer accepted, or moved), end that person''s active membership of the trip''s chat thread IN THE SAME TRANSACTION. Never adds anyone; never touches circle or direct threads.';

DROP TRIGGER IF EXISTS trip_members_end_thread_membership ON public.trip_members;
CREATE TRIGGER trip_members_end_thread_membership
  AFTER DELETE OR UPDATE OF role, status, user_id, trip_id ON public.trip_members
  FOR EACH ROW EXECUTE FUNCTION public.trip_members_end_thread_membership();

-- RETURNS trigger cannot be called over PostgREST, but EXECUTE defaults to PUBLIC
-- on creation; nothing but the trigger needs it.
REVOKE ALL ON FUNCTION public.trip_members_end_thread_membership() FROM PUBLIC, anon, authenticated;

COMMIT;

-- ── Postconditions (recomputed from the catalog; nothing carried from the body) ──
DO $post$
DECLARE
  v_fn  regprocedure := to_regprocedure('public.trip_members_end_thread_membership()');
  v_def text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3763): trip_members_end_thread_membership() is missing';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3763): trip_members_end_thread_membership() is not SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn
                    AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3763): trip_members_end_thread_membership() has no pinned search_path';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3763): a client role can execute trip_members_end_thread_membership()';
  END IF;

  SELECT pg_get_triggerdef(t.oid) INTO v_def FROM pg_trigger t
   WHERE t.tgrelid = 'public.trip_members'::regclass
     AND t.tgname = 'trip_members_end_thread_membership' AND NOT t.tgisinternal;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3763): trigger trip_members_end_thread_membership is not on trip_members';
  END IF;
  IF position('AFTER DELETE OR UPDATE OF role, status, user_id, trip_id' in v_def) = 0
     OR position('FOR EACH ROW' in v_def) = 0
     OR position('trip_members_end_thread_membership()' in v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3763): trigger does not cover every write that can end a membership: %', v_def;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.trip_members'::regclass
                AND t.tgname = 'trip_members_end_thread_membership' AND t.tgenabled = 'D') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3763): trigger trip_members_end_thread_membership is DISABLED';
  END IF;
END
$post$;
