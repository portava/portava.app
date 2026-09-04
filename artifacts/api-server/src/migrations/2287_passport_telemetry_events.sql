-- 2287_passport_telemetry_events.sql
--
-- Passport product telemetry (Passport spec §32) — storage + flag.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHAT §32 ASKS FOR
-- =================
-- §32 names a fixed set of Passport telemetry events (passport_viewed,
-- availability_set, stamp_issued, stamp_verified, trust_summary_viewed, …).
-- Portava had no Passport telemetry sink at all, so those events had nowhere to
-- land. This table is that sink for the SERVER-EMITTED members of the set — the
-- ones a server action produces rather than a client interaction — beginning
-- with stamp_issued / stamp_verified emitted by the StampAwardEngine.
--
-- SHAPE — MODELLED ON public.media_events, DELIBERATELY
-- =====================================================
-- Like media_events, this table carries NO top-level user-identifying column:
-- (event_name, payload, occurred_at). Any pseudonymous actor/subject reference
-- rides INSIDE `payload`, projected through an allow-list by the fire-and-forget
-- emitter (lib/passportTelemetry.ts). Keeping the identifier out of a top-level
-- column is the same posture media_events takes — the store is analytics, not a
-- second copy of who-did-what — and it is why this table needs no per-user
-- deletion step or RLS owner policy: there is no owner column to key one on.
--
-- WHAT THIS TABLE MUST NEVER CONTAIN
-- ==================================
-- No raw coordinates and no contact/identity PII. §23/§25 make precise location
-- the single most dangerous thing to accumulate in a telemetry store. The
-- emitter strips coordinate- and identity-shaped keys before every write, and
-- passport_telemetry_payload_is_clean re-checks the top-level payload at the
-- database so a future writer that bypasses the emitter cannot store one either.
--
-- RETENTION. Every row carries `expires_at` (default 90 days) so this can never
-- become indefinite behavioural history by accident; the existing retention
-- sweeps can adopt the index.
--
-- OFF BY DEFAULT. `passport_telemetry_enabled` is seeded FALSE; the emitter is
-- fail-closed (isFlagEnabled → false on any error), so nothing is collected
-- until the flag is switched on.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: feature_flags must exist.';
  END IF;
END $$;

-- ── Events ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.passport_telemetry_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- §32 event name. Closed set enforced below; an unknown name is rejected
  -- rather than stored as "unknown".
  event_name   text NOT NULL,
  -- Pseudonymous, allow-listed context only. No top-level actor column by design
  -- (see header) — the actor/subject ride here as ids the emitter allow-lists.
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  -- Retention horizon so telemetry never becomes indefinite history.
  expires_at   timestamptz NOT NULL DEFAULT (now() + interval '90 days')
);

-- The §32 event set. Anything else is rejected by the CHECK (and dropped by the
-- emitter before it ever gets here).
ALTER TABLE public.passport_telemetry_events
  DROP CONSTRAINT IF EXISTS passport_telemetry_events_name_check;
ALTER TABLE public.passport_telemetry_events
  ADD CONSTRAINT passport_telemetry_events_name_check
  CHECK (event_name IN (
    'passport_viewed','passport_shared','passport_qr_scanned',
    'availability_set','availability_expired','open_to_plans_enabled',
    'stamp_issued','stamp_verified','stamp_viewed',
    'trust_summary_viewed','shared_context_viewed','make_plan_started',
    'journey_viewed','memory_viewed','my_world_opened',
    'follow_from_passport','message_from_passport','trip_invite_from_passport'
  ));

-- Database-level privacy backstop. Checks only TOP-LEVEL payload keys — a CHECK
-- must stay cheap and the emitter already projects to an allow-list. Defence in
-- depth, not a replacement. Lives in a function because Postgres refuses a
-- subquery inside a CHECK constraint (0A000). search_path is pinned so the
-- constraint cannot be redirected at a shadowing object.
CREATE OR REPLACE FUNCTION public.passport_telemetry_payload_is_clean(p jsonb)
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
      '%(lat|lng|lon|coord|geometry|geohash|bbox|altitude|accuracy|heading|bearing|street|postcode|address|email|phone|avatar|display_name|username|device_id|push_token)%'
  );
$fn$;

COMMENT ON FUNCTION public.passport_telemetry_payload_is_clean(jsonb) IS
  'Passport spec §32/§23: true when a telemetry payload carries no top-level coordinate- or contact/identity-shaped key. A function because a CHECK constraint may not contain a subquery.';

REVOKE ALL ON FUNCTION public.passport_telemetry_payload_is_clean(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.passport_telemetry_payload_is_clean(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.passport_telemetry_payload_is_clean(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.passport_telemetry_payload_is_clean(jsonb) TO service_role;

ALTER TABLE public.passport_telemetry_events
  DROP CONSTRAINT IF EXISTS passport_telemetry_events_clean_payload_check;
ALTER TABLE public.passport_telemetry_events
  ADD CONSTRAINT passport_telemetry_events_clean_payload_check
  CHECK (public.passport_telemetry_payload_is_clean(payload));

COMMENT ON TABLE public.passport_telemetry_events IS
  'Passport spec §32 product telemetry sink for server-emitted events (stamp_issued/stamp_verified today). Modelled on media_events: no top-level user column — pseudonymous actor/subject ride in payload via an allow-list. Raw coordinates and contact/identity PII are rejected by the emitter AND by passport_telemetry_payload_is_clean. Rows carry a 90-day retention horizon (expires_at).';

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS passport_telemetry_events_name_time_idx
  ON public.passport_telemetry_events (event_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS passport_telemetry_events_expiry_idx
  ON public.passport_telemetry_events (expires_at);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Deny-default; REVOKE-first. Server-emitted telemetry: only service_role reads
-- or writes. No anon / authenticated grant, no owner policy (there is no owner
-- column to scope one on — the actor lives in payload).

ALTER TABLE public.passport_telemetry_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.passport_telemetry_events FROM PUBLIC;
REVOKE ALL ON public.passport_telemetry_events FROM anon;
REVOKE ALL ON public.passport_telemetry_events FROM authenticated;
REVOKE ALL ON public.passport_telemetry_events FROM service_role;

GRANT INSERT, SELECT, DELETE ON public.passport_telemetry_events TO service_role;

DROP POLICY IF EXISTS passport_telemetry_events_service_all ON public.passport_telemetry_events;
CREATE POLICY passport_telemetry_events_service_all ON public.passport_telemetry_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── Flag ────────────────────────────────────────────────────────────────────
-- OFF by default. With it off the emitter records nothing (fail-closed).

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('passport_telemetry_enabled', FALSE,
   'Passport spec §32 product telemetry: server-side emission of Passport events (stamp_issued/stamp_verified from StampAwardEngine via lib/passportTelemetry.ts) into passport_telemetry_events. OFF ships nothing (fail-closed). Payloads are allow-listed and carry no raw location or contact/identity PII.')
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions ─────────────────────────────────────────────────────────
DO $$
DECLARE on_count int;
BEGIN
  IF to_regclass('public.passport_telemetry_events') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: passport_telemetry_events was not created.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'passport_telemetry_events_clean_payload_check'
      AND conrelid = 'public.passport_telemetry_events'::regclass
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the payload-clean CHECK is missing.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.feature_flags WHERE flag = 'passport_telemetry_enabled'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: passport_telemetry_enabled flag was not seeded.';
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'passport_telemetry_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: passport_telemetry_enabled seeded ON — it must ship OFF';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   DROP TABLE IF EXISTS public.passport_telemetry_events;
--   DROP FUNCTION IF EXISTS public.passport_telemetry_payload_is_clean(jsonb);
--   DELETE FROM public.feature_flags WHERE flag = 'passport_telemetry_enabled';
-- The reversal removes only a disabled capability's sink; no served data changes.
