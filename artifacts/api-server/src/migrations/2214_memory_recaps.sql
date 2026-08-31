-- 2214_memory_recaps.sql
--
-- Memory + Experience Intelligence — §5 "Personal Recaps" and "On This Day".
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHAT THIS ADDS, AND WHY
-- -----------------------
-- §5 composes owner-only trip/monthly/yearly/milestone recaps and anniversary
-- resurfacing ("On This Day") from ONLY the memory the user is eligible to see.
-- It reuses the §12 eligibility core wholesale and adds NOTHING to the
-- allow/deny boundary — the boundary already lives in exactly one place,
-- memory_remembers_for_user (2213), and this migration must not fork it.
--
-- Two things ship here:
--
--   1. The `memory_recaps` FEATURE FLAG, seeded DISABLED. §5 ships OFF: it is a
--      certification gate, not a launch. Every read endpoint and the
--      notification path consult it fail-closed (off ⇒ empty/inert, zero work).
--      Seeded ON CONFLICT DO NOTHING so re-running the migration never
--      force-flips an operator's later choice — same convention as
--      memory_projection (2183).
--
--   2. `memory_recaps_for_user(user, from, to)` — a THIN DELEGATING reader that
--      returns memory_remembers_for_user(user) NARROWED to a time window. It
--      writes NO deny logic of its own: it selects FROM the §12 core function,
--      so every allow/deny rule (expired / non-active / sensitive /
--      non-user-visible policy class / sensitive-category inference /
--      deleted-subject social memory / user-suppressed forget/hide/incorrect) is
--      inherited unchanged, and a window can only REMOVE rows, never add one.
--      This is the SQL-level guarantee that "recaps draw derived memory only
--      through the §12 core". Source content (postcards/trips/stamps/consented
--      Shared Moments) is assembled in TS through the SAME §12 builders.
--
-- LEAST PRIVILEGE (the 2182/2190/2213 rule, restated because it is load-bearing):
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on every NEW public
-- function to anon AND authenticated. memory_recaps_for_user returns a user's
-- derived memory keyed by a CALLER-SUPPLIED id, so an anon/authenticated grant
-- would be a privacy oracle exactly like the §12 reader. It is REVOKEd from
-- PUBLIC, anon, authenticated and GRANTed only to service_role, and the
-- postcondition below re-checks EVERY memory_* / project_* function.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: feature_flags missing.';
  END IF;
  IF to_regprocedure('public.memory_remembers_for_user(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2213 first — §5 delegates to memory_remembers_for_user and must not fork the boundary.';
  END IF;
END $$;

-- ── The certification gate: seed the master flag DISABLED ─────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'memory_recaps',
    false,
    'Gates §5 Personal Recaps and On This Day (owner-only recap/anniversary reads + their opt-in notifications). Off = the recap/on-this-day endpoints return empty/inert and do ZERO work, and no notification fires. STAYS OFF until memory deletion, consent, and retention behaviour are certified. The eligibility boundary is the §12 core (memory_remembers_for_user); this flag gates the §5 readers on top of it.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── memory_recaps_for_user(user, from, to) → §12 core, windowed ───────────────
-- Delegates ENTIRELY to memory_remembers_for_user for allow/deny; the ONLY thing
-- it adds is a time-window narrowing on when the memory was last supported (or,
-- absent that, when it became valid). NULL bounds mean "unbounded on that side",
-- so (NULL, NULL) is exactly the §12 core row set. A window is strictly
-- subtractive, so this reader can never surface a row the core would deny.
CREATE OR REPLACE FUNCTION public.memory_recaps_for_user(
  p_user_id uuid,
  p_from    timestamptz DEFAULT NULL,
  p_to      timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id                uuid,
  memory_type       text,
  subject_type      text,
  subject_id        text,
  content           text,
  confidence        real,
  is_inferred       boolean,
  observation_count integer,
  sensitivity       text,
  visibility        text,
  state             text,
  retention_class   text,
  valid_from        timestamptz,
  valid_to          timestamptz,
  last_supported_at timestamptz,
  derivation        text,
  source_event_ids  uuid[]
)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT
    r.id, r.memory_type, r.subject_type, r.subject_id, r.content, r.confidence,
    r.is_inferred, r.observation_count, r.sensitivity, r.visibility, r.state,
    r.retention_class, r.valid_from, r.valid_to, r.last_supported_at,
    r.derivation, r.source_event_ids
  FROM public.memory_remembers_for_user(p_user_id) r
  WHERE p_user_id IS NOT NULL
    AND (p_from IS NULL OR coalesce(r.last_supported_at, r.valid_from) >= p_from)
    AND (p_to   IS NULL OR coalesce(r.last_supported_at, r.valid_from) <  p_to)
  ORDER BY coalesce(r.last_supported_at, r.valid_from) DESC NULLS LAST, r.memory_type, r.subject_id;
$fn$;

REVOKE ALL ON FUNCTION public.memory_recaps_for_user(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_recaps_for_user(uuid, timestamptz, timestamptz) TO service_role;

COMMENT ON FUNCTION public.memory_recaps_for_user(uuid, timestamptz, timestamptz) IS
  '§5 Personal Recaps: memory_remembers_for_user(user) narrowed to [from, to) on last_supported_at (else valid_from). Adds NO deny logic — every allow/deny rule is inherited from the §12 core, and the window is strictly subtractive. service_role only.';

-- ── Postcondition — prove it delegates, and stayed least-privilege ────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_recaps') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_recaps flag not seeded';
  END IF;
  IF to_regprocedure('public.memory_recaps_for_user(uuid, timestamptz, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_recaps_for_user not created';
  END IF;
  -- Delegation guard: the body MUST select from the §12 core. If a future edit
  -- replaced the delegation with a hand-written memory_projections query, this
  -- fails the migration rather than silently forking the allow/deny boundary.
  IF position('memory_remembers_for_user' IN pg_get_functiondef('public.memory_recaps_for_user(uuid, timestamptz, timestamptz)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_recaps_for_user must delegate to memory_remembers_for_user (do not fork the §12 boundary)';
  END IF;
  IF position('memory_projections' IN pg_get_functiondef('public.memory_recaps_for_user(uuid, timestamptz, timestamptz)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_recaps_for_user references memory_projections directly — it must go through the §12 core, not re-query with its own WHERE clause';
  END IF;
  -- The DROP/CREATE default-grant trap (2190 lesson) — check EVERY memory/project fn.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (p.proname LIKE 'memory\_%' OR p.proname LIKE 'project\_%memory%')
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
           OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a memory function is executable by anon/authenticated (Supabase default grants after CREATE — re-REVOKE it)';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP FUNCTION IF EXISTS public.memory_recaps_for_user(uuid, timestamptz, timestamptz);
--   DELETE FROM public.feature_flags WHERE flag = 'memory_recaps';
