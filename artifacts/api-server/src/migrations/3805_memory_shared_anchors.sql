-- 3805_memory_shared_anchors.sql
-- Highlights/Memories spec §5 "Shared experiences" (docs/specs/Portava_Highlights_
-- Memories_Development_Architecture_Spec_v1.txt:225-226): "A shared experience is
-- not one globally editable personal Memory. Prefer a shared-experience anchor plus
-- separate personal Memories. Mutual 'Remember this together' creates an explicitly
-- shared object only after participant consent." Census H53
-- (census-highlights-memories.md:386, NOT-BUILT: "`memory_tags` grants no ownership
-- and creates no shared object").
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; B58 memories band
-- 3802-3819, cluster MEM-ANCHOR-1, the SERVER half). APPLIED TO NO DATABASE by the
-- lane that wrote it. ADDITIVE: two new tables, three functions, two triggers, one
-- flag seeded FALSE. NO EXISTING ROW IS READ OR WRITTEN.
--
-- ── 1. THE OBJECT ────────────────────────────────────────────────────────────
-- memory_shared_anchors        one shared experience. It owns NOTHING of anybody's
--                              Memory: it is a link between separate personal
--                              Memories, each of which stays its owner's alone.
--   created_by                 the HOST: the owner of the Memory it was started
--                              from. Only the host invites (see 3 below).
-- memory_shared_anchor_members one row per person asked.
--   status                     invited | accepted | declined | left (CHECK).
--   memory_id                  the member's OWN Memory, optional, set only while
--                              accepted; FK memories ON DELETE SET NULL, and the
--                              guard trigger refuses a Memory the member does not
--                              own (or one that is deleted / removed).
--   consented_at / left_at     stamped by CHECK on accepted / left.
--
-- An anchor is "shared" only while it has TWO OR MORE accepted members — the host
-- (whose own row is accepted when the host starts it: inviting is the host's
-- consent) and at least one invitee who accepted. Until then nobody but the host is
-- in it, and an invitee sees only who invited them.
--
-- ── 2. THE ANCHOR ADDS NO READ GRANT ─────────────────────────────────────────
-- Nothing here changes who may read a Memory. The API (routes/memorySharedAnchors.ts,
-- services/memory/memorySharedAnchors.ts) returns a member's linked Memory id to a
-- viewer ONLY when the existing canReadMemory ladder already admits that viewer, and
-- shows a viewer accepted members only, minus anyone blocked in either direction.
--
-- ── 3. WHO MAY BE INVITED (open owner question Q-H53-1; fail-closed default) ──
-- memory_shared_anchor_invite(memory, inviter, invitee) is the ONE writer of new
-- rows. It re-checks, in the transaction that writes: the Memory is the inviter's,
-- live (not deleted / removed); the invitee holds an APPROVED memory_tags row on it
-- (not pending, not removed; not trip crew, not anyone else); the inviter is the
-- anchor's host. Blocks are checked by the API with the shared readers
-- (lib/exclusionSet.ts) before it calls this — a second copy of the block rule in
-- SQL would drift. A transaction-scoped advisory lock per Memory makes
-- find-or-create race-free, and the partial UNIQUE index on memory_id makes a
-- Memory belong to at most one anchor.
--
-- ── 4. DISSOLUTION = ERASURE (open owner question Q-H53-4; fail-closed default) ─
-- memory_shared_anchor_dissolve() runs AFTER every status change and every DELETE
-- of a member row (a leave, a decline, an account deletion's cascade). When the host
-- is no longer an accepted member, or fewer than two people remain invited or
-- accepted, the anchor is DELETED and every member row with it (CASCADE) — the
-- declined and left rows included, so nothing about who was asked or who said no
-- survives the anchor. Until then a declined or left row is kept so that person is
-- not re-invited into the same anchor. Deleting the host's account cascades the
-- anchor; deleting a member's account deletes their row and re-runs the rule.
--
-- ── 5. ACCESS ────────────────────────────────────────────────────────────────
-- RLS ON with NO policy; every client privilege revoked (check:client-privilege-
-- boundary rule 4); service_role holds exactly SELECT, INSERT, UPDATE, DELETE and
-- EXECUTE on the invite function. No client role can execute any function here.
--
-- ── 6. THE FLAG ──────────────────────────────────────────────────────────────
-- memory_shared_anchors_enabled, seeded FALSE here, so the row exists exactly where
-- the tables do. FALSE or absent: every route answers as if it did not exist (the
-- request falls through to the API's own "no such route") and nothing is read past
-- the flag or written. Turning it on is the owner's call, after the client half
-- (cluster MEM-ANCHOR-2) exists.
--
-- Rollback: db/rollback/2026-10-14-3805-memory-shared-anchors-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3805): auth.users is missing — the erasure cascades cannot be created.';
  END IF;
  IF to_regclass('public.memories') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3805): public.memories does not exist.';
  END IF;
  IF to_regclass('public.memory_tags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3805): public.memory_tags does not exist — an invitation needs an approved tag.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3805): public.feature_flags does not exist.';
  END IF;
END $pre$;

-- ── 1. The tables ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.memory_shared_anchors (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.memory_shared_anchor_members (
  anchor_id    uuid NOT NULL REFERENCES public.memory_shared_anchors (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  memory_id    uuid NULL REFERENCES public.memories (id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'invited',
  invited_at   timestamptz NOT NULL DEFAULT now(),
  consented_at timestamptz NULL,
  left_at      timestamptz NULL,
  PRIMARY KEY (anchor_id, user_id),
  CONSTRAINT memory_shared_anchor_members_status_check
    CHECK (status IN ('invited', 'accepted', 'declined', 'left')),
  CONSTRAINT memory_shared_anchor_members_consent_stamped
    CHECK (status <> 'accepted' OR consented_at IS NOT NULL),
  CONSTRAINT memory_shared_anchor_members_left_stamped
    CHECK (status <> 'left' OR left_at IS NOT NULL),
  CONSTRAINT memory_shared_anchor_members_memory_while_accepted
    CHECK (memory_id IS NULL OR status = 'accepted')
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_shared_anchor_members_memory_once
  ON public.memory_shared_anchor_members (memory_id) WHERE memory_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_shared_anchor_members_user_idx
  ON public.memory_shared_anchor_members (user_id);
CREATE INDEX IF NOT EXISTS memory_shared_anchors_created_by_idx
  ON public.memory_shared_anchors (created_by);

COMMENT ON TABLE public.memory_shared_anchors IS
  'Spec §5 shared-experience anchor (migration 3805, census H53): a link between separate personal Memories, owning none of them. created_by = the host, the owner of the Memory it was started from. Service role only; erased when it dissolves (memory_shared_anchor_dissolve).';
COMMENT ON TABLE public.memory_shared_anchor_members IS
  'Spec §5 participant consent (migration 3805, census H53): one row per person asked. invited -> accepted | declined; accepted -> left. memory_id is the member''s OWN Memory, only while accepted (guard trigger). Shared = two or more accepted. Service role only.';

-- ── 2. The guard: transitions, immutability, the member's OWN live Memory ─────
CREATE OR REPLACE FUNCTION public.memory_shared_anchor_members_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('invited', 'accepted') THEN
      RAISE EXCEPTION 'memory_shared_anchor_members: a row is created invited (or accepted, for the host), not %', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.anchor_id IS DISTINCT FROM OLD.anchor_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'memory_shared_anchor_members: a membership cannot be moved to another anchor or person'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT ((OLD.status = 'invited' AND NEW.status IN ('accepted', 'declined'))
             OR (OLD.status = 'accepted' AND NEW.status = 'left')) THEN
      RAISE EXCEPTION 'memory_shared_anchor_members: % -> % is not a transition (invited -> accepted | declined; accepted -> left)', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.memory_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.memory_id IS DISTINCT FROM OLD.memory_id) THEN
    IF NOT EXISTS (SELECT 1 FROM public.memories m
                    WHERE m.id = NEW.memory_id AND m.owner_id = NEW.user_id
                      AND m.state NOT IN ('deleted', 'removed')) THEN
      RAISE EXCEPTION 'memory_shared_anchor_members: a member may link only a live Memory they own'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS memory_shared_anchor_members_guard ON public.memory_shared_anchor_members;
CREATE TRIGGER memory_shared_anchor_members_guard
  BEFORE INSERT OR UPDATE ON public.memory_shared_anchor_members
  FOR EACH ROW EXECUTE FUNCTION public.memory_shared_anchor_members_guard();

-- ── 3. Dissolution = erasure (Q-H53-4) ───────────────────────────────────────
-- The anchor row is locked first, so two members leaving at once are judged one
-- after the other (each statement in a READ COMMITTED function sees the other's
-- committed change), and an anchor already erased is a no-op.
CREATE OR REPLACE FUNCTION public.memory_shared_anchor_dissolve()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_anchor uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.anchor_id ELSE NEW.anchor_id END;
  v_host   uuid;
BEGIN
  SELECT a.created_by INTO v_host FROM public.memory_shared_anchors a WHERE a.id = v_anchor FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memory_shared_anchor_members s
                  WHERE s.anchor_id = v_anchor AND s.user_id = v_host AND s.status = 'accepted')
     OR (SELECT count(*) FROM public.memory_shared_anchor_members s
          WHERE s.anchor_id = v_anchor AND s.status IN ('invited', 'accepted')) < 2 THEN
    DELETE FROM public.memory_shared_anchors WHERE id = v_anchor;
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS memory_shared_anchor_members_dissolve ON public.memory_shared_anchor_members;
CREATE TRIGGER memory_shared_anchor_members_dissolve
  AFTER UPDATE OF status OR DELETE ON public.memory_shared_anchor_members
  FOR EACH ROW EXECUTE FUNCTION public.memory_shared_anchor_dissolve();

-- ── 4. The one writer of new rows: invite (Q-H53-1) ─────────────────────────
-- Outcomes: invited | already_invited | not_found (the Memory is missing, not
-- live, or not the inviter's) | not_invitable (no APPROVED tag, or the inviter
-- themself) | not_host (the Memory is linked to an anchor someone else hosts).
CREATE OR REPLACE FUNCTION public.memory_shared_anchor_invite(p_memory_id uuid, p_inviter_id uuid, p_invitee_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_owner   uuid;
  v_state   text;
  v_anchor  uuid;
  v_host    uuid;
  v_created boolean := false;
BEGIN
  IF p_memory_id IS NULL OR p_inviter_id IS NULL OR p_invitee_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('memory_shared_anchor:' || p_memory_id::text, 0));

  SELECT m.owner_id, m.state INTO v_owner, v_state FROM public.memories m WHERE m.id = p_memory_id;
  IF NOT FOUND OR v_state IN ('deleted', 'removed') OR v_owner IS DISTINCT FROM p_inviter_id THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF p_invitee_id = p_inviter_id
     OR NOT EXISTS (SELECT 1 FROM public.memory_tags t
                     WHERE t.memory_id = p_memory_id AND t.tagged_user_id = p_invitee_id AND t.status = 'approved') THEN
    RETURN jsonb_build_object('outcome', 'not_invitable');
  END IF;

  SELECT s.anchor_id, a.created_by INTO v_anchor, v_host
    FROM public.memory_shared_anchor_members s
    JOIN public.memory_shared_anchors a ON a.id = s.anchor_id
   WHERE s.memory_id = p_memory_id AND s.status = 'accepted';
  IF FOUND AND v_host IS DISTINCT FROM p_inviter_id THEN
    RETURN jsonb_build_object('outcome', 'not_host');
  END IF;
  IF NOT FOUND THEN
    INSERT INTO public.memory_shared_anchors (created_by) VALUES (p_inviter_id) RETURNING id INTO v_anchor;
    INSERT INTO public.memory_shared_anchor_members (anchor_id, user_id, memory_id, status, consented_at)
      VALUES (v_anchor, p_inviter_id, p_memory_id, 'accepted', now());
    v_created := true;
  END IF;

  INSERT INTO public.memory_shared_anchor_members (anchor_id, user_id, status)
    VALUES (v_anchor, p_invitee_id, 'invited')
    ON CONFLICT (anchor_id, user_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'already_invited', 'anchor_id', v_anchor);
  END IF;
  RETURN jsonb_build_object('outcome', 'invited', 'anchor_id', v_anchor, 'created', v_created);
END
$fn$;

-- ── 5. Access: RLS on, no policy, no client privilege ────────────────────────
ALTER TABLE public.memory_shared_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_shared_anchor_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_shared_anchors FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.memory_shared_anchor_members FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_shared_anchors TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_shared_anchor_members TO service_role;
REVOKE ALL ON FUNCTION public.memory_shared_anchor_invite(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_shared_anchor_invite(uuid, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.memory_shared_anchor_members_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.memory_shared_anchor_dissolve() FROM PUBLIC, anon, authenticated;

-- ── 6. The flag, FALSE ───────────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('memory_shared_anchors_enabled', false,
   'Spec §5 shared-experience anchor (migration 3805, census H53): the owner of a Memory may invite people holding an APPROVED tag on it to "remember this together"; each accepts (optionally linking their OWN Memory), declines or leaves. FALSE / absent = every /memory-shared-anchors and /memories/:id/shared-anchor route answers as if it did not exist and nothing is written. Turning it on is the owner''s call after the client half exists.')
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (recomputed from the catalog; no session state) ───────────
DO $post$
DECLARE
  t text;
  r text;
  p text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.memory_shared_anchors', 'public.memory_shared_anchor_members'] LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3805): % was not created', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass(t)) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3805): row level security is off on %', t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = to_regclass(t)) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3805): % carries a policy — it must have none (service role only)', t;
    END IF;
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege(r, t, p) THEN
          RAISE EXCEPTION 'POSTCONDITION FAILED (3805): % holds % on % — service role only', r, p, t;
        END IF;
      END LOOP;
    END LOOP;
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', t, p) THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3805): service_role lacks % on %', p, t;
      END IF;
    END LOOP;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_shared_anchor_members'::regclass
                   AND conname = 'memory_shared_anchor_members_status_check'
                   AND pg_get_constraintdef(oid) LIKE '%invited%' AND pg_get_constraintdef(oid) LIKE '%accepted%'
                   AND pg_get_constraintdef(oid) LIKE '%declined%' AND pg_get_constraintdef(oid) LIKE '%left%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3805): the member status CHECK (invited | accepted | declined | left) is missing';
  END IF;
  -- Each member's OWN Memory: the link is cut (SET NULL), never the member's row
  -- and never the Memory.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_shared_anchor_members'::regclass
                   AND contype = 'f' AND confrelid = 'public.memories'::regclass AND confdeltype = 'n') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3805): memory_shared_anchor_members.memory_id must reference memories ON DELETE SET NULL';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_shared_anchor_members'::regclass
                   AND contype = 'f' AND confrelid = 'auth.users'::regclass AND confdeltype = 'c')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_shared_anchors'::regclass
                   AND contype = 'f' AND confrelid = 'auth.users'::regclass AND confdeltype = 'c')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_shared_anchor_members'::regclass
                   AND contype = 'f' AND confrelid = 'public.memory_shared_anchors'::regclass AND confdeltype = 'c') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3805): an erasure cascade (auth.users -> anchor / member, anchor -> member) is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                  WHERE i.indrelid = 'public.memory_shared_anchor_members'::regclass AND i.indisunique
                    AND c.relname = 'memory_shared_anchor_members_memory_once' AND i.indpred IS NOT NULL) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3805): a Memory must be linkable to at most one anchor (memory_shared_anchor_members_memory_once)';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.memory_shared_anchor_members'::regclass AND NOT tgisinternal
        AND tgname IN ('memory_shared_anchor_members_guard', 'memory_shared_anchor_members_dissolve') AND tgenabled <> 'D') <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3805): the guard and dissolution triggers are not both installed and enabled';
  END IF;
  IF to_regprocedure('public.memory_shared_anchor_invite(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3805): memory_shared_anchor_invite was not created';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(r, 'public.memory_shared_anchor_invite(uuid,uuid,uuid)', 'EXECUTE')
       OR has_function_privilege(r, 'public.memory_shared_anchor_members_guard()', 'EXECUTE')
       OR has_function_privilege(r, 'public.memory_shared_anchor_dissolve()', 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3805): % may execute a 3805 function — service role only', r;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.memory_shared_anchor_invite(uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3805): service_role cannot execute memory_shared_anchor_invite';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_shared_anchors_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3805): memory_shared_anchors_enabled was not seeded';
  END IF;
END $post$;

COMMIT;
