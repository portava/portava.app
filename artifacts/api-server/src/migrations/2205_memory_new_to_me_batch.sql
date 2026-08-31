-- 2205_memory_new_to_me_batch.sql
--
-- Memory + Experience Intelligence — BATCH New-to-Me (§7 / §13 wiring).
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHAT THIS IS
-- -----------
-- `memory_is_new_to_user` (2185) answers New-to-Me for ONE subject. Wiring it
-- into the Discovery serve path (§13) means answering it for a PAGE of served
-- candidates on every request. Calling the single-subject function once per
-- candidate is N round-trips per page; this is the set-at-a-time equivalent, so
-- the serve path pays ONE round-trip for the whole page.
--
-- SEMANTICS — identical to memory_is_new_to_user, evaluated per input id:
--   a subject is "new to me" when the user has NO active memory of it AND has
--   not marked it already_known / not_interested. A briefly-seen impression does
--   not count — only a projected memory or explicit feedback marks awareness
--   (§7 "distinguish impression from meaningful awareness").
--
-- The caller supplies discovery_places.id values (the id space place memory keys
-- on — subject_type='place', subject_id=saved_places.place_id=discovery_places.id).
-- The application-side placeIdBridge maps the Discovery serve id space
-- (db/<uuid>, node/<id>) onto that space before calling this.
--
-- Like the other read functions in 2185 this is a pure read: service_role-only,
-- caller-supplied identity, search_path pinned. It is NOT internally flag-gated —
-- the serve path gates the whole New-to-Me surface on `memory_projection`, and a
-- read that returns "everything is new" when the projector has produced nothing
-- is already the correct pre-launch answer.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_projections') IS NULL OR to_regclass('public.memory_feedback') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: memory contract (2183) missing.';
  END IF;
  IF to_regprocedure('public.memory_is_new_to_user(uuid, text, text)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2185 first (memory_is_new_to_user missing).';
  END IF;
END $$;

-- ── memory_are_new_to_user(user, subject_type, subject_ids[]) → (id, is_new) ───
-- Set-at-a-time New-to-Me. Returns one row per input subject_id with its novelty,
-- mirroring memory_is_new_to_user exactly (active memory OR already_known /
-- not_interested feedback ⇒ NOT new). unnest preserves the caller's set; DISTINCT
-- collapses duplicate inputs without changing membership.
CREATE OR REPLACE FUNCTION public.memory_are_new_to_user(
  p_user_id      uuid,
  p_subject_type text,
  p_subject_ids  text[]
)
RETURNS TABLE (
  subject_id text,
  is_new     boolean
)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT s.subject_id,
    NOT (
      EXISTS (
        SELECT 1 FROM public.memory_projections mp
        WHERE mp.user_id = p_user_id
          AND mp.subject_type = p_subject_type
          AND mp.subject_id = s.subject_id
          AND mp.state = 'active'
      )
      OR EXISTS (
        SELECT 1 FROM public.memory_feedback f
        WHERE f.user_id = p_user_id
          AND f.subject_type = p_subject_type
          AND f.subject_id = s.subject_id
          AND f.kind IN ('already_known','not_interested')
      )
    ) AS is_new
  FROM (SELECT DISTINCT unnest(coalesce(p_subject_ids, ARRAY[]::text[])) AS subject_id) s;
$fn$;

-- ── Least-privilege — service_role only (2182/2184/2185 rule) ─────────────────
REVOKE ALL ON FUNCTION public.memory_are_new_to_user(uuid, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_are_new_to_user(uuid, text, text[]) TO service_role;

COMMENT ON FUNCTION public.memory_are_new_to_user(uuid, text, text[]) IS
  'Batch New-to-Me (spec §7/§13): one row per input subject_id with is_new, matching memory_is_new_to_user. Lets the Discovery serve path annotate a whole page in one round-trip. service_role only.';

DO $$
BEGIN
  IF to_regprocedure('public.memory_are_new_to_user(uuid, text, text[])') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_are_new_to_user not created';
  END IF;
  IF has_function_privilege('anon','public.memory_are_new_to_user(uuid, text, text[])','EXECUTE')
     OR has_function_privilege('authenticated','public.memory_are_new_to_user(uuid, text, text[])','EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_are_new_to_user reachable by anon/authenticated';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP FUNCTION IF EXISTS public.memory_are_new_to_user(uuid, text, text[]);
