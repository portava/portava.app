-- 3665_telegraph_forwarding_and_structured_schemas.sql
-- Telegraph §30A.9 forwarding provenance + content capabilities (census-telegraph T406, T407),
-- share-revocation propagation for EXPIRES_WITH_SOURCE (T353), and the flag for §30A.16's
-- versioned structured-message schemas + client capability negotiation (T429, T431).
-- POST-CUTOVER CANONICAL FORWARD MIGRATION. Lane T-PLAT band 3665-3669.
--
-- Spec §30A.9, verbatim:
--   "Track whether a message derivative is FORWARDED, RESHARED_FROM_SOURCE, or COPIED_ATTACHMENT
--    without exposing private conversation lineage to recipients. Content capabilities may specify
--    ALLOW, NO_FORWARD, SOURCE_POLICY, or EXPIRES_WITH_SOURCE."
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS FILE ADDS
-- ══════════════════════════════════════════════════════════════════════════════
-- 1. public.message_content_capabilities — the capability an AUTHOR stated on their own message.
--    No row = SOURCE_POLICY (services/telegraph/forwarding.ts, proposed ruling P-TPLAT-1).
-- 2. public.message_forwards — one row per derivative: which message it was made from, its
--    provenance and the capability it inherited. THE LINEAGE. Service role only: RLS on, no
--    policy, every client grant revoked; no client — not the forwarder, not the new audience —
--    can read a source id out of it. The thread read exposes only the provenance word.
-- 3. public.telegraph_record_forward(...) — the derivative and its provenance row in ONE
--    transaction, after re-checking under row locks that the source is live and that its
--    capability is the one the caller decided on. service_role only.
-- 4. public.telegraph_forward_expire_with_source() + two triggers on public.messages — when a
--    source is deleted or unsent (deleted_at goes NULL -> set; unsend sets it too, 3000) or hard
--    deleted, every derivative made under EXPIRES_WITH_SOURCE — or whose source's author has
--    since stated EXPIRES_WITH_SOURCE — is tombstoned (deleted_at, body '') IN THE SAME
--    TRANSACTION, and its provenance row stamped revoked_at. A derivative's own tombstone fires
--    the same trigger, so a chain of forwards expires to its end. T353's latency is therefore
--    zero commits: no reader on any path (API, PostgREST, realtime) can observe the source gone
--    and a derivative live. SECURITY DEFINER because the actor who unsends is generally not a
--    member of the threads the derivatives live in; EXECUTE revoked from every client role
--    (a trigger function cannot be called directly in any case).
-- 5. Two flags, seeded FALSE: telegraph_forwarding_enabled, telegraph_structured_schemas_enabled.
--    OFF: no route writes either table, the thread read reads neither, and the typed / share
--    routes write exactly the bodies they wrote before. The trigger is NOT gated: once a
--    derivative exists its source's revocation must reach it whatever the flag says later.
--
-- ACCOUNT DELETION. Both tables are erased without a service step: every row CASCADEs from its
-- message (public.messages is erased for a deleted account) and set_by / forwarded_by CASCADE from
-- auth.users — not from profiles, whose row AccountDeletionService keeps as a tombstone, so a
-- profiles-keyed cascade would never fire. A deleted author's messages going takes their
-- EXPIRES_WITH_SOURCE derivatives with them through the delete trigger below.
--
-- Nothing is backfilled. No existing row changes. No grant on an existing table changes.
--
-- ROLLBACK: db/rollback/2026-10-10-3665-telegraph-forwarding-and-structured-schemas-rollback.sql

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3665): public.messages must exist.';
  END IF;
  IF to_regclass('public.message_threads') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3665): public.message_threads must exist.';
  END IF;
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3665): auth.users must exist.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3665): public.feature_flags must exist.';
  END IF;
END $pre$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. Author-stated content capabilities
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.message_content_capabilities (
  message_id  uuid        PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  capability  text        NOT NULL
                CHECK (capability IN ('ALLOW', 'NO_FORWARD', 'SOURCE_POLICY', 'EXPIRES_WITH_SOURCE')),
  set_by      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.message_content_capabilities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.message_content_capabilities FROM PUBLIC;
REVOKE ALL ON public.message_content_capabilities FROM anon;
REVOKE ALL ON public.message_content_capabilities FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.message_content_capabilities TO service_role;

COMMENT ON TABLE public.message_content_capabilities IS
  'Telegraph §30A.9 (census-telegraph T407, migration 3665): the forwarding capability the AUTHOR stated on their own message — ALLOW | NO_FORWARD | SOURCE_POLICY | EXPIRES_WITH_SOURCE. No row = SOURCE_POLICY. Written only by PUT /threads/:id/messages/:id/content-capability (author only, never on a derivative) while telegraph_forwarding_enabled is TRUE. Service role only.';

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. Derivative provenance — the lineage, service role only
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.message_forwards (
  target_message_id uuid        PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: a hard-deleted source must not erase the fact that the derivative is
  -- one (the "Forwarded" label). The BEFORE DELETE trigger below has already tombstoned every
  -- derivative that expires with it by the time this action runs.
  source_message_id uuid        NULL REFERENCES public.messages(id) ON DELETE SET NULL,
  provenance        text        NOT NULL
                      CHECK (provenance IN ('FORWARDED', 'RESHARED_FROM_SOURCE', 'COPIED_ATTACHMENT')),
  -- The capability the derivative was made under. NO_FORWARD cannot appear: such a source has no derivatives.
  capability        text        NOT NULL
                      CHECK (capability IN ('ALLOW', 'SOURCE_POLICY', 'EXPIRES_WITH_SOURCE')),
  forwarded_by      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Stamped by the expiry trigger, in the same transaction as the source's revocation.
  revoked_at        timestamptz NULL,
  CONSTRAINT message_forwards_not_self CHECK (source_message_id IS NULL OR source_message_id <> target_message_id)
);

CREATE INDEX IF NOT EXISTS message_forwards_source_idx
  ON public.message_forwards (source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_forwards_forwarded_by_idx
  ON public.message_forwards (forwarded_by);

ALTER TABLE public.message_forwards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.message_forwards FROM PUBLIC;
REVOKE ALL ON public.message_forwards FROM anon;
REVOKE ALL ON public.message_forwards FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.message_forwards TO service_role;

COMMENT ON TABLE public.message_forwards IS
  'Telegraph §30A.9 (census-telegraph T406, migration 3665): one row per forwarded derivative — its source message, provenance (FORWARDED | RESHARED_FROM_SOURCE | COPIED_ATTACHMENT) and inherited capability. THE PRIVATE LINEAGE: service role only, never exposed to the derivative''s audience (the thread read serves the provenance word alone). revoked_at is stamped by telegraph_forward_expire_with_source in the source''s own revocation transaction.';

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. The one writer of a derivative
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.telegraph_record_forward(
  p_source_message_id uuid,
  p_target_thread_id  uuid,
  p_forwarder_id      uuid,
  p_body              text,
  p_msg_type          text,
  p_subtype           text,
  p_provenance        text,
  p_capability        text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_deleted   timestamptz;
  v_explicit  text;
  v_inherited text;
  v_effective text;
  v_id        uuid;
  v_at        timestamptz;
BEGIN
  IF p_source_message_id IS NULL OR p_target_thread_id IS NULL OR p_forwarder_id IS NULL THEN
    RAISE EXCEPTION 'telegraph_record_forward: source, target thread and forwarder are required';
  END IF;
  IF p_provenance NOT IN ('FORWARDED', 'RESHARED_FROM_SOURCE') THEN
    -- COPIED_ATTACHMENT is in the vocabulary and refused at the write (no object copy / EXIF policy yet).
    RAISE EXCEPTION 'telegraph_record_forward: provenance % is not written', p_provenance;
  END IF;

  -- The source row is locked FOR SHARE: an unsend / delete of it now waits for this transaction,
  -- and when it runs, its expiry trigger sees the provenance row written below.
  SELECT deleted_at INTO v_deleted FROM public.messages WHERE id = p_source_message_id FOR SHARE;
  IF NOT FOUND OR v_deleted IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'source_gone');
  END IF;

  -- The capability is re-derived here, under lock, so a NO_FORWARD stated after the caller
  -- decided cannot be raced past.
  SELECT capability INTO v_explicit FROM public.message_content_capabilities
   WHERE message_id = p_source_message_id FOR SHARE;
  SELECT capability INTO v_inherited FROM public.message_forwards
   WHERE target_message_id = p_source_message_id;
  v_effective := COALESCE(v_explicit, v_inherited, 'SOURCE_POLICY');
  IF v_effective = 'NO_FORWARD' THEN
    RETURN jsonb_build_object('outcome', 'restricted');
  END IF;
  IF v_effective IS DISTINCT FROM p_capability THEN
    RETURN jsonb_build_object('outcome', 'capability_changed');
  END IF;

  INSERT INTO public.messages (thread_id, sender_id, body, msg_type, subtype)
  VALUES (p_target_thread_id, p_forwarder_id, p_body, COALESCE(p_msg_type, 'text'), p_subtype)
  RETURNING id, created_at INTO v_id, v_at;

  INSERT INTO public.message_forwards (target_message_id, source_message_id, provenance, capability, forwarded_by)
  VALUES (v_id, p_source_message_id, p_provenance, v_effective, p_forwarder_id);

  UPDATE public.message_threads SET last_message_at = v_at, updated_at = v_at WHERE id = p_target_thread_id;

  RETURN jsonb_build_object('outcome', 'forwarded', 'messageId', v_id, 'createdAt', v_at);
END
$fn$;

REVOKE ALL ON FUNCTION public.telegraph_record_forward(uuid, uuid, uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.telegraph_record_forward(uuid, uuid, uuid, text, text, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.telegraph_record_forward(uuid, uuid, uuid, text, text, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.telegraph_record_forward(uuid, uuid, uuid, text, text, text, text, text) TO service_role;

COMMENT ON FUNCTION public.telegraph_record_forward(uuid, uuid, uuid, text, text, text, text, text) IS
  'Telegraph §30A.9 (3665): writes a forwarded derivative and its message_forwards row in one transaction, after re-checking under FOR SHARE locks that the source is live and that its effective capability (author-stated, else inherited, else SOURCE_POLICY) is the caller''s. Outcomes: forwarded | source_gone | restricted | capability_changed. service_role only; every authorization fact other than these two is decided by routes/telegraphForward.ts before the call.';

-- ══════════════════════════════════════════════════════════════════════════════
-- 4. EXPIRES_WITH_SOURCE — propagated in the source's own transaction
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.telegraph_forward_expire_with_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_author_expires boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NOT (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL) THEN
      RETURN NULL;
    END IF;
  END IF;

  -- Cheap exit for the overwhelmingly common case: a message nobody forwarded.
  IF NOT EXISTS (SELECT 1 FROM public.message_forwards WHERE source_message_id = OLD.id AND revoked_at IS NULL) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NULL END;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.message_content_capabilities
     WHERE message_id = OLD.id AND capability = 'EXPIRES_WITH_SOURCE'
  ) INTO v_author_expires;

  WITH expiring AS (
    UPDATE public.message_forwards f
       SET revoked_at = clock_timestamp()
     WHERE f.source_message_id = OLD.id
       AND f.revoked_at IS NULL
       AND (f.capability = 'EXPIRES_WITH_SOURCE' OR v_author_expires)
    RETURNING f.target_message_id
  )
  UPDATE public.messages m
     SET deleted_at = clock_timestamp(),
         body       = ''
    FROM expiring e
   WHERE m.id = e.target_message_id
     AND m.deleted_at IS NULL;
  -- Each derivative tombstoned above fires this trigger in turn, so a chain expires to its end.

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NULL END;
END
$fn$;

REVOKE ALL ON FUNCTION public.telegraph_forward_expire_with_source() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.telegraph_forward_expire_with_source() FROM anon;
REVOKE ALL ON FUNCTION public.telegraph_forward_expire_with_source() FROM authenticated;

COMMENT ON FUNCTION public.telegraph_forward_expire_with_source() IS
  'Telegraph §30A.9 / T353 (3665): when a message is deleted or unsent (deleted_at set) or hard-deleted, tombstones every forwarded derivative made under EXPIRES_WITH_SOURCE — or whose source author has since stated it — in the same transaction, and stamps message_forwards.revoked_at. Not flag-gated: a derivative that exists must expire with its source.';

DROP TRIGGER IF EXISTS telegraph_forward_expire_on_tombstone ON public.messages;
CREATE TRIGGER telegraph_forward_expire_on_tombstone
  AFTER UPDATE OF deleted_at ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.telegraph_forward_expire_with_source();

DROP TRIGGER IF EXISTS telegraph_forward_expire_on_delete ON public.messages;
CREATE TRIGGER telegraph_forward_expire_on_delete
  BEFORE DELETE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.telegraph_forward_expire_with_source();

-- ══════════════════════════════════════════════════════════════════════════════
-- 5. The flags, seeded FALSE
-- ══════════════════════════════════════════════════════════════════════════════

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('telegraph_forwarding_enabled', false,
   'CAPABILITY gate for Telegraph §30A.9 forwarding (census-telegraph T406/T407/T353). OFF (the seed): POST /threads/:id/forward and PUT …/content-capability answer feature_disabled and the thread read reads neither 3665 table. ON: forwards are written through telegraph_record_forward and the thread read carries the provenance word and the capability in force. The EXPIRES_WITH_SOURCE trigger runs whatever this says.'),
  ('telegraph_structured_schemas_enabled', false,
   'CAPABILITY gate for Telegraph §30A.16 versioned structured-message schemas and client capability negotiation (census-telegraph T429/T431). OFF (the seed): typed and share bodies are written exactly as before and the thread read serves every row as stored. ON: bodies carry their schema id, a client naming an unsupported schema is refused, and rows/actions a client has not declared it supports are served as a payload-free fallback.')
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (each recomputed from the catalog — no session state) ─────
DO $post$
DECLARE
  v_n int;
BEGIN
  IF to_regclass('public.message_content_capabilities') IS NULL OR to_regclass('public.message_forwards') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3665): a table was not created.';
  END IF;

  SELECT count(*) INTO v_n FROM pg_class
   WHERE oid IN ('public.message_content_capabilities'::regclass, 'public.message_forwards'::regclass)
     AND relrowsecurity;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3665): RLS must be enabled on both tables.';
  END IF;

  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename IN ('message_content_capabilities', 'message_forwards');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3665): % polic(ies) on the 3665 tables; service role only means none.', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM information_schema.table_privileges
   WHERE table_schema = 'public' AND table_name IN ('message_content_capabilities', 'message_forwards')
     AND grantee IN ('anon', 'authenticated', 'PUBLIC');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3665): client roles hold % privilege(s) on the 3665 tables.', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('telegraph_record_forward', 'telegraph_forward_expire_with_source')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3665): a client role can EXECUTE a 3665 function.';
  END IF;

  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.messages'::regclass AND NOT tgisinternal
     AND tgname IN ('telegraph_forward_expire_on_tombstone', 'telegraph_forward_expire_on_delete');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3665): expected 2 expiry triggers on public.messages, found %.', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM public.feature_flags
   WHERE flag IN ('telegraph_forwarding_enabled', 'telegraph_structured_schemas_enabled');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3665): the two flags were not seeded.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag IN ('telegraph_forwarding_enabled', 'telegraph_structured_schemas_enabled') AND enabled) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3665): both flags must be seeded FALSE.';
  END IF;
END $post$;

COMMIT;
