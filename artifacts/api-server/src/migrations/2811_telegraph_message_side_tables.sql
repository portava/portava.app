-- 2811_telegraph_message_side_tables.sql
-- Telegraph §12 — the four tables §12's aggregate table names and this schema
-- does not have: message_edits, message_reactions, message_attachments and
-- conversation_action_refs. POST-CUTOVER CANONICAL FORWARD MIGRATION
-- (2100-2999 band). Telegraph lane 2810-2819.
--
-- Required identically by both specification versions:
--   §12  message_edits           "Versioned text edits where retained."
--        message_reactions       "Reaction metadata."
--        message_attachments     "Typed media/file attachment references."
--        conversation_action_refs "References to canonical Plans, Trips, Events,
--                                 Places, etc."
--   §12.1 "Avoid a giant unversioned metadata_json field and avoid dozens of
--         nullable foreign keys on messages. Structured payload types use
--         versioned schemas and explicit reference tables."
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THE CENSUS FOUND, AND WHY EACH TABLE IS SHAPED AS IT IS
-- ══════════════════════════════════════════════════════════════════════════════
-- T142 message_edits — "Absent from the schema; edits overwrite in place." The
--   edit route sets messages.body and messages.edited_at, so the previous text
--   is gone. §12 says "versioned text edits WHERE RETAINED", which is a
--   deliberate qualifier: retention is a policy choice, not a given. So this
--   table records a version NUMBER and the PREVIOUS body, and the decision
--   about whether to write the body at all belongs to the writer, not to the
--   schema — `previous_body` is nullable, and a deployment that retains only
--   the fact of an edit writes NULL into it and still gets a correct version
--   count.
--
-- T143 message_reactions — "Absent. Note the dangling consumer: a
--   telegraph.reaction notification template exists and is fully written
--   (services/notifications/NotificationTemplateService.ts, 'reacted to your
--   message') for a feature that has no table, no route and no UI." That
--   template is the reason this table's shape is not negotiable: something
--   already expects (message, actor, emoji).
--
-- T144 message_attachments — "Implemented as four nullable columns on messages
--   — media_url, media_type, media_thumbnail_url, media_duration_seconds —
--   which is the exact shape §12.1 forbids. One attachment per message maximum;
--   no typed reference table; no file kind." This table is the reference table,
--   and it points at public.media_assets (§16.1's "MessageAttachment →
--   MediaAsset"), which already exists and which message media does not use.
--
-- T147 conversation_action_refs — "No table. References live as untyped fields
--   inside the JSON body, so nothing can be joined, revalidated or revoked."
--   Revocation is the word that matters: T46 records that a shared card is a
--   frozen snapshot which survives the source object being deleted. A reference
--   row can be revoked; a string inside a JSON blob cannot.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- FOUR TABLES, NO WRITERS, AND THAT IS THE HONEST STATE
-- ══════════════════════════════════════════════════════════════════════════════
-- census-trips' own rule — "a table nothing writes satisfies nothing" — applies
-- here and this header says so rather than leaving it to be discovered. Nothing
-- in the application writes any of these four today. They are declared together
-- because they are one decision (stop putting structure in `messages.body` and
-- in nullable columns) and because a command route that writes one of them
-- should not have to wait for a separate migration per table. Every one ships
-- with RLS enabled and a read policy keyed on ACTIVE thread membership, so the
-- day a writer exists the authorization is already the conversation's.
--
-- THE FLAG IS 2810's. There is deliberately no second flag: these tables and
-- 2810's envelope are one capability from an operator's point of view
-- ("Telegraph's message kernel"), and two switches for one capability is how a
-- half-on state gets created by accident.
--
-- ROLLBACK: db/rollback/2026-09-12-2811-telegraph-message-side-tables-rollback.sql

BEGIN;

-- ── Preconditions ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.messages must exist.';
  END IF;
  IF to_regclass('public.message_threads') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.message_threads must exist.';
  END IF;
  IF to_regclass('public.message_thread_members') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.message_thread_members must exist.';
  END IF;
  IF to_regclass('public.media_assets') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.media_assets must exist — §16.1 requires attachments to point at it.';
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. §12 message_edits
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.message_edits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    uuid        NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  editor_id     uuid        NOT NULL,
  -- 1 is the FIRST edit, not the original. The original is the message row.
  version       integer     NOT NULL,
  -- NULL when a deployment retains the fact of an edit but not its text. See
  -- the header: §12's "where retained" is the spec declining to decide this.
  previous_body text,
  edited_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_edits_version_positive CHECK (version >= 1),
  CONSTRAINT message_edits_version_uniq UNIQUE (message_id, version)
);

COMMENT ON TABLE public.message_edits IS
  'Telegraph §12 message_edits (census T142). One row per edit, numbered from 1. previous_body is NULLABLE on purpose: §12 says "versioned text edits WHERE RETAINED", which leaves retention to policy — a deployment that keeps only the fact of an edit writes NULL and still gets a correct version count. No writer today.';

CREATE INDEX IF NOT EXISTS message_edits_message_idx ON public.message_edits (message_id, version DESC);

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. §12 message_reactions
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.message_reactions (
  message_id uuid        NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL,
  -- A short grapheme cluster, not an arbitrary string. The length cap is a
  -- guard against this column becoming a second message body: a "reaction"
  -- that can hold 200 characters is a message that dodges every control the
  -- send path applies (§22's scam signals, the block guard, the rate limit).
  emoji      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_reactions_pkey PRIMARY KEY (message_id, user_id, emoji),
  CONSTRAINT message_reactions_emoji_short CHECK (char_length(emoji) BETWEEN 1 AND 16)
);

COMMENT ON TABLE public.message_reactions IS
  'Telegraph §12 message_reactions (census T143). The primary key makes a repeated reaction from the same person idempotent rather than a duplicate row. The 16-character cap on emoji is a control, not a formatting preference: a reaction that could hold a sentence would be a message that bypasses the send path''s block guard, rate limit and §22 scam detection. A telegraph.reaction notification template has existed with no table since before this migration.';

CREATE INDEX IF NOT EXISTS message_reactions_user_idx ON public.message_reactions (user_id, created_at DESC);

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. §12 message_attachments — §16.1's MessageAttachment → MediaAsset
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.message_attachments (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id     uuid        NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  -- §16.1: "MediaAsset != Message != Memory; MessageAttachment → MediaAsset".
  -- The asset is the canonical object; this row is the reference. Deliberately
  -- NOT ON DELETE CASCADE from media_assets: an asset's deletion is a decision
  -- about the asset, and silently vanishing an attachment row would erase the
  -- evidence that a message HAD one.
  media_asset_id uuid        NOT NULL REFERENCES public.media_assets(id) ON DELETE RESTRICT,
  -- §16.2's file KIND, which the four nullable columns on `messages` cannot
  -- express: they admit only 'image' and 'video' via a CHECK.
  kind           text        NOT NULL,
  -- §12.1 forbids "one attachment per message maximum". Ordinal makes the
  -- plural case representable and orderable.
  ordinal        integer     NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_attachments_kind_check CHECK (kind IN ('image', 'video', 'audio', 'file')),
  CONSTRAINT message_attachments_ordinal_nonneg CHECK (ordinal >= 0),
  CONSTRAINT message_attachments_ordinal_uniq UNIQUE (message_id, ordinal)
);

COMMENT ON TABLE public.message_attachments IS
  'Telegraph §12/§16.1 message_attachments (census T144). Replaces the four nullable columns on public.messages, which §12.1 names as the anti-pattern and which cap a message at one attachment of two kinds. Points at public.media_assets with ON DELETE RESTRICT: an asset deletion must not silently erase the fact that a message carried one. No writer today; messages.media_url is still the live path.';

CREATE INDEX IF NOT EXISTS message_attachments_message_idx ON public.message_attachments (message_id, ordinal);

-- ══════════════════════════════════════════════════════════════════════════════
-- 4. §12 conversation_action_refs
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.conversation_action_refs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid        NOT NULL REFERENCES public.message_threads(id) ON DELETE CASCADE,
  -- The message that carried the reference, when one did. NULL for a reference
  -- promoted into the conversation by something other than a message.
  message_id      uuid        REFERENCES public.messages(id) ON DELETE SET NULL,
  object_type     text        NOT NULL,
  object_id       uuid        NOT NULL,
  -- §12.1's "versioned schemas": the version of the payload shape this
  -- reference was created under, so a reader can tell a v1 card from a v2 one
  -- without guessing from its fields.
  payload_version integer     NOT NULL DEFAULT 1,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- The half a JSON string cannot have. T46: a shared card is a frozen
  -- snapshot that outlives the object it points at. A reference row can be
  -- revoked; a string inside a body cannot.
  revoked_at      timestamptz,
  revoked_reason  text,
  CONSTRAINT conversation_action_refs_object_type_check
    CHECK (object_type IN ('trip', 'plan', 'event', 'place', 'memory', 'booking', 'meetup', 'post')),
  CONSTRAINT conversation_action_refs_uniq UNIQUE (conversation_id, object_type, object_id, message_id)
);

COMMENT ON TABLE public.conversation_action_refs IS
  'Telegraph §12 conversation_action_refs (census T147). The explicit reference table §12.1 asks for, replacing untyped ids inside messages.body. Carries payload_version (§12.1 "versioned schemas") and revoked_at — the property a string in a JSON blob cannot have, and the one T46 says is missing when a source object is deleted and the card lives on. No writer today.';

CREATE INDEX IF NOT EXISTS conversation_action_refs_live_idx
  ON public.conversation_action_refs (conversation_id, object_type)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS conversation_action_refs_object_idx
  ON public.conversation_action_refs (object_type, object_id);

-- ══════════════════════════════════════════════════════════════════════════════
-- 5. RLS — read is the conversation's, write is the service's
-- ══════════════════════════════════════════════════════════════════════════════
--
-- Every policy below is SELECT-only and keyed on ACTIVE membership of the
-- conversation the row belongs to. There is no INSERT, UPDATE or DELETE policy
-- for any role, so a signed-in client cannot write any of these four tables
-- directly — every write must go through the service role, which means through
-- a route, which means through the authorization a route applies. That is the
-- same posture §26 asks for and the same one migration 2400's tables have.

ALTER TABLE public.message_edits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_action_refs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS message_edits_member_select ON public.message_edits;
CREATE POLICY message_edits_member_select ON public.message_edits
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.messages m
      JOIN public.message_thread_members mm ON mm.thread_id = m.thread_id
     WHERE m.id = message_edits.message_id
       AND mm.user_id = auth.uid()
       AND mm.left_at IS NULL
  ));

DROP POLICY IF EXISTS message_reactions_member_select ON public.message_reactions;
CREATE POLICY message_reactions_member_select ON public.message_reactions
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.messages m
      JOIN public.message_thread_members mm ON mm.thread_id = m.thread_id
     WHERE m.id = message_reactions.message_id
       AND mm.user_id = auth.uid()
       AND mm.left_at IS NULL
  ));

DROP POLICY IF EXISTS message_attachments_member_select ON public.message_attachments;
CREATE POLICY message_attachments_member_select ON public.message_attachments
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.messages m
      JOIN public.message_thread_members mm ON mm.thread_id = m.thread_id
     WHERE m.id = message_attachments.message_id
       AND mm.user_id = auth.uid()
       AND mm.left_at IS NULL
  ));

DROP POLICY IF EXISTS conversation_action_refs_member_select ON public.conversation_action_refs;
CREATE POLICY conversation_action_refs_member_select ON public.conversation_action_refs
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.message_thread_members mm
     WHERE mm.thread_id = conversation_action_refs.conversation_id
       AND mm.user_id = auth.uid()
       AND mm.left_at IS NULL
  ));

-- ── Postconditions ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO v_missing FROM (
    SELECT t FROM unnest(ARRAY['message_edits','message_reactions','message_attachments','conversation_action_refs']) t
     WHERE to_regclass('public.' || t) IS NULL
  ) q;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: table(s) not created: %', v_missing;
  END IF;

  SELECT string_agg(t, ', ') INTO v_missing FROM (
    SELECT t FROM unnest(ARRAY['message_edits','message_reactions','message_attachments','conversation_action_refs']) t
     WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname='public' AND c.relname=t AND c.relrowsecurity)
  ) q;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: RLS not enabled on: %', v_missing;
  END IF;

  -- No write policy may exist for any of the four. A write policy added later
  -- would have to delete this assertion, which is the point of it being here.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public'
       AND tablename IN ('message_edits','message_reactions','message_attachments','conversation_action_refs')
       AND cmd <> 'SELECT'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a non-SELECT policy exists on a Telegraph side table — writes must go through the service role.';
  END IF;
END $$;

COMMIT;
