-- 3770_trip_hard_delete_thread_guard.sql
--
-- Owner ruling OD-1012-DEL-1 (docs/ops/owner-decisions-20261012.md): "Investigate
-- trip hard-delete error 23514 and repair the intended trip/chat lifecycle. Do not
-- bypass the constraint or blindly cascade-delete chat history. Bring back any
-- unresolved retention or ownership decision."
--
-- ── THE DEFECT ───────────────────────────────────────────────────────────────
-- `message_threads.trip_id` references `trips(id)` ON DELETE SET NULL (baseline
-- `message_threads_trip_id_fkey`), while `chk_thread_context` (3660) lets only a
-- `trip` thread carry a trip_id and REQUIRES a `trip` thread to carry one. So the
-- referential action can never succeed: deleting a trip that still has its crew
-- conversation fails with a raw 23514 on a row of a table the deleter never
-- named ("new row for relation message_threads violates check constraint
-- chk_thread_context"). Who meets it today:
--   * the trip owner over PostgREST — `trips_delete` (owner_id = auth.uid()) plus
--     the baseline's GRANT ALL to authenticated make the hard delete a client
--     door; no server route hard-deletes (DELETE /api/trips/:tripId archives);
--   * any operator / harness DELETE of a trip (scripts/local-db's deleteUser
--     deletes trips by owner_id before the profile);
--   * a schema still carrying the 2026-08-19 baseline's CASCADE edge
--     trips.owner_id -> profiles: deleting the profile cascades into the trip.
--     The canonical chain re-rules that edge to SET NULL in 2139 ("co-travellers
--     keep the itinerary"), so account deletion there leaves the trip, its
--     thread and the other members' messages in place, owner nulled.
--
-- ── WHAT THE APPROVED RULES SAY, AND WHAT THEY DO NOT ───────────────────────
-- Decided: the product's "delete a trip" is an ARCHIVE (routes/trips-expansion.ts
-- DELETE /trips/:tripId, kernel ARCHIVE_TRIP with soft_delete); account deletion
-- keeps a shared trip for its co-travellers and keeps a conversation's other side
-- (2139). Telegraph spec v1.1 §30.15: canonical conversations and messages are
-- durable. NOT decided: what a trip's conversation and its messages become when
-- the trip row itself is destroyed — kept for the members (as what kind of
-- thread, owned by whom, readable by the members the trip had already removed?),
-- archived read-only, or erased (on what retention clock?). `trips`,
-- `message_threads` and `message_thread_members` sit in UNCLASSIFIED_BACKLOG of
-- lib/deletionDispositions.ts; Trips spec v4 §5.3 keeps a trip "until
-- deletion/retention policy", which does not exist.
--
-- ── SO THIS FILE DECIDES NOTHING: IT REFUSES, CLEARLY, BEFORE ANYTHING MOVES ─
-- A BEFORE DELETE ROW trigger on `trips` refuses the delete of a trip that still
-- has a thread carrying its id, with SQLSTATE PT409 (PostgREST answers HTTP 409)
-- and a message that names the trip, the reason and the archive path, instead of
-- a 23514 about another table. The refusal aborts the whole statement, so a
-- multi-row DELETE, or a profile delete cascading into trips, removes nothing.
-- It does not touch chk_thread_context, the foreign key, any thread or any
-- message; a trip with no thread deletes exactly as it does today.
--
-- SECURITY DEFINER because the deleter may not be able to SEE the thread: an
-- owner who has left the crew thread is hidden from it by mt_select, and an
-- invoker-rights lookup would miss it and fall through to the raw 23514. EXECUTE
-- is revoked from client roles (a trigger function's EXECUTE is checked when the
-- trigger is created, not when it fires).
--
-- SAFE TO LEAVE UNAPPLIED. Unapplied, the same deletes fail as today, with 23514.
--
-- Rollback: db/rollback/2026-10-12-3770-trip-hard-delete-thread-guard-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trips') IS NULL OR to_regclass('public.message_threads') IS NULL THEN
    RAISE EXCEPTION '3770: public.trips and public.message_threads are required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'message_threads' AND column_name = 'trip_id') THEN
    RAISE EXCEPTION '3770: message_threads.trip_id is required';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.trips_refuse_delete_with_thread()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  -- Any thread carrying this trip's id. chk_thread_context lets only a `trip`
  -- thread carry one today; if a later arm admits another type, refusing it too
  -- is the fail-closed reading until its fate is decided.
  IF EXISTS (SELECT 1 FROM public.message_threads th WHERE th.trip_id = OLD.id) THEN
    RAISE EXCEPTION 'trip_delete_refused: trip % still has its crew conversation', OLD.id
      USING ERRCODE = 'PT409',
            DETAIL = 'trip_thread_fate_undecided: what the conversation and its messages become when the trip itself is destroyed is open owner decision OD-1012-DEL-1. Nothing was deleted.',
            HINT = 'Archive the trip instead: DELETE /api/trips/:tripId archives it and keeps the conversation.';
  END IF;
  RETURN OLD;
END
$fn$;

COMMENT ON FUNCTION public.trips_refuse_delete_with_thread() IS
  'OD-1012-DEL-1 (3770): refuses the hard delete of a trip that still has a message thread carrying its id (SQLSTATE PT409), before any cascade runs, instead of the raw 23514 the SET NULL foreign key raises against chk_thread_context. Decides nothing about the thread or its messages.';

DROP TRIGGER IF EXISTS trips_refuse_delete_with_thread ON public.trips;
CREATE TRIGGER trips_refuse_delete_with_thread
  BEFORE DELETE ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.trips_refuse_delete_with_thread();

REVOKE ALL ON FUNCTION public.trips_refuse_delete_with_thread() FROM PUBLIC, anon, authenticated;

COMMIT;

-- ── Postconditions (recomputed from the catalog; nothing carried from the body) ──
DO $post$
DECLARE
  v_fn  regprocedure := to_regprocedure('public.trips_refuse_delete_with_thread()');
  v_def text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3770): trips_refuse_delete_with_thread() is missing';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3770): trips_refuse_delete_with_thread() is not SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn
                    AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3770): trips_refuse_delete_with_thread() has no pinned search_path';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3770): a client role can execute trips_refuse_delete_with_thread()';
  END IF;

  SELECT pg_get_triggerdef(t.oid) INTO v_def FROM pg_trigger t
   WHERE t.tgrelid = 'public.trips'::regclass
     AND t.tgname = 'trips_refuse_delete_with_thread' AND NOT t.tgisinternal;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3770): trigger trips_refuse_delete_with_thread is not on trips';
  END IF;
  IF position('BEFORE DELETE ON public.trips' in v_def) = 0
     OR position('FOR EACH ROW' in v_def) = 0
     OR position('trips_refuse_delete_with_thread()' in v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3770): trigger is not BEFORE DELETE FOR EACH ROW: %', v_def;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.trips'::regclass
                AND t.tgname = 'trips_refuse_delete_with_thread' AND t.tgenabled = 'D') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3770): trigger trips_refuse_delete_with_thread is DISABLED';
  END IF;
END
$post$;
