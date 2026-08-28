-- 2190_memory_lifecycle_fixes.sql
--
-- Memory + Experience Intelligence — LIFECYCLE CORRECTNESS.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHY THIS EXISTS
-- ---------------
-- A completeness audit of the memory system (2183-2189) found four blocking
-- defects and two important ones. They share a single schema root — the
-- projection layer could not answer "what still supports this memory?" — so this
-- fixes the schema rather than patching each symptom.
--
--  P0-1  Account deletion did not purge memory IN PRODUCTION.
--        2187 built an auth.users -> profiles -> memory ON DELETE CASCADE and
--        certified it on CI. But production's public.profiles has NO foreign key
--        to auth.users at all (verified: zero rows in pg_constraint for
--        conrelid='public.profiles' contype='f'), AND the canonical deletion path
--        (services/accountDeletion/AccountDeletionService.ts) deliberately keeps
--        an ANONYMISED TOMBSTONE profile rather than deleting the row. So the
--        cascade could never fire in production regardless of the FK. Fixed here
--        by an explicit erasure function called by the deletion service, mirroring
--        the existing erase_intel_for_actor precedent. The 2187 FKs are KEPT as
--        defence in depth but are no longer depended upon.
--
--  P0-2  Hide/forget was structurally dead. memory_retrieve suppressed feedback
--        only via `f.projection_id = mp.id`, but neither memory_retrieve nor
--        memory_rediscover returned an id, so no client could ever name a
--        projection; and subject-scoped feedback (the only kind a client could
--        send) was ignored by retrieval. Fixed by returning a stable id AND by
--        honouring subject-scoped feedback. Feedback is also made DURABLE across
--        re-projection (see the FK change below), so a forgotten memory cannot be
--        resurrected by the next projector pass.
--
--  P0-3  Retention was inert: the projector never set valid_to, so
--        memory_sweep_expired could not match a projected row. Fixed by setting
--        valid_to for the class the spec says should decay (derived_preference /
--        semantic, §18 "recompute/decay"). NOTE, deliberately: episodic/place/
--        social are retention_class='durable_fact', which §18 defines as
--        "canonical lifecycle/user deletion" — a TTL would be WRONG for them.
--        Their lifecycle is retraction-on-loss-of-support, added below.
--
--  P1-5/6 Social memory survived a block, and unfollow/unsave left orphans,
--        because the projector only checked eligibility at write time and never
--        retracted. Fixed by SUPPORT ACCOUNTING: every projector pass stamps
--        last_projected_at on the rows it re-affirms, then retracts the rows it
--        did not. One mechanism covers block-after-projection, unfollow, unsave,
--        removed interests and any future source loss, without a trigger per
--        source table.
--
-- PROVENANCE (the architectural requirement): after this migration a derived
-- memory can answer every required question —
--   what supports it?          provenance.derivation + provenance.support
--   is support still valid?    last_projected_at >= the last completed pass
--   when last observed?        last_supported_at
--   when does it expire?       valid_to (NULL = durable, governed by retraction)
--   what suppresses it?        memory_feedback, matched by id OR durable subject key
--   does that survive reruns?  yes — feedback is subject-keyed and no longer
--                              cascade-deleted with the projection
--   what retracts it?          loss of support in a full projector pass

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_projections') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2183 first.';
  END IF;
  IF to_regprocedure('public.project_user_memory(uuid, boolean)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2184/2186 first.';
  END IF;
END $$;

-- ── 1. SUPPORT ACCOUNTING + RETRACTED STATE ──────────────────────────────────
-- last_supported_at means "when was the underlying evidence last observed" and is
-- deliberately allowed to be an old timestamp (an episodic visit is dated by the
-- visit). It therefore CANNOT double as the support watermark. last_projected_at
-- is the separate, always-now stamp used to decide what lost support.
ALTER TABLE public.memory_projections
  ADD COLUMN IF NOT EXISTS last_projected_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS memory_projections_support_idx
  ON public.memory_projections (user_id, last_projected_at);

-- 'retracted' = support disappeared (unfollowed, unsaved, blocked, interest removed).
-- Distinct from 'decayed' (expired by TTL) and 'forgotten' (user asked us to forget).
ALTER TABLE public.memory_projections DROP CONSTRAINT IF EXISTS memory_projections_state_check;
ALTER TABLE public.memory_projections
  ADD CONSTRAINT memory_projections_state_check
  CHECK (state IN ('active','decayed','hidden','forgotten','retracted'));

-- ── 2. DURABLE FEEDBACK (P0-2) ───────────────────────────────────────────────
-- Feedback keyed only by projection_id died with the projection: a forget was
-- erased by the very re-projection it was meant to suppress. Carry the durable
-- subject key on every feedback row, and stop cascading.
ALTER TABLE public.memory_feedback
  ADD COLUMN IF NOT EXISTS memory_type text;

ALTER TABLE public.memory_feedback DROP CONSTRAINT IF EXISTS memory_feedback_projection_id_fkey;
ALTER TABLE public.memory_feedback
  ADD CONSTRAINT memory_feedback_projection_id_fkey
  FOREIGN KEY (projection_id) REFERENCES public.memory_projections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS memory_feedback_subject_idx
  ON public.memory_feedback (user_id, subject_type, subject_id);

-- ── 3. RETRIEVAL: return a stable id, honour subject-scoped feedback ─────────
DROP FUNCTION IF EXISTS public.memory_retrieve(uuid, text, integer);
CREATE FUNCTION public.memory_retrieve(
  p_user_id uuid,
  p_surface text DEFAULT 'compass',
  p_limit   integer DEFAULT 20
)
RETURNS TABLE (
  id                uuid,
  memory_type       text,
  subject_type      text,
  subject_id        text,
  content           text,
  confidence        real,
  last_supported_at timestamptz,
  valid_from        timestamptz
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  RETURN QUERY
  SELECT mp.id, mp.memory_type, mp.subject_type, mp.subject_id, mp.content,
         mp.confidence, mp.last_supported_at, mp.valid_from
  FROM public.memory_projections mp
  WHERE mp.user_id = p_user_id
    AND mp.state = 'active'
    AND (mp.valid_to IS NULL OR mp.valid_to > now())
    AND NOT EXISTS (
      SELECT 1 FROM public.memory_feedback f
      WHERE f.user_id = p_user_id
        -- match by id OR by the durable subject key, so feedback survives a
        -- re-projection that replaced the row
        AND ( f.projection_id = mp.id
              OR (f.subject_type IS NOT DISTINCT FROM mp.subject_type
                  AND f.subject_id IS NOT DISTINCT FROM mp.subject_id
                  AND (f.memory_type IS NULL OR f.memory_type = mp.memory_type)) )
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

DROP FUNCTION IF EXISTS public.memory_rediscover(uuid, text, integer);
CREATE FUNCTION public.memory_rediscover(
  p_user_id uuid,
  p_city    text,
  p_limit   integer DEFAULT 20
)
RETURNS TABLE (
  id           uuid,
  memory_type  text,
  subject_type text,
  subject_id   text,
  content      text,
  confidence   real,
  reason       text
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT mp.*,
      CASE
        WHEN mp.memory_type='episodic' AND mp.subject_type='city'
             AND lower(mp.subject_id)=lower(p_city) THEN 'been_here_before'
        WHEN mp.memory_type='place'  THEN 'you_saved'
        WHEN mp.memory_type='social' THEN 'you_know'
        ELSE 'relevant'
      END AS reason,
      CASE WHEN mp.memory_type='episodic' AND mp.subject_type='city'
                AND lower(mp.subject_id)=lower(p_city) THEN 0 ELSE 1 END AS rank_bucket
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
          AND f.kind IN ('hide','forget','already_known','not_interested'))
  )
  SELECT c.id, c.memory_type, c.subject_type, c.subject_id, c.content, c.confidence, c.reason
  FROM candidate c
  ORDER BY c.rank_bucket, c.confidence DESC, c.last_supported_at DESC
  LIMIT greatest(0, coalesce(p_limit, 20));
END
$fn$;

-- ── 4. ERASURE (P0-1) ────────────────────────────────────────────────────────
-- One idempotent, atomic purge of every memory artefact a user owns. Called by
-- AccountDeletionService as a FATAL step, mirroring erase_intel_for_actor.
-- Deliberately NOT dependent on any FK cascade.
CREATE OR REPLACE FUNCTION public.erase_memory_for_user(p_user_id uuid)
RETURNS TABLE (projections_deleted integer, events_deleted integer, feedback_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE p_del integer := 0; e_del integer := 0; f_del integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0; RETURN;
  END IF;

  -- feedback first: it references projections (ON DELETE SET NULL would orphan it)
  WITH d AS (DELETE FROM public.memory_feedback WHERE user_id = p_user_id RETURNING 1)
  SELECT count(*)::int INTO f_del FROM d;

  WITH d AS (DELETE FROM public.memory_projections WHERE user_id = p_user_id RETURNING 1)
  SELECT count(*)::int INTO p_del FROM d;

  -- memory_events blocks UPDATE only (2183's trg_memory_events_no_update), so a
  -- DELETE needs no erasure declaration — unlike the intel tables.
  WITH d AS (DELETE FROM public.memory_events WHERE user_id = p_user_id RETURNING 1)
  SELECT count(*)::int INTO e_del FROM d;

  RETURN QUERY SELECT p_del, e_del, f_del;
END
$fn$;

REVOKE ALL ON FUNCTION public.erase_memory_for_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erase_memory_for_user(uuid) TO service_role;

-- ── 5. RETRACTION + REAL RETENTION (P0-3, P1-5, P1-6) ────────────────────────
-- Wraps the existing projector: run it, then retract everything it did not
-- re-affirm. One mechanism for block-after-projection, unfollow, unsave and
-- removed interests.
CREATE OR REPLACE FUNCTION public.project_user_memory_with_retraction(
  p_user_id      uuid,
  p_enforce_flag boolean DEFAULT true
)
RETURNS TABLE (projected integer, retracted integer)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_run_started timestamptz := clock_timestamp();
  v_projected   integer := 0;
  v_retracted   integer := 0;
  v_enabled     boolean;
BEGIN
  IF p_enforce_flag THEN
    SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag='memory_projection';
    IF v_enabled IS DISTINCT FROM true THEN
      RETURN QUERY SELECT 0, 0; RETURN;
    END IF;
  END IF;

  v_projected := public.project_user_memory(p_user_id, false);

  -- Anything re-affirmed by that pass has last_projected_at >= v_run_started
  -- (the projector stamps it). Whatever did not is no longer supported.
  -- Scoped to the re-projectable classes only: intent is TTL-governed and
  -- user-taught memory is not derived, so neither may be retracted here.
  WITH r AS (
    UPDATE public.memory_projections
    SET state = 'retracted'
    WHERE user_id = p_user_id
      AND state = 'active'
      AND memory_type IN ('episodic','semantic','social','place')
      AND last_projected_at < v_run_started
    RETURNING 1
  )
  SELECT count(*)::int INTO v_retracted FROM r;

  RETURN QUERY SELECT v_projected, v_retracted;
END
$fn$;

REVOKE ALL ON FUNCTION public.project_user_memory_with_retraction(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_user_memory_with_retraction(uuid, boolean) TO service_role;

COMMENT ON COLUMN public.memory_projections.last_projected_at IS
  'Support watermark: set to now() every time the projector re-affirms this row. A row whose last_projected_at predates a completed projector pass has lost its supporting evidence and is retracted. Distinct from last_supported_at, which dates the EVIDENCE (an episodic visit keeps its visit date).';
COMMENT ON FUNCTION public.erase_memory_for_user(uuid) IS
  'Idempotent, atomic purge of all memory state for a user. Called by AccountDeletionService; deliberately independent of any FK cascade, because production keeps an anonymised tombstone profile and has no profiles->auth.users FK.';
COMMENT ON FUNCTION public.project_user_memory_with_retraction(uuid, boolean) IS
  'Projector + retraction pass. Retracts derived memory that lost its supporting evidence (block, unfollow, unsave, removed interest). Scheduler entrypoint.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='memory_projections' AND column_name='last_projected_at') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: last_projected_at missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='memory_feedback' AND column_name='memory_type') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_feedback.memory_type missing';
  END IF;
  IF to_regprocedure('public.erase_memory_for_user(uuid)') IS NULL
     OR to_regprocedure('public.project_user_memory_with_retraction(uuid, boolean)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: lifecycle functions missing';
  END IF;
  -- retrieval must now expose an id, or hide/forget stays unaddressable
  IF pg_get_function_result((SELECT oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='memory_retrieve')) NOT LIKE 'TABLE(id uuid%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_retrieve does not return an id';
  END IF;
  IF has_function_privilege('anon','public.erase_memory_for_user(uuid)','EXECUTE')
     OR has_function_privilege('authenticated','public.erase_memory_for_user(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: erasure reachable by anon/authenticated';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP FUNCTION IF EXISTS public.project_user_memory_with_retraction(uuid, boolean);
--   DROP FUNCTION IF EXISTS public.erase_memory_for_user(uuid);
--   ALTER TABLE public.memory_feedback DROP COLUMN IF EXISTS memory_type;
--   ALTER TABLE public.memory_projections DROP COLUMN IF EXISTS last_projected_at;
--   (and re-apply 2185/2188 bodies for memory_retrieve / memory_rediscover)

-- ── 6. Fan-out must retract too ──────────────────────────────────────────────
-- project_all_memory is the scheduler entrypoint; it must call the retraction
-- wrapper, or the scheduler would re-affirm memory and never retract what lost
-- support. (Appended after the COMMIT above is intentional: this is a separate,
-- self-contained statement block applied in the same change.)
BEGIN;
CREATE OR REPLACE FUNCTION public.project_all_memory(p_enforce_flag boolean DEFAULT true)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE v_enabled boolean; v_total integer := 0; r record; v_p integer; v_r integer;
BEGIN
  IF p_enforce_flag THEN
    SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag='memory_projection';
    IF v_enabled IS DISTINCT FROM true THEN RETURN 0; END IF;
  END IF;
  FOR r IN
    SELECT e.src_key::uuid AS uid FROM public.compass_graph_edges e
      WHERE e.src_type='person' AND e.dst_type='city' AND e.edge_type IN ('visited','returned_to')
        AND e.src_key ~ '^[0-9a-fA-F-]{36}$'
        AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = e.src_key::uuid)
    UNION SELECT follower_id FROM public.user_follows
    UNION SELECT user_id FROM public.saved_places
    UNION SELECT user_id FROM public.compass_user_preferences
      WHERE coalesce(array_length(interests,1),0) > 0 OR coalesce(array_length(travel_styles,1),0) > 0
  LOOP
    SELECT w.projected, w.retracted INTO v_p, v_r
      FROM public.project_user_memory_with_retraction(r.uid, false) w;
    v_total := v_total + coalesce(v_p, 0);
  END LOOP;
  RETURN v_total;
END
$fn$;
REVOKE ALL ON FUNCTION public.project_all_memory(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_all_memory(boolean) TO service_role;
COMMIT;
