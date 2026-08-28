-- 2189_memory_intent.sql
--
-- Memory + Experience Intelligence Architecture — INTENT memory (§5.5, §9).
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHAT THIS CLOSES
-- ----------------
-- 2183 allowed memory_type='intent' and the 'ephemeral' retention class, and
-- 2185's sweep deletes expired ephemeral memory — but nothing ever WROTE intent
-- memory, so layer L5 (Intent State) had a shape and no producer. This adds it.
--
-- THE SPEC'S TWO HARD RULES, BOTH ENFORCED HERE
-- ---------------------------------------------
-- §9: "Intent should decay aggressively and should not silently become a
--      permanent preference."
-- §24 (non-goal): "Do not turn every short-term intent into a durable
--      personality trait."
-- So record_intent_memory ALWAYS writes retention_class='ephemeral' and ALWAYS
-- sets a bounded valid_to — both are hard-coded, not caller-supplied, so no
-- caller can accidentally mint a durable preference through this path. The TTL
-- is clamped to [5, 720] minutes: a caller cannot pass 0 (never expires by
-- accident) nor a year. memory_retrieve already excludes valid_to <= now(), so
-- intent stops surfacing the moment it lapses even before the sweep deletes it.
--
-- Intent is also kept SEPARATE from durable memory by construction: it is its
-- own memory_type, so §10 retrieval and the Compass block can weight it
-- differently, and the retention sweep removes it outright rather than decaying
-- it into the durable set.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_projections') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2183 first.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.record_intent_memory(
  p_user_id      uuid,
  p_intent_type  text,
  p_content      text,
  p_ttl_minutes  integer DEFAULT 90,
  p_confidence   real    DEFAULT 0.6,
  p_enforce_flag boolean DEFAULT true
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_enabled boolean;
  v_ttl     integer;
BEGIN
  IF p_enforce_flag THEN
    SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag = 'memory_projection';
    IF v_enabled IS DISTINCT FROM true THEN RETURN false; END IF;
  END IF;

  IF p_user_id IS NULL OR coalesce(btrim(p_intent_type), '') = '' THEN
    RETURN false;
  END IF;

  -- Aggressive decay is not negotiable by the caller (§9, §24).
  v_ttl := least(720, greatest(5, coalesce(p_ttl_minutes, 90)));

  INSERT INTO public.memory_projections
    (user_id, memory_type, subject_type, subject_id, content, confidence,
     provenance, retention_class, valid_from, valid_to, last_supported_at)
  VALUES
    (p_user_id, 'intent', 'intent', btrim(p_intent_type),
     coalesce(nullif(btrim(p_content), ''), btrim(p_intent_type)),
     least(1.0, greatest(0.0, coalesce(p_confidence, 0.6)))::real,
     jsonb_build_object('derivation', 'request_signals', 'ttl_minutes', v_ttl),
     'ephemeral',                                   -- ALWAYS ephemeral
     now(),
     now() + make_interval(mins => v_ttl),          -- ALWAYS bounded
     now())
  ON CONFLICT (user_id, memory_type, subject_type, subject_id)
  DO UPDATE SET
    content           = EXCLUDED.content,
    confidence        = EXCLUDED.confidence,
    provenance        = EXCLUDED.provenance,
    -- a repeat signal REFRESHES the window; it never accumulates into permanence
    valid_from        = EXCLUDED.valid_from,
    valid_to          = EXCLUDED.valid_to,
    last_supported_at = EXCLUDED.last_supported_at,
    retention_class   = 'ephemeral',
    state             = 'active';

  RETURN true;
END
$fn$;

-- Least-privilege — caller-supplied identity + writes ⇒ service_role only
-- (Supabase default privileges grant EXECUTE to anon AND authenticated
-- explicitly, so REVOKE FROM PUBLIC alone is insufficient — the 2182 lesson).
REVOKE ALL ON FUNCTION public.record_intent_memory(uuid, text, text, integer, real, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_intent_memory(uuid, text, text, integer, real, boolean)
  TO service_role;

COMMENT ON FUNCTION public.record_intent_memory(uuid, text, text, integer, real, boolean) IS
  'Intent memory producer (spec §5.5/§9): records short-lived intent derived from request signals. ALWAYS ephemeral with a bounded TTL (clamped 5-720 min) so intent can never silently become a durable preference (§24). Flag-gated; service_role only.';

DO $$
BEGIN
  IF to_regprocedure('public.record_intent_memory(uuid, text, text, integer, real, boolean)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: record_intent_memory not created';
  END IF;
  IF has_function_privilege('anon', 'public.record_intent_memory(uuid, text, text, integer, real, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.record_intent_memory(uuid, text, text, integer, real, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: record_intent_memory reachable by anon/authenticated';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP FUNCTION IF EXISTS public.record_intent_memory(uuid, text, text, integer, real, boolean);
