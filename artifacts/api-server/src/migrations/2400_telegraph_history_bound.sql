-- 2400_telegraph_history_bound.sql
-- Telegraph §14.3 "Group history bounds" — the substrate, and a flag seeded FALSE.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Telegraph lane 2400-2409.
--
-- Both Telegraph specification versions require this (v1_1 is a byte-exact
-- superset of v1; the shared body is identical):
--   §14.3  conversation_member.visibleFromSequence / visibleUntilSequence
--          "New members do not automatically receive pre-membership history."
--   §26    "New member reads pre-membership history without policy → DENY"
--   §29    "No group-add operation that leaks prior DM history."
--   §30A.4 "Conversation membership records must include joined_at, left_at,
--          removed_at, visible_from_sequence, visible_until_sequence, and role."
--   §30A.20 "A newly added group participant cannot read history outside the
--          authorized sequence window."
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT THIS GATES THE FIX FOR
-- ══════════════════════════════════════════════════════════════════════════════
-- GET /api/threads/:threadId/messages (routes/messaging.ts) filters on
-- thread_id plus CURRENT active membership and nothing else. There is no
-- joined_at bound and no sequence. syncTripChatMembers (services/groupChatSync.ts)
-- adds every newly-accepted trip member to the trip thread, and that member can
-- page back through everything said before they existed. GET /me/threads and
-- GET /me/unread-counts read the same rows with the same absence of a bound, so
-- the inbox preview and the unread badge leak the same history.
--
-- Measured 2026-09-07 on production (ajrurzioarfkagpuxfnb), aggregate only:
-- 3 (message, active-member) pairs exist where the member's joined_at is later
-- than a message another member sent. The leak is live, not latent.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY A DEDICATED COLUMN AND NOT joined_at
-- ══════════════════════════════════════════════════════════════════════════════
-- joined_at is NOT a stable interval start in this codebase. The sync writer
-- that owns the mounted GET /trips/:tripId/chat route
-- (services/groupChatSync.ts, reached because routes/index.ts registers
-- messagingRouter before groupChatRouter) UPSERTS every accepted member with
-- `joined_at: now` on EVERY sync, ignoreDuplicates: false. Any trip acceptance
-- rewrites joined_at for every existing member of that thread. A bound keyed on
-- joined_at would therefore hide a long-standing member's OWN history the next
-- time anyone joined. It cannot be the bound.
--
-- So the bound is its own column, visible_from_at, and it is DATABASE-
-- AUTHORITATIVE: a BEFORE trigger sets it, so the two disagreeing sync writers
-- (services/groupChatSync.ts and lib/chatSync.ts) and the two DM creation paths
-- (open-thread, accept-request) all get the same rule without each being edited
-- and without any of them being able to reset it by accident.
--
-- WHY A TIMESTAMP AND NOT visible_from_sequence
-- The spec's word is "sequence". This schema has no sequence column on
-- public.messages; every reader orders and paginates by created_at, and
-- migration 2325 declined to introduce a competing sequence for the same
-- reason (Appendix A: reuse the established convention). The bound is
-- expressed in the same coordinate the readers already use. If a sequence is
-- ever introduced, visible_from_at maps onto it monotonically.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE TRIGGER RULES
-- ══════════════════════════════════════════════════════════════════════════════
--   INSERT       visible_from_at := COALESCE(explicit value, joined_at, now()).
--                A writer that supplies a value (a "policy" grant, §26) keeps
--                it; otherwise the window opens where the membership does.
--   UPDATE       left_at NOT NULL → NULL is a REJOIN, i.e. a new membership
--                interval: visible_from_at := now() unless the writer changed
--                it explicitly. The member does not regain the messages sent
--                while they were out. (OWNER DECISION — see below.)
--   UPDATE       any other update leaves visible_from_at exactly as the writer
--                sent it; an active interval's window does not move under a
--                reconciling upsert because the reconcilers never send the
--                column.
--   NULL         means UNBOUNDED. Every row that exists before this migration
--                keeps NULL. Nothing is backfilled — see below.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY THE READ IS GATED RATHER THAN SHIPPED ON, AND WHAT IS NOT DECIDED HERE
-- ══════════════════════════════════════════════════════════════════════════════
-- Applying a bound can only ever REMOVE messages from somebody's screen. The
-- column and trigger are inert: nothing reads visible_from_at until
-- telegraph_history_bound_enabled is TRUE, and the routes only SELECT the
-- column when the flag reads TRUE, so a build that carries this code is safe
-- against a database that has not run this file.
--
-- OFF (the seed): every reader is byte-for-byte what it is today.
-- ON: GET /threads/:id/messages, its quoted-reply context, GET /me/threads'
--     preview and unread count, GET /me/unread-counts and GET /me/saved-messages
--     exclude messages with created_at < the caller's visible_from_at. A NULL
--     visible_from_at stays unbounded even when ON.
--
-- Read through lib/featureFlags.isFlagEnabled, which is false-on-error, so an
-- unreadable flag leaves the readers unbounded — exactly as they are now —
-- rather than silently hiding history.
--
-- OWNER DECISIONS THIS FILE DOES NOT MAKE:
--   1. Backfill. Existing production rows (18 on 2026-09-07) keep NULL and stay
--      unbounded when the flag turns ON. A backfill from joined_at is REFUSED
--      here because joined_at has been rewritten by the sync (above); it would
--      hide long-standing members' own history. If the owner wants existing
--      members bounded, the value has to be chosen deliberately.
--   2. Rejoin. The trigger treats a rejoin as a new interval (spec §26: a
--      removed member is denied the future sequence; a rejoin is a new
--      membership). If the owner wants a returning member to see the gap, the
--      rejoin branch below is the one line to change.
--   3. Whether a "policy" grant of pre-membership history exists at all. The
--      column accepts an explicit earlier value; no route writes one.
--
-- ROLLBACK: db/rollback/2026-09-07-2400-telegraph-history-bound-rollback.sql

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.message_thread_members') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.message_thread_members must exist.';
  END IF;
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.messages must exist.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags must exist.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'message_thread_members'
       AND column_name = 'joined_at'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: message_thread_members.joined_at must exist.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'message_thread_members'
       AND column_name = 'left_at'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: message_thread_members.left_at must exist.';
  END IF;
END $$;

-- ── The bound (§14.3 visibleFromSequence, in this schema's coordinate) ────────

ALTER TABLE public.message_thread_members
  ADD COLUMN IF NOT EXISTS visible_from_at timestamptz;

COMMENT ON COLUMN public.message_thread_members.visible_from_at IS
  'Telegraph §14.3/§30A.4 visible_from bound. Messages with created_at earlier than this are outside the member''s authorized window. NULL = unbounded (rows that predate migration 2400, or an explicit policy grant). Set by trigger telegraph_member_visibility_window; read only when feature flag telegraph_history_bound_enabled is TRUE.';

-- ── The trigger ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.telegraph_member_visibility_window()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.visible_from_at := COALESCE(NEW.visible_from_at, NEW.joined_at, now());
    RETURN NEW;
  END IF;

  -- UPDATE. A rejoin (left_at NOT NULL -> NULL) is a new membership interval.
  IF OLD.left_at IS NOT NULL AND NEW.left_at IS NULL THEN
    IF NEW.visible_from_at IS NOT DISTINCT FROM OLD.visible_from_at THEN
      NEW.visible_from_at := now();
    END IF;
  END IF;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.telegraph_member_visibility_window() IS
  'Telegraph §14.3: opens a member''s visibility window at the membership start (INSERT) and again on rejoin (left_at NOT NULL -> NULL). Writer-independent so no sync path can reset it by accident. Nothing reads the column unless telegraph_history_bound_enabled is TRUE.';

DROP TRIGGER IF EXISTS telegraph_member_visibility_window ON public.message_thread_members;
CREATE TRIGGER telegraph_member_visibility_window
  BEFORE INSERT OR UPDATE ON public.message_thread_members
  FOR EACH ROW EXECUTE FUNCTION public.telegraph_member_visibility_window();

-- ── The flag, seeded FALSE ────────────────────────────────────────────────────

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('telegraph_history_bound_enabled', false,
   'CAPABILITY gate for Telegraph §14.3 group history bounds. OFF (the seed): every message reader is exactly as before 2400 — a newly added group member can page back through the whole thread. ON: GET /threads/:id/messages (and its quoted-reply context), GET /me/threads preview/unread, GET /me/unread-counts and GET /me/saved-messages exclude messages created before the caller''s message_thread_members.visible_from_at; NULL stays unbounded. Read fail-closed (isFlagEnabled), so an unreadable flag leaves readers unbounded rather than silently hiding history.')
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'message_thread_members'
       AND column_name = 'visible_from_at' AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: message_thread_members.visible_from_at was not created as timestamptz.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'message_thread_members'
      AND t.tgname = 'telegraph_member_visibility_window' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trigger telegraph_member_visibility_window is absent.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_history_bound_enabled'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: feature flag telegraph_history_bound_enabled was not seeded.';
  END IF;
END $$;

COMMIT;
