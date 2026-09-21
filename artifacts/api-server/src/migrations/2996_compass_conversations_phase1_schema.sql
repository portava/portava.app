-- 2996_compass_conversations_phase1_schema.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band), compass lane.
--
-- ═══════════════════════════════════════
-- WHAT THIS IS FOR
-- ═══════════════════════════════════════
-- docs/specs/compass-phase1-spec.md §1 states the conversation schema:
--
--   compass_conversations (id, user_id, trip_id nullable, created_at,
--                          last_active_at, status)
--   compass_messages      (id, conversation_id, role user|assistant|system-event,
--                          content, structured payload, created_at)
--
-- 20260723_compass_conversations.sql shipped the tables WITHOUT `trip_id` and
-- `status`, and with `role` CHECKed to user|assistant only. census-compass
-- C1-01 has graded "the stated schema" ✗ on exactly those three gaps since
-- §13.3, and every other C1-01 criterion passes. This file closes the three.
--
-- ═══════════════════════════════════════
-- WHAT IT DOES NOT DO
-- ═══════════════════════════════════════
-- It renames nothing: the messages table keeps its shipped name
-- `compass_conversation_messages` (the spec's `compass_messages` is a name,
-- not a column, and every reader in the tree uses the shipped one). It writes
-- no rows and changes no existing row: `status` defaults to 'active', which is
-- what every conversation so far has been.
--
-- The service names the two new columns ONLY when a probe finds them
-- (services/compass/CompassConversationService.ts conversationSchemaReady), so
-- a build carrying this file runs unchanged against a database that has not
-- applied it. The migration is therefore safe to apply before or after the
-- build; only `system-event` rows need it applied first, and the service
-- refuses to write one until the probe says so.
--
-- Idempotent: every statement is IF NOT EXISTS / DROP-then-ADD, and the
-- postconditions below verify the end state rather than the path to it.

BEGIN;

ALTER TABLE public.compass_conversations
  ADD COLUMN IF NOT EXISTS trip_id UUID NULL REFERENCES public.trips(id) ON DELETE SET NULL;

ALTER TABLE public.compass_conversations
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE public.compass_conversations
  DROP CONSTRAINT IF EXISTS compass_conversations_status_check;
ALTER TABLE public.compass_conversations
  ADD CONSTRAINT compass_conversations_status_check CHECK (status IN ('active', 'archived'));

-- The reuse read is "this user's most recent ACTIVE conversation".
CREATE INDEX IF NOT EXISTS compass_conversations_user_active_idx
  ON public.compass_conversations (user_id, last_active_at DESC)
  WHERE status = 'active';

-- `role` gains the spec's third value. The constraint name is the one
-- Postgres auto-generated for 20260723's inline CHECK, measured on portava-ci.
ALTER TABLE public.compass_conversation_messages
  DROP CONSTRAINT IF EXISTS compass_conversation_messages_role_check;
ALTER TABLE public.compass_conversation_messages
  ADD CONSTRAINT compass_conversation_messages_role_check
  CHECK (role IN ('user', 'assistant', 'system-event'));

COMMENT ON COLUMN public.compass_conversations.trip_id IS
  'compass-phase1-spec §1: the trip this conversation is about, when the client said so. Nullable; SET NULL when the trip goes.';
COMMENT ON COLUMN public.compass_conversations.status IS
  'compass-phase1-spec §1: active | archived. Only active conversations are reused by getOrCreateConversation.';

-- ── Postconditions: the end state, not the path ──────────────────────────────
DO $post$
DECLARE
  n int;
  def text;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'compass_conversations'
     AND column_name IN ('trip_id', 'status');
  IF n <> 2 THEN RAISE EXCEPTION '2996: compass_conversations is missing trip_id/status (found %)', n; END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'compass_conversation_messages_role_check';
  IF def IS NULL OR position('system-event' IN def) = 0 THEN
    RAISE EXCEPTION '2996: role CHECK does not admit system-event (%)', coalesce(def, 'absent');
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'compass_conversations_status_check';
  IF def IS NULL OR position('archived' IN def) = 0 THEN
    RAISE EXCEPTION '2996: status CHECK is wrong (%)', coalesce(def, 'absent');
  END IF;

  SELECT count(*) INTO n FROM public.compass_conversations WHERE status <> 'active';
  IF n <> 0 THEN RAISE EXCEPTION '2996: % existing conversation(s) are not active after the default', n; END IF;
END $post$;

COMMIT;
