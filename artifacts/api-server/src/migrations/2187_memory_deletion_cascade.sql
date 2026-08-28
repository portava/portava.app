-- 2187_memory_deletion_cascade.sql
--
-- Memory + Experience Intelligence Architecture — account-deletion integrity.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHY
-- ---
-- The memory contract (2183) intentionally shipped WITHOUT user FKs, so a bad
-- projection could never fail on a foreign key. But that left the memory tables
-- user-keyed yet unlinked — nothing purges them on account deletion, violating
-- spec §17 (deletion), §23 (certification: "Delete account → derived memories …
-- are removed") and §24. This adds the deletion path the right way: a CASCADE FK
-- to profiles, which itself cascades from auth.users (profiles_id_fkey), so
-- auth.admin.deleteUser → profiles row deleted → memory rows deleted, with no
-- application code in the loop.
--
-- SAFE: the memory tables are empty (0 rows on CI and prod), so adding the FK
-- cannot fail on existing data. To keep the projector robust against a stale
-- Experience-Graph person key that no longer has a profile, project_all_memory
-- is re-issued with a profile-existence guard on the graph branch — so every
-- projected user_id is a real profile and the new FK can never be violated at
-- write time.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_projections') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: apply 2183 first.';
  END IF;
  -- Empty-table guard: only proceed if there is no data that could violate the FK.
  IF (SELECT count(*) FROM public.memory_events) > 0
     OR (SELECT count(*) FROM public.memory_projections) > 0
     OR (SELECT count(*) FROM public.memory_feedback) > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: memory tables are non-empty; verify every user_id resolves to a profile before adding the FK.';
  END IF;
END $$;

-- (The memory_events append-only-on-UPDATE guard lives in 2183, deliberately NOT
-- the shared intel_append_only() — that one also blocks DELETE unless an intel
-- erasure flag is set, which would break the account-deletion cascade added here.
-- 2183's trg_memory_events_no_update blocks UPDATE only, leaving DELETE free for
-- this cascade and the retention sweep.)

ALTER TABLE public.memory_events
  ADD CONSTRAINT memory_events_user_fk
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE public.memory_projections
  ADD CONSTRAINT memory_projections_user_fk
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE public.memory_feedback
  ADD CONSTRAINT memory_feedback_user_fk
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- Re-issue project_all_memory with a profile-existence guard on the graph branch
-- (follows / saved_places / preferences user_ids already FK to profiles, so only
-- the free-text graph person key can be stale). Keeps every write FK-valid.
CREATE OR REPLACE FUNCTION public.project_all_memory(p_enforce_flag boolean DEFAULT true)
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
    IF v_enabled IS DISTINCT FROM true THEN RETURN 0; END IF;
  END IF;

  FOR r IN
    SELECT e.src_key::uuid AS uid
    FROM public.compass_graph_edges e
    WHERE e.src_type='person' AND e.dst_type='city' AND e.edge_type IN ('visited','returned_to')
      AND e.src_key ~ '^[0-9a-fA-F-]{36}$'
      AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = e.src_key::uuid)
    UNION SELECT follower_id FROM public.user_follows
    UNION SELECT user_id FROM public.saved_places
    UNION SELECT user_id FROM public.compass_user_preferences
      WHERE coalesce(array_length(interests,1),0) > 0 OR coalesce(array_length(travel_styles,1),0) > 0
  LOOP
    v_total := v_total + public.project_user_memory(r.uid, false);
  END LOOP;

  RETURN v_total;
END
$fn$;

REVOKE ALL ON FUNCTION public.project_all_memory(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_all_memory(boolean) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='memory_events_user_fk')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='memory_projections_user_fk')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='memory_feedback_user_fk') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory deletion-cascade FKs not all present';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   ALTER TABLE public.memory_feedback    DROP CONSTRAINT IF EXISTS memory_feedback_user_fk;
--   ALTER TABLE public.memory_projections DROP CONSTRAINT IF EXISTS memory_projections_user_fk;
--   ALTER TABLE public.memory_events      DROP CONSTRAINT IF EXISTS memory_events_user_fk;
--   (and re-apply 2186's project_all_memory body)
