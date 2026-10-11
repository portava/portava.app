-- 3768_trips_current_stage_and_home_timezone.sql
--
-- Trips v4 §5.1, `trips` key columns (census-trips TR77): `current_stage_id` and
-- `home_timezone`. They were the two of the row's seven key columns that no
-- migration created (census §7.3, §39 and §75 each counted zero occurrences under
-- artifacts/api-server/src/). `version` landed with the kernel; `owner_user_id`
-- and `lifecycle_state` are spelled `owner_id` and `status` and stay as they are.
--
-- ── WHAT THIS FILE ADDS ─────────────────────────────────────────────────────
-- 1. trips.current_stage_id uuid NULL — the stage the trip is in NOW.
--    STORED, not computed, because §5.1 lists it as a column. It is a fact the
--    crew states: START_STAGE sets it, COMPLETE_STAGE clears it. Interval
--    containment cannot say it: stages may have no times, and a stage that ran
--    long is still current after its planned end.
--    A COMPOSITE foreign key (current_stage_id, id) -> trip_stages (id, trip_id)
--    makes "another trip's stage" unrepresentable. A plain FK on
--    current_stage_id would accept any stage id. The UNIQUE (id, trip_id) on
--    trip_stages exists only to be that FK's target; id alone is already unique.
--    ON DELETE SET NULL (current_stage_id): REMOVE_STAGE on the current stage
--    clears the pointer. Only that column is nulled, never trips.id. The
--    column-list form needs PostgreSQL 15+, asserted in $pre$.
-- 2. trips.home_timezone text NULL — the traveller's home IANA zone.
--    The trip's own `timezone` is the DESTINATION's zone (computeTripStatus reads
--    it for the trip's local day). §5.1 names this as a separate column.
--    A CHECK constrains its SHAPE (2797's precedent: a CHECK cannot ask tzdata
--    whether a zone exists): letters, digits, '_', '-' and '/' segments, with
--    '+' only after the first '/', so 'Etc/GMT+5' passes and the POSIX offset
--    'UTC+3' does not. The kernel asks: UPDATE_TRIP refuses any zone
--    absent from pg_timezone_names. A POSIX string such as 'XYZ3' passes
--    `AT TIME ZONE` and is still refused, because it is not a NAMED zone.
--
-- ── WHO WRITES THEM ────────────────────────────────────────────────────────
-- Only public.trip_kernel_execute (§4: every aggregate mutation is a command):
--   * UPDATE_TRIP accepts `home_timezone` in its strict patch allow-list
--     (null clears it).
--   * START_STAGE sets current_stage_id to the stage it started.
--   * COMPLETE_STAGE clears it if that stage was current.
--   * UPDATE_STAGE with a `state` patch follows the same rule: 'active' makes
--     the stage current, and any other state clears it if it was current.
--   * REMOVE_STAGE is covered by the foreign key.
-- current_stage_id is deliberately NOT in UPDATE_TRIP's allow-list: a pointer
-- the client could set directly would not need to agree with the stage's state.
-- Clients reach both only through the server's routes. trips carries Supabase's
-- default table-level client grants, so a PostgREST owner write is NOT closed
-- by this file. That is the pre-existing client-grant gap on every trips
-- column (memory: client write-grants audit). The composite FK and the shape
-- CHECK bound what such a write could store.
--
-- ── EXISTING ROWS ──────────────────────────────────────────────────────────
-- Both columns are NULL on every existing trip. There is NO backfill. Copying
-- trips.timezone would put the destination's zone in the home column. Picking
-- an 'active' stage would invent a START_STAGE nobody issued. A backfill is an
-- owner decision (census-trips §92).
--
-- ── ORDER / ANCESTRY ───────────────────────────────────────────────────────
-- The kernel is transformed by named anchors, each asserted to occur exactly once
-- (2764's method). The anchors are 2450's UPDATE_TRIP allow-list / visibility
-- check / show_header_publicly column, 2764's UPDATE_STAGE event tail and 2779's
-- stage-state UPDATE. None of them is read or written by 3970-3979. 3979 anchors
-- on v_rec_day and ADMIN_HIDE_TRIP and counts branches, admin dispatch entries
-- and participant family assignments, and this file adds none of those. So the
-- two files commute: on a fresh chain this runs before 3979, and on portava-ci
-- it runs after it.
--
-- Rollback: db/rollback/2026-10-11-3768-trips-current-stage-and-home-timezone-rollback.sql

BEGIN;

DO $pre$
DECLARE d text; n int;
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION '3768: PostgreSQL 15+ is required (ON DELETE SET NULL (column) on the composite foreign key)';
  END IF;
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name IN ('trips', 'trip_stages');
  IF n <> 2 THEN RAISE EXCEPTION '3768: public.trips and public.trip_stages (2760) must exist'; END IF;
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'trips' AND column_name IN ('current_stage_id', 'home_timezone');
  IF n <> 0 THEN RAISE EXCEPTION '3768: trips already has current_stage_id/home_timezone (% of 2)', n; END IF;
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION '3768: trip_kernel_execute not found'; END IF;
  IF position('START_STAGE' in d) = 0 OR position('c_trip_patch' in d) = 0 THEN
    RAISE EXCEPTION '3768: the installed kernel predates 2779 (START_STAGE) or 2450 (UPDATE_TRIP allow-list); apply the kernel ancestry first';
  END IF;
  IF position('home_timezone' in d) > 0 OR position('current_stage_id' in d) > 0 THEN
    RAISE EXCEPTION '3768: the kernel already names home_timezone/current_stage_id; this migration is not idempotent by design';
  END IF;
END
$pre$;

ALTER TABLE public.trips
  ADD COLUMN current_stage_id uuid NULL,
  ADD COLUMN home_timezone    text NULL;

ALTER TABLE public.trip_stages
  ADD CONSTRAINT trip_stages_id_trip_unique UNIQUE (id, trip_id);

ALTER TABLE public.trips
  ADD CONSTRAINT trips_current_stage_same_trip
    FOREIGN KEY (current_stage_id, id) REFERENCES public.trip_stages (id, trip_id)
    ON DELETE SET NULL (current_stage_id),
  ADD CONSTRAINT trips_home_timezone_shaped
    CHECK (home_timezone IS NULL
           OR (char_length(home_timezone) BETWEEN 1 AND 64
               AND home_timezone ~ '^[A-Za-z][A-Za-z0-9_-]*(/[A-Za-z0-9_+-]+)*$'));

COMMENT ON COLUMN public.trips.current_stage_id IS
  'Trips spec §5.1: the stage the trip is in now. Written only by trip_kernel_execute (START_STAGE sets, COMPLETE_STAGE / UPDATE_STAGE away from active clears; REMOVE_STAGE via the FK). NULL = no stage started. Composite FK: always a stage of THIS trip. Migration 3768.';
COMMENT ON COLUMN public.trips.home_timezone IS
  'Trips spec §5.1: the traveller''s home IANA zone, distinct from trips.timezone (the destination''s). Written only by trip_kernel_execute UPDATE_TRIP, which refuses a name absent from pg_timezone_names; the CHECK constrains shape only. NULL = not stated (no backfill). Migration 3768.';

DO $mig$
DECLARE
  d text;
  n int;
  before_len int;
  branches_before int;
  -- 1. the UPDATE_TRIP allow-list
  a_list  constant text := $a$'plan_edit_permission','progress','show_header_publicly'];$a$;
  r_list  constant text := $a$'plan_edit_permission','progress','show_header_publicly','home_timezone'];$a$;
  -- 2. UPDATE_TRIP: the zone must be a NAMED zone tzdata carries
  a_vis   constant text := $a$        IF v_patch ? 'visibility' AND (v_patch->>'visibility') NOT IN ('public','buddies','private','invite') THEN
$a$;
  r_vis   constant text := $a$        -- 3768 (census-trips TR77): a home zone is a name tzdata carries, or null to clear it.
        IF v_patch ? 'home_timezone' AND jsonb_typeof(v_patch->'home_timezone') <> 'null' THEN
          IF jsonb_typeof(v_patch->'home_timezone') <> 'string'
             OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name = v_patch->>'home_timezone') THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_COMMAND_MALFORMED',
                                      'detail', 'home_timezone is not a time zone name this database knows', 'contract_version', 2);
          END IF;
        END IF;
        IF v_patch ? 'visibility' AND (v_patch->>'visibility') NOT IN ('public','buddies','private','invite') THEN
$a$;
  -- 3. UPDATE_TRIP: the column write
  a_col   constant text := $a$          show_header_publicly     = CASE WHEN v_patch ? 'show_header_publicly'     THEN (v_patch->>'show_header_publicly')::boolean        ELSE show_header_publicly END,
$a$;
  r_col   constant text := $a$          show_header_publicly     = CASE WHEN v_patch ? 'show_header_publicly'     THEN (v_patch->>'show_header_publicly')::boolean        ELSE show_header_publicly END,
          home_timezone            = CASE WHEN v_patch ? 'home_timezone'            THEN v_patch->>'home_timezone'                          ELSE home_timezone END,
$a$;
  -- 4. START_STAGE / COMPLETE_STAGE (2779): the pointer follows the transition
  a_start constant text := $a$        UPDATE public.trip_stages SET state = v_new_status, updated_at = now() WHERE id = v_stage_id;
$a$;
  r_start constant text := $a$        UPDATE public.trip_stages SET state = v_new_status, updated_at = now() WHERE id = v_stage_id;
        -- 3768 (census-trips TR77): the trip's current-stage pointer is the stage the crew started last.
        IF v_type = 'START_STAGE' THEN
          UPDATE public.trips SET current_stage_id = v_stage_id WHERE id = v_trip_id;
        ELSE
          UPDATE public.trips SET current_stage_id = NULL WHERE id = v_trip_id AND current_stage_id = v_stage_id;
        END IF;
$a$;
  -- 5. UPDATE_STAGE (2764): a `state` patch is the same transition, said differently
  a_upd   constant text := $a$        v_family     := 'stage';
        v_event_type := 'trip.stage_updated';
$a$;
  r_upd   constant text := $a$        -- 3768 (census-trips TR77): a state patch moves the current-stage pointer as START/COMPLETE_STAGE do.
        IF v_patch ? 'state' THEN
          IF v_patch->>'state' = 'active' THEN
            UPDATE public.trips SET current_stage_id = v_stage_id WHERE id = v_trip_id;
          ELSE
            UPDATE public.trips SET current_stage_id = NULL WHERE id = v_trip_id AND current_stage_id = v_stage_id;
          END IF;
        END IF;
        v_family     := 'stage';
        v_event_type := 'trip.stage_updated';
$a$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  before_len := length(d);
  branches_before := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');

  n := (length(d) - length(replace(d, a_list, ''))) / length(a_list);
  IF n <> 1 THEN RAISE EXCEPTION '3768: anchor c_trip_patch tail occurs % times, expected 1', n; END IF;
  d := replace(d, a_list, r_list);

  n := (length(d) - length(replace(d, a_vis, ''))) / length(a_vis);
  IF n <> 1 THEN RAISE EXCEPTION '3768: anchor UPDATE_TRIP visibility check occurs % times, expected 1', n; END IF;
  d := replace(d, a_vis, r_vis);

  n := (length(d) - length(replace(d, a_col, ''))) / length(a_col);
  IF n <> 1 THEN RAISE EXCEPTION '3768: anchor show_header_publicly column occurs % times, expected 1', n; END IF;
  d := replace(d, a_col, r_col);

  n := (length(d) - length(replace(d, a_start, ''))) / length(a_start);
  IF n <> 1 THEN RAISE EXCEPTION '3768: anchor stage-state UPDATE (2779) occurs % times, expected 1', n; END IF;
  d := replace(d, a_start, r_start);

  n := (length(d) - length(replace(d, a_upd, ''))) / length(a_upd);
  IF n <> 1 THEN RAISE EXCEPTION '3768: anchor UPDATE_STAGE event tail occurs % times, expected 1', n; END IF;
  d := replace(d, a_upd, r_upd);

  IF length(d) <= before_len THEN RAISE EXCEPTION '3768: the transform did not grow the definition'; END IF;
  n := (length(d) - length(replace(d, E'\n      WHEN ''', ''))) / length(E'\n      WHEN ''');
  IF n <> branches_before THEN
    RAISE EXCEPTION '3768: the transform changed the number of command branches (% -> %); it adds none', branches_before, n;
  END IF;

  EXECUTE d;
END
$mig$;

COMMIT;

-- ── Postconditions (a separate session under the live applier: everything is
--    recomputed from the catalog; nothing the body left behind is read) ───────
DO $post$
DECLARE d text; t text; n int; i int; j int; b text;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'trips'
     AND ((column_name = 'current_stage_id' AND data_type = 'uuid') OR (column_name = 'home_timezone' AND data_type = 'text'))
     AND is_nullable = 'YES' AND column_default IS NULL;
  IF n <> 2 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3768): trips.current_stage_id uuid / home_timezone text, nullable, no default: found % of 2', n; END IF;

  SELECT count(*) INTO n FROM pg_constraint c
   WHERE c.conrelid = 'public.trips'::regclass AND c.conname = 'trips_current_stage_same_trip'
     AND c.contype = 'f' AND c.confrelid = 'public.trip_stages'::regclass AND c.confdeltype = 'n'
     AND array_length(c.conkey, 1) = 2
     AND c.confdelsetcols = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.trips'::regclass AND attname = 'current_stage_id')]::int2[];
  IF n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3768): the composite same-trip FK with ON DELETE SET NULL (current_stage_id) is missing'; END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.trip_stages'::regclass AND conname = 'trip_stages_id_trip_unique' AND contype = 'u';
  IF n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3768): trip_stages (id, trip_id) UNIQUE missing'; END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.trips'::regclass AND conname = 'trips_home_timezone_shaped' AND contype = 'c';
  IF n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3768): trips_home_timezone_shaped CHECK missing'; END IF;

  SELECT pg_get_functiondef(p.oid) INTO d
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'trip_kernel_execute';
  IF d IS NULL THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3768): trip_kernel_execute not found'; END IF;
  FOREACH t IN ARRAY ARRAY[
    $a$'show_header_publicly','home_timezone'];$a$,
    'pg_catalog.pg_timezone_names',
    $a$home_timezone            = CASE WHEN v_patch ? 'home_timezone'$a$,
    'UPDATE public.trips SET current_stage_id = v_stage_id WHERE id = v_trip_id;',
    'UPDATE public.trips SET current_stage_id = NULL WHERE id = v_trip_id AND current_stage_id = v_stage_id;',
    -- what the transform did not name must still be there
    'TRIP_VERSION_CONFLICT', 'authz.is_accepted_trip_member', 'trip_command_receipts', 'trip_outbox',
    'trip.stage_started', 'trip.stage_completed', 'trip.stage_updated', 'TRIP_STAGE_INVALID_TRANSITION'] LOOP
    IF position(t in d) = 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3768): % missing after apply', t; END IF;
  END LOOP;
  -- The pointer is set in exactly two places (START_STAGE, UPDATE_STAGE→active)
  -- and cleared in exactly two (COMPLETE_STAGE, UPDATE_STAGE away from active).
  t := 'UPDATE public.trips SET current_stage_id = v_stage_id WHERE id = v_trip_id;';
  n := (length(d) - length(replace(d, t, ''))) / length(t);
  IF n <> 2 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3768): current_stage_id is set in % places, expected 2', n; END IF;
  t := 'UPDATE public.trips SET current_stage_id = NULL WHERE id = v_trip_id AND current_stage_id = v_stage_id;';
  n := (length(d) - length(replace(d, t, ''))) / length(t);
  IF n <> 2 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3768): current_stage_id is cleared in % places, expected 2', n; END IF;
  -- Nowhere else may name the pointer: not UPDATE_TRIP's allow-list, not CREATE_TRIP.
  n := (length(d) - length(replace(d, 'current_stage_id', ''))) / length('current_stage_id');
  IF n <> 6 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3768): current_stage_id is named % times in the kernel, expected 6 (2 sets + 2 clears x2)', n; END IF;

  -- The UPDATE_TRIP validation sits INSIDE UPDATE_TRIP's branch.
  i := position(E'      WHEN ''UPDATE_TRIP'' THEN\n' in d);
  j := position(E'      WHEN ''CANCEL_TRIP'', ''COMPLETE_TRIP'', ''ARCHIVE_TRIP'' THEN\n' in d);
  IF i = 0 OR j <= i THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3768): UPDATE_TRIP branch bounds not found'; END IF;
  b := substr(d, i, j - i);
  IF position('pg_catalog.pg_timezone_names' in b) = 0 OR position($a$home_timezone            = CASE$a$ in b) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3768): the home_timezone check or write is not inside UPDATE_TRIP';
  END IF;
END
$post$;
