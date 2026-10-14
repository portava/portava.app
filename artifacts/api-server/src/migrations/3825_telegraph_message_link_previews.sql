-- 3825_telegraph_message_link_previews.sql
-- Telegraph §30A.8 controlled server-side link previews (census-telegraph T404) and §30A.20's
-- "external previews cannot cause recipient-side network disclosure" (T446).
-- POST-CUTOVER CANONICAL FORWARD MIGRATION. B58 cluster TM-1, telegraph+media band 3825-3839.
--
-- Spec §30A.8, verbatim:
--   "External URL previews are fetched through a controlled server-side preview service.
--    Recipients must not silently contact arbitrary sender-provided domains simply to render a
--    preview."
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS FILE ADDS
-- ══════════════════════════════════════════════════════════════════════════════
-- 1. public.message_link_previews — ONE row per message: the text-only preview the server fetched
--    for the first external https link in the message's stored body, when the SENDER asked for it at
--    send time (routes/telegraphLinkPreview.ts). Service role only: RLS on, no policy, every client
--    privilege revoked (check:client-privilege-boundary rule 4). Recipients read it through the
--    API, which never fetches anything at view time.
-- 2. public.telegraph_store_link_preview(...) — the only writer. Takes FOR SHARE on the message
--    row, re-checks that the message is live, plaintext (thread not E2EE) and still has the body
--    the preview was made from (sha256), and inserts at most one row (ON CONFLICT DO NOTHING).
--    An edit / unsend / delete that races the store either waits for it (and its trigger then
--    removes the row) or wins (and the store answers 'message_gone' / 'stale'). service_role only.
-- 3. public.telegraph_link_preview_drop_on_change() + trigger — when a message's body changes
--    (edit, unsend, the tombstone a delete writes) or its deleted_at is set, its preview row is
--    deleted IN THE SAME TRANSACTION. NOT flag-gated: a stored preview lives exactly as long as
--    the body it describes, whatever the flag says later. SECURITY DEFINER because the actor is
--    often a client role that holds no privilege on the preview table (EXECUTE revoked from
--    every client role; pinned search_path).
-- 4. Flag telegraph_link_previews_enabled, seeded FALSE. OFF: no route reads or writes the table.
--
-- RETENTION (owner question Q-LP4, fail-closed default): the life of the message. Hard delete of
-- a message, of its thread, and account erasure (public.messages rows go) CASCADE; unsend, delete
-- and edit remove the row through the trigger. No separate retention period exists.
--
-- ACCOUNT DELETION. ERASED_BY_CASCADE (lib/deletionDispositions.ts): the table carries no person
-- column; every row goes with its message (FK ON DELETE CASCADE) or with the message's tombstone
-- (trigger).
--
-- Nothing is backfilled. No existing row changes. No grant on an existing table changes.
--
-- ROLLBACK: db/rollback/2026-10-14-3825-telegraph-message-link-previews-rollback.sql

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3825): public.messages must exist.';
  END IF;
  IF to_regclass('public.message_threads') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3825): public.message_threads must exist.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3825): public.feature_flags must exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'message_threads' AND column_name = 'is_e2ee') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3825): public.message_threads.is_e2ee must exist.';
  END IF;
END $pre$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. The stored preview — service role only
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.message_link_previews (
  message_id    uuid        PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  thread_id     uuid        NOT NULL REFERENCES public.message_threads(id) ON DELETE CASCADE,
  -- 'ok': a preview was fetched. 'none': the link was fetched and gave nothing previewable (or the
  -- fetch failed) — stored so the sender's retry does not fetch again.
  status        text        NOT NULL CHECK (status IN ('ok', 'none')),
  -- The ORIGINAL link and host as the sender wrote them (normalised). Never the page's or a
  -- redirect's: the recipient is shown the host the link names.
  url           text        NULL CHECK (url IS NULL OR (char_length(url) <= 2048 AND url LIKE 'https://%')),
  host          text        NULL CHECK (host IS NULL OR char_length(host) <= 253),
  title         text        NULL CHECK (title IS NULL OR char_length(title) <= 200),
  description   text        NULL CHECK (description IS NULL OR char_length(description) <= 500),
  site_name     text        NULL CHECK (site_name IS NULL OR char_length(site_name) <= 100),
  -- sha256 (hex) of the body the preview was made from. A row is served only beside that body.
  source_digest text        NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_link_previews_ok_has_link CHECK (status <> 'ok' OR (url IS NOT NULL AND host IS NOT NULL)),
  CONSTRAINT message_link_previews_none_is_empty CHECK (
    status <> 'none' OR (url IS NULL AND host IS NULL AND title IS NULL AND description IS NULL AND site_name IS NULL))
);

CREATE INDEX IF NOT EXISTS message_link_previews_thread_idx
  ON public.message_link_previews (thread_id);

ALTER TABLE public.message_link_previews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.message_link_previews FROM PUBLIC;
REVOKE ALL ON public.message_link_previews FROM anon;
REVOKE ALL ON public.message_link_previews FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.message_link_previews TO service_role;

COMMENT ON TABLE public.message_link_previews IS
  'Telegraph §30A.8 (census-telegraph T404/T446, migration 3825): the text-only link preview the SERVER fetched once, at the sender''s request at send time, for the first external https link in a plaintext message''s stored body. Recipients read it through GET /threads/:id/link-previews, which never fetches. Written only by telegraph_store_link_preview (service_role). Deleted with the message, its thread, its edit, unsend or delete (trigger telegraph_link_preview_drop_on_change). Service role only.';

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. The only writer
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.telegraph_store_link_preview(
  p_message_id    uuid,
  p_thread_id     uuid,
  p_source_digest text,
  p_status        text,
  p_url           text,
  p_host          text,
  p_title         text,
  p_description   text,
  p_site_name     text
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_body    text;
  v_deleted timestamptz;
  v_thread  uuid;
  v_e2ee    boolean;
BEGIN
  -- FOR SHARE: an UPDATE of this message (edit, unsend, delete) now waits for this transaction,
  -- and its trigger then deletes what is inserted below; if it committed first, the row read here
  -- already shows it.
  SELECT m.body, m.deleted_at, m.thread_id
    INTO v_body, v_deleted, v_thread
    FROM public.messages m
   WHERE m.id = p_message_id
     FOR SHARE;
  IF NOT FOUND OR v_deleted IS NOT NULL OR v_thread IS DISTINCT FROM p_thread_id THEN
    RETURN 'message_gone';
  END IF;

  SELECT t.is_e2ee INTO v_e2ee FROM public.message_threads t WHERE t.id = v_thread;
  IF v_e2ee IS DISTINCT FROM false THEN
    RETURN 'e2ee';
  END IF;

  IF v_body IS NULL OR v_body = '' OR encode(sha256(convert_to(v_body, 'UTF8')), 'hex') IS DISTINCT FROM p_source_digest THEN
    RETURN 'stale';
  END IF;

  INSERT INTO public.message_link_previews
    (message_id, thread_id, status, url, host, title, description, site_name, source_digest)
  VALUES
    (p_message_id, v_thread, p_status, p_url, p_host, p_title, p_description, p_site_name, p_source_digest)
  ON CONFLICT (message_id) DO NOTHING;
  IF FOUND THEN
    RETURN 'stored';
  END IF;
  RETURN 'exists';
END
$fn$;

REVOKE ALL ON FUNCTION public.telegraph_store_link_preview(uuid, uuid, text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.telegraph_store_link_preview(uuid, uuid, text, text, text, text, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.telegraph_store_link_preview(uuid, uuid, text, text, text, text, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.telegraph_store_link_preview(uuid, uuid, text, text, text, text, text, text, text) TO service_role;

COMMENT ON FUNCTION public.telegraph_store_link_preview(uuid, uuid, text, text, text, text, text, text, text) IS
  'Telegraph §30A.8 (3825): stores one link preview for a message under FOR SHARE on the message row, after re-checking it is live, in p_thread_id, in a non-E2EE thread and still carries the body whose sha256 is p_source_digest. Outcomes: stored | exists | message_gone | stale | e2ee. service_role only.';

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. The preview goes with the body it describes
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.telegraph_link_preview_drop_on_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  DELETE FROM public.message_link_previews WHERE message_id = NEW.id;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.telegraph_link_preview_drop_on_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.telegraph_link_preview_drop_on_change() FROM anon;
REVOKE ALL ON FUNCTION public.telegraph_link_preview_drop_on_change() FROM authenticated;

COMMENT ON FUNCTION public.telegraph_link_preview_drop_on_change() IS
  'Telegraph §30A.8 (3825): deletes a message''s link preview when its body changes or its deleted_at is set (edit, unsend, delete-for-everyone, any tombstone), in the same transaction. Not flag-gated.';

DROP TRIGGER IF EXISTS telegraph_link_preview_drop_on_change ON public.messages;
CREATE TRIGGER telegraph_link_preview_drop_on_change
  AFTER UPDATE OF body, deleted_at ON public.messages
  FOR EACH ROW
  WHEN (OLD.body IS DISTINCT FROM NEW.body OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL))
  EXECUTE FUNCTION public.telegraph_link_preview_drop_on_change();

-- ══════════════════════════════════════════════════════════════════════════════
-- 4. The flag, seeded FALSE
-- ══════════════════════════════════════════════════════════════════════════════

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('telegraph_link_previews_enabled', false,
   'CAPABILITY gate for Telegraph §30A.8 link previews (census-telegraph T404/T446, migration 3825). OFF (the seed): POST /threads/:id/messages/:id/link-preview answers no_preview and fetches nothing, and GET /threads/:id/link-previews answers an empty list and reads no preview row. ON: the SENDER''s POST, within 15 minutes of writing the message, makes the server fetch the first external https link in the stored body once (text only) and store it; recipients read the stored row only. The drop-on-change trigger runs whatever this says.')
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (each recomputed from the catalog — no session state) ─────
DO $post$
DECLARE
  v_n int;
BEGIN
  IF to_regclass('public.message_link_previews') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3825): public.message_link_previews was not created.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.message_link_previews'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3825): RLS must be enabled on public.message_link_previews.';
  END IF;

  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'message_link_previews';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3825): % polic(ies) on message_link_previews; service role only means none.', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM information_schema.table_privileges
   WHERE table_schema = 'public' AND table_name = 'message_link_previews'
     AND grantee IN ('anon', 'authenticated', 'PUBLIC');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3825): client roles hold % privilege(s) on message_link_previews.', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('telegraph_store_link_preview', 'telegraph_link_preview_drop_on_change')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3825): a client role can EXECUTE a 3825 function.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.messages'::regclass AND NOT tgisinternal
                    AND tgname = 'telegraph_link_preview_drop_on_change') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3825): the drop-on-change trigger is missing on public.messages.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_link_previews_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3825): telegraph_link_previews_enabled was not seeded.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_link_previews_enabled' AND enabled) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3825): telegraph_link_previews_enabled must be seeded FALSE.';
  END IF;
END $post$;

COMMIT;
