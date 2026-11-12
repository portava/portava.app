-- 3936_telegraph_message_content_ref.sql
-- Telegraph §12 / §12.1 message envelope `contentRef` WRITTEN (census-telegraph T141, T156).
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane TELEGRAPH's census-drive
-- band 3934-3949, 2026-10-24).
--
-- WRITTEN, NOT APPLIED. One trigger function and one trigger on public.messages. No row is
-- backfilled (an existing card keeps content_ref NULL, which is "predates 3936"); no policy,
-- grant or flag changes.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- §12: "Stable envelope, sender, sequence, kind, lifecycle and content reference."
-- 2810 added messages.content_ref — "a reference to structured content held elsewhere, for
-- the card kinds §12.1 says must NOT live as unversioned JSON inside body" — and nothing
-- writes it. On production the other five envelope fields are written (sequence and
-- lifecycle_state by 2810's trigger with the kernel ON; client_message_id / idempotency_key
-- by the send door; unsent_at by 3650's function). This writes the sixth.
--
-- WHAT A CONTENT REFERENCE IS HERE. The one message kind whose content is held elsewhere is
-- the Portava object card: its body is `{"kind":"PORTAVA_OBJECT","objectType":…,"objectId":…,
-- "caption":…,"shareProjectionVersion":…}` (services/telegraph/shareables.ts
-- buildPortavaObjectBody), and the place, plan, trip or memory it names lives in that
-- domain's own table, re-resolved for each viewer. Its content reference is
--
--     portava:<objectType>:<objectId>          e.g. portava:PLACE:3f1c…
--
-- derived from the stored body by the database itself, so every door that writes a card —
-- the share route, the forward function, the coordination and kinds doors — gets the same
-- reference with no application code. Text, media and the versioned typed kinds (their
-- envelope carries kind + envelopeVersion inside body, which is not the "unversioned JSON"
-- §12.1 warns about) are not references to content held elsewhere and stay NULL. A body that
-- is not well-formed JSON, names another kind, or carries an objectType / objectId outside
-- the shape below writes nothing — never a guessed reference.
--
-- A TOMBSTONE CARRIES NO REFERENCE. When a message is unsent (unsent_at) or deleted
-- (deleted_at), content_ref is cleared in the same UPDATE, exactly as the body is blanked:
-- what the retraction removed must not stay addressable through the envelope.
--
-- THE FLAG. 2810's own rule: with telegraph_message_kernel_enabled OFF its triggers return
-- immediately and every reader behaves as before 2810. This trigger reads the same flag and
-- does nothing while it is OFF (it is ON on production since 2026-10-23). The tombstone
-- clear is applied whatever the flag says — it only ever removes.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ORDER INDEPENDENCE (a gap number in the lane band; on portava-ci and production applied
-- after 3999)
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends on 2810 (messages.content_ref, the kernel flag) and the baseline columns body,
-- msg_type, deleted_at. Nothing numbered above 3936 alters messages.content_ref or defines
-- a trigger or function of these names. The other BEFORE triggers on messages
-- (2810's sequence allocation) write other columns, so their order does not matter.
--
-- ROLLBACK (nothing depends on these objects; content_ref values already written stay):
--   BEGIN;
--   DROP TRIGGER IF EXISTS telegraph_message_content_ref ON public.messages;
--   DROP FUNCTION IF EXISTS public.telegraph_message_content_ref();
--   DELETE FROM public.schema_migration_ledger WHERE filename = '3936_telegraph_message_content_ref.sql';
--   COMMIT;

BEGIN;

DO $pre$
BEGIN
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.messages'::regclass AND attnum > 0 AND NOT attisdropped
         AND attname IN ('content_ref', 'body', 'msg_type', 'deleted_at', 'unsent_at')) <> 5 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3936): messages must carry content_ref, unsent_at (2810) and body, msg_type, deleted_at.';
  END IF;
  IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute
       WHERE attrelid = 'public.messages'::regclass AND attname = 'content_ref' AND NOT attisdropped) <> 'text' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3936): messages.content_ref must be text (2810).';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.telegraph_message_content_ref()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_enabled boolean;
  v_doc     jsonb;
  v_type    text;
  v_id      text;
BEGIN
  -- A tombstone carries no reference, whatever the flag says (it only ever removes).
  IF NEW.unsent_at IS NOT NULL OR NEW.deleted_at IS NOT NULL THEN
    NEW.content_ref := NULL;
    RETURN NEW;
  END IF;

  IF NEW.msg_type IS DISTINCT FROM 'portava_object' OR NEW.body IS NULL OR NEW.body = '' THEN
    RETURN NEW;  -- not a card whose content is held elsewhere
  END IF;
  -- An UPDATE that did not touch the body or the kind has nothing to re-derive.
  IF TG_OP = 'UPDATE' AND NEW.body IS NOT DISTINCT FROM OLD.body AND NEW.msg_type IS NOT DISTINCT FROM OLD.msg_type
     AND NEW.content_ref IS NOT DISTINCT FROM OLD.content_ref THEN
    RETURN NEW;
  END IF;

  SELECT enabled INTO v_enabled FROM public.feature_flags WHERE flag = 'telegraph_message_kernel_enabled';
  IF COALESCE(v_enabled, false) IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_doc := NEW.body::jsonb;
  EXCEPTION WHEN others THEN
    NEW.content_ref := NULL;  -- not well-formed: never a guessed reference
    RETURN NEW;
  END;

  v_type := v_doc ->> 'objectType';
  v_id   := v_doc ->> 'objectId';
  IF jsonb_typeof(v_doc) = 'object' AND v_doc ->> 'kind' = 'PORTAVA_OBJECT'
     AND v_type ~ '^[A-Z][A-Z_]{0,31}$' AND v_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' THEN
    NEW.content_ref := 'portava:' || v_type || ':' || v_id;
  ELSE
    NEW.content_ref := NULL;
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.telegraph_message_content_ref() IS
  'Telegraph §12/§12.1 (census-telegraph T141/T156, 3936): writes messages.content_ref = portava:<objectType>:<objectId> for a Portava object card, derived from its stored body; NULL for every other kind and for a body that is not that shape; cleared when the message is unsent or deleted. No-op (except the tombstone clear) while telegraph_message_kernel_enabled is OFF.';

DROP TRIGGER IF EXISTS telegraph_message_content_ref ON public.messages;
CREATE TRIGGER telegraph_message_content_ref
  BEFORE INSERT OR UPDATE OF body, msg_type, content_ref, deleted_at, unsent_at ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.telegraph_message_content_ref();

REVOKE ALL ON FUNCTION public.telegraph_message_content_ref() FROM PUBLIC, anon, authenticated;

COMMIT;

-- ── Postconditions ────────────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.messages'::regclass AND tgname = 'telegraph_message_content_ref'
                    AND tgenabled = 'O' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3936): trigger telegraph_message_content_ref is missing or disabled.';
  END IF;
  IF has_function_privilege('authenticated', 'public.telegraph_message_content_ref()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.telegraph_message_content_ref()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3936): a client role can execute telegraph_message_content_ref().';
  END IF;
END $post$;
