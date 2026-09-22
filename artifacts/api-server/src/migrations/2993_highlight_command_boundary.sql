-- 2993_highlight_command_boundary.sql
--
-- WHAT: the §17 COMMAND BOUNDARY for the Highlight commands. Two halves:
--
--   1. The event tables learn a SECOND SUBJECT KIND. `memory_domain_events`,
--      `memory_event_outbox`, `memory_command_receipts` and
--      `memory_command_audit` gain `highlight_id`, and `memory_id` is relaxed
--      to NULL on the two event tables — under a new CHECK that says EXACTLY
--      ONE subject is present. See "WHY RELAXING NOT NULL IS NOT A WEAKENING".
--
--   2. public.highlight_kernel_execute(jsonb) — the ONE function that applies a
--      Highlight command to canonical state and writes the domain event, the
--      outbox row, the idempotency receipt and the command-audit row IN THE
--      SAME TRANSACTION. service_role only. Same shape, same envelope and the
--      same reason codes as public.memory_kernel_execute (2711).
--
-- Spec: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
--   §5   the Highlight lifecycle: DRAFT -> ACTIVE -> {EXPIRED, PINNED},
--        PINNED -> HIDDEN, HIDDEN -> EXPIRED.
--   §12  "Pinned/manual order always outranks automatic ordering."
--   §17  "All canonical writes should cross an explicit command boundary for
--        authorization, invariants, idempotency, audit, and downstream event
--        generation." + PIN_HIGHLIGHT / UNPIN_HIGHLIGHT / PUBLISH_HIGHLIGHT /
--        HIDE_HIGHLIGHT among the seventeen command names, highlight.pinned
--        and highlight.hidden among the fourteen event names, and "Use an
--        outbox pattern: canonical mutation and event-outbox insert occur in
--        one database transaction."
--   §19  "client-generated operation IDs and server-side idempotency"
--   §21  Archive and Delete are DIFFERENT operations; Archive is reversible.
--   §23  owner-only access to canonical private facts.
--   §24  reason codes; "Do not log sensitive raw content unless strictly
--        necessary."
--
-- WHAT WAS MEASURED BEFORE THIS MIGRATION
-- =======================================
-- census docs/architecture/census-highlights-memories.md H142: "§17's
-- requirement is the COMMAND BOUNDARY, and PIN_HIGHLIGHT is still absent from
-- MEMORY_COMMAND_TYPES — no idempotency key, no receipt, no audit row, no
-- outbox insert." Re-measured in this lane against the 20260915 production
-- schema snapshot (src/lib/capability/snapshots/20260915-production-schema.json):
--
--   * 2710's four kernel tables ARE on production. 2723's `pinned_at` IS on
--     `public.highlights`. So the storage for pin/hide exists.
--   * `public.highlights` has NO memory_id and shares no id with
--     public.memories. Its columns are exactly: id, owner_id, media_url,
--     media_type, video_duration_seconds, caption, location_name,
--     location_city, location_country, visibility, expires_at, created_at,
--     deleted_at, archived_at, filter_id, filter_intensity, updated_at,
--     lifetime_class, lifecycle_state, highlight_type, pinned_at,
--     renderer_version.
--   * 2710 declares memory_domain_events.memory_id and
--     memory_event_outbox.memory_id as `uuid NOT NULL`, and the event table's
--     is a foreign key to public.memories.
--
-- THE CONSEQUENCE, WHICH IS THE FINDING THIS MIGRATION EXISTS TO FIX:
-- 2710's type CHECK already admits highlight.created, highlight.published,
-- highlight.expired, highlight.pinned and highlight.hidden, and
-- src/lib/memoryOutbox.ts already exports all five. NOT ONE OF THEM COULD
-- PHYSICALLY BE WRITTEN. Every row needs a memory_id that is a real
-- public.memories id, and a Highlight has none. Five names were in the
-- vocabulary and unreachable — a declared capability with no row shape behind
-- it, which is the exact defect class this repository keeps catching.
--
-- THE DESIGN DECISION, AND WHY
-- ============================
-- Three options were on the table.
--
--   (a) ONE event stream, two subject kinds. Add a nullable `highlight_id`
--       beside `memory_id` and require EXACTLY ONE of them.   <-- CHOSEN
--   (b) A SEPARATE highlight event stream (its own tables, its own outbox).
--   (c) Make `highlights` a projection of `memories` — give every Highlight a
--       backing Memory row.
--
-- (a) was chosen for three reasons, in order of weight:
--
--   1. §17 lists ONE outbox and ONE vocabulary of fourteen event names, and
--      five of those fourteen are `highlight.*`. The spec already put both
--      subjects in one stream; 2710 already wrote both into one CHECK
--      constraint. (b) would split a stream the spec defines as one, and would
--      duplicate the drain loop, the lease, the ack path and the §24
--      projection-lag metric — two of everything, which is two things to keep
--      in agreement by convention rather than by construction.
--   2. (c) is the largest possible change and the least reversible. It would
--      put a row in `memories` for every Highlight ever posted, and every
--      existing reader of `memories` — the timeline, the passport, the
--      discovery feed, the account-deletion sweep — would silently acquire
--      them. A storage decision that big is not something a command-boundary
--      lane gets to make on the way past.
--   3. A Highlight and a Memory are genuinely different aggregates, and (a) is
--      the only option that SAYS SO in the schema. `highlight_id` is a
--      separate column with its own foreign key and its own sequence
--      uniqueness; nothing about a Highlight is asserted to be a Memory.
--
-- WHY RELAXING `memory_id` FROM NOT NULL TO NULL IS NOT A WEAKENING
-- =================================================================
-- This is the one part of this migration a reviewer should be suspicious of,
-- so the argument is written out rather than implied. Never weaken a
-- data-integrity check to make room for a feature.
--
--   BEFORE: memory_id IS NOT NULL.
--           States exactly one thing: "there is a memory_id".
--   AFTER:  memory_id may be NULL, and
--           CHECK (num_nonnulls(memory_id, highlight_id) = 1).
--           States: "there is EXACTLY ONE subject, and it is either a Memory
--           or a Highlight, never both and never neither."
--
-- The second statement IMPLIES the first for every row that has a memory_id,
-- and additionally forbids two shapes the old constraint permitted nothing to
-- say about: a row with both subjects, and — once the column exists — a row
-- with a highlight_id and a memory_id that disagree. The set of rows the table
-- admits with NO subject is empty under both. So the AFTER state is strictly
-- stronger on the question the NOT NULL was answering, and answers a question
-- the NOT NULL could not.
--
-- The constraint is therefore a PRECONDITION of the relaxation, not a
-- companion to it. The DDL below adds the column and the CHECK first and drops
-- the NOT NULL last, inside one transaction, so there is no ordering in which
-- this migration half-applies into a table that admits a subjectless row. If
-- the CHECK could not be added, the NOT NULL would have to stay and the
-- Highlight commands would remain unbuildable; that is stated here so the
-- trade cannot be made quietly later.
--
-- WHY A SECOND FUNCTION AND NOT A CHANGE TO memory_kernel_execute
-- ===============================================================
-- This repository's established shape is ONE KERNEL FUNCTION PER AGGREGATE:
-- public.trip_kernel_execute (2420), public.memory_kernel_execute (2711), the
-- Telegraph message kernel (2810). A Highlight is a different aggregate with a
-- different lifecycle (§5 draws two separate diagrams), different ownership
-- storage (`highlights.owner_id`, not `memories.owner_id`) and a different
-- soft-delete column. Folding it into memory_kernel_execute would mean
-- CREATE OR REPLACE-ing 450 lines of validated plpgsql into this file so that
-- one CASE arm could be added — and every future fix to 2711 would then have
-- to be made in whichever copy happened to be newest. A highlight command sent
-- to memory_kernel_execute is genuinely a mistake, and that function still
-- answers MEMORY_COMMAND_UNKNOWN_TYPE for it, which is the right answer.
--
-- The two functions SHARE the four tables, the receipt key
-- (actor_user_id, idempotency_key), the reason-code vocabulary and the audit
-- outcomes, so §19's idempotency and §24's metrics span both aggregates. One
-- actor reusing one key across the two kernels is refused by the same rule.
--
-- WHAT IS NOT BUILT HERE, AND WHY
-- ===============================
--   * PUBLISH_HIGHLIGHT (§17) is NOT implemented, and no column was invented to
--     make it implementable. Measured: `public.highlights` has no published_at.
--     It has `lifecycle_state`, whose value space is fixed by
--     2723_highlight_class_lifecycle_and_pin.sql:137 to
--     (NULL, 'DRAFT', 'ACTIVE', 'EXPIRED', 'PINNED', 'HIDDEN') — there is no
--     'PUBLISHED'. Nothing in the API server writes highlights.lifecycle_state
--     at all (measured: the only TypeScript writer of any `lifecycle_state` is
--     src/server/telegraph/commandRoute.ts, on `messages`), and
--     src/services/highlights/highlightLifecycle.ts:322 states that DRAFT "has
--     no witness and is still never derived". So no Highlight is ever in a
--     pre-published state, and the nearest storable value, 'ACTIVE', is what
--     describeHighlightLifecycle already DERIVES for a live row. Writing it
--     would not publish anything: it would replace a derived answer with a
--     stored one and change what every reader of that function sees, which is
--     a behaviour change dressed as a command. PUBLISH_HIGHLIGHT stays
--     undeclared, with that reason recorded in
--     src/lib/memoryCommandBus.ts MEMORY_COMMAND_TYPES_NOT_DECLARED.
--   * highlight.created, highlight.published and highlight.expired remain in
--     2710's type CHECK and in MEMORY_EVENT_TYPES with NO writer. They are now
--     WRITEABLE (the row shape exists) but unwritten. That is a smaller and
--     more honest gap than before and it is not closed here.
--   * There is no UNHIDE command. §17 names HIDE_HIGHLIGHT and does not name
--     its inverse, so DELETE /highlights/:id/archive keeps its direct write.
--     §21 makes Archive reversible and this migration does not change that.
--   * SET_RESURFACING_POLICY (§17): §11's user controls still have no storage.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2993.
-- Depends on: 2710 (the four kernel tables), 0026/2723 (public.highlights with
-- owner_id, deleted_at, archived_at, pinned_at, expires_at).
-- Ordering: 2993 runs BEFORE 2994. 2994 creates public.memory_outbox_claim and
-- has been edited in place to return `highlight_id` alongside `memory_id`;
-- see that file's header for why editing it was correct rather than amending
-- it from a later migration.
--
-- MUST BE TRUE BEFORE APPLYING:
--   * 2710 has been applied (the four tables exist).
--   * public.highlights carries owner_id, deleted_at, archived_at and
--     pinned_at. The postconditions below REFUSE to apply otherwise, rather
--     than creating a function that raises the first time it is called.
--   * The flag `memory_kernel_enabled` is still FALSE. This migration does not
--     flip it and nothing calls the new function until an operator does.
--
-- REVERSIBLE BY:
--   DROP FUNCTION IF EXISTS public.highlight_kernel_execute(jsonb);
--   DROP POLICY IF EXISTS memory_domain_events_highlight_owner_select ON public.memory_domain_events;
--   ALTER TABLE public.memory_command_audit    DROP COLUMN IF EXISTS highlight_id;
--   ALTER TABLE public.memory_command_receipts DROP CONSTRAINT IF EXISTS memory_command_receipts_one_subject,
--                                              DROP COLUMN IF EXISTS highlight_id;
--   ALTER TABLE public.memory_event_outbox     DROP CONSTRAINT IF EXISTS memory_event_outbox_one_subject,
--                                              DROP COLUMN IF EXISTS highlight_id;
--   ALTER TABLE public.memory_domain_events    DROP CONSTRAINT IF EXISTS memory_domain_events_one_subject,
--                                              DROP CONSTRAINT IF EXISTS memory_domain_events_highlight_sequence_unique,
--                                              DROP COLUMN IF EXISTS highlight_id;
--   -- and only then, if every remaining row has one:
--   ALTER TABLE public.memory_event_outbox  ALTER COLUMN memory_id SET NOT NULL;
--   ALTER TABLE public.memory_domain_events ALTER COLUMN memory_id SET NOT NULL;
--   (Safe while memory_kernel_enabled is false: nothing writes these tables.)

BEGIN;

-- ── 0. Preconditions. Refuse rather than half-apply. ─────────────────────────
DO $$
DECLARE missing text;
BEGIN
  IF to_regclass('public.memory_domain_events') IS NULL THEN
    RAISE EXCEPTION '2993 PRECONDITION FAILED: public.memory_domain_events does not exist — apply 2710 first';
  END IF;
  IF to_regclass('public.highlights') IS NULL THEN
    RAISE EXCEPTION '2993 PRECONDITION FAILED: public.highlights does not exist';
  END IF;
  -- The three columns the commands write, plus the two they read. A function
  -- naming an absent column compiles at CALL time, not at CREATE time, so
  -- without this check the failure would surface as a 503 on a user's first
  -- pin rather than here.
  SELECT string_agg(c, ', ') INTO missing
    FROM unnest(ARRAY['owner_id', 'deleted_at', 'archived_at', 'pinned_at', 'expires_at']) c
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'highlights' AND column_name = c);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '2993 PRECONDITION FAILED: public.highlights is missing column(s) % — apply 2723 first', missing;
  END IF;
END $$;

-- ── 1. memory_domain_events: a second subject kind ───────────────────────────
-- Column, then CHECK, then the NOT NULL relaxation — in that order, so the
-- table is never (even momentarily, even inside this transaction) able to
-- admit a row with no subject at all.
ALTER TABLE public.memory_domain_events
  ADD COLUMN IF NOT EXISTS highlight_id uuid NULL REFERENCES public.highlights(id) ON DELETE CASCADE;

ALTER TABLE public.memory_domain_events DROP CONSTRAINT IF EXISTS memory_domain_events_one_subject;
ALTER TABLE public.memory_domain_events
  ADD CONSTRAINT memory_domain_events_one_subject
  CHECK (num_nonnulls(memory_id, highlight_id) = 1);

ALTER TABLE public.memory_domain_events ALTER COLUMN memory_id DROP NOT NULL;

-- The companion to 2710's UNIQUE (memory_id, sequence). Two UNIQUE constraints
-- rather than one over a coalesced expression: NULLs are distinct in a unique
-- index, so each constraint polices exactly the rows of its own subject kind
-- and says nothing about the other's.
ALTER TABLE public.memory_domain_events DROP CONSTRAINT IF EXISTS memory_domain_events_highlight_sequence_unique;
ALTER TABLE public.memory_domain_events
  ADD CONSTRAINT memory_domain_events_highlight_sequence_unique UNIQUE (highlight_id, sequence);
-- NO separate (highlight_id, sequence) index is created. The UNIQUE constraint
-- above already builds one, and it is the index the kernel's
-- `max(sequence) WHERE highlight_id = ...` read uses. 2710 created
-- idx_memory_domain_events_memory_seq beside its own UNIQUE (memory_id,
-- sequence) and that pair is redundant; this migration does not repeat the
-- redundancy, and does not drop 2710's either — removing an index is a
-- separate change with its own risk.

COMMENT ON COLUMN public.memory_domain_events.highlight_id IS
  'Spec v1 §17. The Highlight this event is about, when the subject is a Highlight rather than a Memory. EXACTLY ONE of (memory_id, highlight_id) is non-null — see constraint memory_domain_events_one_subject, which is what makes memory_id''s nullability a strengthening rather than a relaxation.';

-- §23 owner-only, as 2710's memory policy already is. A separate policy rather
-- than a widened one: policies are OR-ed, the memory policy's EXISTS is false
-- for a highlight row (memory_id is NULL), and keeping them apart means a
-- future change to one subject's visibility cannot reach the other's by
-- accident.
DROP POLICY IF EXISTS memory_domain_events_highlight_owner_select ON public.memory_domain_events;
CREATE POLICY memory_domain_events_highlight_owner_select ON public.memory_domain_events
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.highlights h
             WHERE h.id = public.memory_domain_events.highlight_id
               AND h.owner_id = auth.uid())
  );

-- ── 2. memory_event_outbox ───────────────────────────────────────────────────
-- `highlight_id` is a PLAIN uuid with no foreign key, exactly as 2710 made
-- `memory_id` a plain uuid here. The outbox row already follows its event
-- (event_id REFERENCES memory_domain_events ON DELETE CASCADE), so a hard-
-- deleted Highlight takes its outbox rows with it through that edge; a second
-- foreign key would add a second lock on `highlights` for no additional
-- guarantee.
ALTER TABLE public.memory_event_outbox
  ADD COLUMN IF NOT EXISTS highlight_id uuid NULL;

ALTER TABLE public.memory_event_outbox DROP CONSTRAINT IF EXISTS memory_event_outbox_one_subject;
ALTER TABLE public.memory_event_outbox
  ADD CONSTRAINT memory_event_outbox_one_subject
  CHECK (num_nonnulls(memory_id, highlight_id) = 1);

ALTER TABLE public.memory_event_outbox ALTER COLUMN memory_id DROP NOT NULL;

COMMENT ON COLUMN public.memory_event_outbox.highlight_id IS
  'Spec v1 §17. The Highlight subject of this outbox row. EXACTLY ONE of (memory_id, highlight_id) is non-null. public.memory_outbox_claim (2994) returns BOTH, so a consumer can never see a row whose subject it cannot name.';

-- ── 3. memory_command_receipts ───────────────────────────────────────────────
-- AT MOST one subject here, not exactly one: 2710 made memory_id NULL-able on
-- purpose because CREATE_MEMORY has no id when the command arrives, and that
-- row shape (a receipt with neither) is still legitimate. What must never
-- happen is a receipt claiming both.
ALTER TABLE public.memory_command_receipts
  ADD COLUMN IF NOT EXISTS highlight_id uuid NULL REFERENCES public.highlights(id) ON DELETE CASCADE;

ALTER TABLE public.memory_command_receipts DROP CONSTRAINT IF EXISTS memory_command_receipts_one_subject;
ALTER TABLE public.memory_command_receipts
  ADD CONSTRAINT memory_command_receipts_one_subject
  CHECK (num_nonnulls(memory_id, highlight_id) <= 1);

COMMENT ON COLUMN public.memory_command_receipts.highlight_id IS
  'Spec v1 §17/§19. The Highlight a replayed command''s receipt belongs to. Cascades with the Highlight for the same reason memory_id cascades with the Memory: replaying a command against a row that is gone has nothing to return.';

-- ── 4. memory_command_audit ──────────────────────────────────────────────────
-- Deliberately NOT a foreign key, and deliberately not covered by a one-subject
-- CHECK. 2710's header gives the reason for the first: "who tried to do what to
-- that Highlight, and what did the system answer" is exactly the question an
-- incident asks AFTER the row is gone. The reason for the second is that this
-- table records ATTEMPTS, including malformed ones — an attempt that named no
-- subject, or named a nonsense one, must still be recordable, or the audit
-- stops covering precisely the events worth auditing.
ALTER TABLE public.memory_command_audit
  ADD COLUMN IF NOT EXISTS highlight_id uuid NULL;

CREATE INDEX IF NOT EXISTS idx_memory_command_audit_highlight
  ON public.memory_command_audit (highlight_id, created_at DESC) WHERE highlight_id IS NOT NULL;

COMMENT ON COLUMN public.memory_command_audit.highlight_id IS
  'Spec v1 §17/§24. The Highlight a command attempt named. A plain uuid, NOT a foreign key and NOT constrained against memory_id: the audit outlives its subject and must be able to record an attempt that named no valid subject at all.';

-- ── 5. public.highlight_kernel_execute ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.highlight_kernel_execute(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_highlight_id uuid;
  v_actor        uuid;
  v_cmd_id       uuid;
  v_corr         uuid;
  v_key          text;
  v_type         text;
  v_payload      jsonb;
  v_observed     timestamptz;
  v_now          timestamptz;
  v_seq          bigint;
  v_event_id     uuid;
  v_event_type   text;
  v_result       jsonb;
  v_receipt      public.memory_command_receipts%ROWTYPE;
  v_owner        uuid;
  v_deleted      timestamptz;
  v_archived     timestamptz;
  v_pinned       timestamptz;
  v_expires      timestamptz;
  v_from         text;
  v_to           text;
BEGIN
  -- ONE CLOCK. Bound once and derived from everywhere below, so the state the
  -- row is written with, the state the event says it moved to and the event's
  -- occurred_at cannot disagree by however long the function took to run.
  v_now := now();

  -- ── envelope ───────────────────────────────────────────────────────────────
  BEGIN
    v_highlight_id := (p_command->>'highlight_id')::uuid;
    v_actor        := (p_command->>'actor_user_id')::uuid;
    v_cmd_id       := (p_command->>'command_id')::uuid;
    v_corr         := (p_command->>'correlation_id')::uuid;
    v_key          := p_command->>'idempotency_key';
    v_type         := p_command->>'type';
    v_payload      := coalesce(p_command->'payload', '{}'::jsonb);
    v_observed     := (p_command->>'client_observed_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED',
                              'detail', SQLERRM, 'contract_version', 1);
  END;

  IF v_actor IS NULL OR v_cmd_id IS NULL OR v_type IS NULL OR v_key IS NULL
     OR char_length(v_key) < 1 OR char_length(v_key) > 200
     OR jsonb_typeof(v_payload) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED', 'contract_version', 1);
  END IF;

  -- PUBLISH_HIGHLIGHT is absent from this list ON PURPOSE. See the header: the
  -- schema has no storable representation of "published" that differs from
  -- what creation already does, so this function refuses the name rather than
  -- accepting it and doing something else.
  IF v_type NOT IN ('PIN_HIGHLIGHT', 'UNPIN_HIGHLIGHT', 'HIDE_HIGHLIGHT') THEN
    INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, highlight_id, actor_user_id, idempotency_key, outcome, reason)
    VALUES (v_cmd_id, v_type, NULL, v_highlight_id, v_actor, v_key, 'rejected', 'MEMORY_COMMAND_UNKNOWN_TYPE');
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_UNKNOWN_TYPE',
                              'detail', v_type, 'contract_version', 1);
  END IF;

  -- ── idempotency (§19) ──────────────────────────────────────────────────────
  -- The SAME table and the SAME key as memory_kernel_execute, so one actor
  -- cannot reuse one operation id across the two aggregates either.
  SELECT * INTO v_receipt FROM public.memory_command_receipts
   WHERE actor_user_id = v_actor AND idempotency_key = v_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_receipt.command_type IS DISTINCT FROM v_type THEN
      INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, highlight_id, actor_user_id, idempotency_key, outcome, reason)
      VALUES (v_cmd_id, v_type, NULL, v_highlight_id, v_actor, v_key, 'rejected', 'MEMORY_IDEMPOTENCY_KEY_REUSED');
      RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_IDEMPOTENCY_KEY_REUSED',
                                'detail', format('key already used for %s', v_receipt.command_type),
                                'contract_version', 1);
    END IF;
    INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, highlight_id, actor_user_id, idempotency_key, outcome, event_id)
    VALUES (v_cmd_id, v_type, NULL, v_receipt.highlight_id, v_actor, v_key, 'duplicate', v_receipt.event_id);
    -- The ORIGINAL result_json, not a recomputed one. A replay that recomputed
    -- would return a body describing a different world than the first call did.
    RETURN jsonb_build_object(
      'ok', true, 'duplicate', true,
      'highlight_id', v_receipt.highlight_id, 'event_id', v_receipt.event_id,
      'event_type', v_receipt.event_type, 'result', v_receipt.result_json,
      'contract_version', 1);
  END IF;

  IF v_highlight_id IS NULL THEN
    INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, highlight_id, actor_user_id, idempotency_key, outcome, reason)
    VALUES (v_cmd_id, v_type, NULL, NULL, v_actor, v_key, 'rejected', 'MEMORY_COMMAND_MALFORMED');
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED',
                              'detail', 'highlight_id required', 'contract_version', 1);
  END IF;

  -- ── the aggregate, its owner and its state (§23) ───────────────────────────
  -- The row is read and LOCKED before any check, and the lock is what makes the
  -- sequence allocation below safe: two concurrent commands against one
  -- Highlight serialize here, so `max(sequence) + 1` cannot be read twice.
  --
  -- OWNERSHIP IS RE-CHECKED HERE and the caller is not trusted, exactly as
  -- memory_kernel_execute re-checks `memories.owner_id`. The application also
  -- checks it; this is the defence-in-depth half.
  SELECT owner_id, deleted_at, archived_at, pinned_at, expires_at
    INTO v_owner, v_deleted, v_archived, v_pinned, v_expires
    FROM public.highlights WHERE id = v_highlight_id
    FOR UPDATE;

  IF NOT FOUND OR v_deleted IS NOT NULL THEN
    INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, highlight_id, actor_user_id, idempotency_key, outcome, reason)
    VALUES (v_cmd_id, v_type, NULL, v_highlight_id, v_actor, v_key, 'rejected', 'HIGHLIGHT_NOT_FOUND');
    RETURN jsonb_build_object('ok', false, 'reason', 'HIGHLIGHT_NOT_FOUND', 'contract_version', 1);
  END IF;

  IF v_owner IS DISTINCT FROM v_actor THEN
    -- The AUDIT records that this was an ownership refusal, not an absence.
    -- The HTTP layer deliberately answers 404 for both — see
    -- src/lib/memoryCommandBus.ts sendMemoryCommandRejection, which explains
    -- why the outside answer must not distinguish what the inside must.
    INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, highlight_id, actor_user_id, idempotency_key, outcome, reason)
    VALUES (v_cmd_id, v_type, NULL, v_highlight_id, v_actor, v_key, 'rejected', 'HIGHLIGHT_AUTH_NOT_OWNER');
    RETURN jsonb_build_object('ok', false, 'reason', 'HIGHLIGHT_AUTH_NOT_OWNER', 'contract_version', 1);
  END IF;

  -- ── §5 Highlight lifecycle, DERIVED and labelled as derived ────────────────
  -- `highlights.lifecycle_state` is NULL on every row this deployment has ever
  -- written (nothing writes it), so the state is derived from the columns that
  -- do carry facts, in the same precedence order as
  -- src/services/highlights/highlightLifecycle.ts describeHighlightLifecycle:
  -- archived -> HIDDEN, pinned -> PINNED, expired -> EXPIRED, else ACTIVE.
  -- The event payload marks this `derived` so a §18 consumer never mistakes it
  -- for a stored state. No lifecycle_state is WRITTEN here: writing one would
  -- replace every reader's derived answer with a stored one, which is a
  -- behaviour change and not this command's business.
  v_from := CASE
    WHEN v_archived IS NOT NULL THEN 'HIDDEN'
    WHEN v_pinned   IS NOT NULL THEN 'PINNED'
    WHEN v_expires IS NOT NULL AND v_expires <= v_now THEN 'EXPIRED'
    ELSE 'ACTIVE' END;

  -- ══ APPLY. Every check above has passed; the first write happens here. ══
  CASE v_type

    WHEN 'PIN_HIGHLIGHT' THEN
      -- §12 manual_pin. `pinned_at` ONLY. Deliberately not lifecycle_state —
      -- routes/highlights.ts records the reason at length: §5 draws no
      -- PINNED -> ACTIVE edge, so a stored PINNED could never be undone
      -- without an illegal transition, while §17 names UNPIN_HIGHLIGHT, which
      -- says it must be undoable. Writing the column keeps unpin a reversal of
      -- a fact rather than an illegal move in a state machine.
      UPDATE public.highlights SET pinned_at = v_now WHERE id = v_highlight_id;
      v_event_type := 'highlight.pinned';
      v_result := jsonb_build_object('id', v_highlight_id, 'pinned_at', v_now);
      v_to := CASE WHEN v_archived IS NOT NULL THEN 'HIDDEN' ELSE 'PINNED' END;

    WHEN 'UNPIN_HIGHLIGHT' THEN
      UPDATE public.highlights SET pinned_at = NULL WHERE id = v_highlight_id;
      -- §17 lists no `highlight.unpinned`. The event is highlight.pinned and
      -- the payload carries `command_type` and the resulting `pinned` state —
      -- the precedent 2711 already set, where ADD_MEDIA and REMOVE_MEDIA both
      -- emit memory.corrected and the payload distinguishes them. Inventing an
      -- event name the spec does not list would give a consumer a name nobody
      -- agreed on.
      v_event_type := 'highlight.pinned';
      v_result := jsonb_build_object('id', v_highlight_id, 'pinned_at', NULL);
      v_to := CASE
        WHEN v_archived IS NOT NULL THEN 'HIDDEN'
        WHEN v_expires IS NOT NULL AND v_expires <= v_now THEN 'EXPIRED'
        ELSE 'ACTIVE' END;

    WHEN 'HIDE_HIGHLIGHT' THEN
      -- §21: Archive is the REVERSIBLE removal from browsing and is a
      -- different operation from Delete. This writes `archived_at`, which
      -- DELETE /highlights/:id/archive clears. It does NOT write `deleted_at`:
      -- that column is terminal, no route clears it, and §5 puts HIDDEN inside
      -- the reversible cycle (PINNED -> HIDDEN -> EXPIRED).
      UPDATE public.highlights SET archived_at = v_now WHERE id = v_highlight_id;
      v_event_type := 'highlight.hidden';
      v_result := jsonb_build_object('id', v_highlight_id, 'archived_at', v_now);
      v_to := 'HIDDEN';

  END CASE;

  -- ── Event + outbox + receipt + audit. Same transaction as the change. ──────
  SELECT coalesce(max(sequence), 0) + 1 INTO v_seq
    FROM public.memory_domain_events WHERE highlight_id = v_highlight_id;

  INSERT INTO public.memory_domain_events (
    memory_id, highlight_id, sequence, type, actor_user_id, causation_id,
    correlation_id, payload_json, schema_version, occurred_at)
  VALUES (
    NULL, v_highlight_id, v_seq, v_event_type, v_actor, v_cmd_id, v_corr,
    -- §23 PRIVACY-FILTERED PAYLOAD. Ids, the command name and the §5
    -- vocabulary — never the caption, the media URL, the filter or the place.
    -- A §18 consumer that needs the body reads the canonical row under its own
    -- authorization; it does not learn it by subscribing.
    jsonb_build_object(
      'command_type',     v_type,
      'from_state',       v_from,
      'to_state',         v_to,
      -- Says out loud that the two states above were DERIVED from
      -- archived_at/pinned_at/expires_at and not read from lifecycle_state,
      -- so a consumer cannot mistake an inference for a stored fact.
      'state_provenance', 'derived',
      -- The resulting pin state, which is what makes highlight.pinned readable
      -- without a second query for the UNPIN case.
      'pinned',           (v_type = 'PIN_HIGHLIGHT'),
      'visibility',       NULL,
      'refs', jsonb_build_object(
        'highlight_id',  v_highlight_id,
        'memory_id',     NULL,
        'actor_user_id', v_actor)),
    1, coalesce(v_observed, v_now))
  RETURNING event_id INTO v_event_id;

  INSERT INTO public.memory_event_outbox (event_id, memory_id, highlight_id, type)
  VALUES (v_event_id, NULL, v_highlight_id, v_event_type);

  INSERT INTO public.memory_command_receipts (
    actor_user_id, idempotency_key, command_id, command_type, memory_id,
    highlight_id, event_id, event_type, result_json)
  VALUES (v_actor, v_key, v_cmd_id, v_type, NULL, v_highlight_id, v_event_id, v_event_type, v_result);

  INSERT INTO public.memory_command_audit (
    command_id, command_type, memory_id, highlight_id, actor_user_id,
    idempotency_key, outcome, event_id)
  VALUES (v_cmd_id, v_type, NULL, v_highlight_id, v_actor, v_key, 'accepted', v_event_id);

  RETURN jsonb_build_object(
    'ok', true, 'duplicate', false,
    'highlight_id', v_highlight_id, 'event_id', v_event_id, 'event_type', v_event_type,
    'sequence', v_seq, 'result', v_result, 'contract_version', 1);
END;
$fn$;

COMMENT ON FUNCTION public.highlight_kernel_execute(jsonb) IS
  'Highlight Command Bus write path (Highlights/Memories spec §5/§12/§17/§19/§21/§23/§24). Applies ONE of PIN_HIGHLIGHT / UNPIN_HIGHLIGHT / HIDE_HIGHLIGHT: honours the shared idempotency receipt, locks and re-checks highlights.owner_id, applies the column change, then writes memory_domain_events + memory_event_outbox + memory_command_receipts + memory_command_audit in the SAME transaction. PUBLISH_HIGHLIGHT is refused by name — the schema has no storable "published" distinct from creation. Rejections are RETURNED with a §24 reason code and still write an audit row; failures RAISE and roll everything back. service_role only.';

REVOKE ALL ON FUNCTION public.highlight_kernel_execute(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.highlight_kernel_execute(jsonb) TO service_role;

-- ── 6. Postconditions ────────────────────────────────────────────────────────
DO $$
DECLARE v jsonb; n integer;
BEGIN
  -- The four tables carry the new column.
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND column_name = 'highlight_id'
     AND table_name IN ('memory_domain_events', 'memory_event_outbox',
                        'memory_command_receipts', 'memory_command_audit');
  IF n <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected highlight_id on 4 kernel tables, found %', n;
  END IF;

  -- THE CENTRAL CLAIM OF THIS MIGRATION, ASSERTED RATHER THAN ASSUMED: the
  -- relaxation of memory_id is covered by a constraint that is strictly
  -- stronger. If the CHECK is not there, the NOT NULL must not have gone.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_domain_events_one_subject') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_id was relaxed on memory_domain_events with no exactly-one-subject CHECK to replace it';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_event_outbox_one_subject') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_id was relaxed on memory_event_outbox with no exactly-one-subject CHECK to replace it';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_domain_events_highlight_sequence_unique') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_domain_events has no UNIQUE (highlight_id, sequence)';
  END IF;

  -- No row anywhere is subjectless. Vacuously true on an empty table and
  -- checked anyway, because "the constraint exists" and "the data satisfies
  -- it" are different statements and only one of them was just enforced.
  SELECT count(*) INTO n FROM public.memory_domain_events
   WHERE num_nonnulls(memory_id, highlight_id) <> 1;
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % memory_domain_events row(s) do not have exactly one subject', n;
  END IF;

  -- Client roles gained nothing.
  IF has_function_privilege('anon', 'public.highlight_kernel_execute(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.highlight_kernel_execute(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a client role can EXECUTE highlight_kernel_execute';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.highlight_kernel_execute(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role cannot EXECUTE highlight_kernel_execute';
  END IF;

  -- A malformed command is REJECTED, not raised, and writes no event.
  v := public.highlight_kernel_execute('{}'::jsonb);
  IF (v->>'reason') IS DISTINCT FROM 'MEMORY_COMMAND_MALFORMED' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: highlight_kernel_execute({}) returned %', v;
  END IF;

  -- PUBLISH_HIGHLIGHT is refused BY NAME. This is the assertion that keeps the
  -- header's claim honest: the command is not quietly accepted as a no-op.
  v := public.highlight_kernel_execute(jsonb_build_object(
        'command_id', gen_random_uuid(), 'actor_user_id', gen_random_uuid(),
        'highlight_id', gen_random_uuid(),
        'idempotency_key', '2993-postcondition-publish', 'type', 'PUBLISH_HIGHLIGHT',
        'payload', '{}'::jsonb));
  IF (v->>'reason') IS DISTINCT FROM 'MEMORY_COMMAND_UNKNOWN_TYPE' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: PUBLISH_HIGHLIGHT returned % instead of being refused by name', v;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memory_command_audit
                  WHERE idempotency_key = '2993-postcondition-publish'
                    AND outcome = 'rejected' AND reason = 'MEMORY_COMMAND_UNKNOWN_TYPE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a rejected highlight command wrote no audit row';
  END IF;
  DELETE FROM public.memory_command_audit WHERE idempotency_key = '2993-postcondition-publish';

  -- A command naming a Highlight that does not exist is HIGHLIGHT_NOT_FOUND
  -- and writes no event.
  v := public.highlight_kernel_execute(jsonb_build_object(
        'command_id', gen_random_uuid(), 'actor_user_id', gen_random_uuid(),
        'highlight_id', gen_random_uuid(),
        'idempotency_key', '2993-postcondition-absent', 'type', 'PIN_HIGHLIGHT',
        'payload', '{}'::jsonb));
  IF (v->>'reason') IS DISTINCT FROM 'HIGHLIGHT_NOT_FOUND' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: an absent Highlight returned %', v;
  END IF;
  DELETE FROM public.memory_command_audit WHERE idempotency_key = '2993-postcondition-absent';

  -- The flag is still FALSE: applying this migration must not turn anything on.
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_kernel_enabled' AND enabled = false) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_kernel_enabled is missing or not false';
  END IF;
END $$;

COMMIT;
