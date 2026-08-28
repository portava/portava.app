-- 2185_memory_retrieval_retention.sql
--
-- Memory + Experience Intelligence Architecture — RETRIEVAL, NEW-TO-ME, RETENTION.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHAT THIS IS
-- ------------
-- 2183 = contract, 2184 = projector. This is the read + governance side:
--   * memory_retrieve      — surface-specific retrieval (§10). Passport does not
--                            rank like Discovery; Discovery suppresses what the
--                            user already knows.
--   * memory_is_new_to_user — the New-to-Me primitive (§7): personalized novelty,
--                            honouring the already_known / not_interested feedback
--                            the contract added.
--   * memory_sweep_expired — retention (§18): expiring memories past valid_to
--                            decay; ephemeral/short-lived ones are removed. Intent
--                            memory (§9) decays aggressively via this sweep.
--
-- All three are service_role-only (caller-supplied identity), flag-gated by
-- memory_projection where they write, search_path pinned — the 2182/2184 rules.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_projections') IS NULL OR to_regclass('public.memory_feedback') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: memory contract (2183) missing.';
  END IF;
END $$;

-- ── memory_retrieve(user, surface, limit) → ranked memories (§10) ─────────────
-- Surface-specific: 'discovery' biases to novelty and hides already_known /
-- not_interested subjects; 'passport' is a chronological timeline of durable
-- memory; 'compass' (default) ranks by confidence then recency. Hidden/forgotten
-- memory is never returned; feedback filters are hard filters, not weights (§10).
CREATE OR REPLACE FUNCTION public.memory_retrieve(
  p_user_id uuid,
  p_surface text DEFAULT 'compass',
  p_limit   integer DEFAULT 20
)
RETURNS TABLE (
  memory_type   text,
  subject_type  text,
  subject_id    text,
  content       text,
  confidence    real,
  last_supported_at timestamptz,
  valid_from    timestamptz
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  RETURN QUERY
  SELECT mp.memory_type, mp.subject_type, mp.subject_id, mp.content,
         mp.confidence, mp.last_supported_at, mp.valid_from
  FROM public.memory_projections mp
  WHERE mp.user_id = p_user_id
    AND mp.state = 'active'
    AND (mp.valid_to IS NULL OR mp.valid_to > now())
    -- hard filters from user feedback (§10): forget/hide always suppress;
    -- discovery additionally suppresses already_known / not_interested (§7).
    AND NOT EXISTS (
      SELECT 1 FROM public.memory_feedback f
      WHERE f.user_id = p_user_id
        AND f.projection_id = mp.id
        AND ( f.kind IN ('hide','forget')
              OR (p_surface = 'discovery' AND f.kind IN ('already_known','not_interested')) )
    )
  ORDER BY
    CASE WHEN p_surface = 'passport'  THEN mp.valid_from        END DESC NULLS LAST,
    CASE WHEN p_surface = 'discovery' THEN mp.last_supported_at END DESC NULLS LAST,
    mp.confidence DESC, mp.last_supported_at DESC
  LIMIT greatest(0, coalesce(p_limit, 20));
END
$fn$;

-- ── memory_is_new_to_user(user, subject) → boolean (§7 New-to-Me) ─────────────
--
-- *** STATUS: BUILT, DELIBERATELY NOT WIRED (deferred 2026-08-28). ***
-- This function has ZERO callers, and that is a recorded decision, not an
-- oversight. Do not treat §7 New-to-Me as a delivered feature.
--
-- WHY IT IS NOT WIRED: its intended consumer is the Discovery serve path (§13),
-- but Discovery serves candidates in a DIFFERENT ID SPACE from the one place
-- memory is keyed in. Place memory keys on discovery_places.id (a uuid, via
-- saved_places); the Discovery serve path emits prefixed ids ("db/..." for
-- database places, plus OSM-sourced ids). Calling this function with a Discovery
-- candidate id would therefore match nothing and report EVERY place as "new to
-- me" — a silent, confident wrong answer on a user-facing surface, which is
-- worse than the feature being absent.
--
-- WHAT WIRING IT REQUIRES (the actual next slice, not a code change here):
--   1. an id bridge between the Discovery serve id space and discovery_places.id
--      (the same demand-side bridge IG-08 needed: saved_places -> discovery_places
--      -> places), and
--   2. a decision about where novelty applies — Discovery serve, Compass "show me
--      something new", or both.
-- Until (1) exists, this stays unwired on purpose.
-- Personalized novelty: a subject is "new to me" when the user has no ACTIVE
-- memory of it AND has not marked it already_known / not_interested. A briefly
-- seen impression does not count — only a projected memory or explicit feedback
-- marks something as known (§7 "distinguish impression from meaningful awareness").
CREATE OR REPLACE FUNCTION public.memory_is_new_to_user(
  p_user_id     uuid,
  p_subject_type text,
  p_subject_id   text
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT NOT (
    EXISTS (
      SELECT 1 FROM public.memory_projections mp
      WHERE mp.user_id = p_user_id
        AND mp.subject_type = p_subject_type
        AND mp.subject_id = p_subject_id
        AND mp.state = 'active'
    )
    OR EXISTS (
      SELECT 1 FROM public.memory_feedback f
      WHERE f.user_id = p_user_id
        AND f.subject_type = p_subject_type
        AND f.subject_id = p_subject_id
        AND f.kind IN ('already_known','not_interested')
    )
  );
$fn$;

-- ── memory_sweep_expired() → rows swept (§18 retention) ───────────────────────
-- Expiring memory past valid_to: durable-ish classes DECAY (kept, marked), while
-- ephemeral / short-lived / intent memory is REMOVED (it was never meant to
-- persist — §9 intent decays aggressively). Flag-gated; returns rows affected.
CREATE OR REPLACE FUNCTION public.memory_sweep_expired(
  p_enforce_flag boolean DEFAULT true
)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_enabled boolean;
  v_decayed integer := 0;
  v_removed integer := 0;
BEGIN
  IF p_enforce_flag THEN
    SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag = 'memory_projection';
    IF v_enabled IS DISTINCT FROM true THEN RETURN 0; END IF;
  END IF;

  -- Ephemeral / short-lived / intent past valid_to: delete outright.
  WITH gone AS (
    DELETE FROM public.memory_projections
    WHERE valid_to IS NOT NULL AND valid_to <= now()
      AND retention_class IN ('ephemeral','short_lived')
    RETURNING 1
  )
  SELECT count(*) INTO v_removed FROM gone;

  -- Everything else past valid_to: decay (keep the row, stop surfacing it).
  WITH decayed AS (
    UPDATE public.memory_projections
    SET state = 'decayed'
    WHERE valid_to IS NOT NULL AND valid_to <= now()
      AND state = 'active'
      AND retention_class NOT IN ('ephemeral','short_lived')
    RETURNING 1
  )
  SELECT count(*) INTO v_decayed FROM decayed;

  RETURN v_removed + v_decayed;
END
$fn$;

-- ── Least-privilege — service_role only (2182/2184 rule) ─────────────────────
REVOKE ALL ON FUNCTION public.memory_retrieve(uuid, text, integer)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.memory_is_new_to_user(uuid, text, text)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.memory_sweep_expired(boolean)             FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_retrieve(uuid, text, integer)    TO service_role;
GRANT EXECUTE ON FUNCTION public.memory_is_new_to_user(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.memory_sweep_expired(boolean)           TO service_role;

COMMENT ON FUNCTION public.memory_retrieve(uuid, text, integer) IS
  'Memory retrieval (spec §10): surface-specific ranked memories for a user. discovery hides already_known/not_interested; passport is a timeline; compass ranks by confidence. service_role only.';
COMMENT ON FUNCTION public.memory_is_new_to_user(uuid, text, text) IS
  'New-to-Me primitive (spec §7): true when the user has no active memory of the subject and has not marked it already_known/not_interested. service_role only.';
COMMENT ON FUNCTION public.memory_sweep_expired(boolean) IS
  'Retention sweep (spec §18): ephemeral/short-lived memory past valid_to is deleted; other expired memory decays. Flag-gated. service_role only.';

DO $$
BEGIN
  IF to_regprocedure('public.memory_retrieve(uuid, text, integer)') IS NULL
     OR to_regprocedure('public.memory_is_new_to_user(uuid, text, text)') IS NULL
     OR to_regprocedure('public.memory_sweep_expired(boolean)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: retrieval/retention functions not all created';
  END IF;
  IF has_function_privilege('anon','public.memory_retrieve(uuid, text, integer)','EXECUTE')
     OR has_function_privilege('authenticated','public.memory_sweep_expired(boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory read/sweep fns reachable by anon/authenticated';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP FUNCTION IF EXISTS public.memory_sweep_expired(boolean);
--   DROP FUNCTION IF EXISTS public.memory_is_new_to_user(uuid, text, text);
--   DROP FUNCTION IF EXISTS public.memory_retrieve(uuid, text, integer);
