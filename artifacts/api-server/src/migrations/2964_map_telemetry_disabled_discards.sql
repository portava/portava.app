-- 2964_map_telemetry_disabled_discards.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS FIXES: COLLECTION-OFF WAS STILL COLLECTING
-- ══════════════════════════════════════════════════════════════════════════════
-- `map_telemetry_enabled` is the Map's COLLECTION control. 2202 states its
-- off-state contract in the file that seeds it, and states it without
-- qualification:
--
--   "OFF by default: the route answers { ok: true, accepted: 0, enabled: false }
--    and the client keeps queueing locally. Nothing is collected until switched
--    on."
--
-- routes/mapTelemetry.ts did not keep that promise. On the flag-off path it
-- wrote a row into `map_telemetry_drops` carrying `viewer_id` (the account, from
-- the bearer token), `map_session_id` (the client-minted correlation key that
-- 2202 itself describes as what "lets §35 measure real-world outcomes"), and
-- `received_at`. Account + session + timestamp + a count of map activity is a
-- record of a person using the map. It is per-user behavioural data, and it was
-- being written while the control that governs collecting per-user behavioural
-- data was FALSE.
--
-- The comment defending it argued that the row is "an operational fact about
-- the pipeline rather than a record of anything the user did on the map". That
-- argument does not survive the row's own columns: a row that says WHICH ACCOUNT
-- and WHICH MAP SESSION discarded HOW MANY events at WHAT TIME is a record of
-- what that user did on the map, whatever the table is called. `viewer_id` being
-- NOT NULL is a reason the write had to name a user, not a reason it was
-- permitted to.
--
-- It also misfiled the row. 2202 defines `map_telemetry_drops` as
-- "Client-side telemetry drop accounting" — losses the CLIENT's bounded queue
-- suffered. A server-side refusal is a different fact, and folding it into that
-- table both overstates client queue pressure and makes the two indistinguishable
-- in analysis.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS DOES INSTEAD: KEEP THE DIAGNOSTIC, DROP THE SUBJECT
-- ══════════════════════════════════════════════════════════════════════════════
-- The diagnostic is real and must not be lost. Commit 63772b76c found that
-- "every production map telemetry event was silently discarded", and it went
-- unnoticed for months precisely because a dashboard cannot tell an off flag
-- from a feature nobody opened — both read zero. That finding requires exactly
-- ONE fact to stay observable:
--
--   in period P, the server refused B batches carrying E events because the
--   collection flag was off.
--
-- Answering that needs no account, no session, and no per-request row. So this
-- table has none of them. It is an hourly counter and nothing else:
--
--   * NO viewer_id, and no column that could hold one. The separation is
--     structural, not a convention a later writer can forget — there is no
--     identity column to populate.
--   * NO map_session_id. A session id is a pseudonymous identifier: it
--     correlates one person's requests across time, which is the whole reason
--     §35 stores it on the enabled path.
--   * NO per-request row. One row per POST is itself a timing trace — arrival
--     times and batch sizes fingerprint a session even with the id removed.
--     Requests inside the same hour are summed into one row, so what is stored
--     is a volume, not a sequence.
--
-- An hourly bucket is coarse enough that the row is a property of the pipeline
-- and fine enough to locate an outage to the hour it began, which is what
-- 63772b76c's investigation actually needed.
--
-- `batches` is kept alongside `events` because they answer different questions:
-- events falling to zero while batches stay flat means clients are still trying
-- and the server is still refusing (a flag that should be on), whereas both
-- falling to zero means the clients stopped (a different failure entirely).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ARITHMETIC IN THE DATABASE, NOT IN THE ROUTE
-- ══════════════════════════════════════════════════════════════════════════════
-- Accumulating into a shared bucket is read-modify-write, and concurrent map
-- clients make that a lost-update race if the route does it. The upsert lives in
-- a function so the increment is one atomic statement, and the route's only move
-- is to call it with a count. That also means the route holds no INSERT on this
-- table at all: it cannot write a column this file did not choose.
--
-- The function is SECURITY DEFINER for the same reason 2960's purge is — the
-- counter must not depend on the caller's table rights — and EXECUTE is granted
-- to service_role only, matching 2202's posture of service_role and nothing else.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- RETENTION
-- ══════════════════════════════════════════════════════════════════════════════
-- These rows name nobody, so they are not the behavioural history 2202's 90-day
-- promise exists to bound. They still age out, because an operational counter
-- that grows forever is how a table stops being operational. 2960's
-- `purge_expired_map_telemetry()` is replaced here to sweep this table too; the
-- replacement is additive — both original DELETEs are preserved verbatim and the
-- returned count still includes them. 2964 runs after 2960 in the chain, so
-- last-statement-wins gives the three-table version.

BEGIN;

-- Preconditions. This file is a correction to 2202's telemetry surface; if that
-- surface is absent, the correction is being applied to the wrong database.
DO $$
BEGIN
  IF to_regclass('public.map_telemetry_events') IS NULL THEN
    RAISE EXCEPTION '2964 PRECONDITION FAILED: public.map_telemetry_events is absent — apply 2202_map_telemetry.sql first.';
  END IF;
  IF to_regclass('public.map_telemetry_drops') IS NULL THEN
    RAISE EXCEPTION '2964 PRECONDITION FAILED: public.map_telemetry_drops is absent — apply 2202_map_telemetry.sql first.';
  END IF;
END $$;

-- ── The counter ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.map_telemetry_disabled_discards (
  bucket_hour  timestamptz PRIMARY KEY,
  batches      bigint      NOT NULL DEFAULT 0,
  events       bigint      NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL DEFAULT (now() + interval '90 days')
);

-- The bucket must actually be a bucket. Without this a writer could pass
-- clock_timestamp() and turn the table back into a per-request timing trace,
-- which is one of the three things this file exists to prevent.
ALTER TABLE public.map_telemetry_disabled_discards
  DROP CONSTRAINT IF EXISTS map_telemetry_disabled_discards_bucket_is_hour_check;
ALTER TABLE public.map_telemetry_disabled_discards
  ADD CONSTRAINT map_telemetry_disabled_discards_bucket_is_hour_check
  CHECK (bucket_hour = date_trunc('hour', bucket_hour));

ALTER TABLE public.map_telemetry_disabled_discards
  DROP CONSTRAINT IF EXISTS map_telemetry_disabled_discards_counts_check;
ALTER TABLE public.map_telemetry_disabled_discards
  ADD CONSTRAINT map_telemetry_disabled_discards_counts_check
  CHECK (batches >= 0 AND events >= 0);

COMMENT ON TABLE public.map_telemetry_disabled_discards IS
  'Map spec §35: how many telemetry batches/events the server refused per hour because map_telemetry_enabled was FALSE. Deliberately carries NO viewer, NO session and NO per-request row — 2202 promises "nothing is collected until switched on", and this table keeps the 63772b76c discard observable without collecting anything about a user. Written only by record_map_telemetry_disabled_discard().';

COMMENT ON COLUMN public.map_telemetry_disabled_discards.batches IS
  'POST /api/map/telemetry requests refused in this hour. Distinguishes "clients still emitting, server refusing" from "clients stopped" — events alone cannot.';

CREATE INDEX IF NOT EXISTS map_telemetry_disabled_discards_expiry_idx
  ON public.map_telemetry_disabled_discards (expires_at);

ALTER TABLE public.map_telemetry_disabled_discards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.map_telemetry_disabled_discards FROM PUBLIC;
REVOKE ALL ON public.map_telemetry_disabled_discards FROM anon;
REVOKE ALL ON public.map_telemetry_disabled_discards FROM authenticated;
REVOKE ALL ON public.map_telemetry_disabled_discards FROM service_role;
-- SELECT and DELETE only. The route reaches this table through the function
-- below and never through an INSERT of its own.
GRANT SELECT, DELETE ON public.map_telemetry_disabled_discards TO service_role;

-- ── The one writer ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_map_telemetry_disabled_discard(p_events integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_events bigint := GREATEST(COALESCE(p_events, 0), 0);
BEGIN
  -- A refusal that discarded nothing is not a discard. Writing a row for it
  -- would satisfy "the discard is recorded" without recording any discard, and
  -- would additionally turn an empty keep-alive POST into a stored fact.
  IF v_events = 0 THEN
    RETURN;
  END IF;

  INSERT INTO public.map_telemetry_disabled_discards AS d (bucket_hour, batches, events)
  VALUES (date_trunc('hour', now()), 1, v_events)
  ON CONFLICT (bucket_hour) DO UPDATE
    SET batches = d.batches + 1,
        events  = d.events + EXCLUDED.events;
END;
$fn$;

REVOKE ALL ON FUNCTION public.record_map_telemetry_disabled_discard(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_map_telemetry_disabled_discard(integer) FROM anon;
REVOKE ALL ON FUNCTION public.record_map_telemetry_disabled_discard(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_map_telemetry_disabled_discard(integer) TO service_role;

COMMENT ON FUNCTION public.record_map_telemetry_disabled_discard(integer) IS
  'Adds one refused batch of p_events events to the current hour bucket of map_telemetry_disabled_discards. Atomic upsert so concurrent clients cannot lose an increment. Takes a COUNT and nothing else — it is structurally incapable of storing a viewer or a session. service_role only.';

-- ── Retention: 2960''s sweep, extended to the third table ─────────────────────

CREATE OR REPLACE FUNCTION public.purge_expired_map_telemetry()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  event_count    bigint := 0;
  drop_count     bigint := 0;
  discard_count  bigint := 0;
BEGIN
  WITH deleted AS (
    DELETE FROM public.map_telemetry_events
    WHERE expires_at <= clock_timestamp()
    RETURNING 1
  )
  SELECT count(*) INTO event_count FROM deleted;

  WITH deleted AS (
    DELETE FROM public.map_telemetry_drops
    WHERE expires_at <= clock_timestamp()
    RETURNING 1
  )
  SELECT count(*) INTO drop_count FROM deleted;

  WITH deleted AS (
    DELETE FROM public.map_telemetry_disabled_discards
    WHERE expires_at <= clock_timestamp()
    RETURNING 1
  )
  SELECT count(*) INTO discard_count FROM deleted;

  RETURN event_count + drop_count + discard_count;
END;
$fn$;

REVOKE ALL ON FUNCTION public.purge_expired_map_telemetry() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_expired_map_telemetry() FROM anon;
REVOKE ALL ON FUNCTION public.purge_expired_map_telemetry() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_map_telemetry() TO service_role;

COMMENT ON FUNCTION public.purge_expired_map_telemetry() IS
  'Enforces the 90-day Map telemetry retention 2202 declared. Deletes map_telemetry_events, map_telemetry_drops and map_telemetry_disabled_discards rows past expires_at and returns the combined count. service_role only; called by runMapTelemetryRetentionSweep behind map_telemetry_retention_enabled.';

-- ── Postconditions ────────────────────────────────────────────────────────────
-- Assert the PRIVACY properties, not just that objects exist. Every claim the
-- header makes about what this table cannot hold is checked here, so a later
-- edit that adds an identity column fails at apply time rather than in review.
DO $$
DECLARE
  v_bad   text;
  v_src   text;
  v_count integer;
BEGIN
  IF to_regclass('public.map_telemetry_disabled_discards') IS NULL THEN
    RAISE EXCEPTION '2964 POSTCONDITION FAILED: map_telemetry_disabled_discards was not created';
  END IF;

  -- No identity column, by name. The route cannot store a viewer or a session
  -- because there is nowhere to put one.
  SELECT string_agg(a.attname, ', ') INTO v_bad
  FROM pg_attribute a
  WHERE a.attrelid = 'public.map_telemetry_disabled_discards'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped
    AND (
      a.attname LIKE '%viewer%' OR a.attname LIKE '%user%' OR a.attname LIKE '%session%'
      OR a.attname LIKE '%account%' OR a.attname LIKE '%device%' OR a.attname LIKE '%actor%'
    );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '2964 POSTCONDITION FAILED: identity-shaped column(s) on map_telemetry_disabled_discards: %', v_bad;
  END IF;

  -- No identity column, by type either. A uuid here would be an identifier
  -- whatever it were named.
  SELECT string_agg(a.attname, ', ') INTO v_bad
  FROM pg_attribute a
  WHERE a.attrelid = 'public.map_telemetry_disabled_discards'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped
    AND a.atttypid = 'uuid'::regtype;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '2964 POSTCONDITION FAILED: uuid column(s) on map_telemetry_disabled_discards: %', v_bad;
  END IF;

  -- The exact shape, so an added column of any kind is noticed.
  SELECT count(*) INTO v_count
  FROM pg_attribute a
  WHERE a.attrelid = 'public.map_telemetry_disabled_discards'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped;
  IF v_count <> 4 THEN
    RAISE EXCEPTION '2964 POSTCONDITION FAILED: expected exactly 4 columns (bucket_hour, batches, events, expires_at), found %', v_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.map_telemetry_disabled_discards'::regclass
      AND conname = 'map_telemetry_disabled_discards_bucket_is_hour_check'
  ) THEN
    RAISE EXCEPTION '2964 POSTCONDITION FAILED: the hour-bucket CHECK is missing — a writer could store a per-request timestamp';
  END IF;

  -- No client role may read, write or reach the counter.
  IF has_table_privilege('anon', 'public.map_telemetry_disabled_discards', 'SELECT')
     OR has_table_privilege('authenticated', 'public.map_telemetry_disabled_discards', 'SELECT')
     OR has_table_privilege('anon', 'public.map_telemetry_disabled_discards', 'INSERT')
     OR has_table_privilege('authenticated', 'public.map_telemetry_disabled_discards', 'INSERT') THEN
    RAISE EXCEPTION '2964 POSTCONDITION FAILED: a client role holds rights on map_telemetry_disabled_discards';
  END IF;

  -- service_role writes through the function, not through the table.
  IF has_table_privilege('service_role', 'public.map_telemetry_disabled_discards', 'INSERT')
     OR has_table_privilege('service_role', 'public.map_telemetry_disabled_discards', 'UPDATE') THEN
    RAISE EXCEPTION '2964 POSTCONDITION FAILED: service_role holds a direct INSERT/UPDATE — the upsert function must be the only writer';
  END IF;

  IF NOT has_function_privilege('service_role', 'public.record_map_telemetry_disabled_discard(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '2964 POSTCONDITION FAILED: service_role cannot EXECUTE record_map_telemetry_disabled_discard';
  END IF;
  IF has_function_privilege('anon', 'public.record_map_telemetry_disabled_discard(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.record_map_telemetry_disabled_discard(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '2964 POSTCONDITION FAILED: a client role can EXECUTE record_map_telemetry_disabled_discard';
  END IF;

  -- Exactly one overload, so a stray argument list cannot shadow the writer.
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'record_map_telemetry_disabled_discard';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '2964 POSTCONDITION FAILED: % overloads of record_map_telemetry_disabled_discard exist; exactly 1 is required', v_count;
  END IF;

  -- The retention replacement is ADDITIVE. Comments are stripped first so prose
  -- naming a table cannot satisfy a check that the body deletes from it.
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'purge_expired_map_telemetry';
  v_src := regexp_replace(v_src, '--[^' || chr(10) || ']*', '', 'g');
  IF v_src NOT LIKE '%DELETE FROM public.map_telemetry_events%' THEN
    RAISE EXCEPTION '2964 POSTCONDITION FAILED: the replacement purge no longer sweeps map_telemetry_events';
  END IF;
  IF v_src NOT LIKE '%DELETE FROM public.map_telemetry_drops%' THEN
    RAISE EXCEPTION '2964 POSTCONDITION FAILED: the replacement purge no longer sweeps map_telemetry_drops';
  END IF;
  IF v_src NOT LIKE '%DELETE FROM public.map_telemetry_disabled_discards%' THEN
    RAISE EXCEPTION '2964 POSTCONDITION FAILED: the replacement purge does not sweep map_telemetry_disabled_discards';
  END IF;
END $$;

COMMIT;
