-- 3395_discovery_dwell_telemetry_flag.sql
-- Discovery outcome measurement (census-discovery DV-41 / §55): `04` §7 dwell
-- quality on Discovery's place surfaces. ONE capability flag, seeded OFF.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; Discovery outcome
-- measurement lane 3395-3399). APPLIED TO NO DATABASE by the lane that wrote it
-- other than the local PostgreSQL 16 harness.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention:
-- read fail-closed via isFlagEnabled.
--
-- ── WHAT THIS GATES ─────────────────────────────────────────────────────────
-- `discovery_dwell_telemetry_enabled`. It is NEW BEHAVIOURAL COLLECTION, so its
-- activation is the owner's decision and this file only creates it, OFF.
--   ON:  the client (travel-buddy-standalone/src/services/discoveryDwell.ts,
--        mounted on the Discovery place detail sheet) measures dwell on a served
--        place and classifies it active / passive_foreground / idle; a signed-in
--        viewer's emission is POSTed to /api/rank-events/dwell, which binds it
--        to the viewer's own exposure (recommendation_id) and writes one
--        rank_events attention row per kind (2890's dwell_ms / dwell_kind,
--        outcome 'analytics', event_type 'place_dwell'), idempotent on the
--        client's event id through 2891's (recommendation_id, outcome) index.
--   OFF / absent / unreadable (the seed): the client measures and sends
--        nothing; the route answers 404 feature_disabled and reads and writes
--        nothing. Every served body and every existing row is exactly what it
--        was before this file.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds it ON. Absent and
-- FALSE read the same, so an unapplied 3395 and an applied one behave alike.
-- Readers: lib/discoveryDwell.acceptDiscoveryDwell (server) and
-- hooks/useDiscoveryDwell (client, through GET /api/feature-flags).
--
-- The interaction window that separates `active` from `passive_foreground`
-- (DWELL_INTERACTION_WINDOW_MS in the client module) is UNRATIFIED: no spec
-- states it. Turning this flag on also adopts that number; both are the
-- owner's decision (census-discovery §55).
--
-- No schema dependency beyond feature_flags: 2890 (dwell columns) and 2891
-- (the arbiter) are applied in production (2026-09-14); where they are absent the
-- route refuses to write rather than write non-idempotently.
--
-- Rollback: db/rollback/2026-09-27-3395-discovery-dwell-telemetry-flag-rollback.sql
-- (deletes the row while it is still FALSE, and this file's ledger row).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3395): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'discovery_dwell_telemetry_enabled',
    false,
    'Discovery dwell telemetry (census-discovery DV-41, §55): 04 §7 dwell quality on the Discovery place detail sheet. ON: the client classifies dwell on a served place as active (foreground, touched within the unratified interaction window) / passive_foreground / idle (backgrounded or screen off; never interest) and a signed-in viewer''s emission is written as rank_events attention rows bound to that viewer''s own exposure, idempotent on the client event id. OFF / absent / unreadable (the seed): nothing is measured, sent, read or written. New behavioural collection: turning it on is an owner decision.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'discovery_dwell_telemetry_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3395): expected discovery_dwell_telemetry_enabled present, found %', present;
  END IF;

  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'discovery_dwell_telemetry_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3395): discovery_dwell_telemetry_enabled is ON — dwell collection is new behavioural collection, enabling it is an owner decision, and this must ship OFF';
  END IF;
END $post$;
