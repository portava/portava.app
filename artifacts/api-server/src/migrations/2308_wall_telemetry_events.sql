-- 2308_wall_telemetry_events.sql
--
-- Wall product telemetry (Wall spec §32) — the missing server half.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHY THIS EXISTS
-- ===============
-- The Wall client has always emitted the full §32 event set. It fans every event
-- to a pluggable sink, and the real transport
-- (travel-buddy-standalone/src/features/wall/services/wallAnalyticsTransport.ts,
-- wired at app boot in app/_layout.tsx) POSTs each one to `/api/wall/telemetry`.
--
-- THAT ROUTE DID NOT EXIST. Thirteen of the fifteen §32 events — feed open, mode
-- select, engagement, Live For You shown/opened, Context Thread shown/acted/
-- ignored, follow-from-feed, handoff, caught-up, not-interested and the
-- consented real-world outcome — had nowhere on the server to land, and the
-- transport is fire-and-forget, so the 404 was swallowed silently. TABLE 7
-- Phase 7 ("outcome learning / continuous certification") was a closed loop with
-- its client end wired into nothing.
--
-- Only `wall_impression` and `wall_action` had a server home at all
-- (POST /wall/impression, POST /wall/action → rank_events), which is why this
-- table is NOT a second copy of those: it is the sink for the events that had
-- none.
--
-- SHAPE — MODELLED ON public.map_telemetry_events (migration 2202)
-- ===============================================================
-- Same posture, same three lines of defence, deliberately: an allow-listed event
-- name, a jsonb payload of ids/enums/counts, a viewer stamped from the bearer
-- token, and a database CHECK that refuses a coordinate-, contact- or free-text-
-- shaped key even if a future writer bypasses the route.
--
-- WHAT THIS TABLE MUST NEVER CONTAIN
-- ==================================
-- §32 is explicit: the Wall never logs raw private message text or unnecessary
-- raw typed content. The client union has no free-text field by construction;
-- routes/wallTelemetry.ts re-derives each payload from a per-event allow-list
-- rather than trusting the body; and wall_telemetry_payload_is_clean is the
-- third line, at the database.
--
-- `viewer_id` is the ONE identifier stored, it is stamped from the bearer token
-- (never from the request body), and it CASCADES from auth.users so a deleted
-- account takes its Wall telemetry with it. That is a deliberate difference from
-- map_telemetry_events, whose viewer_id has no FK and therefore survives
-- deletion.
--
-- RETENTION. Rows carry `expires_at` (default 90 days) so this cannot become
-- indefinite behavioural history by accident.
--
-- FLAG. None of its own. The whole Wall is dark behind `wall_enabled`
-- (migration 2270) and every other Wall route gates on that single flag; a
-- second, separately-pressed telemetry flag is exactly how a surface ends up
-- switched on while recording nothing — which is the failure this migration
-- exists to end.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: feature_flags must exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'wall_enabled') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: wall_enabled must exist (migration 2270).';
  END IF;
END $$;

-- ── Events ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.wall_telemetry_events (
  id           bigserial PRIMARY KEY,
  viewer_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_name   text NOT NULL,
  -- The contract that produced this row. Stored so a breaking payload change is
  -- deliberate and visible rather than silently averaged in with older rows.
  schema_version text NOT NULL DEFAULT '1.0',
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT (now() + interval '90 days')
);

ALTER TABLE public.wall_telemetry_events
  DROP CONSTRAINT IF EXISTS wall_telemetry_events_name_check;
ALTER TABLE public.wall_telemetry_events
  ADD CONSTRAINT wall_telemetry_events_name_check
  CHECK (event_name IN (
    'wall_feed_open','wall_mode_select','wall_impression','wall_action',
    'wall_engagement','wall_live_shown','wall_live_open','wall_context_shown',
    'wall_context_acted','wall_context_ignored','wall_follow_from_feed',
    'wall_handoff','wall_caught_up','wall_not_interested',
    'wall_real_world_outcome'
  ));

-- The database-level privacy backstop. Checks only TOP-LEVEL payload keys — a
-- CHECK constraint must stay cheap and the Wall's payloads are flat by
-- construction. Defence in depth, not a replacement for the route's allow-list.
--
-- The scan lives in a function because Postgres REFUSES a subquery inside a
-- CHECK constraint (0A000), and scanning an unknown set of jsonb keys needs one.
--
-- search_path is pinned so the constraint cannot be redirected at a shadowing
-- object — the hazard scripts/verify-search-path-hazard.mjs guards.
CREATE OR REPLACE FUNCTION public.wall_telemetry_payload_is_clean(p jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $fn$
  SELECT NOT EXISTS (
    SELECT 1
    FROM jsonb_object_keys(COALESCE(p, '{}'::jsonb)) AS k
    WHERE lower(k) SIMILAR TO
      '%(lat|lng|lon|coord|geometry|geohash|bbox|address|street|postcode|email|phone|avatar|handle|username|display_name|displayname|device_id|push_token|user_id|userid|actor|author|owner|creator|profile_id|text|content|caption|body|message|comment|note|query|title|description)%'
  );
$fn$;

COMMENT ON FUNCTION public.wall_telemetry_payload_is_clean(jsonb) IS
  'Wall spec §32: true when a telemetry payload carries no coordinate-, contact- or free-text-shaped top-level key. Exists as a function because a CHECK constraint may not contain a subquery.';

REVOKE ALL ON FUNCTION public.wall_telemetry_payload_is_clean(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wall_telemetry_payload_is_clean(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.wall_telemetry_payload_is_clean(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.wall_telemetry_payload_is_clean(jsonb) TO service_role;

ALTER TABLE public.wall_telemetry_events
  DROP CONSTRAINT IF EXISTS wall_telemetry_events_no_raw_content_check;
ALTER TABLE public.wall_telemetry_events
  ADD CONSTRAINT wall_telemetry_events_no_raw_content_check
  CHECK (public.wall_telemetry_payload_is_clean(payload));

COMMENT ON TABLE public.wall_telemetry_events IS
  'Wall spec §32 product telemetry — the sink for the thirteen client-only Wall events that previously POSTed to a nonexistent /api/wall/telemetry. Ids, enums and counts only; raw text, contact details and coordinates are rejected by the route AND by wall_telemetry_events_no_raw_content_check. viewer_id is stamped from the bearer token, never from the request body, and CASCADEs from auth.users.';

COMMENT ON COLUMN public.wall_telemetry_events.payload IS
  'Flat, allow-listed ids/enums/counts derived by routes/wallTelemetry.ts. Never the request body verbatim.';

CREATE INDEX IF NOT EXISTS wall_telemetry_events_viewer_time_idx
  ON public.wall_telemetry_events (viewer_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS wall_telemetry_events_name_time_idx
  ON public.wall_telemetry_events (event_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS wall_telemetry_events_expiry_idx
  ON public.wall_telemetry_events (expires_at);

ALTER TABLE public.wall_telemetry_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wall_telemetry_events FROM PUBLIC;
REVOKE ALL ON public.wall_telemetry_events FROM anon;
REVOKE ALL ON public.wall_telemetry_events FROM authenticated;
REVOKE ALL ON public.wall_telemetry_events FROM service_role;
GRANT INSERT, SELECT, DELETE ON public.wall_telemetry_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.wall_telemetry_events_id_seq TO service_role;

COMMIT;

-- REVERSAL (manual):
--   DROP TABLE IF EXISTS public.wall_telemetry_events;
--   DROP FUNCTION IF EXISTS public.wall_telemetry_payload_is_clean(jsonb);
