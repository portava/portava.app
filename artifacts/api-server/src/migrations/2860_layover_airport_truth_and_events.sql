-- 2860_layover_airport_truth_and_events.sql
--
-- The two storage objects §10 and §11 need: an airport FACT OBSERVATION with
-- provenance and a TTL, and a canonical EXTERNAL EVENT with a unique dedup key.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2860.
-- Creates TWO new tables. Alters nothing that exists. Moves no row.
-- Seeds no feature flag.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- Spec §10 names five fact classes, each with a freshness, and a `TruthValue<T>`
-- carrying `sourceClass`, `sourceRefs[]`, `observedAt`, `expiresAt`,
-- `fallbackLevel` and a `conflict` flag. Census L14 scores the existing airport
-- store BUILT-BUT-WRONG for exactly the missing half: "`airport_profiles` holds
-- operational facts and no social identity — boundary holds. It holds no
-- provenance and no TTL: every column is a bare value (0127:17-41)". L86 adds
-- "No provenance column on any layover table" and L197 records that a new table
-- was created without either.
--
-- Spec §11 names a canonical event envelope with ten members and §24 requires a
-- "unique dedup key / source event id". Census L90 scores the existing
-- `layover_events` table as implementing three of the ten, L194 records "no
-- dedup index or unique constraint of any kind on the events table", and L263
-- scores the duplicate-event requirement NOT-BUILT.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY NOT `intel_observations` / `intel_claims` — THE §19-7 CONDITION, EVALUATED
-- ══════════════════════════════════════════════════════════════════════════════
-- Spec §19 step 7 is conditional: "Create airport intelligence observation/truth
-- tables IF the existing intelligence schema cannot represent the required
-- TTL/provenance cleanly." Census L197 scores that BUILT-BUT-WRONG and says why:
-- a new table (`airport_profiles`) was created AND it carries neither TTL nor
-- provenance, "so the clause's condition was neither evaluated nor satisfied by
-- the outcome". This header evaluates it, because a second new table without
-- that evaluation would repeat the same defect.
--
-- The existing schema is close. `intel_observations` (2130_intel_storage.sql:140)
-- carries `source_class`, `capture_surface`, `observed_at`, `received_at`,
-- `expires_at` and `idempotency_key`; `intel_claims` (:204) carries
-- `confidence`, `confidence_band`, `source_count`, `expires_at`,
-- `hard_expires_at`, `superseded_by` and a `status` whose vocabulary already
-- includes 'conflicting'. That is most of §10's `TruthValue<T>` and most of
-- §10.1's contradiction handling, already deployed.
--
-- THREE THINGS BLOCK REUSE, and each is a NOT NULL constraint or a CHECK on the
-- existing table, not a preference:
--   1. `intel_observations.actor_id uuid NOT NULL REFERENCES profiles(id)`
--      (2130:142). An official airport feed and an operator sensor have no
--      profile row. Reuse means either widening that column to nullable — on a
--      table whose whole privacy argument is that every observation has an
--      accountable actor — or minting profile rows for feeds.
--   2. `intel_observations.subject_id uuid NOT NULL REFERENCES places(id)`
--      (2130:144), and the same on `intel_claims` (:207). An airport is an
--      `airport_profiles` row (0127:17-41), not a `places` row, and mirroring
--      3,206 airports into `places` to satisfy an FK is a larger and more
--      consequential change than this file.
--   3. `intel_observations_subject_kind_check` admits
--      'experience','zone','neighborhood','route','event','service' (2130:166)
--      — there is no 'airport', so every row would have to be filed under a
--      kind it is not.
--
-- The condition is therefore SATISFIED: the existing schema cannot carry an
-- airport operational fact without widening two NOT NULL foreign keys and a
-- CHECK on a live table that another lane owns. A separate table is the smaller
-- change and the reversible one. IF THE OWNER PREFERS REUSE, this migration is
-- the thing to drop — see the rollback file — and the work becomes a change to
-- 2130's table, which is a Sensing-lane decision and not this lane's to take.
--
-- `layover_events` is NOT the place for either. It is an in-app audit trail of
-- eighteen UI actions with `user_id UUID NOT NULL REFERENCES profiles(id)`
-- (0127:194-211) — every row is a thing a specific traveller did. An external
-- event has no user, and an airport observation has no session. Widening that
-- table would put a NOT NULL user on a fact about a security queue and force
-- every future reader to ask which kind of row it is holding.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ORDERING — READ BEFORE LANDING A WRITER
-- ══════════════════════════════════════════════════════════════════════════════
-- NO CODE WRITES EITHER TABLE, DELIBERATELY, and none may until this migration
-- is applied and its postconditions are confirmed. This is 2700's rule and the
-- reason for it is unchanged: supabase-js sends every key in the insert
-- payload, so a writer that names a column fails outright on any database that
-- has not run this migration.
--
-- The code that will use these tables exists and is pure:
--   * src/services/airport/LayoverAirportTruth.ts — screening, decay,
--     corroboration, outlier rejection and the §10.1 contradiction rules,
--     producing a `TruthValue<number>` from a bag of observations;
--   * src/services/airport/LayoverEventReplanner.ts — the canonical envelope,
--     the eleven-type vocabulary, normalisation, dedup by stable source key,
--     and the eight-step §11.1 pipeline.
-- Both take their inputs as arguments and neither imports a Supabase client.
-- The sequence is: apply this, confirm the postconditions, THEN land an ingest
-- route and a reader, behind a flag seeded FALSE. Applying this migration alone
-- changes no behaviour, because nothing reads or writes what it creates.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WRITE BOUNDARY — WHY NEITHER TABLE IS CLIENT-WRITABLE
-- ══════════════════════════════════════════════════════════════════════════════
-- Census L201 records what happened the last time a layover table shipped with
-- a policy whose write half was left implicit: `layover_recommendations` carried
-- `FOR ALL … USING (…)` with no `WITH CHECK`, PostgreSQL reused the USING clause
-- as the write check, and a session owner could write their own certified
-- safety fields. 2335 and 2510 closed it.
--
-- Both tables here are therefore SELECT-only for `authenticated` and nothing at
-- all for `anon`, with no INSERT/UPDATE/DELETE policy of any kind. A traveller
-- report, when one is built, arrives through a server route on the service role
-- and is screened by `LayoverAirportTruth.screenObservations` — which is where
-- the §23 rate limit and the plausibility check live. A client that could INSERT
-- its own observation row would bypass both.
--
-- OBSERVATIONS ARE READABLE BY ANY SIGNED-IN USER, and that is a deliberate
-- decision rather than an oversight: an airport queue time is a fact about a
-- place, not about a person. The only identity on the row is `observer_id`, a
-- free TEXT handle for the FEED or SENSOR that reported it — it is NOT a
-- profiles FK and must never become one. A traveller-sourced observation is
-- attributed to the ingest channel, not to the traveller, so this table cannot
-- become a record of who was standing in which queue. The CHECK below enforces
-- that `observer_kind = 'community'` rows carry a non-UUID handle.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT WAS MEASURED
-- ══════════════════════════════════════════════════════════════════════════════
-- Production `ajrurzioarfkagpuxfnb`, read from this repository's own committed
-- artifacts (`src/lib/capability/layover-cutover-measurement.json`,
-- `src/lib/capability/snapshots/20260908-production-schema.json`): 5 layover
-- sessions ever, 0 active; 3,206 `airport_profiles` of which 0 are verified and
-- 0 carry a non-default buffer; 0 external event sources of any kind. Both
-- tables are empty on arrival and stay empty until an ingest surface exists.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- REVERSIBLE BY
-- ══════════════════════════════════════════════════════════════════════════════
--   DROP TABLE IF EXISTS public.layover_external_events;
--   DROP TABLE IF EXISTS public.airport_fact_observations;
-- Nothing else is touched, so those two statements restore the prior state
-- exactly. Rollback file:
--   db/rollback/2026-09-13-2860-layover-airport-truth-and-events-rollback.sql
--
-- ══════════════════════════════════════════════════════════════════════════════
-- APPLY ORDER
-- ══════════════════════════════════════════════════════════════════════════════
-- Independent of 2335 / 2410 / 2510 / 2700 / 2740 / 2741. Safe to apply at any
-- time. It does not depend on 2700 even though the replanner's step 4 wants
-- 2700's table: the replanner reports `snapshotPersisted: false` and does not
-- attempt a write.

BEGIN;

-- ── §10 the observation channel ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS airport_fact_observations (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- IATA code or an airport_profiles id, as the producer names it. TEXT and
  -- not an FK on purpose: an observation about an airport this deployment has
  -- no profile row for is still evidence, and dropping it on the floor because
  -- the join fails is how a fallback-profile airport stays permanently dark.
  airport_ref         TEXT        NOT NULL CHECK (length(airport_ref) BETWEEN 1 AND 64),

  -- Mirrors AIRPORT_FACT_TYPES in LayoverAirportTruth.ts. A CHECK rather than
  -- an enum type for consistency with 0127's vocabularies, and because adding a
  -- fact type must be a migration a reviewer sees.
  fact_type           TEXT        NOT NULL CHECK (fact_type IN (
                        'terminal_topology','gate_assignment','checkpoint_location','walking_link_minutes',
                        'security_layout','lounge_hours','transport_schedule',
                        'security_wait_minutes','immigration_wait_minutes','taxi_queue_minutes','disruption_level',
                        'checkpoint_timing_minutes','queue_report_minutes','closure_reported',
                        'time_of_day_distribution')),

  -- Mirrors AIRPORT_FACT_CLASSES. Denormalised from fact_type so a retention
  -- job can sweep by class without knowing the mapping.
  fact_class          TEXT        NOT NULL CHECK (fact_class IN (
                        'STATIC_TOPOLOGY','OPERATIONAL_SEMI_LIVE','FAST_LIVE',
                        'TRAVELER_OBSERVATION','HISTORICAL_MODEL')),

  -- Minutes for the timing facts, a small ordinal for the state facts. NUMERIC
  -- rather than INTEGER because a queue report of 7.5 minutes is a real
  -- reading and rounding it at the boundary is a decision the reconciler
  -- should make, not the column.
  value               NUMERIC     NOT NULL,

  -- ── provenance, which is the entire point of this table (L86) ──────────────
  observer_kind       TEXT        NOT NULL CHECK (observer_kind IN
                        ('community','portava_sensor','operator_feed','official')),
  -- A FEED or SENSOR handle. NEVER a profiles id — see the WRITE BOUNDARY note.
  -- A community row must not carry a bare UUID, which is the shape a profiles
  -- id would arrive in.
  observer_id         TEXT        NOT NULL CHECK (length(observer_id) BETWEEN 1 AND 128),
  observer_trust      NUMERIC     CHECK (observer_trust IS NULL OR (observer_trust >= 0 AND observer_trust <= 1)),
  source_ref          TEXT        NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 512),

  -- ── TTL, the other missing half (L14) ──────────────────────────────────────
  observed_at         TIMESTAMPTZ NOT NULL,
  -- Set by the writer from FACT_CLASS_TTL_MIN. Stored rather than computed so a
  -- producer that knows its own expiry (a schedule valid until 06:00) can say so.
  expires_at          TIMESTAMPTZ NOT NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT airport_fact_observations_ttl_forward CHECK (expires_at > observed_at),
  CONSTRAINT airport_fact_observations_community_not_a_profile CHECK (
    observer_kind <> 'community'
    OR observer_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  )
);

-- The read the reconciler makes: everything unexpired for one airport and one
-- fact, newest first.
CREATE INDEX IF NOT EXISTS airport_fact_obs_lookup_idx
  ON airport_fact_observations(airport_ref, fact_type, observed_at DESC);

-- The read a retention sweep makes.
CREATE INDEX IF NOT EXISTS airport_fact_obs_expiry_idx
  ON airport_fact_observations(expires_at);

ALTER TABLE airport_fact_observations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "airport_fact_obs_read" ON airport_fact_observations;
CREATE POLICY "airport_fact_obs_read"
  ON airport_fact_observations FOR SELECT TO authenticated
  USING (TRUE);

REVOKE ALL ON public.airport_fact_observations FROM anon;
REVOKE ALL ON public.airport_fact_observations FROM authenticated;
GRANT SELECT ON public.airport_fact_observations TO authenticated;

-- ── §11 the canonical external event ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS layover_external_events (
  -- The envelope's own eventId. A producer that mints a fresh one per DELIVERY
  -- is the failure §24 names, which is why this is the primary key and
  -- `dedup_key` — not this — carries uniqueness.
  event_id            TEXT        PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 200),

  event_type          TEXT        NOT NULL CHECK (event_type IN (
                        'flight.arrival_delayed','flight.departure_delayed','flight.gate_changed',
                        'flight.cancelled','airport.security_wait_changed','airport.immigration_wait_changed',
                        'mobility.route_degraded','weather.condition_changed','layover.checkpoint_observed',
                        'layover.return_started','layover.airport_reentered')),

  occurred_at         TIMESTAMPTZ NOT NULL,
  received_at         TIMESTAMPTZ NOT NULL,
  source              TEXT        NOT NULL CHECK (length(source) BETWEEN 1 AND 128),
  -- Empty string when the producer supplied none; the dedup key is then a
  -- content digest. NOT NULL so "absent" has exactly one spelling.
  source_event_id     TEXT        NOT NULL DEFAULT '',

  -- [{kind, ref}]. JSONB because it is a variable-length provenance detail, not
  -- a field a safety predicate joins on (spec §4's implementation rule).
  subject_refs        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  payload             JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- THE REQUIREMENT (§24, census L263). `source:sourceEventId` when the
  -- producer supplied one, else a sha256 over the content that decides what the
  -- event means. Unique, so a duplicate delivery is a constraint violation the
  -- writer can swallow rather than a second replan.
  dedup_key           TEXT        NOT NULL CHECK (length(dedup_key) BETWEEN 1 AND 400),

  confidence          TEXT        NOT NULL DEFAULT 'MEDIUM'
                        CHECK (confidence IN ('INSUFFICIENT','LOW','MEDIUM','HIGH')),

  -- Set when the replanner has run for this event. NULL = not yet processed,
  -- which is what makes the pending set a query rather than a queue service.
  processed_at        TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT layover_external_events_not_future CHECK (occurred_at <= received_at)
);

-- §24. The whole point of the table.
CREATE UNIQUE INDEX IF NOT EXISTS layover_external_events_dedup_uidx
  ON layover_external_events(dedup_key);

-- The fanout read: unprocessed events, oldest first.
CREATE INDEX IF NOT EXISTS layover_external_events_pending_idx
  ON layover_external_events(occurred_at)
  WHERE processed_at IS NULL;

ALTER TABLE layover_external_events ENABLE ROW LEVEL SECURITY;

-- NO POLICY AT ALL, which with RLS enabled means no client can read a row
-- either. An external operational event is not a traveller's data and there is
-- no surface that shows one; granting a read now would be granting it to
-- nobody, and a policy nobody needs is a policy nobody reviews. The service
-- role bypasses RLS, which is how the (unbuilt) replanner will read it.
REVOKE ALL ON public.layover_external_events FROM anon;
REVOKE ALL ON public.layover_external_events FROM authenticated;

-- ── postconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE
  dedup_unique BOOLEAN;
  writable_cols INTEGER;
  policy_count INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'airport_fact_observations'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2860): airport_fact_observations missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'layover_external_events'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2860): layover_external_events missing';
  END IF;

  -- RLS on, or every policy and grant below is decoration.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'airport_fact_observations' AND c.relrowsecurity = TRUE
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2860): RLS not enabled on airport_fact_observations';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'layover_external_events' AND c.relrowsecurity = TRUE
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2860): RLS not enabled on layover_external_events';
  END IF;

  -- The §24 guarantee, asserted as UNIQUE and not merely as present. An index
  -- that exists but is not unique deduplicates nothing.
  SELECT i.indisunique INTO dedup_unique
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  WHERE c.relname = 'layover_external_events_dedup_uidx';
  IF dedup_unique IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2860): layover_external_events_dedup_uidx missing or not UNIQUE';
  END IF;

  -- The write boundary, asserted rather than assumed — this is the check
  -- census L201 says was missing the last time a layover table shipped.
  SELECT count(*) INTO writable_cols
  FROM information_schema.column_privileges
  WHERE table_schema = 'public'
    AND table_name IN ('airport_fact_observations','layover_external_events')
    AND grantee IN ('anon','authenticated')
    AND privilege_type IN ('INSERT','UPDATE','DELETE');
  IF writable_cols <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2860): % client-writable column grant(s) on the new tables', writable_cols;
  END IF;

  -- Exactly one policy on the observations table, and it is a SELECT.
  SELECT count(*) INTO policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'airport_fact_observations';
  IF policy_count <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2860): airport_fact_observations has % policies, expected exactly 1', policy_count;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'airport_fact_observations'
      AND policyname = 'airport_fact_obs_read' AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2860): airport_fact_obs_read is not a SELECT policy';
  END IF;

  -- No policy at all on the events table — see the note above the REVOKEs.
  SELECT count(*) INTO policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'layover_external_events';
  IF policy_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2860): layover_external_events has % policies, expected 0', policy_count;
  END IF;

  -- This migration must not have touched the existing layover tables. If a
  -- later edit widens 0127's audit trail instead of using the new table, the
  -- header's argument for two tables no longer holds and a reviewer must
  -- re-make it.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'layover_events'
      AND column_name IN ('dedup_key','source_event_id','received_at')
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2860): layover_events gained envelope columns -- see WHY in the header';
  END IF;
END $$;

COMMIT;
