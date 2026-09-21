-- 2761_trip_legs_and_commitments.sql
--
-- Trips v4 §5.1 `trip_legs` and `trip_commitments` (census-trips TR79, TR81),
-- and with them the §7.1 Commitment contract fields the census scores
-- separately (TR122 the contract, TR123 requiredArrivalAt, TR124
-- latenessTolerance, TR125 prepDuration, and the shape TR126/TR127 measure).
--
-- Ordered after 2760: both reference public.trip_stages.
--
-- THE COLUMN SETS ARE THE SPEC'S, AND THE TWO HALVES ARE RECONCILED HERE
-- =====================================================================
-- §5.1 gives trip_commitments as:
--     id, trip_id, stage_id, type, starts_at, required_arrival_at, place_id,
--     flexibility, source_ref
-- §7.1 gives the Commitment model as:
--     startsAt, requiredArrivalAt, placeId, latenessTolerance, prepDuration,
--     flexibility, confidence
-- The two lists DISAGREE — §7.1 adds latenessTolerance, prepDuration and
-- confidence, which §5.1's row omits. The table is the union, because a
-- contract field with nowhere to live is a contract that cannot be honoured,
-- and because §7.2's invariant reads `required_buffer(next)` which is exactly
-- what prep_duration and lateness_tolerance parameterise. Recording the
-- disagreement rather than silently picking one list.
--
-- WHAT IS DELIBERATELY NOT HERE
-- =============================
-- §7.2's core invariant (TR128) needs `route(previous.place, next.place,
-- future_departure_time)`. There is no route provider in this tree, so the
-- invariant cannot be evaluated and is NOT attempted. What these tables give it
-- is well-formed inputs: an arrival requirement distinct from a start time, a
-- buffer, and a per-commitment confidence — the three things the invariant needs
-- that did not previously exist anywhere.
--
-- Neither table has a writer yet, for the reason 2760 states: §4 requires the
-- command path, and the kernel function is replaced whole per change, so all of
-- §5's families land together. census-trips TR79/TR81/TR122-125 therefore do
-- NOT close here — rule 2, "a table nothing writes satisfies nothing", is the
-- census's and it is right.
--
-- Both tables: RLS on, crew SELECT only, no client write grants.

BEGIN;

DO $pre$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public' AND table_name='trip_stages';
  IF n <> 1 THEN RAISE EXCEPTION '2761: requires 2760 (trip_stages)'; END IF;

  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public' AND table_name IN ('trip_legs','trip_commitments');
  IF n <> 0 THEN RAISE EXCEPTION '2761: a target table already exists (found %)', n; END IF;
END
$pre$;

-- ── trip_legs (§5.1) ─────────────────────────────────────────────────────────
-- "from_stage_id, to_stage_id" — a leg joins two stages. Both are required and
-- must differ: a leg from a stage to itself is not travel.
CREATE TABLE public.trip_legs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       uuid        NOT NULL REFERENCES public.trips(id)       ON DELETE CASCADE,
  from_stage_id uuid        NOT NULL REFERENCES public.trip_stages(id) ON DELETE CASCADE,
  to_stage_id   uuid        NOT NULL REFERENCES public.trip_stages(id) ON DELETE CASCADE,
  leg_type      text        NOT NULL,
  starts_at     timestamptz NULL,
  ends_at       timestamptz NULL,
  source_ref    text        NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_legs_distinct_stages     CHECK (from_stage_id <> to_stage_id),
  CONSTRAINT trip_legs_interval_ordered
    CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at >= starts_at),
  CONSTRAINT trip_legs_type_known
    CHECK (leg_type IN ('flight','train','bus','ferry','car','walk','other'))
);

COMMENT ON TABLE public.trip_legs IS
  'Trips spec §5.1 trip_legs — travel between two trip_stages. No writer yet (§4 command path pending); RLS crew SELECT only.';

CREATE INDEX idx_trip_legs_trip  ON public.trip_legs (trip_id);
CREATE INDEX idx_trip_legs_from  ON public.trip_legs (from_stage_id);
CREATE INDEX idx_trip_legs_to    ON public.trip_legs (to_stage_id);

ALTER TABLE public.trip_legs ENABLE ROW LEVEL SECURITY;
CREATE POLICY trip_legs_select_crew ON public.trip_legs
  FOR SELECT USING (authz.is_trip_crew(trip_id));
REVOKE ALL ON public.trip_legs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trip_legs TO authenticated;

-- ── trip_commitments (§5.1 + §7.1) ───────────────────────────────────────────
CREATE TABLE public.trip_commitments (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id             uuid        NOT NULL REFERENCES public.trips(id)       ON DELETE CASCADE,
  stage_id            uuid        NULL     REFERENCES public.trip_stages(id) ON DELETE SET NULL,
  type                text        NOT NULL,
  starts_at           timestamptz NULL,
  -- §7.1: arrival semantics DISTINCT from start time. This is the column whose
  -- absence census-trips TR123 is about — "a plan that starts at 19:00 and
  -- needs you there by 18:45 cannot say so".
  required_arrival_at timestamptz NULL,
  place_id            uuid        NULL,
  -- §7.1 / §7.2 required_buffer(next). Intervals, not integers: "20 minutes" is
  -- a duration and storing it as a bare number needs a unit convention that
  -- every reader must remember and one will forget.
  lateness_tolerance  interval    NULL,
  prep_duration       interval    NULL,
  -- §7.1 flexibility. A vocabulary, not free text (TR126 measured the existing
  -- binary lock_type as "the nearest analogue" — this is the graded one).
  flexibility         text        NOT NULL DEFAULT 'flexible',
  -- §7.1 confidence, 0..1. Distinct from trip_reservations.extraction_confidence,
  -- which is confidence in a PARSE, not in the commitment (TR127).
  confidence          numeric(3,2) NULL,
  source_ref          text        NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_commitments_type_known
    CHECK (type IN ('lodging','transport','event','booking','meeting','other')),
  CONSTRAINT trip_commitments_flexibility_known
    CHECK (flexibility IN ('fixed','shiftable','flexible')),
  CONSTRAINT trip_commitments_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  -- An arrival requirement that falls AFTER the thing starts is not a
  -- requirement; it is the ordering defect 2750 fixed one table over.
  CONSTRAINT trip_commitments_arrival_before_start
    CHECK (starts_at IS NULL OR required_arrival_at IS NULL OR required_arrival_at <= starts_at),
  -- Durations are non-negative. A negative buffer would invert §7.2's invariant.
  CONSTRAINT trip_commitments_durations_nonnegative
    CHECK ((lateness_tolerance IS NULL OR lateness_tolerance >= interval '0')
       AND (prep_duration      IS NULL OR prep_duration      >= interval '0'))
);

COMMENT ON TABLE public.trip_commitments IS
  'Trips spec §5.1 + §7.1 Commitment — a fixed point a timeline must respect. Carries the arrival/buffer/confidence fields §7.2 needs; the invariant itself is not evaluated (no route provider). No writer yet (§4 command path pending); RLS crew SELECT only.';

CREATE INDEX idx_trip_commitments_trip        ON public.trip_commitments (trip_id);
CREATE INDEX idx_trip_commitments_trip_time   ON public.trip_commitments (trip_id, required_arrival_at);
CREATE INDEX idx_trip_commitments_stage       ON public.trip_commitments (stage_id);

ALTER TABLE public.trip_commitments ENABLE ROW LEVEL SECURITY;
CREATE POLICY trip_commitments_select_crew ON public.trip_commitments
  FOR SELECT USING (authz.is_trip_crew(trip_id));
REVOKE ALL ON public.trip_commitments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trip_commitments TO authenticated;

DO $post$
DECLARE n int; sec boolean; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trip_legs','trip_commitments'] LOOP
    SELECT count(*) INTO n FROM information_schema.tables
     WHERE table_schema='public' AND table_name=t;
    IF n <> 1 THEN RAISE EXCEPTION '2761: % absent after create', t; END IF;

    EXECUTE format('SELECT relrowsecurity FROM pg_class WHERE oid=%L::regclass', 'public.'||t) INTO sec;
    IF NOT sec THEN RAISE EXCEPTION '2761: RLS not enabled on %', t; END IF;

    SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename=t;
    IF n <> 1 THEN RAISE EXCEPTION '2761: % expected 1 policy, found %', t, n; END IF;

    SELECT count(*) INTO n FROM pg_policies
     WHERE schemaname='public' AND tablename=t AND cmd <> 'SELECT';
    IF n <> 0 THEN RAISE EXCEPTION '2761: % has a non-SELECT policy', t; END IF;

    IF has_table_privilege('authenticated', 'public.'||t, 'INSERT')
       OR has_table_privilege('authenticated', 'public.'||t, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.'||t, 'DELETE')
    THEN RAISE EXCEPTION '2761: authenticated holds a write privilege on %', t; END IF;
    IF NOT has_table_privilege('authenticated', 'public.'||t, 'SELECT')
    THEN RAISE EXCEPTION '2761: authenticated cannot SELECT %', t; END IF;
  END LOOP;

  -- The §7.1 fields whose absence the census measured must actually be here.
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='trip_commitments'
     AND column_name IN ('required_arrival_at','lateness_tolerance','prep_duration','flexibility','confidence');
  IF n <> 5 THEN RAISE EXCEPTION '2761: expected the 5 §7.1 contract columns, found %', n; END IF;
END
$post$;

COMMIT;
