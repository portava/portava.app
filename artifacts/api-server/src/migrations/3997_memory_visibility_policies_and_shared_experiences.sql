-- 3997_memory_visibility_policies_and_shared_experiences.sql
--
-- Highlights/Memories Development Architecture Spec v1
-- (docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt):
--
--   §3.6 "memory_visibility_policies — Audience and location precision policy."
--   §10  "Publishing location must never exceed the owner's selected precision."
--   §25  "Public location precision cannot exceed owner policy."
--   §28.7 "Never allow public location precision above the owner's publication
--         policy."
--   §5   "A shared experience is not one globally editable personal Memory.
--         Prefer a shared-experience anchor plus separate personal Memories.
--         Mutual 'Remember this together' creates an explicitly shared object
--         only after participant consent."
--
-- Census docs/architecture/census-highlights-memories.md: H33 (the table) and
-- H53 (the anchor and participant consent), both NOT-BUILT before this file.
--
-- WRITTEN, NOT APPLIED. Additive: three new tables, seven functions, three
-- triggers (one on public.memories, firing only when a Memory is deleted or
-- removed), two flags seeded FALSE. No existing row is read or written.
--
-- ── PART 1. memory_visibility_policies (H33) ────────────────────────────────
-- One row per (owner, audience): the owner's PUBLICATION POLICY, i.e. the finest
-- location precision any Memory of theirs may be served at to that audience.
-- The audience is the Memory's own audience class (memories.visibility mapped to
-- §4's VisibilityClass: public -> 'public', friends_only -> 'followers',
-- trip_crew -> 'trip_crew', circle_only / custom -> 'selected_people').
-- 'private' (only_me) has no row: an owner-only Memory has no other viewer.
--
-- It does not replace memories.location_precision (2338), which is §3.1's
-- per-Memory rung. The two compose by taking the STRICTER rung, together with
-- the Hidden-Gem ceiling; nothing can widen another
-- (services/memory/memoryVisibilityPolicies.ts). No row = no owner ceiling for
-- that audience, which is today's behaviour. No default is chosen here: what a
-- new owner's policy should be is the owner's call, not a migration's.
--
-- The ladder is 2338's, lower case and in the spec's order
-- (lib/memoryLocationPrecision.ts MEMORY_LOCATION_PRECISIONS).
--
-- ── PART 2. memory_shared_experiences + invitations (H53) ───────────────────
-- memory_shared_experience_invitations is the CONSENT LEDGER. The owner of a
-- Memory (the host) may invite a person who holds an APPROVED memory_tags row on
-- that Memory. The invitee answers:
--     pending -> accepted | declined;   accepted -> left
-- (trigger-enforced; rows are created pending; declined and left are final for
-- that Memory, so a "no" is not re-asked). A pending invitation the host
-- withdraws is deleted.
--
-- memory_shared_experiences is the SHARED OBJECT. It is created ONLY by
-- memory_shared_experience_respond, in the same transaction as the FIRST
-- acceptance — so it never exists before a participant consented — and it is
-- erased when no accepted participant remains (memory_shared_experience_dissolve),
-- when the host ends it, when the host's Memory is deleted, or when the host's
-- account is erased. It OWNS NO MEMORY: it links the host's Memory to each
-- participant's OWN Memory (participant_memory_id, optional, only while
-- accepted, and only a live Memory the participant owns — guard trigger). Each
-- Memory stays its owner's alone, editable only by its owner (§5 "not one
-- globally editable personal Memory"). The anchor grants no read access: the API
-- (routes/memorySharedExperiences.ts) shows a linked Memory only where the
-- existing canReadMemory ladder already admits the viewer, and never shows a
-- member blocked in either direction.
--
-- ── ACCESS ───────────────────────────────────────────────────────────────────
-- Every table: RLS enabled with no policy (deny by default for clients), every
-- client privilege revoked, service_role holds exactly SELECT, INSERT, UPDATE,
-- DELETE. Every function is SECURITY INVOKER with a pinned search_path, and only
-- service_role may execute it. This is the 3990–3993 shape for server-only
-- Memory tables.
--
-- ── FLAGS ────────────────────────────────────────────────────────────────────
-- memory_visibility_policies_enabled and memory_shared_experiences_enabled are
-- seeded FALSE. Off or absent: the routes answer as if they did not exist, no
-- policy is read or written, and the shared-experience functions refuse
-- ('disabled'). Turning either on is the owner's call.
--
-- Rollback (nothing else depends on these objects):
--   DROP TABLE IF EXISTS public.memory_shared_experience_invitations,
--     public.memory_shared_experiences, public.memory_visibility_policies;
--   DROP FUNCTION IF EXISTS public.memory_shared_experience_invite(uuid, uuid, uuid),
--     public.memory_shared_experience_respond(uuid, uuid, boolean, uuid),
--     public.memory_shared_experience_leave(uuid, uuid),
--     public.memory_shared_experience_end(uuid, uuid),
--     public.memory_shared_experience_invitations_guard(),
--     public.memory_shared_experience_dissolve();
--   DROP TRIGGER IF EXISTS memory_shared_experience_memory_gone ON public.memories;
--   DROP FUNCTION IF EXISTS public.memory_shared_experience_memory_gone();
--   DELETE FROM public.feature_flags WHERE flag IN
--     ('memory_visibility_policies_enabled', 'memory_shared_experiences_enabled');

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3997): auth.users is missing; the erasure cascades cannot be created';
  END IF;
  IF to_regclass('public.memories') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3997): public.memories does not exist';
  END IF;
  IF to_regclass('public.memory_tags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3997): public.memory_tags does not exist; an invitation needs an approved tag';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3997): public.feature_flags does not exist';
  END IF;
END
$pre$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('memory_visibility_policies_enabled', false,
   '3997 (census H33): the owner''s per-audience location precision policy (memory_visibility_policies). FALSE / absent: the policy routes answer as if absent and no non-owner read consults the table.'),
  ('memory_shared_experiences_enabled', false,
   '3997 (census H53): "Remember this together". The owner of a Memory invites people holding an approved tag on it; the shared experience exists only after one of them consents. FALSE / absent: every route answers as if absent and every function refuses.')
ON CONFLICT (flag) DO NOTHING;

-- ── PART 1 ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.memory_visibility_policies (
  owner_id           uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  audience           text NOT NULL,
  location_precision text NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, audience),
  CONSTRAINT memory_visibility_policies_audience_check
    CHECK (audience IN ('public', 'followers', 'trip_crew', 'selected_people')),
  CONSTRAINT memory_visibility_policies_precision_check
    CHECK (location_precision IN ('exact', 'venue', 'neighborhood', 'city', 'country', 'hidden'))
);

COMMENT ON TABLE public.memory_visibility_policies IS
  'Spec §3.6 memory_visibility_policies (3997, census H33): the owner''s publication policy, one location-precision ceiling per audience class. Composes stricter-wins with memories.location_precision (2338) and the Hidden-Gem ceiling. No row = no ceiling. Service role only.';

-- ── PART 2 ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.memory_shared_experiences (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id        uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  host_memory_id uuid NOT NULL REFERENCES public.memories (id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_shared_experiences_one_per_memory UNIQUE (host_memory_id)
);

CREATE TABLE IF NOT EXISTS public.memory_shared_experience_invitations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_memory_id        uuid NOT NULL REFERENCES public.memories (id) ON DELETE CASCADE,
  host_id               uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  invitee_id            uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  status                text NOT NULL DEFAULT 'pending',
  experience_id         uuid NULL REFERENCES public.memory_shared_experiences (id) ON DELETE CASCADE,
  participant_memory_id uuid NULL REFERENCES public.memories (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  responded_at          timestamptz NULL,
  left_at               timestamptz NULL,
  CONSTRAINT memory_shared_experience_invitations_status_check
    CHECK (status IN ('pending', 'accepted', 'declined', 'left')),
  CONSTRAINT memory_shared_experience_invitations_not_self
    CHECK (host_id <> invitee_id),
  CONSTRAINT memory_shared_experience_invitations_once
    UNIQUE (host_memory_id, invitee_id),
  CONSTRAINT memory_shared_experience_invitations_answered
    CHECK ((status = 'pending') = (responded_at IS NULL)),
  CONSTRAINT memory_shared_experience_invitations_left_stamped
    CHECK ((status = 'left') = (left_at IS NOT NULL)),
  CONSTRAINT memory_shared_experience_invitations_member_only_when_accepted
    CHECK ((status = 'accepted') = (experience_id IS NOT NULL)),
  CONSTRAINT memory_shared_experience_invitations_link_only_when_accepted
    CHECK (participant_memory_id IS NULL OR status = 'accepted')
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_shared_experience_invitations_link_once
  ON public.memory_shared_experience_invitations (participant_memory_id) WHERE participant_memory_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_shared_experience_invitations_invitee_idx
  ON public.memory_shared_experience_invitations (invitee_id, status);
CREATE INDEX IF NOT EXISTS memory_shared_experience_invitations_experience_idx
  ON public.memory_shared_experience_invitations (experience_id);
CREATE INDEX IF NOT EXISTS memory_shared_experiences_host_idx
  ON public.memory_shared_experiences (host_id);

COMMENT ON TABLE public.memory_shared_experiences IS
  'Spec §5 shared-experience anchor (3997, census H53). Created only with the first participant''s consent; erased when none remains. Links separate personal Memories and owns none of them. Service role only.';
COMMENT ON TABLE public.memory_shared_experience_invitations IS
  'Spec §5 participant consent (3997, census H53): pending -> accepted | declined; accepted -> left. participant_memory_id is the participant''s OWN live Memory, only while accepted. Service role only.';

-- The guard: rows start pending, transitions are the consent ledger's, identities
-- never move, and a linked Memory is the participant's own live Memory.
CREATE OR REPLACE FUNCTION public.memory_shared_experience_invitations_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.experience_id IS NOT NULL OR NEW.participant_memory_id IS NOT NULL THEN
      RAISE EXCEPTION 'memory_shared_experience_invitations: an invitation is created pending, unanswered and unlinked'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.host_memory_id IS DISTINCT FROM OLD.host_memory_id
       OR NEW.host_id IS DISTINCT FROM OLD.host_id OR NEW.invitee_id IS DISTINCT FROM OLD.invitee_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'memory_shared_experience_invitations: who invited whom to which Memory cannot change'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT ((OLD.status = 'pending' AND NEW.status IN ('accepted', 'declined'))
             OR (OLD.status = 'accepted' AND NEW.status = 'left')) THEN
      RAISE EXCEPTION 'memory_shared_experience_invitations: % -> % is not a consent transition', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.participant_memory_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.participant_memory_id IS DISTINCT FROM OLD.participant_memory_id)
     AND NOT EXISTS (SELECT 1 FROM public.memories m
                      WHERE m.id = NEW.participant_memory_id AND m.owner_id = NEW.invitee_id
                        AND m.state NOT IN ('deleted', 'removed')) THEN
    RAISE EXCEPTION 'memory_shared_experience_invitations: a participant may link only a live Memory they own'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS memory_shared_experience_invitations_guard ON public.memory_shared_experience_invitations;
CREATE TRIGGER memory_shared_experience_invitations_guard
  BEFORE INSERT OR UPDATE ON public.memory_shared_experience_invitations
  FOR EACH ROW EXECUTE FUNCTION public.memory_shared_experience_invitations_guard();

-- Dissolution: an experience with no accepted participant is erased. Runs after
-- every status change and every deletion of an invitation (a leave, an account
-- erasure's cascade). The experience row is locked first, so two participants
-- leaving at once are judged one after the other.
CREATE OR REPLACE FUNCTION public.memory_shared_experience_dissolve()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_experience uuid := OLD.experience_id;
BEGIN
  IF v_experience IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM public.memory_shared_experiences e WHERE e.id = v_experience FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memory_shared_experience_invitations i
                  WHERE i.experience_id = v_experience AND i.status = 'accepted') THEN
    DELETE FROM public.memory_shared_experiences WHERE id = v_experience;
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS memory_shared_experience_dissolve ON public.memory_shared_experience_invitations;
CREATE TRIGGER memory_shared_experience_dissolve
  AFTER UPDATE OF status OR DELETE ON public.memory_shared_experience_invitations
  FOR EACH ROW EXECUTE FUNCTION public.memory_shared_experience_dissolve();

-- invite: the ONE writer of new invitations. Outcomes: invited | already_invited
-- | already_member | answered (declined or left: final for this Memory) |
-- not_found (Memory missing, not live, or not the host's) | not_invitable (no
-- APPROVED tag on the Memory, or the host themself) | disabled.
-- Blocks are checked by the API (memoryReadPolicy.isBlocked) before this is
-- called; a second copy of the block rule in SQL would drift.
CREATE OR REPLACE FUNCTION public.memory_shared_experience_invite(p_host_id uuid, p_memory_id uuid, p_invitee_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_owner  uuid;
  v_state  text;
  v_status text;
  v_id     uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_shared_experiences_enabled' AND enabled IS TRUE) THEN
    RETURN jsonb_build_object('outcome', 'disabled');
  END IF;
  IF p_host_id IS NULL OR p_memory_id IS NULL OR p_invitee_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  SELECT m.owner_id, m.state INTO v_owner, v_state FROM public.memories m WHERE m.id = p_memory_id FOR SHARE;
  IF NOT FOUND OR v_owner IS DISTINCT FROM p_host_id OR v_state IN ('deleted', 'removed') THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF p_invitee_id = p_host_id OR NOT EXISTS (
       SELECT 1 FROM public.memory_tags t
        WHERE t.memory_id = p_memory_id AND t.tagged_user_id = p_invitee_id AND t.status = 'approved') THEN
    RETURN jsonb_build_object('outcome', 'not_invitable');
  END IF;
  SELECT i.status, i.id INTO v_status, v_id FROM public.memory_shared_experience_invitations i
   WHERE i.host_memory_id = p_memory_id AND i.invitee_id = p_invitee_id FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', CASE v_status WHEN 'pending' THEN 'already_invited'
                                                       WHEN 'accepted' THEN 'already_member'
                                                       ELSE 'answered' END,
                              'invitation_id', v_id);
  END IF;
  INSERT INTO public.memory_shared_experience_invitations (host_memory_id, host_id, invitee_id)
    VALUES (p_memory_id, p_host_id, p_invitee_id)
    ON CONFLICT (host_memory_id, invitee_id) DO NOTHING
    RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'already_invited');
  END IF;
  RETURN jsonb_build_object('outcome', 'invited', 'invitation_id', v_id);
END
$fn$;

-- respond: the invitee's consent. Accepting the FIRST time creates the shared
-- experience in this same transaction. Outcomes: accepted | declined |
-- not_found (no pending invitation of this person's) | host_memory_gone |
-- memory_not_linkable (the Memory offered is not this person's live Memory, or
-- is already linked to another shared experience) | disabled.
CREATE OR REPLACE FUNCTION public.memory_shared_experience_respond(p_invitation_id uuid, p_invitee_id uuid, p_accept boolean, p_participant_memory_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_inv        public.memory_shared_experience_invitations%ROWTYPE;
  v_state      text;
  v_experience uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_shared_experiences_enabled' AND enabled IS TRUE) THEN
    RETURN jsonb_build_object('outcome', 'disabled');
  END IF;
  IF p_invitation_id IS NULL OR p_invitee_id IS NULL OR p_accept IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  SELECT * INTO v_inv FROM public.memory_shared_experience_invitations i
   WHERE i.id = p_invitation_id AND i.invitee_id = p_invitee_id FOR UPDATE;
  IF NOT FOUND OR v_inv.status <> 'pending' THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF NOT p_accept THEN
    UPDATE public.memory_shared_experience_invitations SET status = 'declined', responded_at = now() WHERE id = v_inv.id;
    RETURN jsonb_build_object('outcome', 'declined');
  END IF;
  SELECT m.state INTO v_state FROM public.memories m WHERE m.id = v_inv.host_memory_id AND m.owner_id = v_inv.host_id FOR SHARE;
  IF NOT FOUND OR v_state IN ('deleted', 'removed') THEN
    RETURN jsonb_build_object('outcome', 'host_memory_gone');
  END IF;
  -- The invitation stands on the invitee's approved tag. A tag the host or the
  -- invitee removed since is no longer evidence they were there together.
  IF NOT EXISTS (SELECT 1 FROM public.memory_tags t WHERE t.memory_id = v_inv.host_memory_id
                  AND t.tagged_user_id = p_invitee_id AND t.status = 'approved') THEN
    RETURN jsonb_build_object('outcome', 'not_invitable');
  END IF;
  IF p_participant_memory_id IS NOT NULL AND (
       NOT EXISTS (SELECT 1 FROM public.memories m WHERE m.id = p_participant_memory_id
                    AND m.owner_id = p_invitee_id AND m.state NOT IN ('deleted', 'removed'))
       OR EXISTS (SELECT 1 FROM public.memory_shared_experience_invitations o
                   WHERE o.participant_memory_id = p_participant_memory_id)
       OR EXISTS (SELECT 1 FROM public.memory_shared_experiences e
                   WHERE e.host_memory_id = p_participant_memory_id)) THEN
    RETURN jsonb_build_object('outcome', 'memory_not_linkable');
  END IF;
  INSERT INTO public.memory_shared_experiences (host_id, host_memory_id)
    VALUES (v_inv.host_id, v_inv.host_memory_id)
    ON CONFLICT (host_memory_id) DO NOTHING;
  SELECT e.id INTO v_experience FROM public.memory_shared_experiences e
   WHERE e.host_memory_id = v_inv.host_memory_id FOR UPDATE;
  UPDATE public.memory_shared_experience_invitations
     SET status = 'accepted', responded_at = now(), experience_id = v_experience,
         participant_memory_id = p_participant_memory_id
   WHERE id = v_inv.id;
  RETURN jsonb_build_object('outcome', 'accepted', 'experience_id', v_experience);
END
$fn$;

-- leave: a participant leaves (their consent is withdrawn; the experience
-- dissolves through the trigger when no participant remains). Outcomes: left |
-- not_member. The flag is deliberately NOT checked: turning the feature off must
-- never trap a person inside a shared experience they want to leave.
CREATE OR REPLACE FUNCTION public.memory_shared_experience_leave(p_experience_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  IF p_experience_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_member');
  END IF;
  UPDATE public.memory_shared_experience_invitations
     SET status = 'left', left_at = now(), experience_id = NULL, participant_memory_id = NULL
   WHERE experience_id = p_experience_id AND invitee_id = p_user_id AND status = 'accepted'
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_member');
  END IF;
  RETURN jsonb_build_object('outcome', 'left');
END
$fn$;

-- end: the host ends the shared experience for everyone. The experience and every
-- invitation of the host's Memory are erased, the declined and left ones
-- included, so nothing about who was asked survives it. Outcomes: ended |
-- not_found (no experience or pending invitation on a Memory this host owns).
CREATE OR REPLACE FUNCTION public.memory_shared_experience_end(p_host_id uuid, p_memory_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_gone integer := 0;
  v_n    integer;
BEGIN
  IF p_host_id IS NULL OR p_memory_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  DELETE FROM public.memory_shared_experiences WHERE host_memory_id = p_memory_id AND host_id = p_host_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_gone := v_gone + v_n;
  DELETE FROM public.memory_shared_experience_invitations WHERE host_memory_id = p_memory_id AND host_id = p_host_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_gone := v_gone + v_n;
  RETURN jsonb_build_object('outcome', CASE WHEN v_gone > 0 THEN 'ended' ELSE 'not_found' END);
END
$fn$;

-- A Memory that is deleted or removed (a soft delete: memories.state) takes its
-- shared experience with it, as a hard delete does through the cascades: the
-- experience and every invitation of a HOST Memory are erased, and a
-- PARTICIPANT's link to it is cut while their acceptance stands. SECURITY
-- DEFINER because the UPDATE that fires it may be any role that may write
-- memories, none of which holds a privilege on these tables; search_path is
-- pinned and no client role may execute it.
CREATE OR REPLACE FUNCTION public.memory_shared_experience_memory_gone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  DELETE FROM public.memory_shared_experiences WHERE host_memory_id = NEW.id;
  DELETE FROM public.memory_shared_experience_invitations WHERE host_memory_id = NEW.id;
  UPDATE public.memory_shared_experience_invitations SET participant_memory_id = NULL
   WHERE participant_memory_id = NEW.id;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS memory_shared_experience_memory_gone ON public.memories;
CREATE TRIGGER memory_shared_experience_memory_gone
  AFTER UPDATE OF state ON public.memories
  FOR EACH ROW
  WHEN (NEW.state IN ('deleted', 'removed') AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION public.memory_shared_experience_memory_gone();

-- ── Access ───────────────────────────────────────────────────────────────────
ALTER TABLE public.memory_visibility_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_shared_experiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_shared_experience_invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_visibility_policies FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.memory_shared_experiences FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.memory_shared_experience_invitations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_visibility_policies TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_shared_experiences TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_shared_experience_invitations TO service_role;

REVOKE ALL ON FUNCTION public.memory_shared_experience_invite(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.memory_shared_experience_respond(uuid, uuid, boolean, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.memory_shared_experience_leave(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.memory_shared_experience_end(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.memory_shared_experience_invitations_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.memory_shared_experience_dissolve() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.memory_shared_experience_memory_gone() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_shared_experience_invite(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.memory_shared_experience_respond(uuid, uuid, boolean, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.memory_shared_experience_leave(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.memory_shared_experience_end(uuid, uuid) TO service_role;

-- ── Postconditions (recomputed from the catalog in this transaction) ─────────
DO $post$
DECLARE
  t text;
  r text;
  p text;
  f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.memory_visibility_policies', 'public.memory_shared_experiences',
                           'public.memory_shared_experience_invitations'] LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3997): % was not created', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass(t)) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3997): row level security is off on %', t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = to_regclass(t)) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3997): % carries a policy; it is service-role only', t;
    END IF;
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege(r, t, p) THEN
          RAISE EXCEPTION 'POSTCONDITION FAILED (3997): % holds % on %', r, p, t;
        END IF;
      END LOOP;
    END LOOP;
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', t, p) THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3997): service_role lacks % on %', p, t;
      END IF;
    END LOOP;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_visibility_policies'::regclass
                   AND conname = 'memory_visibility_policies_precision_check'
                   AND pg_get_constraintdef(oid) LIKE '%exact%' AND pg_get_constraintdef(oid) LIKE '%hidden%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3997): the precision ladder CHECK is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_shared_experience_invitations'::regclass
                   AND conname = 'memory_shared_experience_invitations_member_only_when_accepted') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3997): an experience link must exist only while accepted';
  END IF;
  -- The erasure cascades: account -> policy / experience / invitation (host and
  -- invitee), host Memory -> experience / invitation, experience -> invitation.
  IF (SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND confdeltype = 'c' AND conrelid IN (
        'public.memory_visibility_policies'::regclass, 'public.memory_shared_experiences'::regclass,
        'public.memory_shared_experience_invitations'::regclass)) <> 7 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3997): the seven erasure cascades are not all present';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_shared_experience_invitations'::regclass
                   AND contype = 'f' AND confrelid = 'public.memories'::regclass AND confdeltype = 'n') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3997): a participant''s own Memory must be unlinked (SET NULL), never deleted';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.memory_shared_experience_invitations'::regclass
        AND NOT tgisinternal AND tgenabled <> 'D'
        AND tgname IN ('memory_shared_experience_invitations_guard', 'memory_shared_experience_dissolve')) <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3997): the guard and dissolution triggers are not both installed and enabled';
  END IF;
  FOREACH f IN ARRAY ARRAY['public.memory_shared_experience_invite(uuid,uuid,uuid)',
                           'public.memory_shared_experience_respond(uuid,uuid,boolean,uuid)',
                           'public.memory_shared_experience_leave(uuid,uuid)',
                           'public.memory_shared_experience_end(uuid,uuid)'] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3997): % was not created', f;
    END IF;
    IF (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(f)) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3997): % must be SECURITY INVOKER', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3997): % must be executable by service_role only', f;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.memories'::regclass AND NOT tgisinternal
                   AND tgname = 'memory_shared_experience_memory_gone' AND tgenabled <> 'D')
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.memory_shared_experience_memory_gone()'::regprocedure)
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.memory_shared_experience_memory_gone()'::regprocedure
                     AND proconfig IS NOT NULL AND array_to_string(proconfig, ',') LIKE 'search_path=%')
     OR has_function_privilege('anon', 'public.memory_shared_experience_memory_gone()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.memory_shared_experience_memory_gone()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3997): the deleted-Memory trigger must be installed, SECURITY DEFINER with a pinned search_path, and not client-executable';
  END IF;
  IF (SELECT count(*) FROM public.feature_flags
       WHERE flag IN ('memory_visibility_policies_enabled', 'memory_shared_experiences_enabled')) <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3997): the two flags were not seeded';
  END IF;
END
$post$;

COMMIT;
