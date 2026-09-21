-- 2760_trip_stages.sql
--
-- Trips v4 §5.1 `trip_stages` (census-trips TR78), the root of §5's dependency
-- graph: `trip_legs` joins two stages, `trip_commitments` hangs off one, and
-- §7.4's stage-locality check (TR136) has nothing to be local TO without it.
-- Nothing in this tree has a stage concept today — verified against portava-ci
-- and production 2026-09-09: no trip_stages, trip_legs or trip_commitments.
--
-- SPEC COLUMNS, VERBATIM
-- ======================
--   id, trip_id, stage_type, place_id/city_id, timezone, starts_at, ends_at,
--   state, sequence
--
-- `place_id/city_id` is the spec's own slash: a stage is anchored to a canonical
-- place OR to a city, not both, and not neither. That is written as a CHECK
-- rather than left to a convention, because "exactly one anchor" is the property
-- every consumer will assume and none can verify cheaply.
--
-- WHY THIS FILE ADDS NO WRITER, AND WHY THAT MEANS THE CENSUS ROW STAYS OPEN
-- =========================================================================
-- census-trips' own rule 2: "A table nothing writes satisfies nothing." That is
-- correct and this migration does not pretend otherwise — TR78 does NOT close
-- here. §4 requires every aggregate mutation to go through the command path, so
-- the writer is a family of kernel commands, and every kernel change in this
-- repo replaces trip_kernel_execute in full. Schema first, in its own file, so
-- that replacement happens ONCE for all of §5's new families rather than five
-- times; the ordering is deliberate and is recorded in census-trips §26.
--
-- Until that lands this table is deliberately unreachable: RLS on, SELECT for
-- crew only, and NO client grants at all. An empty table nobody can write and
-- only crew can read cannot mislead a consumer into thinking stages exist.
--
-- `sequence` is per-trip and unique, like trip_events.sequence — a stage order
-- that can collide is not an order.

BEGIN;

DO $pre$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public' AND table_name='trips';
  IF n <> 1 THEN RAISE EXCEPTION '2760: public.trips must exist'; END IF;

  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE ns.nspname='authz' AND p.proname='is_trip_crew';
  IF n < 1 THEN RAISE EXCEPTION '2760: authz.is_trip_crew is required for the RLS policy (2334)'; END IF;

  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public' AND table_name='trip_stages';
  IF n <> 0 THEN RAISE EXCEPTION '2760: trip_stages already exists'; END IF;
END
$pre$;

CREATE TABLE public.trip_stages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     uuid        NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  stage_type  text        NOT NULL,
  place_id    uuid        NULL,
  city_id     uuid        NULL,
  timezone    text        NOT NULL,
  starts_at   timestamptz NULL,
  ends_at     timestamptz NULL,
  state       text        NOT NULL DEFAULT 'planned',
  sequence    integer     NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- The spec's `place_id/city_id`: exactly one anchor.
  CONSTRAINT trip_stages_one_anchor
    CHECK ((place_id IS NOT NULL) <> (city_id IS NOT NULL)),
  -- The §4.4 ordering rule, applied here at birth rather than retrofitted the
  -- way trip_plan_items needed in 2750.
  CONSTRAINT trip_stages_interval_ordered
    CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at >= starts_at),
  CONSTRAINT trip_stages_sequence_positive CHECK (sequence > 0),
  CONSTRAINT trip_stages_trip_sequence_unique UNIQUE (trip_id, sequence),
  -- Vocabularies are CHECKs, not conventions. A stage_type nobody declared is a
  -- stage no consumer can render.
  CONSTRAINT trip_stages_type_known
    CHECK (stage_type IN ('city','transit','lodging','excursion','layover')),
  CONSTRAINT trip_stages_state_known
    CHECK (state IN ('planned','active','completed','cancelled'))
);

COMMENT ON TABLE public.trip_stages IS
  'Trips spec §5.1 trip_stages — the stage spine a trip is divided into. Written only by public.trip_kernel_execute once the stage command family lands (§4); until then this table has no writer and census-trips TR78 stays open. RLS: crew SELECT only, no client grants.';

CREATE INDEX idx_trip_stages_trip_sequence ON public.trip_stages (trip_id, sequence);
CREATE INDEX idx_trip_stages_trip_state    ON public.trip_stages (trip_id, state);

ALTER TABLE public.trip_stages ENABLE ROW LEVEL SECURITY;

-- Crew may read their own trip's stages. Nobody may write from a client: the
-- kernel writes as service_role, which bypasses RLS.
CREATE POLICY trip_stages_select_crew ON public.trip_stages
  FOR SELECT USING (authz.is_trip_crew(trip_id));

REVOKE ALL ON public.trip_stages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trip_stages TO authenticated;

DO $post$
DECLARE n int; r record;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public' AND table_name='trip_stages';
  IF n <> 1 THEN RAISE EXCEPTION '2760: table absent after create'; END IF;

  SELECT relrowsecurity INTO r FROM pg_class WHERE oid='public.trip_stages'::regclass;
  IF NOT r.relrowsecurity THEN RAISE EXCEPTION '2760: RLS not enabled'; END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND tablename='trip_stages';
  IF n <> 1 THEN RAISE EXCEPTION '2760: expected exactly 1 policy, found %', n; END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND tablename='trip_stages' AND cmd <> 'SELECT';
  IF n <> 0 THEN RAISE EXCEPTION '2760: a non-SELECT policy exists; this table has no client writer'; END IF;

  -- No client may write. Checked as an equality because "only the kernel writes
  -- this" is the whole containment argument for shipping a writerless table.
  IF has_table_privilege('authenticated', 'public.trip_stages', 'INSERT')
     OR has_table_privilege('authenticated', 'public.trip_stages', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.trip_stages', 'DELETE')
  THEN RAISE EXCEPTION '2760: authenticated holds a write privilege on trip_stages'; END IF;
  IF NOT has_table_privilege('authenticated', 'public.trip_stages', 'SELECT')
  THEN RAISE EXCEPTION '2760: authenticated cannot SELECT trip_stages'; END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid='public.trip_stages'::regclass AND contype='c';
  IF n < 5 THEN RAISE EXCEPTION '2760: expected the 5 CHECK constraints, found %', n; END IF;
END
$post$;

COMMIT;
