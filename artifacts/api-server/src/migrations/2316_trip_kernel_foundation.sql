-- 2316_trip_kernel_foundation.sql
--
-- Trips v4 — THE KERNEL SPINE. Nothing else, on purpose.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHAT THIS IS
-- ============
-- The Trips v4 spec describes a kernel: consequential trip state changes are
-- COMMANDS, a command produces an immutable EVENT, and the aggregate carries a
-- VERSION so two concurrent commands cannot both win. A census against the spec
-- found the kernel genuinely unbuilt — repo-wide greps for trip_events,
-- aggregate_version, trip_snapshots, TripCommand and FreedomWindow all returned
-- zero, and public.trips had no version column at all. ~60 mutating routes
-- write the trip tables directly.
--
-- This migration lays the two pieces everything else in the spec hangs from:
--
--   1. public.trip_events   — the append-only log. One row per consequential
--                             trip state change.
--   2. public.trips.version — the aggregate version. Additive, defaulted, and
--                             bumped by the kernel's compare-and-set.
--
-- It deliberately does NOT create trip_stages, trip_legs, trip_commitments,
-- trip_proposals, trip_snapshots, freedom windows, or any projection. Those
-- need the spine first, and a half-built projection is worse than none.
--
-- WHAT IT DELIBERATELY DOES NOT ADD: A FIFTH STATUS VOCABULARY
-- ============================================================
-- Portava already carries FOUR trip-ish status vocabularies — public.trip_status
-- (canonicalised by src/lib/tripStatus.ts), trip_plan_items.status (free text,
-- no CHECK), route_plan_status, and trip_autopilot_proposals.status. The v4 spec
-- names a `lifecycle_state`; adding one now would make it five and would
-- recreate exactly the endpoint-divergence bug tripStatus.ts was written to fix.
--
-- So this table records transitions of the EXISTING public.trip_status enum:
-- from_status and to_status are typed `public.trip_status`, not text, so an
-- invented label cannot be stored and no new vocabulary is introduced. When
-- lifecycle_state is eventually built it must RETIRE or MAP the existing four,
-- in its own migration, as a deliberate act.
--
-- VERSION SEMANTICS
-- =================
-- trips.version starts at 1 for every existing row and is incremented by the
-- kernel's compare-and-set (UPDATE ... WHERE id = $1 AND version = $expected).
-- trip_events.aggregate_version records the version the aggregate REACHED as a
-- result of the event, so the first kernel-applied event on a fresh trip carries
-- aggregate_version = 2. UNIQUE (trip_id, aggregate_version) makes the log the
-- serialization point: two commands racing at the same version cannot both
-- append, whatever the application layer believes.
--
-- IDEMPOTENCY
-- ===========
-- idempotency_key is NOT NULL and UNIQUE per trip. A retried command carrying
-- the key of one already applied finds the existing event and replays its
-- outcome instead of appending a second one. The uniqueness is enforced HERE,
-- at the database, not by an application-side "check then write" that a
-- concurrent second request would slip through.
--
-- APPEND-ONLY, WITHOUT THE CASCADE TRAP
-- =====================================
-- This log is append-only, enforced by a ROW-LEVEL BEFORE UPDATE OR DELETE
-- trigger. It is deliberately NOT a statement-level trigger: this repo has twice
-- shipped BEFORE ... FOR EACH STATEMENT append-only guards (2130→2137 and
-- 2276/2277/2279→2292) that fired before any row was examined and so refused
-- every parent DELETE, including ones touching zero rows — which broke account
-- deletion and right-to-erasure outright. src/test/appendOnlyCascade.test.ts
-- exists to stop a third round. The row-level guard fires once per real row,
-- which is exactly when there is history to protect.
--
-- The guard exempts the erasure cascade the only way that is safe: it does not
-- fire on DELETE at all when the parent trip is going away, because the FK is
-- ON DELETE CASCADE and a cascaded delete of a trip's events is the trip
-- ceasing to exist, not history being rewritten. Concretely: DELETE is refused
-- only for a caller that is not inside a trips cascade, detected by the parent
-- row no longer being visible.
--
-- RLS POSTURE
-- ===========
-- Deny-default, REVOKE-first, service_role only — the same posture as the
-- newest event tables in this corpus (2287 passport_telemetry_events, 2308
-- wall_telemetry_events). No anon or authenticated grant: the kernel log is
-- read and written by the server, never by a PostgREST client. This is not
-- decoration; ~30 tables in this schema still carry legacy blanket
-- GRANT ALL ... TO anon from the pre-cutover era (trip_activity_log is one of
-- them), and every client-write audit in this repo has traced a real
-- self-promotion defect back to one.

BEGIN;

-- ── Preconditions ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.trips') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.trips must exist.';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles must exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'trip_status') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.trip_status enum must exist.';
  END IF;
END $$;

-- ── 1. Aggregate version on the trips aggregate root ────────────────────────
-- Additive and defaulted: every existing row becomes version 1 without a
-- backfill pass and without any read path changing. Nothing outside the kernel
-- writes this column.

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_version_positive_check;
ALTER TABLE public.trips
  ADD CONSTRAINT trips_version_positive_check CHECK (version >= 1);

COMMENT ON COLUMN public.trips.version IS
  'Trips v4 kernel aggregate version. Starts at 1; incremented ONLY by the Trip Kernel''s compare-and-set (src/lib/tripKernel). A direct UPDATE that does not bump it is exactly the migration debt the direct-trip-write ratchet counts.';

-- ── 2. The append-only event log ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.trip_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The aggregate this event belongs to. CASCADE so a deleted trip takes its
  -- log with it: an event log for a trip that no longer exists is not history,
  -- it is a leak.
  trip_id           uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,

  -- The version the aggregate REACHED because of this event (see header).
  aggregate_version integer NOT NULL CHECK (aggregate_version >= 1),

  -- Closed vocabulary. Exactly one command is routed through the kernel today,
  -- so exactly one event type is legal. Extending this set is a deliberate act
  -- in a later migration, alongside the command that emits it — an open text
  -- column here is how the other four status vocabularies got out of hand.
  event_type        text NOT NULL,

  -- Who issued the command. NULLable so an actor's account deletion can null
  -- the reference without destroying the trip's history (see disposition in
  -- src/lib/deletionDispositions.ts).
  actor_id          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- Transition recorded against the EXISTING public.trip_status enum. Typed,
  -- not text, so no new vocabulary can be introduced through this column.
  from_status       public.trip_status,
  to_status         public.trip_status,

  -- Command-specific detail. Never PII: the kernel writes ids and the command
  -- name only.
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Command de-duplication key. NOT NULL: an event with no key cannot be
  -- replayed, which defeats the point of the log.
  idempotency_key   text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),

  occurred_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.trip_events
  DROP CONSTRAINT IF EXISTS trip_events_event_type_check;
ALTER TABLE public.trip_events
  ADD CONSTRAINT trip_events_event_type_check
  CHECK (event_type IN ('trip.completed'));

-- THE serialization point. Two commands racing at the same aggregate version
-- cannot both append; the loser gets a unique violation and is refused.
ALTER TABLE public.trip_events
  DROP CONSTRAINT IF EXISTS trip_events_trip_version_uniq;
ALTER TABLE public.trip_events
  ADD CONSTRAINT trip_events_trip_version_uniq UNIQUE (trip_id, aggregate_version);

-- Idempotency, enforced at the database rather than by a check-then-write.
ALTER TABLE public.trip_events
  DROP CONSTRAINT IF EXISTS trip_events_trip_idempotency_uniq;
ALTER TABLE public.trip_events
  ADD CONSTRAINT trip_events_trip_idempotency_uniq UNIQUE (trip_id, idempotency_key);

CREATE INDEX IF NOT EXISTS trip_events_trip_time_idx
  ON public.trip_events (trip_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS trip_events_actor_idx
  ON public.trip_events (actor_id);

COMMENT ON TABLE public.trip_events IS
  'Trips v4 kernel: the immutable append-only log of consequential trip state changes. One row per applied TripCommand. UNIQUE (trip_id, aggregate_version) is the concurrency serialization point; UNIQUE (trip_id, idempotency_key) is command de-duplication. Records transitions of the EXISTING public.trip_status enum — it deliberately introduces no new status vocabulary. Written only by src/lib/tripKernel.';

-- ── 3. Append-only guard (ROW level only — see header) ──────────────────────

CREATE OR REPLACE FUNCTION public.trip_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- THE ONE PERMITTED UPDATE: the right-to-erasure anonymisation. Deleting a
    -- profile fires this table's `actor_id ... ON DELETE SET NULL` RI trigger,
    -- which is an UPDATE on this table. A blanket "no UPDATE" here would make
    -- account deletion FAIL — the same class of defect that 2137 and 2292 had
    -- to undo. So permit exactly that one shape (actor_id going non-NULL to
    -- NULL with every other column byte-identical) and refuse everything else.
    IF OLD.actor_id IS NOT NULL
       AND NEW.actor_id IS NULL
       AND NEW.id                IS NOT DISTINCT FROM OLD.id
       AND NEW.trip_id           IS NOT DISTINCT FROM OLD.trip_id
       AND NEW.aggregate_version IS NOT DISTINCT FROM OLD.aggregate_version
       AND NEW.event_type        IS NOT DISTINCT FROM OLD.event_type
       AND NEW.from_status       IS NOT DISTINCT FROM OLD.from_status
       AND NEW.to_status         IS NOT DISTINCT FROM OLD.to_status
       AND NEW.payload           IS NOT DISTINCT FROM OLD.payload
       AND NEW.idempotency_key   IS NOT DISTINCT FROM OLD.idempotency_key
       AND NEW.occurred_at       IS NOT DISTINCT FROM OLD.occurred_at
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'trip_events is append-only: UPDATE is not permitted (only the actor_id erasure null-out)';
  END IF;

  -- DELETE. Allowed only as part of the parent trip going away: the FK is
  -- ON DELETE CASCADE, and Postgres deletes the parent row before firing the
  -- cascade, so inside a genuine cascade the parent is already invisible here.
  -- If the parent trip row is still there, this is a caller deleting history by
  -- hand.
  IF EXISTS (SELECT 1 FROM public.trips t WHERE t.id = OLD.trip_id) THEN
    RAISE EXCEPTION 'trip_events is append-only: DELETE is not permitted while the trip exists';
  END IF;
  RETURN OLD;
END;
$fn$;

COMMENT ON FUNCTION public.trip_events_append_only() IS
  'Row-level append-only guard for trip_events. Deliberately NOT statement-level: a BEFORE ... FOR EACH STATEMENT guard fires before any row is examined and so refuses every parent DELETE, which broke account deletion twice already (2130 to 2137, 2276/2277/2279 to 2292). Two erasure paths are permitted by construction: the trips ON DELETE CASCADE, and the actor_id ON DELETE SET NULL anonymisation (an UPDATE) fired when a profile is deleted. Everything else is refused.';

REVOKE ALL ON FUNCTION public.trip_events_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trip_events_append_only() FROM anon;
REVOKE ALL ON FUNCTION public.trip_events_append_only() FROM authenticated;

DROP TRIGGER IF EXISTS trip_events_append_only_row ON public.trip_events;
CREATE TRIGGER trip_events_append_only_row
  BEFORE UPDATE OR DELETE ON public.trip_events
  FOR EACH ROW EXECUTE FUNCTION public.trip_events_append_only();

-- ── 4. RLS ──────────────────────────────────────────────────────────────────
-- Deny-default, REVOKE-first, service_role only. No anon / authenticated grant.

ALTER TABLE public.trip_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.trip_events FROM PUBLIC;
REVOKE ALL ON public.trip_events FROM anon;
REVOKE ALL ON public.trip_events FROM authenticated;
REVOKE ALL ON public.trip_events FROM service_role;

-- INSERT/SELECT are the kernel's own path. DELETE is granted because the trips
-- erasure cascade needs it. UPDATE is granted for ONE reason and one only: the
-- right-to-erasure anonymisation of actor_id, which AccountDeletionService must
-- perform BY HAND. It cannot rely on the FK: production's deletion keeps an
-- anonymised TOMBSTONE profile rather than deleting profiles(id), so no
-- profiles-keyed ON DELETE SET NULL ever fires (the mistake 2172/2170/2187 made,
-- corrected by 2203/2204/2190, and the reason 2211 exists). Append-only is
-- enforced by the row-level trigger, which refuses every UPDATE except that one
-- shape — the grant is not the enforcement.
GRANT INSERT, SELECT, UPDATE, DELETE ON public.trip_events TO service_role;

DROP POLICY IF EXISTS trip_events_service_all ON public.trip_events;
CREATE POLICY trip_events_service_all ON public.trip_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
DECLARE
  n int;
BEGIN
  IF to_regclass('public.trip_events') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trip_events was not created.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trips' AND column_name = 'version'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trips.version was not added.';
  END IF;

  SELECT count(*) INTO n FROM public.trips WHERE version IS NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % trips row(s) have a NULL version.', n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'trip_events_trip_version_uniq'
      AND conrelid = 'public.trip_events'::regclass
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the (trip_id, aggregate_version) uniqueness is missing — the kernel would have no serialization point.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'trip_events_trip_idempotency_uniq'
      AND conrelid = 'public.trip_events'::regclass
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the (trip_id, idempotency_key) uniqueness is missing — commands would not be idempotent.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trip_events_append_only_row'
      AND tgrelid = 'public.trip_events'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the row-level append-only trigger is missing.';
  END IF;

  -- The trap this corpus has fallen into twice: a STATEMENT-level append-only
  -- trigger blocks the erasure cascade. Assert we did not add one.
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = 'public.trip_events'::regclass
     AND NOT tgisinternal
     AND (tgtype & 1) = 0;   -- bit 0 clear = FOR EACH STATEMENT
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % statement-level trigger(s) on trip_events — those refuse every parent DELETE and break account deletion.', n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.oid = 'public.trip_events'::regclass AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: RLS is not enabled on trip_events.';
  END IF;

  SELECT count(*) INTO n
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'trip_events'
     AND grantee IN ('anon', 'authenticated');
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trip_events carries % client grant(s); the kernel log must be service_role only.', n;
  END IF;

  -- The erasure path must actually be able to run: without UPDATE, deleting an
  -- account would leave the departed user's uuid in actor_id forever.
  SELECT count(*) INTO n
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'trip_events'
     AND grantee = 'service_role' AND privilege_type = 'UPDATE';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role lacks UPDATE on trip_events; the actor_id erasure null-out could not run.';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   DROP TABLE IF EXISTS public.trip_events;
--   DROP FUNCTION IF EXISTS public.trip_events_append_only();
--   ALTER TABLE public.trips DROP CONSTRAINT IF EXISTS trips_version_positive_check;
--   ALTER TABLE public.trips DROP COLUMN IF EXISTS version;
-- The reversal removes only additive kernel scaffolding. No column any existing
-- read path selects is touched, and no row of served trip data changes.
