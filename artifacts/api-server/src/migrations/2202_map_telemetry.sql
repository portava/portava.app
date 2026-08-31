-- 2202_map_telemetry.sql
--
-- Map product telemetry (Map spec §35) — storage + flag.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- §35 names sixteen events and closes with the instruction that actually shapes
-- this schema: "Evaluate whether map interaction produces successful real-world
-- outcomes, not only screen engagement." A per-event row with no correlation key
-- cannot answer that, so every row carries `map_session_id` (minted client-side
-- at map_opened) and a monotonic `seq`, and the decision correlation id lives
-- inside `payload` — letting compass_requested → compass_option_selected →
-- recommendation_accepted → route_started → contribution_submitted be joined
-- into one outcome even though they fire minutes apart from five components.
--
-- WHAT THIS TABLE MUST NEVER CONTAIN
-- ==================================
-- No raw coordinates and no third-party identity. §23/§24 make precise location
-- the single most dangerous thing to accumulate, and a telemetry store is
-- exactly where it accumulates silently and forever. Positions arrive already
-- reduced to a ~4.9 km geohash cell by the client scrubber, and
-- routes/mapTelemetry.ts re-checks every payload and DROPS any event still
-- carrying a coordinate- or identity-shaped key. This migration adds the third
-- line: a CHECK constraint that refuses such a payload at the database, so a
-- future writer that bypasses the route cannot store one either.
--
-- `viewer_id` is the ONE identifier stored, and the route stamps it from the
-- bearer token — never from the request body.
--
-- RETENTION. Rows carry `expires_at` (default 90 days) so this cannot become
-- indefinite behavioural history by accident. The existing retention sweeps can
-- adopt it; until one does, the column is the record of intent, and the index
-- makes the sweep cheap when it lands.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: feature_flags must exist.';
  END IF;
END $$;

-- ── Events ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.map_telemetry_events (
  id                   bigserial PRIMARY KEY,
  viewer_id            uuid NOT NULL,
  event_name           text NOT NULL,
  map_session_id       text NOT NULL,
  seq                  integer NOT NULL DEFAULT 0,
  client_ts            timestamptz NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now(),
  -- Set when the event fired before any map_opened and the session id had to be
  -- synthesised. Analysis must exclude these from session funnels rather than
  -- counting a stray as a real map visit.
  synthesized_session  boolean NOT NULL DEFAULT false,
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at           timestamptz NOT NULL DEFAULT (now() + interval '90 days')
);

ALTER TABLE public.map_telemetry_events
  DROP CONSTRAINT IF EXISTS map_telemetry_events_name_check;
ALTER TABLE public.map_telemetry_events
  ADD CONSTRAINT map_telemetry_events_name_check
  CHECK (event_name IN (
    'map_opened','zone_selected','place_opened','live_state_viewed',
    'why_shown_opened','compass_requested','compass_option_selected',
    'route_started','trip_stop_added','plan_joined','meet_here_created',
    'crew_locate_started','contribution_submitted','alternative_requested',
    'recommendation_accepted','recommendation_declined'
  ));

-- The database-level privacy backstop. Checks only TOP-LEVEL payload keys —
-- a CHECK constraint must stay cheap and immutable, and the route already walks
-- the payload recursively. Defence in depth, not a replacement for that walk.
ALTER TABLE public.map_telemetry_events
  DROP CONSTRAINT IF EXISTS map_telemetry_events_no_raw_location_check;
ALTER TABLE public.map_telemetry_events
  ADD CONSTRAINT map_telemetry_events_no_raw_location_check
  CHECK (
    NOT EXISTS (
      SELECT 1
      FROM jsonb_object_keys(payload) AS k
      WHERE lower(k) SIMILAR TO
        '%(lat|lng|lon|coord|geometry|geohash|bbox|altitude|accuracy|heading|bearing|street|postcode|address|user_id|contributor|author|owner|profile_id|creator|host_id|invitee_id|actor|account_id|handle|email|phone|avatar|display_name|username|device_id|push_token)%'
    )
  );

COMMENT ON TABLE public.map_telemetry_events IS
  'Map spec §35 product telemetry. Positions are coarsened to a ~4.9 km geohash cell client-side; raw coordinates and third-party identity are rejected by the route AND by map_telemetry_events_no_raw_location_check. viewer_id is stamped from the bearer token, never from the request body.';

COMMENT ON COLUMN public.map_telemetry_events.map_session_id IS
  'Client-minted correlation id from map_opened. With seq, this is what lets §35 measure real-world outcomes rather than screen engagement.';

CREATE INDEX IF NOT EXISTS map_telemetry_events_session_idx
  ON public.map_telemetry_events (map_session_id, seq);
CREATE INDEX IF NOT EXISTS map_telemetry_events_viewer_time_idx
  ON public.map_telemetry_events (viewer_id, client_ts DESC);
CREATE INDEX IF NOT EXISTS map_telemetry_events_name_time_idx
  ON public.map_telemetry_events (event_name, client_ts DESC);
CREATE INDEX IF NOT EXISTS map_telemetry_events_expiry_idx
  ON public.map_telemetry_events (expires_at);

ALTER TABLE public.map_telemetry_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.map_telemetry_events FROM PUBLIC;
REVOKE ALL ON public.map_telemetry_events FROM anon;
REVOKE ALL ON public.map_telemetry_events FROM authenticated;
REVOKE ALL ON public.map_telemetry_events FROM service_role;
GRANT INSERT, SELECT, DELETE ON public.map_telemetry_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.map_telemetry_events_id_seq TO service_role;

-- ── Drop counters ─────────────────────────────────────────────────────────────
--
-- The client emitter has a bounded queue and drops the oldest event under
-- pressure. A dropped event that is never reported turns a funnel into a lie
-- that looks like data, so the emitter counts its drops by reason and the
-- server persists them here. An unexplained gap in the event stream should
-- always be explainable by a row in this table.

CREATE TABLE IF NOT EXISTS public.map_telemetry_drops (
  id                 bigserial PRIMARY KEY,
  viewer_id          uuid NOT NULL,
  map_session_id     text,
  dropped            integer NOT NULL DEFAULT 0,
  dropped_total      integer NOT NULL DEFAULT 0,
  dropped_by_reason  jsonb NOT NULL DEFAULT '{}'::jsonb,
  queue_depth        integer NOT NULL DEFAULT 0,
  received_at        timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL DEFAULT (now() + interval '90 days')
);

COMMENT ON TABLE public.map_telemetry_drops IS
  'Client-side telemetry drop accounting. Exists so a shrinking event stream is observable rather than invisible — a gap in map_telemetry_events should always have a row here explaining it.';

CREATE INDEX IF NOT EXISTS map_telemetry_drops_expiry_idx
  ON public.map_telemetry_drops (expires_at);

ALTER TABLE public.map_telemetry_drops ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.map_telemetry_drops FROM PUBLIC;
REVOKE ALL ON public.map_telemetry_drops FROM anon;
REVOKE ALL ON public.map_telemetry_drops FROM authenticated;
REVOKE ALL ON public.map_telemetry_drops FROM service_role;
GRANT INSERT, SELECT, DELETE ON public.map_telemetry_drops TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.map_telemetry_drops_id_seq TO service_role;

-- ── Flag ──────────────────────────────────────────────────────────────────────
-- OFF by default: the route answers { ok: true, accepted: 0, enabled: false }
-- and the client keeps queueing locally. Nothing is collected until switched on.

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('map_telemetry_enabled', FALSE,
   'Map product telemetry (spec §35): ingest for the 16 map events. Positions coarsened to a ~4.9 km cell client-side; raw coordinates and third-party identity rejected at the route and by a CHECK constraint.')
ON CONFLICT (flag) DO NOTHING;

COMMIT;
