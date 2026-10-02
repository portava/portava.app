-- 3376_discovery_recommendations_per_request.sql
-- Discovery telemetry (census-discovery DV-06, DV-40, §48): `10` §3's
-- `recommendations` — ONE row per served Discovery request, signed-in or
-- anonymous. The per-REQUEST exposure denominator, and the only durable record
-- an anonymous serve has.
--
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- ── WHAT ────────────────────────────────────────────────────────────────────
-- One new table, service-role only, append-only, and its one writer's door
-- `record_discovery_serve_request(jsonb)` (SECURITY INVOKER, service_role
-- EXECUTE only, ON CONFLICT (id) DO NOTHING). `10` §3 names the table and its
-- columns (id, user_id, session_id, surface, model_version, context_hash,
-- created_at); this adds only what makes a row a DENOMINATOR and keeps it
-- honest: served_count, the ordered item ids and kinds, the serve point, the
-- viewer class, and the schema version / privacy class / retention tier the
-- rank_events row carries (2890, 3375).
--
-- ── WHY A TABLE, AND WHY NOT A SECOND EVENT STORE ───────────────────────────
-- `04` §2/§6 forbid a competing BEHAVIOUR store; this stores no behaviour. Every
-- item-level exposure of a signed-in viewer stays in rank_events (one row per
-- item, 2891's recommendation_id), which is `10` §3's "prefer extending
-- rank_events" and why `recommendation_items` is NOT created: rank_events IS
-- that table for signed-in serves. What rank_events cannot hold is:
--   1. a REQUEST — "how many requests served how many items" (DV-06: exposures
--      carry denominators per request, not only per item). A serve of zero
--      items writes no rank_events row at all, so a request-level denominator
--      computed from rank_events silently omits every empty serve;
--   2. an ANONYMOUS serve. rank_events.user_id is NOT NULL REFERENCES
--      auth.users, and an exposure nobody can be credited with must not be
--      written against somebody. On production every GET /discovery is
--      anonymous today (the shipping client sends no Authorization header;
--      census-discovery §48), so without this table 100% of real Discovery
--      traffic leaves no record — which is exactly why six weeks of darkness
--      could not be diagnosed from the database.
--
-- ── PRIVACY (`04` §12) ──────────────────────────────────────────────────────
-- An anonymous row has user_id NULL and a session_id minted fresh per request
-- by the server (never a client-supplied value), so two anonymous rows share
-- nothing and cannot be linked. No coordinates, no IP, no user agent, no query
-- text: item ids of public places/posts, counts, a serve point and a hash of
-- the coarse request context (city, category, offset — never a position). A
-- signed-in row carries the user id and is erased with the account
-- (ON DELETE CASCADE from auth.users).
--
-- ── RETENTION ───────────────────────────────────────────────────────────────
-- Labelled `raw_recent` (`04` §11's first layer) and ENFORCED NOWHERE, exactly
-- as 2890's retention_tier: "exact retention must be decided with privacy/legal
-- review", and a migration that invented a horizon would pre-empt it.
--
-- ── `10` §4 — cardinality, indexes, EXPLAIN ─────────────────────────────────
-- Expected cardinality: one row per served Discovery request while
-- discovery_serve_log_enabled is TRUE (it is on production) — the request
-- rate of GET /discovery, /feed, /community, /search, /suggest, /hidden-gems
-- and /map/search. Rows are narrow (≤ ~25 short text ids).
-- Indexes, each for a named path:
--   * PRIMARY KEY (id) — the idempotency arbiter: the writer's retried insert
--     collides on it (23505) and writes nothing a second time (DV-37).
--   * recommendations_user_served_at (user_id, served_at DESC) WHERE user_id IS
--     NOT NULL — the FK's ON DELETE CASCADE from auth.users needs an index on
--     user_id or every account deletion scans the table; the partial predicate
--     keeps anonymous rows out of it.
--   * recommendations_served_at (served_at) — the per-window denominator
--     (`WHERE served_at >= $1 GROUP BY serve_point`) and any future retention
--     sweep, both range scans on time.
-- EXPLAIN (harness, 2026-09-27, empty table, enable_seqscan=off): the window
-- aggregate plans a Bitmap Index Scan on recommendations_served_at, and a
-- delete by user_id a Bitmap Index Scan on recommendations_user_served_at. On
-- an empty table the planner's choice says nothing about production; it is
-- recorded only to show each index is USABLE by its stated predicate.
--
-- Rollback: db/rollback/2026-09-27-3376-discovery-recommendations-per-request-rollback.sql
-- (drops the table and deletes this file's ledger row). REVERSIBLE FOR FREE
-- ONLY until the writer ships: once rows exist, dropping the table destroys
-- the only record of every anonymous serve.

BEGIN;

DO $$
DECLARE
  n int;
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3376): auth.users does not exist.';
  END IF;
  IF to_regclass('public.rank_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3376): public.rank_events does not exist; this table is its per-request companion.';
  END IF;
  IF to_regclass('public.recommendations') IS NOT NULL THEN
    -- Re-running over OUR table is a no-op; anybody else's is a collision.
    SELECT count(*) INTO n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'recommendations'
       AND column_name IN ('served_count', 'item_ids', 'viewer_class', 'serve_point');
    IF n <> 4 THEN
      RAISE EXCEPTION 'PRECONDITION FAILED (3376): a public.recommendations table exists that is not this one; resolve by hand.';
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.recommendations (
  id             text        PRIMARY KEY,
  user_id        uuid        NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  viewer_class   text        NOT NULL,
  session_id     uuid        NOT NULL,
  surface        text        NOT NULL,
  serve_point    smallint    NOT NULL,
  route          text        NULL,
  model_version  text        NOT NULL,
  context_hash   text        NULL,
  served_count   integer     NOT NULL,
  item_ids       text[]      NOT NULL DEFAULT '{}',
  item_kinds     text[]      NOT NULL DEFAULT '{}',
  served_at      timestamptz NOT NULL,
  schema_version smallint    NOT NULL DEFAULT 1,
  privacy_class  text        NOT NULL DEFAULT 'raw_behavioral_event',
  retention_tier text        NOT NULL DEFAULT 'raw_recent',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recommendations_id_shape_check
    CHECK (id ~ '^[A-Za-z0-9_-]{22}$'),
  CONSTRAINT recommendations_viewer_class_check
    CHECK (viewer_class IN ('signed_in', 'anonymous')),
  -- An anonymous row can never carry a user, and a signed-in row always does.
  CONSTRAINT recommendations_viewer_matches_user_check
    CHECK ((viewer_class = 'anonymous') = (user_id IS NULL)),
  CONSTRAINT recommendations_surface_check
    CHECK (surface = 'discovery'),
  -- lib/discoveryServeLog.ts DiscoveryServePoint: 1..12.
  CONSTRAINT recommendations_serve_point_check
    CHECK (serve_point BETWEEN 1 AND 12),
  CONSTRAINT recommendations_route_check
    CHECK (route IS NULL OR char_length(route) BETWEEN 1 AND 120),
  CONSTRAINT recommendations_model_version_check
    CHECK (char_length(model_version) BETWEEN 1 AND 120),
  CONSTRAINT recommendations_context_hash_check
    CHECK (context_hash IS NULL OR context_hash ~ '^[A-Za-z0-9_-]{22}$'),
  CONSTRAINT recommendations_served_count_check
    CHECK (served_count BETWEEN 0 AND 1000),
  -- The denominator and the item list cannot disagree.
  CONSTRAINT recommendations_items_match_count_check
    CHECK (cardinality(item_ids) = served_count AND cardinality(item_kinds) = served_count),
  -- rank_events.item_kind's vocabulary (0153), plus '' for "served, kind not
  -- applicable" (a city or hashtag search result). NULL elements are refused:
  -- <@ never matches a NULL element.
  CONSTRAINT recommendations_item_kinds_check
    CHECK (item_kinds <@ ARRAY['post', 'event', 'plan', 'buddy', 'place', 'gem', '']::text[]),
  CONSTRAINT recommendations_schema_version_check
    CHECK (schema_version IN (1)),
  CONSTRAINT recommendations_privacy_class_check
    CHECK (privacy_class IN ('raw_behavioral_event')),
  CONSTRAINT recommendations_retention_tier_check
    CHECK (retention_tier IN ('raw_recent', 'durable_aggregate', 'audit_security', 'anonymized_longterm'))
);

CREATE INDEX IF NOT EXISTS recommendations_user_served_at
  ON public.recommendations (user_id, served_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS recommendations_served_at
  ON public.recommendations (served_at);

-- Service role only. No client role reads or writes this table, and the API
-- writes it append-only: INSERT and SELECT, never UPDATE or DELETE. Account
-- deletion reaches signed-in rows through the FK cascade, which runs as the
-- table owner and needs no grant here.
ALTER TABLE public.recommendations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.recommendations FROM PUBLIC;
REVOKE ALL ON TABLE public.recommendations FROM anon, authenticated;
REVOKE ALL ON TABLE public.recommendations FROM service_role;
GRANT SELECT, INSERT ON TABLE public.recommendations TO service_role;
DROP POLICY IF EXISTS recommendations_service_role_read ON public.recommendations;
CREATE POLICY recommendations_service_role_read ON public.recommendations
  FOR SELECT TO service_role USING (true);
DROP POLICY IF EXISTS recommendations_service_role_insert ON public.recommendations;
CREATE POLICY recommendations_service_role_insert ON public.recommendations
  FOR INSERT TO service_role WITH CHECK (true);

-- The writer's door. SECURITY INVOKER: it runs with the caller's own INSERT
-- privilege, so it grants nothing a caller did not already hold, and only
-- service_role may EXECUTE it. It exists for ONE property the client cannot
-- express without an arbiter of its own: a replayed request row is resolved by
-- the database (`ON CONFLICT (id) DO NOTHING`) and answered 'duplicate' — no
-- 23505, no ERROR line in the Postgres log, no second row. Every CHECK on the
-- table still applies to what it inserts; it validates nothing itself, so it
-- cannot disagree with the table.
CREATE OR REPLACE FUNCTION public.record_discovery_serve_request(p_row jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  n integer;
BEGIN
  INSERT INTO public.recommendations (
    id, user_id, viewer_class, session_id, surface, serve_point, route,
    model_version, context_hash, served_count, item_ids, item_kinds, served_at,
    schema_version, privacy_class
  ) VALUES (
    p_row->>'id',
    NULLIF(p_row->>'user_id', '')::uuid,
    p_row->>'viewer_class',
    (p_row->>'session_id')::uuid,
    p_row->>'surface',
    (p_row->>'serve_point')::smallint,
    p_row->>'route',
    p_row->>'model_version',
    p_row->>'context_hash',
    (p_row->>'served_count')::integer,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_row->'item_ids', '[]'::jsonb))),
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_row->'item_kinds', '[]'::jsonb))),
    (p_row->>'served_at')::timestamptz,
    COALESCE((p_row->>'schema_version')::smallint, 1),
    COALESCE(p_row->>'privacy_class', 'raw_behavioral_event')
  )
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN CASE WHEN n = 1 THEN 'written' ELSE 'duplicate' END;
END
$fn$;

REVOKE ALL ON FUNCTION public.record_discovery_serve_request(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_discovery_serve_request(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_discovery_serve_request(jsonb) TO service_role;

COMMENT ON FUNCTION public.record_discovery_serve_request(jsonb) IS
  '3376 / census-discovery DV-06, DV-37. Idempotent per-request insert into '
  'public.recommendations: ON CONFLICT (id) DO NOTHING, answers written | '
  'duplicate. SECURITY INVOKER, service_role only.';

COMMENT ON TABLE public.recommendations IS
  '3376 / census-discovery DV-06, DV-40. `10` §3 recommendations: ONE row per '
  'served Discovery request, signed-in or anonymous. id = serveIdFor(exposure) '
  '(lib/discoveryRecommendationRecord.ts), the idempotency arbiter. Item-level '
  'signed-in exposures live in rank_events; an anonymous serve has no '
  'rank_events row and this is its only record (user_id NULL, per-request '
  'server-minted session). Written by lib/discoveryServeLog.ts behind '
  'discovery_serve_log_enabled. Append-only; retention labelled, not enforced.';
COMMENT ON COLUMN public.recommendations.served_count IS
  'The per-request exposure denominator: how many items this request served. '
  'Zero is a real value (an empty serve), never a placeholder.';

-- ── Behavioural postconditions, INSIDE the applying transaction ────────────
-- These write (probes that are always rolled back by their own exception
-- blocks), so they run before COMMIT: the applier admits only read-only
-- assertions after the COMMIT, and a probe is not one.
DO $probe$
DECLARE
  n      int;
  probe  text := 'AAAAAAAAAAAAAAAAAAAAA0';
BEGIN
  -- An anonymous row is admitted (then rolled back) ...
  BEGIN
    INSERT INTO public.recommendations (id, user_id, viewer_class, session_id, surface, serve_point, model_version, served_count, item_ids, item_kinds, served_at)
    VALUES (probe, NULL, 'anonymous', gen_random_uuid(), 'discovery', 1, 'probe', 1, ARRAY['node/1'], ARRAY['place'], now());
    RAISE EXCEPTION USING ERRCODE = 'P3376', MESSAGE = 'probe admitted';
  EXCEPTION
    WHEN SQLSTATE 'P3376' THEN NULL;  -- admitted; the block's rollback removed it
  END;
  -- ... and an anonymous row claiming a user is refused by the pairing CHECK.
  BEGIN
    INSERT INTO public.recommendations (id, user_id, viewer_class, session_id, surface, serve_point, model_version, served_count, served_at)
    VALUES (probe, gen_random_uuid(), 'anonymous', gen_random_uuid(), 'discovery', 1, 'probe', 0, now());
    RAISE EXCEPTION 'POSTCONDITION FAILED (3376): an anonymous row carrying a user id was accepted.';
  EXCEPTION
    WHEN check_violation THEN
      IF SQLERRM NOT LIKE '%recommendations_viewer_matches_user_check%' THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3376): the pairing probe was refused by another check: %', SQLERRM;
      END IF;
    WHEN foreign_key_violation THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3376): an anonymous row carrying a user id passed every CHECK.';
  END;
  -- The door: a replay of the same id answers 'duplicate' and leaves one row.
  BEGIN
    IF public.record_discovery_serve_request(jsonb_build_object(
         'id', probe, 'viewer_class', 'anonymous', 'session_id', gen_random_uuid(), 'surface', 'discovery',
         'serve_point', 10, 'model_version', 'probe', 'served_count', 0, 'served_at', now())) <> 'written'
    THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3376): the first probe call did not answer written.';
    END IF;
    IF public.record_discovery_serve_request(jsonb_build_object(
         'id', probe, 'viewer_class', 'anonymous', 'session_id', gen_random_uuid(), 'surface', 'discovery',
         'serve_point', 10, 'model_version', 'probe', 'served_count', 0, 'served_at', now())) <> 'duplicate'
    THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3376): a replayed probe did not answer duplicate.';
    END IF;
    SELECT count(*) INTO n FROM public.recommendations WHERE id = probe;
    IF n <> 1 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3376): a replay left % rows for one id.', n;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P3376', MESSAGE = 'door probe done';
  EXCEPTION
    WHEN SQLSTATE 'P3376' THEN NULL;  -- rolled back with the block
  END;
END $probe$;

COMMIT;

-- ── Postconditions (separate: they assert what persisted) ──────────────────
DO $post$
DECLARE
  n      int;
  leak   text;
BEGIN
  IF to_regclass('public.recommendations') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3376): public.recommendations was not created.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.recommendations'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3376): RLS is not enabled on public.recommendations.';
  END IF;

  -- No client role holds any privilege, directly or through PUBLIC.
  SELECT string_agg(r || ':' || p, ', ') INTO leak
    FROM unnest(ARRAY['anon', 'authenticated']) r,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
   WHERE has_table_privilege(r, 'public.recommendations', p);
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3376): a client role holds a privilege on recommendations: %.', leak;
  END IF;
  -- The writer can write and read; it cannot rewrite or remove history.
  IF NOT (has_table_privilege('service_role', 'public.recommendations', 'INSERT')
          AND has_table_privilege('service_role', 'public.recommendations', 'SELECT')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3376): service_role cannot INSERT and SELECT recommendations.';
  END IF;
  IF has_table_privilege('service_role', 'public.recommendations', 'UPDATE')
     OR has_table_privilege('service_role', 'public.recommendations', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3376): service_role holds a rewrite privilege on recommendations; the table is append-only.';
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.recommendations'::regclass AND contype = 'c' AND convalidated;
  IF n <> 14 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3376): expected 14 validated CHECKs on recommendations, found %.', n;
  END IF;

  -- The door: service_role alone may call it, and it is INVOKER.
  IF has_function_privilege('anon', 'public.record_discovery_serve_request(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.record_discovery_serve_request(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3376): a client role may EXECUTE record_discovery_serve_request.';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.record_discovery_serve_request(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3376): service_role may not EXECUTE record_discovery_serve_request.';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.record_discovery_serve_request(jsonb)'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3376): record_discovery_serve_request must be SECURITY INVOKER.';
  END IF;

  SELECT count(*) INTO n FROM public.recommendations WHERE id = 'AAAAAAAAAAAAAAAAAAAAA0';
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3376): the probe row persisted.';
  END IF;
END $post$;
