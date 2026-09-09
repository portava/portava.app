-- 2763_trip_presence_proposals_snapshots_outcomes.sql
--
-- Trips v4 §5.1 `trip_presence`, `trip_proposals`, `trip_snapshots`,
-- `trip_outcomes` (census-trips TR87, TR88, TR90, TR91). With 2760-2762 this
-- completes TEN of the eleven §5.1 tables the census scores NOT-BUILT.
--
-- THE ELEVENTH IS DELIBERATELY ABSENT. `trip_plan_participants` keys on
-- `trip_plans`, which does not exist either — `trip_plan_items` is the divergent
-- analogue the census scores W. Creating a participants table against the wrong
-- parent would be inventing a join nobody can use, so TR83 stays open and says
-- why.
--
-- Ordered after 2760: trip_outcomes references trip_stages.
--
-- Spec column sets, verbatim:
--   trip_presence   trip_id, user_id, presence_state, visibility, observed_at,
--                   expires_at, confidence
--   trip_proposals  id, trip_id, proposal_type, payload_json, status,
--                   expires_at, affected_version
--   trip_snapshots  id, trip_id, aggregate_version, snapshot_json,
--                   engine_versions_json, created_at
--   trip_outcomes   id, trip_id, stage_id, plan_id, outcome_type, occurred_at,
--                   evidence_json
--
-- FOUR SHAPE DECISIONS THAT ARE NOT ARBITRARY
-- ===========================================
-- 1. trip_presence.expires_at is NOT NULL and must FOLLOW observed_at. §18.4:
--    "newest valid observation with expiry/confidence; never simple
--    last-write-wins across stale devices." A nullable expiry is
--    last-write-wins with extra steps. TR87 notes the existing
--    `trip_crew_location_sessions` is a live-SHARE session — a different object.
-- 2. trip_proposals.affected_version is the trips.version the proposal was
--    computed against, so a stale proposal is DETECTABLE rather than silently
--    applied (§12.2: Compass may propose, never mutate).
-- 3. trip_snapshots is UNIQUE per (trip_id, aggregate_version). Two different
--    snapshots of one version make replay non-deterministic, which is precisely
--    the property §22.4 exists to guarantee.
-- 4. trip_outcomes.plan_id carries NO foreign key, deliberately, and the
--    postcondition asserts the table has exactly TWO FKs so nobody "fixes" it
--    into three. §5.2 permits an explicit *_id plus source_ref, and the plan a
--    completed outcome refers to may be removed while the fact that it happened
--    must not be. stage_id is SET NULL for the same reason.
--
-- No writer yet — §4 requires the command path and the kernel function is
-- replaced whole per change, so all of §5's families land together. These census
-- rows do NOT close here; rule 2 ("a table nothing writes satisfies nothing") is
-- the census's own and it is right. RLS on, crew SELECT only, no client writes,
-- asserted as an equality in the postconditions.

BEGIN;

DO $pre$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public'
     AND table_name IN ('trip_presence','trip_proposals','trip_snapshots','trip_outcomes');
  IF n <> 0 THEN RAISE EXCEPTION '2763: a target table already exists (found %)', n; END IF;
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='public' AND table_name='trip_stages';
  IF n <> 1 THEN RAISE EXCEPTION '2763: requires 2760 (trip_stages) for trip_outcomes.stage_id'; END IF;
END
$pre$;

CREATE TABLE public.trip_presence (
  trip_id        uuid        NOT NULL REFERENCES public.trips(id)    ON DELETE CASCADE,
  user_id        uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  presence_state text        NOT NULL,
  visibility     text        NOT NULL DEFAULT 'crew',
  observed_at    timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  confidence     numeric(3,2) NULL,
  PRIMARY KEY (trip_id, user_id),
  CONSTRAINT trip_presence_state_known
    CHECK (presence_state IN ('here','nearby','en_route','away','unknown')),
  CONSTRAINT trip_presence_visibility_known
    CHECK (visibility IN ('crew','participants','private')),
  CONSTRAINT trip_presence_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT trip_presence_expires_after_observed CHECK (expires_at > observed_at)
);
COMMENT ON TABLE public.trip_presence IS
  'Trips spec 5.1/10 trip_presence. 18.4: newest valid observation with expiry and confidence, never last-write-wins across stale devices - hence expires_at NOT NULL and required to follow observed_at. No writer yet (4 command path pending); RLS crew SELECT only.';
CREATE INDEX idx_trip_presence_trip_expiry ON public.trip_presence (trip_id, expires_at);

CREATE TABLE public.trip_proposals (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id          uuid        NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  proposal_type    text        NOT NULL,
  payload_json     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status           text        NOT NULL DEFAULT 'pending',
  expires_at       timestamptz NULL,
  affected_version bigint      NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_proposals_type_known
    CHECK (proposal_type IN ('add_plan','move_plan','cancel_plan','add_commitment','stage_change','other')),
  CONSTRAINT trip_proposals_status_known
    CHECK (status IN ('pending','accepted','rejected','expired','superseded')),
  CONSTRAINT trip_proposals_payload_object CHECK (jsonb_typeof(payload_json) = 'object'),
  CONSTRAINT trip_proposals_affected_version_positive
    CHECK (affected_version IS NULL OR affected_version >= 0)
);
COMMENT ON TABLE public.trip_proposals IS
  'Trips spec 5.1/9/12.2 trip_proposals - a proposed change awaiting explicit confirmation. affected_version is the trips.version the proposal was computed against, so a stale proposal is detectable rather than silently applied. No writer yet; RLS crew SELECT only.';
CREATE INDEX idx_trip_proposals_trip_status ON public.trip_proposals (trip_id, status);

CREATE TABLE public.trip_snapshots (
  id                   uuid   PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id              uuid   NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  aggregate_version    bigint NOT NULL,
  snapshot_json        jsonb  NOT NULL,
  engine_versions_json jsonb  NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_snapshots_version_positive CHECK (aggregate_version >= 0),
  CONSTRAINT trip_snapshots_trip_version_unique UNIQUE (trip_id, aggregate_version),
  CONSTRAINT trip_snapshots_snapshot_object CHECK (jsonb_typeof(snapshot_json) = 'object'),
  CONSTRAINT trip_snapshots_engines_object   CHECK (jsonb_typeof(engine_versions_json) = 'object')
);
COMMENT ON TABLE public.trip_snapshots IS
  'Trips spec 5.1/22 trip_snapshots - replay/simulation base state at an aggregate_version. Unique per (trip, version): two different snapshots of one version would make replay non-deterministic, which is the property 22.4 exists to guarantee. No writer yet; RLS crew SELECT only.';
CREATE INDEX idx_trip_snapshots_trip_version ON public.trip_snapshots (trip_id, aggregate_version DESC);

CREATE TABLE public.trip_outcomes (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       uuid        NOT NULL REFERENCES public.trips(id)       ON DELETE CASCADE,
  stage_id      uuid        NULL     REFERENCES public.trip_stages(id) ON DELETE SET NULL,
  plan_id       uuid        NULL,
  outcome_type  text        NOT NULL,
  occurred_at   timestamptz NOT NULL,
  evidence_json jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_outcomes_type_known
    CHECK (outcome_type IN ('completed','skipped','cancelled','missed','substituted','other')),
  CONSTRAINT trip_outcomes_evidence_object CHECK (jsonb_typeof(evidence_json) = 'object')
);
COMMENT ON TABLE public.trip_outcomes IS
  'Trips spec 5.1/20 trip_outcomes - what actually happened, the input Memory and Passport read post-trip. stage_id is SET NULL so an outcome outlives the stage it happened in. plan_id carries NO foreign key deliberately: 5.2 permits an explicit *_id plus source_ref, and the plan a completed outcome refers to may be removed while the fact that it happened must not be. No writer yet; RLS crew SELECT only.';
CREATE INDEX idx_trip_outcomes_trip_time ON public.trip_outcomes (trip_id, occurred_at DESC);

DO $grants$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trip_presence','trip_proposals','trip_snapshots','trip_outcomes'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (authz.is_trip_crew(trip_id))',
      t || '_select_crew', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END
$grants$;

DO $post$
DECLARE n int; sec boolean; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trip_presence','trip_proposals','trip_snapshots','trip_outcomes'] LOOP
    SELECT count(*) INTO n FROM information_schema.tables
     WHERE table_schema='public' AND table_name=t;
    IF n <> 1 THEN RAISE EXCEPTION '2763: % absent after create', t; END IF;

    EXECUTE format('SELECT relrowsecurity FROM pg_class WHERE oid=%L::regclass', 'public.'||t) INTO sec;
    IF NOT sec THEN RAISE EXCEPTION '2763: RLS not enabled on %', t; END IF;

    SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename=t;
    IF n <> 1 THEN RAISE EXCEPTION '2763: % expected 1 policy, found %', t, n; END IF;
    SELECT count(*) INTO n FROM pg_policies
     WHERE schemaname='public' AND tablename=t AND cmd <> 'SELECT';
    IF n <> 0 THEN RAISE EXCEPTION '2763: % has a non-SELECT policy', t; END IF;

    IF has_table_privilege('authenticated','public.'||t,'INSERT')
       OR has_table_privilege('authenticated','public.'||t,'UPDATE')
       OR has_table_privilege('authenticated','public.'||t,'DELETE')
    THEN RAISE EXCEPTION '2763: authenticated holds a write privilege on %', t; END IF;
    IF NOT has_table_privilege('authenticated','public.'||t,'SELECT')
    THEN RAISE EXCEPTION '2763: authenticated cannot SELECT %', t; END IF;
  END LOOP;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid='public.trip_outcomes'::regclass AND contype='f';
  IF n <> 2 THEN RAISE EXCEPTION '2763: trip_outcomes must carry exactly 2 FKs (trip, stage) - plan_id deliberately has none; found %', n; END IF;
END
$post$;

COMMIT;
