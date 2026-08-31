-- 2200_memory_projection_exclude_deleted_profiles.sql
--
-- Memory + Experience Intelligence — DELETION DURABILITY (audit MEM·C1).
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHY THIS EXISTS
-- ---------------
-- A GDPR-erased user's derived memory RESURRECTED within ~6h of erasure.
--
-- The canonical deletion path (services/accountDeletion/AccountDeletionService.ts)
-- keeps an ANONYMISED TOMBSTONE profile — the row survives with
-- account_status='deleted' — and calls erase_memory_for_user (2190) to purge every
-- memory_projections / memory_events / memory_feedback row the user owned. That
-- purge is correct and complete at the moment it runs.
--
-- But erasure only deletes what EXISTS; it does not stop the projector from
-- re-deriving. project_all_memory (2190 §6) is the 6-hourly scheduler entrypoint.
-- It fans out to every user with any projectable signal and calls
-- project_user_memory_with_retraction per user, which RE-CREATES derived memory
-- from the still-present source rows. A tombstoned user is still enumerable
-- because the deletion path deliberately keeps the profile AND does not scrub
-- every derivation source:
--
--   * compass_graph_edges — the Experience-Graph person→city visit edges are NOT
--     purged by account deletion, so the person branch re-enumerates the tombstone
--     (this is the branch the audit named);
--   * user_follows / saved_places / compass_user_preferences — any residual row
--     re-enumerates the tombstone through the other three branches.
--
-- The 2190/2187 guard on the graph branch was only
--   AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = e.src_key::uuid)
-- i.e. "does a profile row still exist?" — which a tombstone SATISFIES, because
-- the tombstone IS a profile row. Existence was never the right question; the
-- right question is "is this profile still a live account?".
--
-- Sibling deletion-cascade work (compass_user_preferences purge, compass_memories
-- / compass_conversations purge) closes individual source branches. This migration
-- closes the branch that survives regardless of which sources are scrubbed: it
-- makes the fan-out itself refuse to re-project a tombstoned profile, on EVERY
-- branch, so a completed erasure stays erased no matter what residual source rows
-- remain.
--
-- THE FIX
-- -------
-- CREATE OR REPLACE project_all_memory so its enumeration filters every candidate
-- user through a single guard:
--   EXISTS (SELECT 1 FROM public.profiles p
--           WHERE p.id = c.uid AND p.account_status <> 'deleted')
-- One outer guard over the UNION of all four branches, rather than a per-branch
-- EXISTS, so no present or future fan-out branch can leak a tombstone. This
-- subsumes the graph branch's existing profile-existence EXISTS (the outer guard
-- already requires the profile to exist) and additionally excludes the tombstone.
--
-- account_status is text NOT NULL DEFAULT 'active' with
--   CHECK (account_status IN ('active','deactivated','pending_deletion','deleted'))
-- (baseline profiles_account_status_check), so `<> 'deleted'` has no NULL pitfall
-- and deliberately STILL PROJECTS 'active', 'deactivated' and 'pending_deletion':
-- only a completed, tombstoned deletion is excluded. A 'pending_deletion' account
-- has not been erased yet, so continuing to project it changes nothing that
-- erasure will not later purge; the moment the deletion service tombstones it to
-- 'deleted' and calls erase_memory_for_user, this guard keeps it erased.
--
-- Nothing else in the function changes: the memory_projection flag gate, the
-- per-user project_user_memory_with_retraction call, and the projected-row tally
-- are byte-for-byte the 2190 §6 body.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.project_all_memory(boolean)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2190 (project_all_memory) first.';
  END IF;
  IF to_regprocedure('public.project_user_memory_with_retraction(uuid, boolean)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2190 (retraction wrapper) first.';
  END IF;
  -- The guard compares against a column this migration assumes exists.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='profiles' AND column_name='account_status') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: profiles.account_status is missing.';
  END IF;
END $$;

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
    -- Every fan-out branch is unioned first, then filtered through ONE guard that
    -- requires a still-live profile. A tombstoned account (account_status='deleted')
    -- is excluded no matter which residual source row re-enumerated it, so a
    -- completed GDPR erasure cannot be resurrected by the next projector pass.
    SELECT c.uid
    FROM (
      SELECT e.src_key::uuid AS uid FROM public.compass_graph_edges e
        WHERE e.src_type='person' AND e.dst_type='city' AND e.edge_type IN ('visited','returned_to')
          -- regex guards the ::uuid cast against non-UUID person keys; keep it.
          AND e.src_key ~ '^[0-9a-fA-F-]{36}$'
      UNION SELECT follower_id FROM public.user_follows
      UNION SELECT user_id FROM public.saved_places
      UNION SELECT user_id FROM public.compass_user_preferences
        WHERE coalesce(array_length(interests,1),0) > 0 OR coalesce(array_length(travel_styles,1),0) > 0
    ) c
    WHERE EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = c.uid AND p.account_status <> 'deleted'
    )
  LOOP
    SELECT w.projected, w.retracted INTO v_p, v_r
      FROM public.project_user_memory_with_retraction(r.uid, false) w;
    v_total := v_total + coalesce(v_p, 0);
  END LOOP;
  RETURN v_total;
END
$fn$;

-- CREATE OR REPLACE preserves the existing ACL, but re-assert it anyway: this is a
-- SECURITY-adjacent scheduler function and the repo's standing rule is that every
-- (re)definition of a memory/projection function restates its grants, so a future
-- DROP/CREATE that trips Supabase's default-grant-to-anon trap is caught here too.
REVOKE ALL ON FUNCTION public.project_all_memory(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_all_memory(boolean) TO service_role;

DO $$
BEGIN
  -- The guard must actually be present in the live function body. Asserting on
  -- pg_get_functiondef makes a future edit that drops the account_status filter
  -- fail this migration's own postcondition rather than silently reopening MEM·C1.
  IF position('account_status' IN pg_get_functiondef('public.project_all_memory(boolean)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: project_all_memory does not filter on account_status — the tombstone-exclusion guard is missing';
  END IF;
  IF has_function_privilege('anon','public.project_all_memory(boolean)','EXECUTE')
     OR has_function_privilege('authenticated','public.project_all_memory(boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: project_all_memory is executable by anon/authenticated';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   Re-apply the 2190 §6 body of public.project_all_memory (the enumeration whose
--   only person guard is `EXISTS (SELECT 1 FROM public.profiles p WHERE p.id =
--   e.src_key::uuid)` on the graph branch). Reversing REOPENS MEM·C1 — a
--   tombstoned account's derived memory will resurrect on the next projector pass.
