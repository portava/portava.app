-- 3660_telegraph_dm_group_formation.sql
-- Telegraph §14.3 / §30A.4 — "Adding a third person to a DM creates a new
-- group; it does not expose the old DM history. Explicitly selected
-- Plans/Places may be carried forward as new share objects."
-- POST-CUTOVER CANONICAL FORWARD MIGRATION. Lane T-GRP band 3660-3664.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THE CENSUS FOUND
-- ══════════════════════════════════════════════════════════════════════════════
-- census-telegraph T212 (N, unguarded absence) and T213 (N): no operation adds a
-- person to a DM, and `message_threads.thread_type` admits only direct | trip |
-- circle, so a group formed out of a DM had no type it could be created as
-- (domain/telegraph/invariants/groupFormationInvariants.ts, GROUP_FORMATION_BLOCKERS).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS FILE DOES
-- ══════════════════════════════════════════════════════════════════════════════
-- 1. Widens message_threads_thread_type_check to admit 'group' — a conversation
--    whose roster the conversation itself owns (not a trip's, not a circle's).
-- 2. Widens chk_thread_context with one more arm: a 'group' row carries neither
--    trip_id nor circle_owner_id. Every existing arm is restated verbatim.
-- 3. Seeds telegraph_dm_group_formation_enabled FALSE.
--
-- WHY THIS WEAKENS NO ACCESS CONTROL. Thread access is decided ONLY by
-- message_thread_members (mt_select / msg_select / mtm_select — 2402), none of
-- which reads thread_type. Client roles hold no INSERT path into
-- message_threads or message_thread_members (mtm_insert WITH CHECK (false); no
-- INSERT policy on message_threads; 3504's privilege boundary). A 'group' row is
-- written only by the server (services/telegraph/groupFormation.ts), behind the
-- flag, after block, Trust-restriction and message-permission gates.
--
-- WHY THE OLD DM HISTORY CANNOT LEAK THROUGH THIS. The group is a NEW
-- message_threads row with a NEW roster; no message is copied or re-pointed, the
-- source DM is not modified, and nothing records which DM a group came from.
-- Carried-forward Plans/Places are new PORTAVA_OBJECT share messages naming the
-- CANONICAL object, never a DM message id.
--
-- ROLLBACK: db/rollback/2026-10-10-3660-telegraph-dm-group-formation-rollback.sql

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF to_regclass('public.message_threads') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.message_threads must exist.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags must exist.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.message_threads
              WHERE thread_type NOT IN ('direct','trip','circle','group')) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: message_threads holds a thread_type outside direct | trip | circle | group.';
  END IF;
END $pre$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. thread_type admits 'group'
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.message_threads DROP CONSTRAINT IF EXISTS message_threads_thread_type_check;
ALTER TABLE public.message_threads
  ADD CONSTRAINT message_threads_thread_type_check
  CHECK ((thread_type = ANY (ARRAY['direct'::text, 'trip'::text, 'circle'::text, 'group'::text])));

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. A 'group' row carries no trip and no circle
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.message_threads DROP CONSTRAINT IF EXISTS chk_thread_context;
ALTER TABLE public.message_threads
  ADD CONSTRAINT chk_thread_context
  CHECK ((((thread_type = 'trip'::text) AND (trip_id IS NOT NULL) AND (circle_owner_id IS NULL))
       OR ((thread_type = 'circle'::text) AND (circle_owner_id IS NOT NULL) AND (trip_id IS NULL))
       OR ((thread_type = 'direct'::text) AND (trip_id IS NULL) AND (circle_owner_id IS NULL))
       OR ((thread_type = 'group'::text) AND (trip_id IS NULL) AND (circle_owner_id IS NULL))));

COMMENT ON CONSTRAINT message_threads_thread_type_check ON public.message_threads IS
  'direct | trip | circle | group. group (3660): a conversation formed by adding people to a DM (Telegraph §14.3); its roster is owned by the conversation, written only by services/telegraph/groupFormation.ts behind telegraph_dm_group_formation_enabled.';

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. The flag, seeded FALSE
-- ══════════════════════════════════════════════════════════════════════════════

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('telegraph_dm_group_formation_enabled', false,
   'CAPABILITY gate for Telegraph §14.3 group formation: POST /api/threads/:id/add-people creates a NEW group conversation from a DM plus the added people, never exposing the DM history, and may carry explicitly selected Plans/Places forward as new share messages. OFF (the seed): the route answers feature_disabled and no group row is ever written.')
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (catalog and flag row only; recomputed, no session state) ──
DO $post$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.message_threads'::regclass AND conname = 'message_threads_thread_type_check';
  IF v_def IS NULL OR v_def NOT LIKE '%''group''%' OR v_def NOT LIKE '%''direct''%'
     OR v_def NOT LIKE '%''trip''%' OR v_def NOT LIKE '%''circle''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: message_threads_thread_type_check must admit direct, trip, circle and group (got %).', v_def;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.message_threads'::regclass AND conname = 'chk_thread_context';
  IF v_def IS NULL OR v_def NOT LIKE '%''group''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: chk_thread_context must carry the group arm (got %).', v_def;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_dm_group_formation_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_dm_group_formation_enabled was not seeded.';
  END IF;
END $post$;

COMMIT;
