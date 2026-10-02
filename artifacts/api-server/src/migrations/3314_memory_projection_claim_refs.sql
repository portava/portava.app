-- 3314_memory_projection_claim_refs.sql
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE MEMORY STAGE OF S112's LINEAGE, PERSISTED (census-sensing S112, §27)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT
--   `claim_refs uuid[]` on public.memory_projections: the intel_state_snapshots
--   ids a memory's world opportunity rested on, carried from the closed
--   ExperienceSession through the S92 bridge (services/memoryProjections/
--   experienceSessionBridge puts them in provenance_json.claim_refs) and now
--   PERSISTED by services/memoryProjections/sessionMemoryStore when the session
--   closes. NOT NULL with an empty default, so every memory the SQL projector
--   writes (cities, preferences, follows, saves — none of which rests on world
--   evidence) reads as "rests on no claim" rather than NULL-means-anything.
--   GIN-indexed so `claim_refs && ARRAY[...]` — the reach's query — is an index
--   scan, exactly as 3311 did for snapshots.
--
--   And ONE function change: project_user_memory_with_retraction (last defined
--   by 2195) keeps its body and gains one predicate, so a memory written from a
--   session outcome (subject_type = 'experience_session') is not retracted by
--   the SQL projector's support watermark. That watermark retracts whatever a
--   projector pass did not re-affirm; the SQL projector never writes a session
--   memory, so without the exclusion every session memory would be retracted
--   on the next six-hourly pass — for a reason that has nothing to do with its
--   support. A session memory's support is the owner's own reported outcome;
--   its lineage to world evidence is governed by the erasure path below.
--
-- WHY
--   census-sensing §24.4 / §26.1: "the S92 bridge's provenance_json.claim_refs
--   is never persisted, because project_all_memory (SQL) writes
--   memory_projections and reads no claim refs; so with memory_projection ON a
--   revocation still cannot be enumerated into memory." This column is the
--   persisted form; services/accountDeletion/sensingRevocationReach reads it
--   with the same overlap query 3311's provenance uses, and
--   services/accountDeletion/sensingErasureRecompute removes, after an erasure,
--   every reference to a snapshot that was withdrawn.
--
-- WHAT IT IS NOT (the privacy argument, stated rather than assumed)
--   A FORWARD reference from the OWNER's own memory to opaque snapshot ids. A
--   snapshot id names no contributor (snapshots are k-gated cohort state), so
--   the column adds no path from a memory to any other person. It is never
--   selected by a memory surface. Nothing is added to memory_events, to the
--   anonymous store or to any published aggregate.
--
-- WITHOUT THIS MIGRATION
--   sessionMemoryStore REFUSES to write a session memory (`claim_refs_unavailable`)
--   rather than writing one without its lineage: a memory whose references were
--   silently dropped is the one state from which a revocation could never reach
--   it. The reach reports `memoryStore: "column_absent"` — a true statement that
--   nothing can have been persisted with references — not "nothing reached".
--
-- Additive, idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
-- CREATE OR REPLACE FUNCTION). Rollback:
--   db/rollback/2026-09-26-3314-memory-projection-claim-refs-rollback.sql
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.memory_projections') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.memory_projections (2183) does not exist.';
  END IF;
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'memory_projections' AND column_name = 'last_projected_at';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: memory_projections.last_projected_at (2190) is absent; the retraction watermark this file amends does not exist yet.';
  END IF;
  IF to_regprocedure('public.project_inferred_preferences(uuid, boolean)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: project_inferred_preferences (2195) is absent; the retraction body below calls it.';
  END IF;
  IF to_regprocedure('public.project_user_memory(uuid, boolean)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: project_user_memory is absent.';
  END IF;
END $$;

ALTER TABLE public.memory_projections
  ADD COLUMN IF NOT EXISTS claim_refs uuid[] NOT NULL DEFAULT '{}'::uuid[];

CREATE INDEX IF NOT EXISTS memory_projections_claim_refs_gin
  ON public.memory_projections USING gin (claim_refs);

COMMENT ON COLUMN public.memory_projections.claim_refs IS
  'S112 memory-stage lineage: the intel_state_snapshots ids the world opportunity behind this memory rested on (from the closed ExperienceSession, via the S92 bridge). Written by services/memoryProjections/sessionMemoryStore; empty for every memory the SQL projector writes. Opaque ids naming no contributor; never selected by a memory surface. Read by services/accountDeletion/sensingRevocationReach (overlap) and pruned by the erasure path of every snapshot an erasure withdrew.';

-- 2195's body, unchanged except the one predicate marked below.
CREATE OR REPLACE FUNCTION public.project_user_memory_with_retraction(
  p_user_id uuid, p_enforce_flag boolean DEFAULT true
)
RETURNS TABLE (projected integer, retracted integer)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_run_started timestamptz := clock_timestamp();
  v_projected integer := 0; v_retracted integer := 0; v_enabled boolean;
BEGIN
  IF p_enforce_flag THEN
    SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag='memory_projection';
    IF v_enabled IS DISTINCT FROM true THEN RETURN QUERY SELECT 0,0; RETURN; END IF;
  END IF;

  v_projected := public.project_user_memory(p_user_id, false)
               + public.project_inferred_preferences(p_user_id, false);

  WITH r AS (
    UPDATE public.memory_projections
    SET state = 'retracted'
    WHERE user_id = p_user_id AND state = 'active'
      AND memory_type IN ('episodic','semantic','social','place')
      AND last_projected_at < v_run_started
      -- 3314: a memory written from a closed ExperienceSession is not this
      -- projector's to re-affirm, so its watermark says nothing about support.
      AND subject_type IS DISTINCT FROM 'experience_session'
    RETURNING 1
  ) SELECT count(*)::int INTO v_retracted FROM r;

  RETURN QUERY SELECT v_projected, v_retracted;
END
$fn$;

REVOKE ALL ON FUNCTION public.project_user_memory_with_retraction(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_user_memory_with_retraction(uuid, boolean) TO service_role;

COMMENT ON FUNCTION public.project_user_memory_with_retraction(uuid, boolean) IS
  'Runs the SQL projector (project_user_memory + project_inferred_preferences) and retracts every active episodic/semantic/social/place memory the pass did not re-affirm — EXCEPT memories written from a closed ExperienceSession (subject_type = experience_session, 3314), whose support is the owner''s own outcome and whose lineage is governed by the erasure path, not by this watermark.';

-- ── Postconditions ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_type text;
  v_nullable text;
  v_src text;
BEGIN
  SELECT udt_name, is_nullable INTO v_type, v_nullable
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'memory_projections' AND column_name = 'claim_refs';
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_projections.claim_refs is absent.';
  END IF;
  IF v_type <> '_uuid' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_projections.claim_refs is % rather than uuid[]; a text array would let a non-id ride in.', v_type;
  END IF;
  IF v_nullable <> 'NO' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_projections.claim_refs is nullable; NULL must not be a third meaning beside "rests on these" and "rests on none".';
  END IF;

  PERFORM 1 FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'memory_projections' AND indexname = 'memory_projections_claim_refs_gin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the GIN index on memory_projections.claim_refs is absent; the reach''s overlap query would seq-scan.';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'project_user_memory_with_retraction';
  IF v_src IS NULL OR v_src NOT LIKE '%experience_session%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: project_user_memory_with_retraction does not exempt session memories; the next projector pass would retract every one of them.';
  END IF;
  IF v_src NOT LIKE '%project_inferred_preferences%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: project_user_memory_with_retraction lost 2195''s inferred-preference projection.';
  END IF;

  -- CALLABLE functions only. A trigger function (RETURNS trigger) cannot be
  -- invoked by any role outside its trigger, so an EXECUTE grant on one is not
  -- an exposure — 2994's memory_relations_owner_matches_source is exactly that,
  -- and counting it would make this file unappliable for a non-reason.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND (p.proname LIKE 'memory\_%' OR p.proname LIKE 'project\_%memory%')
      AND p.prorettype <> 'trigger'::regtype
      AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a callable memory/projector function is anon/authenticated executable.';
  END IF;

  -- The lineage lives on the owner's memory only; memory_events gains nothing.
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'memory_events' AND column_name = 'claim_refs';
  IF FOUND THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_events carries claim_refs; this migration adds lineage to memory_projections only.';
  END IF;
END $$;
