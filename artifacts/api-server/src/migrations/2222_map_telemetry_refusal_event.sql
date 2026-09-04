-- 2222_map_telemetry_refusal_event.sql
--
-- Adds `meet_here_refused` to the map telemetry event set, and pins the
-- telemetry payload SCHEMA VERSION on every stored row.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHY A SEVENTEENTH EVENT
-- =======================
-- §35 names sixteen events. Every one of them describes something the user
-- DID. None describes something the product REFUSED to do.
--
-- That gap matters for exactly one reason: §25 Meet Here can be blocked by a
-- §23 rule (an aggregate subject cannot anchor a meeting point, because
-- resolving it to a point would sharpen an aggregate). Without a refusal
-- event, a policy block and a feature nobody uses produce the identical
-- signal — an absence. A privacy rule that fires constantly would look like
-- dead code, and the obvious "fix" would be to remove the rule.
--
-- The event carries a REASON and a coarsened subject ref. It deliberately
-- carries no decision id: a refusal is a property of the subject and the rule,
-- not an outcome of a Compass decision, and attaching one would let a refusal
-- count against a recommendation it had nothing to do with.
--
-- WHY THE SCHEMA VERSION IS NOW STORED
-- ====================================
-- These payloads have become contracts — analysis, funnels and the decision
-- chain all depend on their shape. The client has always SENT
-- MAP_TELEMETRY_SCHEMA_VERSION in the batch meta, but the server dropped it,
-- so a stored row could not say which contract produced it. A breaking payload
-- change would then be indistinguishable from a bug, and old and new rows
-- would silently be aggregated together.
--
-- Storing it makes a breaking change deliberate: the version becomes visible in
-- the data, and a query can segregate contracts rather than averaging across
-- them. Defaulted to '1.0' — every row written before this migration was
-- written by a 1.0 client.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.map_telemetry_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2202 first (map_telemetry_events missing).';
  END IF;
END $$;

-- ── The seventeenth event ─────────────────────────────────────────────────────

ALTER TABLE public.map_telemetry_events
  DROP CONSTRAINT IF EXISTS map_telemetry_events_name_check;
ALTER TABLE public.map_telemetry_events
  ADD CONSTRAINT map_telemetry_events_name_check
  CHECK (event_name IN (
    -- §35's sixteen
    'map_opened','zone_selected','place_opened','live_state_viewed',
    'why_shown_opened','compass_requested','compass_option_selected',
    'route_started','trip_stop_added','plan_joined','meet_here_created',
    'crew_locate_started','contribution_submitted','alternative_requested',
    'recommendation_accepted','recommendation_declined',
    -- Beyond §35, deliberately — see the header.
    'meet_here_refused'
  ));

-- ── Payload schema version ────────────────────────────────────────────────────

ALTER TABLE public.map_telemetry_events
  ADD COLUMN IF NOT EXISTS schema_version text NOT NULL DEFAULT '1.0';

COMMENT ON COLUMN public.map_telemetry_events.schema_version IS
  'The MAP_TELEMETRY_SCHEMA_VERSION the emitting client declared. Stored so a breaking payload change is deliberate and visible in the data: analysis can segregate contracts instead of averaging across them. Rows written before migration 2222 default to 1.0, which is what produced them.';

CREATE INDEX IF NOT EXISTS map_telemetry_events_schema_version_idx
  ON public.map_telemetry_events (schema_version, event_name);

-- ── Postconditions ────────────────────────────────────────────────────────────
--
-- Catalog reads only. An earlier draft PROVED the constraint by inserting a
-- 'meet_here_refused' row and an unknown row and asserting the second was
-- rejected. src/test/migrationDeployability.test.ts refused it, correctly, on
-- two counts: an unconditional RAISE inside a top-level DO makes the migration
-- self-aborting, and a verification block that writes rows is a test wearing a
-- migration's clothes — it must observe from a SEPARATE transaction. The
-- behavioural assertion now lives in src/test/mapTelemetryRefusalEvent.test.ts.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'map_telemetry_events'
      AND column_name = 'schema_version'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: schema_version column missing';
  END IF;

  -- The constraint must both EXIST and mention the new name; a constraint that
  -- exists but predates this migration would otherwise pass silently.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'map_telemetry_events'
      AND c.conname = 'map_telemetry_events_name_check'
      AND position('meet_here_refused' IN pg_get_constraintdef(c.oid)) > 0
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: name check missing or does not admit meet_here_refused';
  END IF;
END $$;

COMMIT;
