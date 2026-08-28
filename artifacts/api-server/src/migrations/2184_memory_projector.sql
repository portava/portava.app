-- 2184_memory_projector.sql
--
-- Memory + Experience Intelligence Architecture — the deterministic PROJECTOR.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHAT THIS IS
-- ------------
-- 2183 added the contract (memory_events / memory_projections / memory_feedback).
-- This adds the first PROJECTOR: a deterministic, idempotent SQL function that
-- reads the already-populated Experience Graph (compass_graph_edges — the spec's
-- experience_edge, §15) and projects a user's person→city VISITED / RETURNED_TO
-- edges into episodic memory. This is exactly spec §21 Phase A/B: "begin with
-- deterministic projections over existing PostgreSQL/Supabase data… the logical
-- Experience Graph can initially be relational." No new source of truth (§24) —
-- it reads the graph and writes the memory contract.
--
-- WHY SQL, NOT A SERVICE
-- ---------------------
-- The projection is a pure, replayable transform over existing rows. Expressing
-- it as a function makes it deterministic and CI-provable against real data, and
-- a thin scheduler need only call it on a cadence. Idempotent by construction:
-- memory_events de-dupe on their unique index, memory_projections upsert on
-- (user_id, memory_type, subject_type, subject_id). Re-running changes nothing
-- but confidence/last_supported_at as evidence accrues (§22 step 4).
--
-- GATED + LEAST-PRIVILEGE
-- ----------------------
-- project_all_memory / project_user_memory honour the `memory_projection` flag
-- (2183): off ⇒ the function is an inert no-op returning 0. p_enforce_flag=false
-- exists only for tests/backfill. EXECUTE is REVOKED from PUBLIC/anon/authenticated
-- and granted to service_role ONLY — these take a caller-supplied user_id and
-- WRITE, so exposing them to anon/authenticated would be the 2182 anti-pattern
-- (a caller-supplied-identity write vector). search_path is pinned.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_projections') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: memory_projections missing — apply 2183 first.';
  END IF;
  IF to_regclass('public.compass_graph_edges') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: compass_graph_edges missing — the Experience Graph (spec experience_edge) is the projector input.';
  END IF;
END $$;

-- ── project_user_memory(user, enforce_flag) → rows projected ─────────────────
CREATE OR REPLACE FUNCTION public.project_user_memory(
  p_user_id      uuid,
  p_enforce_flag boolean DEFAULT true
)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_enabled boolean;
  v_uid_text text := p_user_id::text;
  v_projected integer := 0;
BEGIN
  IF p_enforce_flag THEN
    SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag = 'memory_projection';
    IF v_enabled IS DISTINCT FROM true THEN
      RETURN 0;  -- inert until the flag is turned on
    END IF;
  END IF;

  -- Aggregate this user's person→city VISITED / RETURNED_TO edges into one
  -- episodic memory per city. observed_count and a returned-again signal raise
  -- confidence deterministically; the most-recent last_seen dates the memory.
  WITH city_evidence AS (
    SELECT
      e.dst_key                                            AS city,
      sum(coalesce(e.observed_count, 1))                   AS obs,
      bool_or(e.edge_type = 'returned_to')                 AS returned,
      max(e.last_seen)                                     AS occurred_at,
      min(e.first_seen)                                    AS first_seen
    FROM public.compass_graph_edges e
    WHERE e.src_type = 'person'
      AND e.src_key  = v_uid_text
      AND e.dst_type = 'city'
      AND e.edge_type IN ('visited', 'returned_to')
      AND e.dst_key IS NOT NULL
    GROUP BY e.dst_key
  ),
  scored AS (
    SELECT
      city,
      returned,
      coalesce(occurred_at, first_seen, now())             AS occurred_at,
      least(0.95, 0.60 + 0.08 * obs + CASE WHEN returned THEN 0.05 ELSE 0 END)::real AS confidence
    FROM city_evidence
  ),
  ins_events AS (
    INSERT INTO public.memory_events
      (user_id, event_type, occurred_at, subject_type, subject_id, source, visibility, source_ref, metadata)
    SELECT
      p_user_id, 'visited', s.occurred_at, 'city', s.city, 'inferred', 'private',
      jsonb_build_object('table', 'compass_graph_edges', 'edge_type', 'visited'),
      jsonb_build_object('returned', s.returned)
    FROM scored s
    ON CONFLICT (user_id, event_type, subject_type, subject_id, occurred_at) DO NOTHING
    RETURNING 1
  ),
  ins_proj AS (
    INSERT INTO public.memory_projections
      (user_id, memory_type, subject_type, subject_id, content, confidence, provenance,
       retention_class, last_supported_at, valid_from)
    SELECT
      p_user_id, 'episodic', 'city', s.city,
      'Visited ' || s.city || CASE WHEN s.returned THEN ' (returned)' ELSE '' END,
      s.confidence,
      jsonb_build_object('derivation', 'compass_graph_edges:visited', 'returned', s.returned),
      'durable_fact', s.occurred_at, s.occurred_at
    FROM scored s
    ON CONFLICT (user_id, memory_type, subject_type, subject_id)
    DO UPDATE SET
      confidence        = EXCLUDED.confidence,
      content           = EXCLUDED.content,
      provenance        = EXCLUDED.provenance,
      last_supported_at = GREATEST(public.memory_projections.last_supported_at, EXCLUDED.last_supported_at),
      -- re-supporting a hidden/decayed memory does not silently un-hide it (§17)
      state             = CASE WHEN public.memory_projections.state = 'active'
                               THEN public.memory_projections.state ELSE public.memory_projections.state END
    RETURNING 1
  )
  SELECT count(*)::int INTO v_projected FROM ins_proj;

  RETURN v_projected;
END
$fn$;

-- ── project_all_memory(enforce_flag) → total rows projected ──────────────────
-- Loops the distinct persons that have any person→city visited/returned edge.
CREATE OR REPLACE FUNCTION public.project_all_memory(
  p_enforce_flag boolean DEFAULT true
)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_enabled boolean;
  v_total   integer := 0;
  r         record;
BEGIN
  IF p_enforce_flag THEN
    SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag = 'memory_projection';
    IF v_enabled IS DISTINCT FROM true THEN
      RETURN 0;
    END IF;
  END IF;

  FOR r IN
    SELECT DISTINCT src_key
    FROM public.compass_graph_edges
    WHERE src_type = 'person' AND dst_type = 'city'
      AND edge_type IN ('visited', 'returned_to')
      AND src_key ~ '^[0-9a-fA-F-]{36}$'   -- only well-formed uuid persons
  LOOP
    v_total := v_total + public.project_user_memory(r.src_key::uuid, false);
  END LOOP;

  RETURN v_total;
END
$fn$;

-- ── Least-privilege: caller-supplied-identity WRITE fns — service_role only ──
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on new public functions to
-- anon AND authenticated EXPLICITLY, not only via PUBLIC — so REVOKE FROM PUBLIC
-- alone leaves them reachable (verified on CI 2026-08-28). Revoke all three.
REVOKE ALL ON FUNCTION public.project_user_memory(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_all_memory(boolean)        FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_user_memory(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_all_memory(boolean)        TO service_role;

COMMENT ON FUNCTION public.project_user_memory(uuid, boolean) IS
  'Memory projector (spec §21): projects a user''s person→city visited/returned_to Experience-Graph edges into episodic memory_projections. Idempotent; gated by memory_projection flag (p_enforce_flag=false only for tests/backfill). service_role only.';
COMMENT ON FUNCTION public.project_all_memory(boolean) IS
  'Runs project_user_memory for every person with city-visit edges. Called by the memory projection scheduler. Gated by memory_projection flag. service_role only.';

DO $$
BEGIN
  IF to_regprocedure('public.project_user_memory(uuid, boolean)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: project_user_memory not created';
  END IF;
  IF to_regprocedure('public.project_all_memory(boolean)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: project_all_memory not created';
  END IF;
  -- must NOT be executable by anon/authenticated (2182 lesson)
  IF has_function_privilege('anon', 'public.project_user_memory(uuid, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.project_user_memory(uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: projector is executable by anon/authenticated — caller-supplied-identity write vector';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP FUNCTION IF EXISTS public.project_all_memory(boolean);
--   DROP FUNCTION IF EXISTS public.project_user_memory(uuid, boolean);
