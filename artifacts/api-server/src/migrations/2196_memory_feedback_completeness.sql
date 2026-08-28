-- 2196_memory_feedback_completeness.sql
--
-- Memory — every feedback kind now does something, and the state vocabulary is live.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- TWO DEFECTS, BOTH OF THE SAME FAMILY: a control that reports success and then
-- has no effect.
--
--  A. `incorrect` WAS A SILENT NO-OP. memory_feedback accepts five kinds and the
--     route returns 201 for all of them, but retrieval only ever suppressed on
--     hide / forget / already_known / not_interested. A user who reported "this
--     memory is wrong" got a success response and the memory kept being served —
--     and kept being injected into the Compass prompt. That is the SAME failure
--     shape as the original hide/forget blocker (2190): the API says yes, the
--     read path never asks. Serving a memory the user has told us is wrong is
--     worse than not serving it, so `incorrect` now suppresses.
--
--  B. THE STATE VOCABULARY WAS DEAD. memory_projections.state permits 'hidden'
--     and 'forgotten', and NOTHING ever wrote them — they existed only in the
--     CHECK constraint. Suppression worked entirely through the feedback join, so
--     behaviour was correct, but anyone reading the schema would reasonably
--     believe a suppressed memory is marked as such, and it was not. Dead
--     vocabulary in a privacy-relevant schema is a trap for the next reader.
--     A trigger now records the user's decision ON the projection.
--
-- WHY BOTH MECHANISMS, RATHER THAN PICKING ONE
-- The feedback join stays the authority, because it is DURABLE: it survives a
-- re-projection that deletes and recreates the row (2190), which a column on the
-- row cannot. The state column is a denormalised record of the user's decision —
-- useful for export, admin and anyone reading the table directly. Belt and
-- braces, with the durable mechanism deliberately the one that governs.
--
-- 'disputed' is added as a distinct state rather than reusing 'forgotten'.
-- "I never want to see this" and "this is factually wrong" are different user
-- statements, and flattening them would lose the signal that the DERIVATION is
-- faulty — which is the actionable part for whoever tunes the projector.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_feedback') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2183 first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='memory_projections' AND column_name='visibility') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2192 first.';
  END IF;
END $$;

-- ── B1. Widen the state vocabulary with a distinct 'disputed' ────────────────
ALTER TABLE public.memory_projections DROP CONSTRAINT IF EXISTS memory_projections_state_check;
ALTER TABLE public.memory_projections
  ADD CONSTRAINT memory_projections_state_check
  CHECK (state IN ('active','decayed','hidden','forgotten','retracted','disputed'));

COMMENT ON COLUMN public.memory_projections.state IS
  'active = served. decayed = expired by TTL (§18). retracted = lost its supporting evidence (2190). hidden = the user hid it. forgotten = the user asked us to forget it. disputed = the user says it is factually WRONG — distinct from forgotten because it also says the derivation is faulty. Suppression is governed by memory_feedback, which survives re-projection; this column records the decision on the row for export and for anyone reading the table.';

-- ── B2. Feedback records the user's decision on the projection ───────────────
CREATE OR REPLACE FUNCTION public.memory_feedback_apply_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE v_state text;
BEGIN
  v_state := CASE NEW.kind
    WHEN 'hide'      THEN 'hidden'
    WHEN 'forget'    THEN 'forgotten'
    WHEN 'incorrect' THEN 'disputed'
    ELSE NULL   -- already_known / not_interested are DISCOVERY-scoped opinions,
                -- not statements that the memory itself is unwanted or wrong, so
                -- they must not change the row's state.
  END;
  IF v_state IS NULL THEN RETURN NEW; END IF;

  -- Match the projection the same way retrieval does: by id, or by the durable
  -- subject key when the row has been replaced by a re-projection.
  UPDATE public.memory_projections mp
  SET state = v_state
  WHERE mp.user_id = NEW.user_id
    AND ( mp.id = NEW.projection_id
          OR ( NEW.projection_id IS NULL
               AND mp.subject_type IS NOT DISTINCT FROM NEW.subject_type
               AND mp.subject_id  IS NOT DISTINCT FROM NEW.subject_id
               AND (NEW.memory_type IS NULL OR mp.memory_type = NEW.memory_type) ) )
    AND mp.state = 'active';   -- never overwrite decayed/retracted bookkeeping

  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_memory_feedback_apply_state ON public.memory_feedback;
CREATE TRIGGER trg_memory_feedback_apply_state
  AFTER INSERT ON public.memory_feedback
  FOR EACH ROW EXECUTE FUNCTION public.memory_feedback_apply_state();

-- ── A. `incorrect` suppresses, in both read paths ────────────────────────────
DROP FUNCTION IF EXISTS public.memory_retrieve(uuid, text, integer);
CREATE FUNCTION public.memory_retrieve(
  p_user_id uuid, p_surface text DEFAULT 'compass', p_limit integer DEFAULT 20
)
RETURNS TABLE (
  id uuid, memory_type text, subject_type text, subject_id text, content text,
  confidence real, last_supported_at timestamptz, valid_from timestamptz
)
LANGUAGE plpgsql STABLE SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  RETURN QUERY
  SELECT mp.id, mp.memory_type, mp.subject_type, mp.subject_id, mp.content,
         mp.confidence, mp.last_supported_at, mp.valid_from
  FROM public.memory_projections mp
  LEFT JOIN public.memory_policy pol ON pol.retention_class = mp.retention_class
  WHERE mp.user_id = p_user_id
    AND mp.state = 'active'
    AND (mp.valid_to IS NULL OR mp.valid_to > now())
    AND (pol.allowed_surfaces IS NULL OR p_surface = ANY (pol.allowed_surfaces))
    AND NOT (mp.sensitivity = 'sensitive' AND p_surface = 'discovery')
    AND NOT EXISTS (
      SELECT 1 FROM public.memory_feedback f
      WHERE f.user_id = p_user_id
        AND ( f.projection_id = mp.id
              OR (f.subject_type IS NOT DISTINCT FROM mp.subject_type
                  AND f.subject_id IS NOT DISTINCT FROM mp.subject_id
                  AND (f.memory_type IS NULL OR f.memory_type = mp.memory_type)) )
        -- 'incorrect' joins hide/forget: a memory the user says is WRONG must not
        -- be served on any surface, and must not reach the Compass prompt.
        AND ( f.kind IN ('hide','forget','incorrect')
              OR (p_surface = 'discovery' AND f.kind IN ('already_known','not_interested')) )
    )
  ORDER BY
    CASE WHEN p_surface = 'passport'  THEN mp.valid_from        END DESC NULLS LAST,
    CASE WHEN p_surface = 'discovery' THEN mp.last_supported_at END DESC NULLS LAST,
    mp.confidence DESC, mp.last_supported_at DESC
  LIMIT greatest(0, coalesce(p_limit, 20));
END
$fn$;

DROP FUNCTION IF EXISTS public.memory_rediscover(uuid, text, integer);
CREATE FUNCTION public.memory_rediscover(
  p_user_id uuid, p_city text, p_limit integer DEFAULT 20
)
RETURNS TABLE (
  id uuid, memory_type text, subject_type text, subject_id text,
  content text, confidence real, reason text
)
LANGUAGE plpgsql STABLE SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT mp.*,
      CASE WHEN mp.memory_type='episodic' AND mp.subject_type='city' AND lower(mp.subject_id)=lower(p_city) THEN 'been_here_before'
           WHEN mp.memory_type='place' THEN 'you_saved'
           WHEN mp.memory_type='social' THEN 'you_know' ELSE 'relevant' END AS reason,
      CASE WHEN mp.memory_type='episodic' AND mp.subject_type='city' AND lower(mp.subject_id)=lower(p_city) THEN 0 ELSE 1 END AS rank_bucket
    FROM public.memory_projections mp
    WHERE mp.user_id=p_user_id AND mp.state='active'
      AND (mp.valid_to IS NULL OR mp.valid_to > now())
      AND ((mp.memory_type='episodic' AND mp.subject_type='city' AND lower(mp.subject_id)=lower(p_city))
           OR mp.memory_type IN ('place','social'))
      AND NOT EXISTS (
        SELECT 1 FROM public.memory_feedback f
        WHERE f.user_id=p_user_id
          AND ( f.projection_id = mp.id
                OR (f.subject_type IS NOT DISTINCT FROM mp.subject_type
                    AND f.subject_id IS NOT DISTINCT FROM mp.subject_id
                    AND (f.memory_type IS NULL OR f.memory_type = mp.memory_type)) )
          AND f.kind IN ('hide','forget','incorrect','already_known','not_interested'))
  )
  SELECT c.id, c.memory_type, c.subject_type, c.subject_id, c.content, c.confidence, c.reason
  FROM candidate c ORDER BY c.rank_bucket, c.confidence DESC, c.last_supported_at DESC
  LIMIT greatest(0, coalesce(p_limit, 20));
END
$fn$;

-- The 2190 lesson: a DROP/CREATEd function is a NEW object and picks up
-- Supabase's default EXECUTE grants to anon AND authenticated. Re-revoke.
REVOKE ALL ON FUNCTION public.memory_retrieve(uuid, text, integer)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.memory_rediscover(uuid, text, integer)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.memory_feedback_apply_state()             FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_retrieve(uuid, text, integer)   TO service_role;
GRANT EXECUTE ON FUNCTION public.memory_rediscover(uuid, text, integer) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_memory_feedback_apply_state' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: feedback state trigger missing';
  END IF;
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='memory_retrieve') NOT LIKE '%incorrect%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_retrieve does not suppress on incorrect';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'memory\_%'
      AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE'))) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a memory function is anon/authenticated executable';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP TRIGGER IF EXISTS trg_memory_feedback_apply_state ON public.memory_feedback;
--   DROP FUNCTION IF EXISTS public.memory_feedback_apply_state();
--   (and re-apply 2192's memory_retrieve / 2190's memory_rediscover bodies)
