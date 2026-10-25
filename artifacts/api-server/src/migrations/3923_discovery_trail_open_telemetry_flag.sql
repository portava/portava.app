-- 3923_discovery_trail_open_telemetry_flag.sql
-- One capability flag, seeded OFF: the server writer of `04` §4's trail_open
-- (census-discovery §133, DV-78), POST /rank-events/trail-open.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane DISCOVERY,
-- 3920-3929). ORDER-INDEPENDENT AND IDEMPOTENT: it needs only
-- public.feature_flags, inserts one row with ON CONFLICT DO NOTHING, and never
-- changes a row that already exists. Rehearsed on the local PostgreSQL harness.
--
-- ── WHY A FLAG, AND WHY IT SHIPS OFF ────────────────────────────────────────
-- A Trail open is recorded as a rank_events row against the viewer's account
-- (lib/discoveryTrailOpen.ts: event_type 'trail_open', outcome 'analytics', no
-- schema change). That is new behavioural collection, the same class as dwell
-- (D-W10-O-9, whose consent request names only the place detail sheet).
-- Whether to collect it, under which wording, and for how long, is the owner's
-- consent and retention decision, not this lane's. So OFF (the seed), absent or
-- unreadable: the route answers 404 feature_disabled and writes nothing.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE ─────────────────────────────────────────
-- Rollback: db/rollback/2026-10-23-3923-discovery-trail-open-telemetry-flag-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3923): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'discovery_trail_open_telemetry_enabled',
    false,
    'POST /rank-events/trail-open records `04` §4 trail_open as a rank_events row (event_type trail_open, outcome analytics) for a signed-in viewer opening a Trail they may see. census-discovery DV-78, §133; migration 3923. New collection linked to the account: OFF (the seed), absent or unreadable, nothing is written (404 feature_disabled). Turning it ON is the owner''s consent and retention decision.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'discovery_trail_open_telemetry_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3923): discovery_trail_open_telemetry_enabled is absent.';
  END IF;
END $post$;
