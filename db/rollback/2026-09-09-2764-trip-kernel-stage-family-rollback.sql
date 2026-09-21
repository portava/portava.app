-- Rollback for 2764_trip_kernel_stage_family.sql
--
-- Removes the ADD_STAGE / UPDATE_STAGE / REMOVE_STAGE family from
-- trip_kernel_execute, returning the function to its 2590 shape.
--
-- NOT REHEARSED ON SUPABASE, for the same reason 2764 is not: neither
-- portava-ci nor production carries the 2590 kernel, so 2764 has never been
-- applied there and this file has never had a subject to run against.
--
-- It IS rehearsed on db/harness/run.sh, the local PostgreSQL 16 harness, on
-- every run: apply 2764, execute the stage commands, run this file, and diff
-- pg_get_functiondef against the definition captured before 2764. The harness
-- fails unless the restored definition is BYTE-IDENTICAL to the 2590 one, and
-- unless a second run of this file refuses.
--
-- Writing it uncovered two of its own defects, both of which the harness caught
-- and neither of which an anchor assertion would have:
--   * the dispatch anchor was indented four spaces, but 2764 writes all three
--     dispatch entries on ONE line, so only ADD_STAGE sits at a line start. The
--     count came back 0 and a rollback that would have worked was refused.
--   * the overrun postcondition was untestable until the branch-count invariant
--     was added; a mutation that excised one branch too many is now caught by
--     name and number rather than by hoping a later check notices.
--
-- This is the INVERSE TRANSFORM, not a re-CREATE of the 2590 body. Re-creating
-- the body would silently discard any later migration that had touched the
-- function; reversing the three named edits cannot, because it asserts each
-- edit is present exactly once and refuses if it is not. If some later
-- migration has rewritten the stage branches, this file stops rather than
-- guessing.
--
-- DATA: none. trip_stages rows are untouched — this removes the writer, not the
-- table. Withdrawing the table itself is
-- db/rollback/2026-09-09-2760-trip-stages-rollback.sql, and it must run AFTER
-- this one: a kernel that dispatches ADD_STAGE at a dropped table is worse than
-- either state alone.

BEGIN;

DO $rb$
DECLARE
  d text;
  n int;
  before_len int;
  branches_before int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION 'rollback 2764: trip_kernel_execute not found'; END IF;
  before_len := length(d);
  -- Every command branch begins with exactly six spaces and WHEN. Counting them
  -- makes "the excision overran" an EXACT test rather than a guess: removing
  -- three branches must remove three headers, no more.
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF branches_before < 20 THEN
    RAISE EXCEPTION 'rollback 2764: only % command branches found; this is not the post-2764 kernel', branches_before;
  END IF;

  IF position('ADD_STAGE' in d) = 0 THEN
    RAISE EXCEPTION 'rollback 2764: the stage family is not present; 2764 was never applied here';
  END IF;

  -- 3. The branches, reversed FIRST, so that a failure here leaves the
  -- declaration and the dispatch intact rather than leaving a dispatch that
  -- routes to branches which no longer exist.
  n := (length(d) - length(replace(d, $a$      WHEN 'ADD_STAGE' THEN$a$, ''))) / length($a$      WHEN 'ADD_STAGE' THEN$a$);
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 2764: ADD_STAGE branch occurs % times, expected 1', n; END IF;
  d := regexp_replace(
         d,
         $a$      WHEN 'ADD_STAGE' THEN.*?      WHEN 'REMOVE_PLAN' THEN$a$,
         $a$      WHEN 'REMOVE_PLAN' THEN$a$,
         -- No 'n' flag: in Postgres ARE, 'n' makes '.' STOP matching newline,
         -- which is the opposite of what a multi-line excision needs. The
         -- non-greedy '.*?' then stops at the FIRST REMOVE_PLAN, which is the
         -- one 2764 re-appended after its branches.
         '');
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before - 3 THEN
    RAISE EXCEPTION 'rollback 2764: the excision removed % command branches, expected exactly 3', branches_before - n;
  END IF;

  -- 2. The capability dispatch.
  -- No leading indent in this anchor: 2764 writes all three dispatch entries on
  -- ONE line, so only ADD_STAGE sits at a line start. Asserting an indented
  -- REMOVE_STAGE counts zero and refuses a rollback that would have worked.
  n := (length(d) - length(replace(d, $a$WHEN 'REMOVE_STAGE' THEN 'crew'$a$, ''))) / length($a$WHEN 'REMOVE_STAGE' THEN 'crew'$a$);
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 2764: the dispatch line occurs % times, expected 1', n; END IF;
  d := replace(d, $a$    WHEN 'ADD_STAGE' THEN 'crew' WHEN 'UPDATE_STAGE' THEN 'crew' WHEN 'REMOVE_STAGE' THEN 'crew'$a$ || E'\n', '');

  -- 1. The declaration.
  n := (length(d) - length(replace(d, '  v_stage_id   uuid;', ''))) / length('  v_stage_id   uuid;');
  IF n <> 1 THEN RAISE EXCEPTION 'rollback 2764: the v_stage_id declaration occurs % times, expected 1', n; END IF;
  d := replace(d, E'  v_stage_id   uuid;\n', '');

  IF length(d) >= before_len THEN
    RAISE EXCEPTION 'rollback 2764: the inverse transform did not shrink the definition';
  END IF;

  EXECUTE d;
END
$rb$;

DO $post$
DECLARE d text; n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';

  IF position('ADD_STAGE' in d) > 0 THEN RAISE EXCEPTION 'rollback 2764: ADD_STAGE survived'; END IF;
  IF position('UPDATE_STAGE' in d) > 0 THEN RAISE EXCEPTION 'rollback 2764: UPDATE_STAGE survived'; END IF;
  IF position('REMOVE_STAGE' in d) > 0 THEN RAISE EXCEPTION 'rollback 2764: REMOVE_STAGE survived'; END IF;
  IF position('v_stage_id' in d) > 0 THEN RAISE EXCEPTION 'rollback 2764: v_stage_id survived'; END IF;
  IF position('trip.stage_' in d) > 0 THEN RAISE EXCEPTION 'rollback 2764: a stage event type survived'; END IF;
  IF position('TRIP_STAGE_' in d) > 0 THEN RAISE EXCEPTION 'rollback 2764: a stage reason code survived'; END IF;

  -- The 2590 kernel must be INTACT, not merely stage-free. A regexp excision
  -- that overran would satisfy every check above and none of these.
  IF position('SET_TRIP_COVER' in d) = 0 THEN RAISE EXCEPTION 'rollback 2764: SET_TRIP_COVER lost — the excision overran'; END IF;
  IF position('REMOVE_PLAN' in d) = 0 THEN RAISE EXCEPTION 'rollback 2764: REMOVE_PLAN lost — the excision overran'; END IF;
  IF position('JOIN_VIA_LINK' in d) = 0 THEN RAISE EXCEPTION 'rollback 2764: JOIN_VIA_LINK lost — the excision overran'; END IF;
  IF position('TRIP_VERSION_CONFLICT' in d) = 0 THEN RAISE EXCEPTION 'rollback 2764: the version conflict was lost'; END IF;
  IF position('authz.is_accepted_trip_member' in d) = 0 THEN RAISE EXCEPTION 'rollback 2764: the crew capability check was lost'; END IF;
  IF position('trip_command_receipts' in d) = 0 THEN RAISE EXCEPTION 'rollback 2764: the idempotency receipt was lost'; END IF;
  IF position('trip_outbox' in d) = 0 THEN RAISE EXCEPTION 'rollback 2764: the outbox write was lost'; END IF;
  n := (length(d) - length(replace(d, 'TRIP_TEMPORAL_RANGE_INVERTED', ''))) / length('TRIP_TEMPORAL_RANGE_INVERTED');
  IF n <> 2 THEN RAISE EXCEPTION 'rollback 2764: expected the 2 trip-level range checks, found %', n; END IF;
END
$post$;

COMMIT;
