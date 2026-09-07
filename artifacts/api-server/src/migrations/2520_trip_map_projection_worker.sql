-- 2520_trip_map_projection_worker.sql
--
-- Trip Map projection worker (Trips spec §19.4) — the first consumer of
-- public.trip_outbox. Map-owned. Reads the outbox + trip_events that 2420
-- writes, projects a per-trip TripMapProjection envelope (§14.1, §19.1) into
-- a Map-owned table, and marks the outbox row published IN THE SAME
-- SUB-TRANSACTION as the projection write, so a crash between the two can
-- neither lose an event nor apply it twice.
--
-- Spec: docs/specs/Portava_Trips_Development_Architecture_Spec_v4.txt
--   §4.4   "State transaction writes domain event + outbox row. Workers
--          publish/retry idempotently. Consumers persist processed event IDs
--          or use deterministic projection version checks."      (both, here)
--   §14.1  TripMapProjection { stage, active plans, confirmed commitments,
--          crew presence summaries, ... generatedAt, sourceTripVersion }
--   §14.4  "Sensitive anchors such as hotel/private lodging must never be
--          included in public or broad social projections."
--   §19.1  every projection carries generatedAt, sourceTripVersion,
--          projectionSchemaVersion, freshness status
--   §19.4  "Projection workers consume domain events/outbox entries and are
--          idempotent by event ID + aggregate version. Rebuild jobs can
--          regenerate projections from canonical state/events without
--          changing business state."
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2520 (Map).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- DEPENDENCY ORDER — READ BEFORE APPLYING ANYWHERE
-- ══════════════════════════════════════════════════════════════════════════════
--   2334 -> 2337 -> 2420  trips.version, trip_events, trip_outbox
--   2450                  OPTIONAL. Contract v2 adds trip_events.actor_role;
--                         nothing here reads it. Every column this file reads
--                         from trip_events / trip_outbox is a 2420 column.
--   2520                  THIS FILE
-- Production (ajrurzioarfkagpuxfnb) has NONE of 2334/2337/2420/2450, so this
-- file's precondition block RAISES there and nothing changes. Until the owner
-- applies that chain the worker has no input anywhere but portava-ci.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS CHANGES FOR A USER: NOTHING, UNTIL A FLAG IS FLIPPED
-- ══════════════════════════════════════════════════════════════════════════════
-- Two new service-only tables, one flag seeded FALSE, three service-role-only
-- functions. No reader is changed: routes/mapProjection.ts still builds the
-- trip_stop layer from canonical `trips` at request time. With the flag false
-- trip_map_projection_drain returns {skipped:true} before its first read of
-- the outbox, and lib/mapTripProjectionWorker.ts (the scheduler that calls
-- it) checks the same flag fail-closed BEFORE issuing the RPC, so the
-- gated-off path is one feature_flags read per tick and nothing else.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- IDEMPOTENCY AND ORDERING (§19.4) — THE TWO INVARIANTS
-- ══════════════════════════════════════════════════════════════════════════════
--   by event_id           trip_map_projection_applied is the persisted set of
--                         processed event IDs (PK event_id). An outbox row whose
--                         event is already there is marked published and the
--                         projection is NOT touched ("replayed").
--   by aggregate_version  trip_map_projections.source_trip_version is the last
--                         version applied. An event is applied only when
--                         aggregate_version = source_trip_version + 1:
--                           > expected  → GAP. Left unpublished, attempts+1,
--                                         every later event for that trip is
--                                         deferred in this pass ("deferred_gap").
--                           < expected  → a version already reflected, by an
--                                         event NOT in the ledger. Refused,
--                                         attempts+1, left unpublished
--                                         ("refused"). Loud, never silent.
--                         UNIQUE (trip_id, aggregate_version) on the ledger and
--                         a conditional upsert (WHERE source_trip_version =
--                         EXCLUDED.source_trip_version - 1) re-assert the rule
--                         at the constraint level against a concurrent drain.
--   atomic publish        projection upsert + ledger insert + published_at are
--                         one plpgsql sub-block. The block either commits all
--                         three or (EXCEPTION) rolls all three back and records
--                         attempts+1. There is no state in which published_at
--                         is set and the projection is not, or vice versa.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THE PROJECTION CONTAINS, AND WHY IT IS COORDINATE-FREE
-- ══════════════════════════════════════════════════════════════════════════════
-- The body is regenerated from CANONICAL STATE at apply time (trips,
-- trip_plan_items, trip_members), not decoded from payload_json. That is
-- §19.4's second sentence and it is what makes the worker independent of the
-- event payload shape: contract v1 payloads are {command_type,payload,result},
-- v2 adds `family`, and neither is read here. The event supplies ordering
-- (aggregate_version), identity (event_id) and the type label; the state
-- supplies the content.
--
-- No coordinates. 2420/2450 strip lat/lng/destination_lat/destination_lng
-- from every event (§5.3) and §14.4 forbids private anchors in broad
-- projections. The body carries `has_destination_coordinates` so a reader can
-- tell a pin-able trip from one without a destination, and fetches the
-- coordinates through the existing authorized read (routes/mapProjection.ts
-- loadViewerTrips → toAuthorizedTripView) if it ever consumes this table.
-- Whether the map's trip_stop layer should read this table instead of
-- canonical `trips` is a product decision NOT taken here.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ══════════════════════════════════════════════════════════════════════════════
--   * Does not change routes/mapProjection.ts or any reader.
--   * Does not author or extend the event vocabulary. Any 'trip.%' type is
--     accepted (the CHECK on trip_events is the contract); the label is
--     recorded, not interpreted. lib/mapTripProjectionWorker.ts pins the
--     22 published TRIP_EVENT_TYPES against the SQL literals as a drift alarm.
--   * Does not delete outbox rows. published_at is the consumer's mark; the
--     row stays for Trips to retain or sweep.
--   * Does not touch trip_events (append-only by trigger) or any canonical
--     Trip table. The only Trips-owned column written is
--     trip_outbox.published_at / attempts — the fields 2420 created for a
--     consumer to write.

BEGIN;

-- ── 0. Preconditions ──────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.trip_events') IS NULL
     OR to_regclass('public.trip_outbox') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'trips' AND column_name = 'version') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trip_events / trip_outbox / trips.version (2420) missing -- apply 2334 -> 2337 -> 2420 first.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: feature_flags (0037) missing.';
  END IF;
END $$;

-- ── 1. The projection (§14.1, §19.1) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trip_map_projections (
  trip_id                   uuid        PRIMARY KEY REFERENCES public.trips(id) ON DELETE CASCADE,
  source_trip_version       bigint      NOT NULL,
  last_event_id             uuid        NULL REFERENCES public.trip_events(event_id) ON DELETE SET NULL,
  last_sequence             bigint      NULL,
  last_event_type           text        NULL,
  projection_schema_version integer     NOT NULL DEFAULT 1,
  generated_at              timestamptz NOT NULL DEFAULT now(),
  body                      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT trip_map_projections_version_nonneg CHECK (source_trip_version >= 0),
  CONSTRAINT trip_map_projections_body_object CHECK (jsonb_typeof(body) = 'object')
);
COMMENT ON TABLE public.trip_map_projections IS
  'TripMapProjection (Trips spec §14.1/§19.1), one row per trip. Written only by trip_map_projection_drain / trip_map_projection_rebuild. source_trip_version is the last aggregate_version applied; freshness = trips.version - source_trip_version. Coordinate-free (§14.4). Service-role only.';

-- ── 2. Processed-event ledger (§4.4 "persist processed event IDs") ────────────
CREATE TABLE IF NOT EXISTS public.trip_map_projection_applied (
  event_id          uuid        PRIMARY KEY REFERENCES public.trip_events(event_id) ON DELETE CASCADE,
  trip_id           uuid        NOT NULL,
  aggregate_version bigint      NOT NULL,
  outbox_id         bigint      NULL,
  applied_via       text        NOT NULL DEFAULT 'drain',
  applied_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_map_projection_applied_trip_version_unique UNIQUE (trip_id, aggregate_version),
  CONSTRAINT trip_map_projection_applied_via_check CHECK (applied_via IN ('drain', 'rebuild'))
);
COMMENT ON TABLE public.trip_map_projection_applied IS
  'Events the Trip Map projection has applied (Trips spec §19.4 idempotency by event_id + aggregate_version). PK event_id refuses a double apply; UNIQUE (trip_id, aggregate_version) refuses a second event for an applied version. Service-role only.';

-- ── 3. RLS and grants: service only ───────────────────────────────────────────
ALTER TABLE public.trip_map_projections        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_map_projection_applied ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trip_map_projections        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.trip_map_projection_applied FROM PUBLIC, anon, authenticated;

-- ── 4. Flag, seeded FALSE ─────────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('trip_map_projection_worker_enabled', false,
   'Trip Map projection worker (Trips spec §19.4): lib/mapTripProjectionWorker.ts drains public.trip_outbox into public.trip_map_projections, idempotent by event_id + aggregate_version. FALSE = the scheduler reads this flag and does nothing else; trip_outbox rows stay unpublished; no reader is affected either way.')
ON CONFLICT (flag) DO NOTHING;

-- ── 5. Body builder — canonical state in, coordinate-free envelope out ────────
CREATE OR REPLACE FUNCTION public.trip_map_projection_body(p_trip_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT jsonb_build_object(
    'trip_id',             t.id,
    'stage',               t.status::text,
    'visibility',          t.visibility::text,
    'title',               t.title,
    'destination_city',    t.destination_city,
    'destination_country', t.destination_country,
    'start_date',          t.start_date,
    'end_date',            t.end_date,
    'has_destination_coordinates', (t.destination_lat IS NOT NULL AND t.destination_lng IS NOT NULL),
    'plans', (
      SELECT jsonb_build_object(
        'active',    count(*) FILTER (WHERE i.status IN ('tentative', 'confirmed')),
        'confirmed', count(*) FILTER (WHERE i.status = 'confirmed'),
        'done',      count(*) FILTER (WHERE i.status = 'done'),
        'cancelled', count(*) FILTER (WHERE i.status = 'cancelled'),
        'total',     count(*))
      FROM public.trip_plan_items i
      WHERE i.trip_id = t.id AND i.removed_at IS NULL),
    'crew', (
      SELECT jsonb_build_object(
        -- A pending invite row carries role='invited' and status 'accepted'
        -- (2450 header); accepted crew is role <> 'invited', as requireTripMember reads it.
        'accepted', count(*) FILTER (WHERE m.role <> 'invited' AND m.status = 'accepted'),
        'invited',  count(*) FILTER (WHERE m.role = 'invited'))
      FROM public.trip_members m
      WHERE m.trip_id = t.id))
  FROM public.trips t
  WHERE t.id = p_trip_id;
$fn$;
COMMENT ON FUNCTION public.trip_map_projection_body(uuid) IS
  'Regenerates the coordinate-free TripMapProjection body for one trip from canonical state (Trips spec §14.1, §14.4, §19.4). NULL when the trip does not exist.';

-- ── 6. The drain — the §19.4 worker ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trip_map_projection_drain(
  p_limit        integer DEFAULT 200,
  p_enforce_flag boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_row        record;
  v_expected   bigint;
  v_body       jsonb;
  v_n          integer;
  v_scanned    integer := 0;
  v_applied    integer := 0;
  v_replayed   integer := 0;
  v_deferred   integer := 0;
  v_refused    integer := 0;
  v_failed     integer := 0;
  v_blocked    uuid[]  := '{}';
  v_last_error text;
BEGIN
  IF p_enforce_flag AND NOT EXISTS (
       SELECT 1 FROM public.feature_flags WHERE flag = 'trip_map_projection_worker_enabled' AND enabled) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'reason', 'disabled',
      'scanned', 0, 'applied', 0, 'replayed', 0, 'deferred_gap', 0, 'refused', 0, 'failed', 0);
  END IF;

  p_limit := LEAST(GREATEST(coalesce(p_limit, 200), 1), 1000);

  -- Ordered by aggregate_version per trip, NOT by outbox id: the version is
  -- the contract (§18.4), the identity column is an accident of insertion.
  FOR v_row IN
    SELECT o.id AS outbox_id, o.event_id, o.trip_id, e.aggregate_version, e.sequence, e.type
      FROM public.trip_outbox o
      JOIN public.trip_events e ON e.event_id = o.event_id
     WHERE o.published_at IS NULL
     ORDER BY o.trip_id, e.aggregate_version, o.id
     LIMIT p_limit
     FOR UPDATE OF o SKIP LOCKED
  LOOP
    v_scanned := v_scanned + 1;

    IF v_row.trip_id = ANY (v_blocked) THEN
      v_deferred := v_deferred + 1;
      CONTINUE;
    END IF;

    BEGIN
      -- Idempotent by event_id: already applied => publish the mark, touch nothing.
      IF EXISTS (SELECT 1 FROM public.trip_map_projection_applied WHERE event_id = v_row.event_id) THEN
        UPDATE public.trip_outbox SET published_at = now()
         WHERE id = v_row.outbox_id AND published_at IS NULL;
        v_replayed := v_replayed + 1;
        CONTINUE;
      END IF;

      -- Ordered by aggregate_version: exactly source_trip_version + 1 applies.
      SELECT source_trip_version INTO v_expected
        FROM public.trip_map_projections WHERE trip_id = v_row.trip_id FOR UPDATE;
      IF NOT FOUND THEN v_expected := 0; END IF;
      v_expected := v_expected + 1;

      IF v_row.aggregate_version > v_expected THEN
        UPDATE public.trip_outbox SET attempts = attempts + 1 WHERE id = v_row.outbox_id;
        v_blocked  := v_blocked || v_row.trip_id;
        v_deferred := v_deferred + 1;
        v_last_error := format('gap: trip %s expected version %s, outbox has %s', v_row.trip_id, v_expected, v_row.aggregate_version);
        CONTINUE;
      ELSIF v_row.aggregate_version < v_expected THEN
        UPDATE public.trip_outbox SET attempts = attempts + 1 WHERE id = v_row.outbox_id;
        v_refused := v_refused + 1;
        v_last_error := format('refused: trip %s version %s already applied by a different event (event_id %s not in ledger)', v_row.trip_id, v_row.aggregate_version, v_row.event_id);
        CONTINUE;
      END IF;

      v_body := public.trip_map_projection_body(v_row.trip_id);
      IF v_body IS NULL THEN
        RAISE EXCEPTION 'trip % not found while projecting event %', v_row.trip_id, v_row.event_id;
      END IF;

      INSERT INTO public.trip_map_projections (
        trip_id, source_trip_version, last_event_id, last_sequence, last_event_type,
        projection_schema_version, generated_at, body)
      VALUES (
        v_row.trip_id, v_row.aggregate_version, v_row.event_id, v_row.sequence, v_row.type,
        1, now(), v_body)
      ON CONFLICT (trip_id) DO UPDATE SET
        source_trip_version       = EXCLUDED.source_trip_version,
        last_event_id             = EXCLUDED.last_event_id,
        last_sequence             = EXCLUDED.last_sequence,
        last_event_type           = EXCLUDED.last_event_type,
        projection_schema_version = EXCLUDED.projection_schema_version,
        generated_at              = EXCLUDED.generated_at,
        body                      = EXCLUDED.body
      WHERE public.trip_map_projections.source_trip_version = EXCLUDED.source_trip_version - 1;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'projection version moved under event % (trip %)', v_row.event_id, v_row.trip_id;
      END IF;

      INSERT INTO public.trip_map_projection_applied (event_id, trip_id, aggregate_version, outbox_id, applied_via)
      VALUES (v_row.event_id, v_row.trip_id, v_row.aggregate_version, v_row.outbox_id, 'drain');

      UPDATE public.trip_outbox SET published_at = now() WHERE id = v_row.outbox_id;
      v_applied := v_applied + 1;
    EXCEPTION WHEN OTHERS THEN
      -- The sub-block rolled back: no projection, no ledger row, no published_at.
      v_failed     := v_failed + 1;
      v_last_error := SQLERRM;
      v_blocked    := v_blocked || v_row.trip_id;
      UPDATE public.trip_outbox SET attempts = attempts + 1 WHERE id = v_row.outbox_id;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true, 'skipped', false,
    'scanned', v_scanned, 'applied', v_applied, 'replayed', v_replayed,
    'deferred_gap', v_deferred, 'refused', v_refused, 'failed', v_failed,
    'last_error', v_last_error);
END;
$fn$;
COMMENT ON FUNCTION public.trip_map_projection_drain(integer, boolean) IS
  'Trip Map projection worker (Trips spec §19.4). Consumes unpublished trip_outbox rows in aggregate_version order per trip; idempotent by event_id (trip_map_projection_applied) and by version (source_trip_version + 1 only; gaps deferred, regressions refused). Projection write, ledger row and published_at commit together or not at all. service_role only; inert unless trip_map_projection_worker_enabled is TRUE.';

-- ── 7. Rebuild from canonical state (§19.4 second sentence) ───────────────────
CREATE OR REPLACE FUNCTION public.trip_map_projection_rebuild(
  p_trip_id      uuid,
  p_enforce_flag boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_version  bigint;
  v_body     jsonb;
  v_last     record;
  v_ledgered integer := 0;
  v_marked   integer := 0;
BEGIN
  IF p_enforce_flag AND NOT EXISTS (
       SELECT 1 FROM public.feature_flags WHERE flag = 'trip_map_projection_worker_enabled' AND enabled) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'reason', 'disabled');
  END IF;

  SELECT version INTO v_version FROM public.trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'TRIP_NOT_FOUND');
  END IF;
  v_body := public.trip_map_projection_body(p_trip_id);

  SELECT event_id, sequence, type INTO v_last
    FROM public.trip_events
   WHERE trip_id = p_trip_id AND aggregate_version <= v_version
   ORDER BY aggregate_version DESC LIMIT 1;

  INSERT INTO public.trip_map_projections (
    trip_id, source_trip_version, last_event_id, last_sequence, last_event_type,
    projection_schema_version, generated_at, body)
  VALUES (p_trip_id, v_version, v_last.event_id, v_last.sequence, v_last.type, 1, now(), v_body)
  ON CONFLICT (trip_id) DO UPDATE SET
    source_trip_version       = EXCLUDED.source_trip_version,
    last_event_id             = EXCLUDED.last_event_id,
    last_sequence             = EXCLUDED.last_sequence,
    last_event_type           = EXCLUDED.last_event_type,
    projection_schema_version = EXCLUDED.projection_schema_version,
    generated_at              = EXCLUDED.generated_at,
    body                      = EXCLUDED.body;

  -- Everything at or below the canonical version is now reflected: ledger it
  -- so the drain treats those outbox rows as replays rather than regressions.
  INSERT INTO public.trip_map_projection_applied (event_id, trip_id, aggregate_version, outbox_id, applied_via)
  SELECT e.event_id, e.trip_id, e.aggregate_version, NULL, 'rebuild'
    FROM public.trip_events e
   WHERE e.trip_id = p_trip_id AND e.aggregate_version <= v_version
  -- Any conflict: an event already ledgered (PK) OR a second event claiming an
  -- already-applied version (UNIQUE). The latter stays unledgered and its
  -- outbox row stays unpublished, so the anomaly remains visible to the drain.
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_ledgered = ROW_COUNT;

  UPDATE public.trip_outbox o SET published_at = now()
   WHERE o.trip_id = p_trip_id AND o.published_at IS NULL
     AND EXISTS (SELECT 1 FROM public.trip_map_projection_applied a WHERE a.event_id = o.event_id);
  GET DIAGNOSTICS v_marked = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'skipped', false, 'trip_id', p_trip_id,
    'source_trip_version', v_version, 'ledgered', v_ledgered, 'outbox_marked', v_marked);
END;
$fn$;
COMMENT ON FUNCTION public.trip_map_projection_rebuild(uuid, boolean) IS
  'Regenerates one trip''s Trip Map projection from canonical state (Trips spec §19.4 rebuild). Writes only trip_map_projections, trip_map_projection_applied and trip_outbox.published_at; changes no business state. service_role only; inert unless trip_map_projection_worker_enabled is TRUE.';

-- ── 8. Function grants: service_role only ─────────────────────────────────────
REVOKE ALL ON FUNCTION public.trip_map_projection_body(uuid)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trip_map_projection_drain(integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trip_map_projection_rebuild(uuid, boolean)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trip_map_projection_body(uuid)              TO service_role;
GRANT EXECUTE ON FUNCTION public.trip_map_projection_drain(integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.trip_map_projection_rebuild(uuid, boolean)  TO service_role;

-- ── 9. Postconditions ─────────────────────────────────────────────────────────
DO $$
DECLARE
  n        integer;
  r        jsonb;
  v_before bigint;
  v_after  bigint;
BEGIN
  SELECT count(*) INTO n FROM pg_tables
   WHERE schemaname = 'public' AND tablename IN ('trip_map_projections', 'trip_map_projection_applied') AND rowsecurity;
  IF n <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected RLS on 2 projection tables, found %', n;
  END IF;

  IF has_table_privilege('anon', 'public.trip_map_projections', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.trip_map_projections', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.trip_map_projection_applied', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.trip_map_projection_applied', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a client role holds a grant on a projection table';
  END IF;

  IF has_function_privilege('anon', 'public.trip_map_projection_drain(integer, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trip_map_projection_drain(integer, boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.trip_map_projection_rebuild(uuid, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trip_map_projection_rebuild(uuid, boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.trip_map_projection_body(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trip_map_projection_body(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a client role can EXECUTE a projection function';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.trip_map_projection_drain(integer, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role cannot EXECUTE trip_map_projection_drain';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'trip_map_projection_worker_enabled' AND enabled = false) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trip_map_projection_worker_enabled is missing or not false';
  END IF;

  -- Gated off, the drain is inert: it returns before reading the outbox and
  -- the unpublished count is unchanged.
  SELECT count(*) INTO v_before FROM public.trip_outbox WHERE published_at IS NULL;
  r := public.trip_map_projection_drain(200, true);
  SELECT count(*) INTO v_after FROM public.trip_outbox WHERE published_at IS NULL;
  IF (r->>'skipped') IS DISTINCT FROM 'true' OR (r->>'applied')::integer <> 0 OR v_before <> v_after THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: drain was not inert with the flag FALSE: %', r;
  END IF;
END $$;

COMMIT;
