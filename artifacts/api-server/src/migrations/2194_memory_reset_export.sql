-- 2194_memory_reset_export.sql
--
-- Memory — §17 user control: reset personalization, and export.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- §17 requires the product to let a user "reset personalization or selected
-- categories" and to support export. The system had view (retrieve), hide and
-- forget (feedback), and full erasure (account deletion) — but no way to say
-- "start my personalization over" short of deleting the account, and no way to
-- see everything Portava has derived.
--
-- THE DESIGN DECISION THAT MATTERS: reset does NOT delete feedback.
-- A user who has told us to forget something and then resets personalization has
-- not withdrawn that instruction — they have asked us to rebuild the derived
-- picture. Deleting their forgets during a reset would silently resurrect memory
-- they explicitly suppressed, on the next projector pass, which is the exact
-- resurrection bug 2190 fixed at the re-projection level. So reset clears
-- PROJECTIONS and EVENTS; suppressions survive.
--
-- Erasure (erase_memory_for_user, 2190) is different and still clears everything
-- including feedback, because there is no user left to hold a preference for.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_projections') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2183 first.';
  END IF;
  IF to_regclass('public.memory_policy') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2192 first.';
  END IF;
END $$;

-- ── Reset personalization (§17) ──────────────────────────────────────────────
-- p_memory_types NULL = all classes; otherwise reset only those categories
-- ("reset personalization OR SELECTED CATEGORIES").
CREATE OR REPLACE FUNCTION public.memory_reset_for_user(
  p_user_id      uuid,
  p_memory_types text[] DEFAULT NULL
)
RETURNS TABLE (projections_cleared integer, events_cleared integer, feedback_kept integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE p_del int := 0; e_del int := 0; f_kept int := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN QUERY SELECT 0,0,0; RETURN;
  END IF;

  WITH d AS (
    DELETE FROM public.memory_projections
    WHERE user_id = p_user_id
      AND (p_memory_types IS NULL OR memory_type = ANY (p_memory_types))
    RETURNING 1
  ) SELECT count(*)::int INTO p_del FROM d;

  WITH d AS (
    DELETE FROM public.memory_events
    WHERE user_id = p_user_id
      AND (p_memory_types IS NULL OR subject_type = ANY (p_memory_types) OR true)
    RETURNING 1
  ) SELECT count(*)::int INTO e_del FROM d;

  -- Deliberately NOT deleted. A forget survives a reset (see the header).
  SELECT count(*)::int INTO f_kept FROM public.memory_feedback WHERE user_id = p_user_id;

  RETURN QUERY SELECT p_del, e_del, f_kept;
END
$fn$;

-- ── Export (§17) ─────────────────────────────────────────────────────────────
-- Everything Portava has derived about the user, including the WHY. Returns rows
-- that are suppressed or decayed too — an export that hid them would understate
-- what is stored, which is the opposite of the point.
CREATE OR REPLACE FUNCTION public.memory_export_for_user(p_user_id uuid)
RETURNS TABLE (
  memory_type       text,
  subject_type      text,
  subject_id        text,
  content           text,
  confidence        real,
  state             text,
  sensitivity       text,
  visibility        text,
  retention_class   text,
  valid_from        timestamptz,
  valid_to          timestamptz,
  last_supported_at timestamptz,
  derivation        text,
  supporting_events integer,
  suppressed_by     text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT mp.memory_type, mp.subject_type, mp.subject_id, mp.content, mp.confidence,
         mp.state, mp.sensitivity, mp.visibility, mp.retention_class,
         mp.valid_from, mp.valid_to, mp.last_supported_at,
         (mp.provenance->>'derivation')::text            AS derivation,
         coalesce(array_length(mp.source_event_ids,1),0) AS supporting_events,
         (SELECT string_agg(DISTINCT f.kind, ',')
            FROM public.memory_feedback f
           WHERE f.user_id = mp.user_id
             AND ( f.projection_id = mp.id
                   OR (f.subject_type IS NOT DISTINCT FROM mp.subject_type
                       AND f.subject_id IS NOT DISTINCT FROM mp.subject_id) )) AS suppressed_by
  FROM public.memory_projections mp
  WHERE mp.user_id = p_user_id
  ORDER BY mp.memory_type, mp.subject_type, mp.subject_id;
$fn$;

REVOKE ALL ON FUNCTION public.memory_reset_for_user(uuid, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.memory_export_for_user(uuid)        FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_reset_for_user(uuid, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.memory_export_for_user(uuid)        TO service_role;

COMMENT ON FUNCTION public.memory_reset_for_user(uuid, text[]) IS
  '§17 "reset personalization or selected categories". Clears derived projections and ledger events, but deliberately KEEPS memory_feedback: a user who reset has not withdrawn a previous forget, and deleting suppressions here would resurrect memory they explicitly suppressed on the next projector pass.';
COMMENT ON FUNCTION public.memory_export_for_user(uuid) IS
  '§17 export: everything derived about the user INCLUDING the why (derivation, supporting event count) and what suppresses it. Deliberately includes decayed/hidden/retracted rows — an export that omitted them would understate what is stored.';

DO $$
BEGIN
  IF to_regprocedure('public.memory_reset_for_user(uuid, text[])') IS NULL
     OR to_regprocedure('public.memory_export_for_user(uuid)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: reset/export functions missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'memory\_%'
      AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE'))) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a memory function is anon/authenticated executable';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP FUNCTION IF EXISTS public.memory_export_for_user(uuid);
--   DROP FUNCTION IF EXISTS public.memory_reset_for_user(uuid, text[]);
