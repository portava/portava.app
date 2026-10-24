-- 3938_telegraph_conversation_action_refs_writer.sql
-- Telegraph §12 conversation_action_refs WRITTEN (census-telegraph T147): every Portava object card a
-- conversation carries is recorded as an explicit, revocable reference to its canonical object.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane TELEGRAPH's census-drive band
-- 3934-3949, 2026-10-24).
--
-- WRITTEN, NOT APPLIED. One trigger function and two triggers on public.messages. No backfill (a card
-- older than 3938 has no reference row, which is "predates 3938"); no policy, grant or flag changes.
--
-- WHY. §12 asks for conversation_action_refs: "references to canonical Plans, Trips, Events, Places".
-- 2811 created the table (object_type CHECK, payload_version, revoked_at, member-only SELECT, no client
-- write) and nothing writes it, so a card's object is still only an id inside a JSON body: nothing can
-- join it, revalidate it, or revoke it.
--
-- WHAT IS WRITTEN, AND BY WHOM. The database writes it, from the stored body, so every door that writes
-- a card — the share route, the forward function, the coordination and kinds doors — records the same
-- reference with no application code (3936's content_ref rule, applied to the reference table):
--   a message with msg_type 'portava_object' whose body is a PORTAVA_OBJECT card naming an object of
--   one of 2811's eight types (TRIP→trip, PLAN→plan, EVENT→event, PLACE→place, MEMORY→memory,
--   BOOKING→booking, MEETUP→meetup, POST→post) by a uuid
--     → one row (conversation, message, object type, object id, payload_version = the card's
--       shareProjectionVersion, created_by = the sender).
--   Any other object type (a profile, a stamp, a map pin…), a non-uuid id, a malformed body, an E2EE
--   message (no body) → no row: 2811's CHECK names the eight, and nothing is guessed.
--
-- A RETRACTION ERASES. When the carrying message is unsent or deleted for everyone (a soft
-- tombstone), its references are DELETED in the same transaction — 3936's rule for content_ref ("a
-- tombstone carries no reference … what the retraction removed must not stay addressable"), applied to
-- the reference table. A revoked row would keep the object id and created_by of something its sender
-- took back; no retention ruling covers keeping that, so nothing is kept. 2811's revoked_at /
-- revoked_reason stay for the SOURCE side (an object that stops being shareable), which has no writer
-- yet and is not this migration's.
-- DELETION FATE. A hard DELETE of the message ERASES its references in the same statement (BEFORE
-- DELETE): account deletion erases the account's messages, so a reference — which carries created_by —
-- never outlives them; the thread's own deletion CASCADEs (2811). Registered ERASED_BY_CASCADE in
-- lib/deletionDispositions.ts.
-- NO CLIENT CAN READ A REFERENCE either: 3740 revoked every client grant on the table (applied on
-- production); only the service role reads it, and no server reader exists yet.
--
-- THE FLAG. Like 2810/3936, the writer runs only while telegraph_message_kernel_enabled is TRUE (ON on
-- production since 2026-10-23). Erasure runs whatever the flag says — it only ever removes.
--
-- NO CLIENT CAN WRITE A REFERENCE (unchanged): 2811 gave conversation_action_refs a member-only SELECT
-- policy and no INSERT/UPDATE/DELETE policy; the trigger function is SECURITY DEFINER (it writes a
-- table the inserting role cannot) and EXECUTE is revoked from client roles.
--
-- ORDER INDEPENDENCE: depends on 2811 (the table) and 2810 (unsent_at, the kernel flag). Nothing numbered
-- above 3938 alters conversation_action_refs or defines these names. 3936's content_ref trigger is
-- independent (it writes messages.content_ref; this writes another table).
--
-- ROLLBACK (reference rows already written stay; they are revocable data, not a schema dependency):
--   BEGIN;
--   DROP TRIGGER IF EXISTS telegraph_action_refs_on_insert ON public.messages;
--   DROP TRIGGER IF EXISTS telegraph_action_refs_on_retract ON public.messages;
--   DROP TRIGGER IF EXISTS telegraph_action_refs_on_delete ON public.messages;
--   DROP FUNCTION IF EXISTS public.telegraph_conversation_action_refs_sync();
--   DELETE FROM public.schema_migration_ledger WHERE filename = '3938_telegraph_conversation_action_refs_writer.sql';
--   COMMIT;

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.conversation_action_refs') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3938): public.conversation_action_refs (2811) does not exist.';
  END IF;
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.conversation_action_refs'::regclass AND NOT attisdropped
         AND attname IN ('conversation_id', 'message_id', 'object_type', 'object_id', 'payload_version', 'created_by', 'revoked_at', 'revoked_reason')) <> 8 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3938): conversation_action_refs must carry 2811''s eight columns.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.messages'::regclass AND attname = 'unsent_at' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3938): messages.unsent_at (2810) does not exist.';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.telegraph_conversation_action_refs_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_enabled boolean;
  v_doc     jsonb;
  v_type    text;
  v_id      text;
  v_version integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A reference derived from a message is ERASED with it (account deletion erases the account's
    -- messages; a reference must not outlive them carrying created_by).
    DELETE FROM public.conversation_action_refs WHERE message_id = OLD.id;
    RETURN OLD;  -- a BEFORE DELETE trigger that returned NULL would cancel the delete
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- A retraction erases, whatever the flag says (it only ever removes): a tombstone carries no reference.
    IF (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL) OR (NEW.unsent_at IS NOT NULL AND OLD.unsent_at IS NULL) THEN
      DELETE FROM public.conversation_action_refs WHERE message_id = NEW.id;
    END IF;
    RETURN NULL;
  END IF;

  -- INSERT of a card.
  IF NEW.msg_type IS DISTINCT FROM 'portava_object' OR NEW.body IS NULL OR NEW.body = ''
     OR NEW.deleted_at IS NOT NULL OR NEW.unsent_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag = 'telegraph_message_kernel_enabled';
  IF COALESCE(v_enabled, false) IS NOT TRUE THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_doc := NEW.body::jsonb;
  EXCEPTION WHEN others THEN
    RETURN NULL;  -- not well-formed: no reference is guessed
  END;
  IF jsonb_typeof(v_doc) <> 'object' OR v_doc ->> 'kind' IS DISTINCT FROM 'PORTAVA_OBJECT' THEN
    RETURN NULL;
  END IF;
  v_type := CASE v_doc ->> 'objectType'
              WHEN 'TRIP' THEN 'trip' WHEN 'PLAN' THEN 'plan' WHEN 'EVENT' THEN 'event' WHEN 'PLACE' THEN 'place'
              WHEN 'MEMORY' THEN 'memory' WHEN 'BOOKING' THEN 'booking' WHEN 'MEETUP' THEN 'meetup' WHEN 'POST' THEN 'post'
              ELSE NULL END;
  v_id := v_doc ->> 'objectId';
  IF v_type IS NULL OR v_id IS NULL OR v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  v_version := CASE WHEN (v_doc ->> 'shareProjectionVersion') ~ '^[1-9][0-9]{0,5}$' THEN (v_doc ->> 'shareProjectionVersion')::integer ELSE 1 END;

  INSERT INTO public.conversation_action_refs (conversation_id, message_id, object_type, object_id, payload_version, created_by)
  VALUES (NEW.thread_id, NEW.id, v_type, v_id::uuid, v_version, NEW.sender_id)
  ON CONFLICT ON CONSTRAINT conversation_action_refs_uniq DO NOTHING;
  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION public.telegraph_conversation_action_refs_sync() IS
  'Telegraph §12 (census-telegraph T147, 3938): records each Portava object card as a conversation_action_refs row (one of 2811''s eight object types, a uuid id, payload_version = the card''s shareProjectionVersion) while telegraph_message_kernel_enabled is ON, and ERASES a message''s references when it is unsent, deleted for everyone or hard-deleted (whatever the flag): a tombstone carries no reference (3936''s rule). SECURITY DEFINER; no client role may execute it.';

DROP TRIGGER IF EXISTS telegraph_action_refs_on_insert ON public.messages;
CREATE TRIGGER telegraph_action_refs_on_insert
  AFTER INSERT ON public.messages
  FOR EACH ROW
  WHEN (NEW.msg_type = 'portava_object')
  EXECUTE FUNCTION public.telegraph_conversation_action_refs_sync();

DROP TRIGGER IF EXISTS telegraph_action_refs_on_retract ON public.messages;
CREATE TRIGGER telegraph_action_refs_on_retract
  AFTER UPDATE OF deleted_at, unsent_at ON public.messages
  FOR EACH ROW
  WHEN ((NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL) OR (NEW.unsent_at IS NOT NULL AND OLD.unsent_at IS NULL))
  EXECUTE FUNCTION public.telegraph_conversation_action_refs_sync();

DROP TRIGGER IF EXISTS telegraph_action_refs_on_delete ON public.messages;
CREATE TRIGGER telegraph_action_refs_on_delete
  BEFORE DELETE ON public.messages
  FOR EACH ROW
  WHEN (OLD.msg_type = 'portava_object')
  EXECUTE FUNCTION public.telegraph_conversation_action_refs_sync();

REVOKE ALL ON FUNCTION public.telegraph_conversation_action_refs_sync() FROM PUBLIC, anon, authenticated;

COMMIT;

DO $post$
BEGIN
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'public.messages'::regclass AND NOT tgisinternal AND tgenabled = 'O'
         AND tgname IN ('telegraph_action_refs_on_insert', 'telegraph_action_refs_on_retract', 'telegraph_action_refs_on_delete')) <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3938): the three action-reference triggers are not all present and enabled.';
  END IF;
  IF has_function_privilege('anon', 'public.telegraph_conversation_action_refs_sync()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.telegraph_conversation_action_refs_sync()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3938): a client role can execute telegraph_conversation_action_refs_sync().';
  END IF;
END $post$;
