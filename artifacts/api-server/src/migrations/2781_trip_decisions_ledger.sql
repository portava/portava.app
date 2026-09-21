-- 2781_trip_decisions_ledger.sql
--
-- Trips spec §21.2 TripDecision ledger, §21.3 explainability and §5.3's
-- historical-evidence class (policy-controlled, minimised payloads).
-- census-trips TR6, TR100, TR387, TR401, TR402.
--
-- WHAT WAS TRUE BEFORE THIS FILE
-- ==============================
-- §40.6 built the ledger IN PROCESS: services/trips/TripDecisionLedger.ts keeps
-- a ring of 256 decisions per API process, explains any of them at
-- GET /trips/:id/decisions/:decisionId/explain, and forgets them on restart.
-- Every §21.2 field was there; retention was "until the process restarts",
-- which is not a policy. TR401 and TR402 stayed W for that one reason, and
-- TR387 (preserve decision/audit evidence per policy) said the evidence was
-- "not persisted".
--
-- WHAT THIS FILE BUILDS
-- =====================
--   trip_decisions — one row per recorded decision, the §21.2 fields as
--   columns, written by the API's service client (a decision is DERIVED, not
--   a command: it does not move the aggregate and must not bump trips.version,
--   so it is deliberately NOT a kernel family). inputs_json holds ids,
--   versions and counts — never row bodies (§21.3 "without retaining
--   unnecessary sensitive raw data"); the CHECK below refuses coordinates.
--   retain_until — §5.3's policy, as a column: default 90 days, and
--   public.trip_decisions_prune() deletes past it and reports how many. A
--   scheduler may call it; nothing here schedules it.
--   RLS: crew SELECT; no client writes.
--
-- Read by TripDecisionLedger.ts when trip_operational_projections_enabled is
-- on and the table exists (probeSchemaReadiness), else the ring. Production
-- has neither until an owner applies this file; the API degrades to the ring.

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trip_decisions') IS NOT NULL THEN
    RAISE EXCEPTION '2781: trip_decisions already exists; this migration is not idempotent by design';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'authz' AND p.proname = 'is_trip_crew') THEN
    RAISE EXCEPTION '2781: authz.is_trip_crew is required for the RLS policy (2334)';
  END IF;
END
$pre$;

CREATE TABLE public.trip_decisions (
  decision_id          uuid        PRIMARY KEY,
  trip_id              uuid        NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  decision_type        text        NOT NULL,
  engine_versions_json jsonb       NOT NULL DEFAULT '{}'::jsonb,
  inputs_json          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  sources              text[]      NOT NULL DEFAULT '{}',
  assumptions          text[]      NOT NULL DEFAULT '{}',
  constraints          text[]      NOT NULL DEFAULT '{}',
  result_json          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  confidence           text        NOT NULL DEFAULT 'N/A',
  source_trip_version  bigint      NULL,
  calculated_at        timestamptz NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  retain_until         timestamptz NOT NULL DEFAULT now() + interval '90 days',
  CONSTRAINT trip_decisions_type_known CHECK (decision_type IN ('freedom_windows', 'trip_health', 'today_projection', 'opportunities', 'meeting_point', 'disruption', 'experience')),
  CONSTRAINT trip_decisions_confidence_known CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW', 'N/A')),
  -- §21.3: ids, versions and counts — a coordinate in the inputs is raw data, refused.
  CONSTRAINT trip_decisions_inputs_minimised CHECK (NOT (inputs_json ? 'lat' OR inputs_json ? 'lng' OR inputs_json ? 'latitude' OR inputs_json ? 'longitude')),
  CONSTRAINT trip_decisions_retention_after_record CHECK (retain_until >= recorded_at)
);
COMMENT ON TABLE public.trip_decisions IS
  'Trips spec §21.2 TripDecision ledger: inputs (ids/versions/counts only — §21.3), sources, assumptions, constraints, result summary, confidence, engine versions, and retain_until (§5.3 policy, default 90 days; public.trip_decisions_prune() enforces it). Written by the API service client (a derived record, not a kernel command); RLS: crew SELECT only.';
CREATE INDEX idx_trip_decisions_trip_recent ON public.trip_decisions (trip_id, recorded_at DESC);
CREATE INDEX idx_trip_decisions_retain ON public.trip_decisions (retain_until);

ALTER TABLE public.trip_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY trip_decisions_crew_select ON public.trip_decisions
  FOR SELECT TO authenticated USING (authz.is_trip_crew(trip_id));
REVOKE ALL ON public.trip_decisions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trip_decisions TO authenticated;

-- §5.3 / TR387: the retention policy, enforceable and measurable.
CREATE OR REPLACE FUNCTION public.trip_decisions_prune()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE n bigint;
BEGIN
  DELETE FROM public.trip_decisions WHERE retain_until < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'pruned', n, 'at', now());
END;
$fn$;
REVOKE ALL ON FUNCTION public.trip_decisions_prune() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.trip_decisions_prune() IS
  'Trips spec §5.3: deletes trip_decisions rows past retain_until and reports the count. service_role only; nothing in the database schedules it.';

DO $post$
DECLARE n int; r record; probe jsonb;
BEGIN
  SELECT relrowsecurity INTO r FROM pg_class WHERE oid = 'public.trip_decisions'::regclass;
  IF NOT r.relrowsecurity THEN RAISE EXCEPTION '2781: RLS not enabled'; END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'trip_decisions';
  IF n <> 1 THEN RAISE EXCEPTION '2781: expected exactly 1 policy, found %', n; END IF;
  IF has_table_privilege('authenticated', 'public.trip_decisions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.trip_decisions', 'DELETE') THEN
    RAISE EXCEPTION '2781: authenticated must not write trip_decisions';
  END IF;
  IF has_function_privilege('authenticated', 'public.trip_decisions_prune()', 'EXECUTE') THEN
    RAISE EXCEPTION '2781: authenticated must not prune';
  END IF;
  probe := public.trip_decisions_prune();
  IF (probe->>'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION '2781: prune probe failed: %', probe; END IF;
END
$post$;

COMMIT;
