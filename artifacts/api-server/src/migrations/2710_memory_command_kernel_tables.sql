-- 2710_memory_command_kernel_tables.sql
--
-- WHAT: the four tables the Memory Command Bus needs, plus the feature flag
-- that gates it, seeded FALSE. No function yet (that is 2711), so applying this
-- migration alone changes nothing any user can observe.
--
--   public.memory_domain_events            immutable domain events (§17's fourteen names)
--   public.memory_event_outbox      the transactional outbox (§17)
--   public.memory_command_receipts  idempotency receipts (§17, §19)
--   public.memory_command_audit     one row per COMMAND ATTEMPT (§17 audit, §24)
--   feature_flags('memory_kernel_enabled', false)
--
-- WHY THE TABLE IS CALLED memory_domain_events AND NOT memory_events.
-- It was written as `memory_events`, and a CI rehearsal before any apply found
-- that `public.memory_events` ALREADY EXISTS -- in CI and in production -- as a
-- completely different table:
--
--   existing:  id, user_id, event_type, occurred_at, subject_type, subject_id,
--              source, visibility, source_ref, metadata, created_at, expires_at
--   this one:  event_id, memory_id, sequence, type, actor_user_id, causation_id,
--              correlation_id, payload_json, schema_version, occurred_at, recorded_at
--
-- Two different things sharing a name. The existing one is load-bearing: ten
-- migrations (2183, 2186, 2187, 2190, 2192, 2193, 2194, 2197, 2200, 2333)
-- build the Memory projection family on it, and both AccountDeletionService and
-- lib/deletionDispositions cascade user erasure through it.
--
-- `CREATE TABLE IF NOT EXISTS` is what makes this worth spelling out. It would
-- NOT have created the table and would NOT have complained; the failure would
-- have surfaced two statements later, when `CREATE INDEX ... (memory_id,
-- sequence)` hit a table with no memory_id column -- and had the index shapes
-- happened to be compatible, it would not have surfaced at all, leaving the
-- kernel writing domain events into the projection family's table. Renaming is
-- the whole fix; nothing else about the design changes.
--
-- Spec: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
--   §17 "All canonical writes should cross an explicit command boundary for
--        authorization, invariants, idempotency, audit, and downstream event
--        generation." + the seventeen command names and fourteen event names.
--   §17 "Use an outbox pattern: canonical mutation and event-outbox insert
--        occur in one database transaction. Consumers must be idempotent and
--        may rebuild disposable projections asynchronously."
--   §19 "client-generated operation IDs and server-side idempotency"
--   §23 "Owner-only access to canonical private Memory facts by default";
--        "Search/index workers consume privacy-filtered event payloads where
--        possible rather than raw entire rows."
--   §24 "Operational logs must include memoryId, commandId, eventId, source
--        version, engine version, reason codes, projection name, failure class."
--
-- WHY. WHAT WAS MEASURED.
-- =======================
-- docs/architecture/census-highlights-memories.md §17, re-measured in this lane
-- against src/routes/memories.ts:
--
--   * Eleven of §17's seventeen commands existed as ad-hoc REST writes with NO
--     command boundary, NO idempotency key, NO audit row and NO outbox insert.
--   * `memory_event_outbox` had ZERO occurrences anywhere in the repository.
--   * Not one of §17's fourteen domain events was emitted by any Memory or
--     Highlight write path.
--   * The census's own summary of the architecture: "Nothing in this repository
--     has been built for the Highlights/Memories spec."
--
-- The consequence that is not academic: a Memory write and anything that has to
-- happen because of it (a projection rebuild, a public-derivative revocation,
-- a search de-index) had no ordered, replayable record connecting them. §21's
-- revocation propagation and §18's derivative registry both start from an event
-- that did not exist. This migration creates the place it will live.
--
-- WHAT THIS CHANGES FOR A USER: NOTHING, UNTIL A FLAG IS FLIPPED
-- =============================================================
-- `memory_kernel_enabled` is seeded FALSE. src/lib/featureFlags.isFlagEnabled
-- is fail-closed (absent row, unreadable table, thrown error => false), so with
-- the flag false every write path in routes/memories.ts is the direct write it
-- was, the four tables below stay empty, and no reader anywhere is changed.
-- src/test/memoryCommandRoutes.test.ts proves the flag-off path never calls the
-- kernel and writes no event.
--
-- The §5 lifecycle guard this lane also shipped is NOT gated by this flag: it
-- is pure TypeScript over the state the row already carries and needs none of
-- these tables.
--
-- TABLE ACCESS
-- ============
--   memory_domain_events            RLS on. ONE policy: SELECT by the Memory's OWNER
--                            (§23 "Owner-only access to canonical private
--                            Memory facts by default"). NOT crew, NOT
--                            participants — §23 line 599 says "participant
--                            membership alone does not grant full Memory
--                            access", and an event stream is a full history of
--                            a private object. INSERT/UPDATE/DELETE/TRUNCATE
--                            revoked from every client role. A trigger refuses
--                            UPDATE for every role including service_role:
--                            events are append-only.
--   memory_event_outbox      RLS on, ZERO policies, ZERO client grants. No
--                            consumer exists (§18's projections are NOT built
--                            by this lane); rows accumulate with published_at
--                            NULL until one does.
--   memory_command_receipts  RLS on, ZERO policies, ZERO client grants. Holds
--                            the full original result for idempotent replay.
--   memory_command_audit     RLS on, ZERO policies, ZERO client grants. Written
--                            for ACCEPTED, DUPLICATE and REJECTED alike —
--                            §24's reason-code metrics have nothing to count if
--                            only successes are recorded.
--
-- WHY memory_command_audit AND memory_command_receipts ARE TWO TABLES.
-- They answer different questions and have different lifetimes. The receipt is
-- operational state: "has this actor already run this operation, and what did
-- it return?" — one row per ACCEPTED command, read on the hot path, and it dies
-- with the Memory (ON DELETE CASCADE) because a replay of a command against a
-- deleted Memory has nothing to return. The audit is the record: one row per
-- ATTEMPT including every refusal, never read on the hot path, and it survives
-- the Memory's deletion (memory_id is a plain uuid, NOT a foreign key) because
-- "who tried to do what to that Memory, and what did the system answer" is
-- exactly the question an incident asks after the row is gone. Folding them
-- into one table would force one of those two behaviours onto the other.
--
-- WHY THE AUDIT KEEPS NO MEMORY BODY. §24: "Do not log sensitive raw content
-- unless strictly necessary." The audit holds ids, the command name, the
-- outcome and the reason code. It does not hold the title, the caption, the
-- coordinates or the media URL — reconstructing what a command DID is the event
-- store's job and the event payload is privacy-filtered too (§23).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2710.
-- Depends on: public.memories (0067), public.feature_flags (0037).
-- Idempotent: every statement is IF NOT EXISTS / CREATE OR REPLACE /
-- DROP IF EXISTS-then-CREATE / ON CONFLICT DO NOTHING.
--
-- MUST BE TRUE BEFORE APPLYING:
--   * public.memories exists with columns id (uuid PK) and owner_id (uuid).
--   * public.feature_flags exists with PK column `flag` (0037_feature_flags.sql).
--   * The `service_role`, `authenticated` and `anon` roles exist (Supabase).
--   * 2711 has NOT yet been applied (it depends on these tables).
--
-- REVERSIBLE BY:
--   DELETE FROM public.feature_flags WHERE flag = 'memory_kernel_enabled';
--   DROP TABLE IF EXISTS public.memory_command_audit;
--   DROP TABLE IF EXISTS public.memory_command_receipts;
--   DROP TABLE IF EXISTS public.memory_event_outbox;
--   DROP TABLE IF EXISTS public.memory_domain_events;
--   DROP FUNCTION IF EXISTS public.memory_domain_events_refuse_update();
--   (Safe while the flag is false: nothing writes these tables.)

BEGIN;

-- ── 1. Event store (§17 domain events) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.memory_domain_events (
  event_id       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id      uuid        NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE,
  sequence       bigint      NOT NULL,
  type           text        NOT NULL,
  actor_user_id  uuid        NULL,
  causation_id   uuid        NULL,   -- the command_id that produced this event
  correlation_id uuid        NULL,
  payload_json   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  schema_version integer     NOT NULL DEFAULT 1,
  occurred_at    timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_domain_events_sequence_unique UNIQUE (memory_id, sequence),
  CONSTRAINT memory_domain_events_sequence_positive CHECK (sequence > 0),
  -- §17's fourteen names, spelled out rather than a LIKE pattern: a typo'd
  -- event type is a projection that silently never fires, and the consumer
  -- side has no way to notice a name nobody subscribes to.
  CONSTRAINT memory_domain_events_type_vocabulary CHECK (type IN (
    'memory.created', 'memory.confirmed', 'memory.corrected', 'memory.merged',
    'memory.split', 'memory.archived', 'memory.deleted', 'memory.visibility_changed',
    'highlight.created', 'highlight.published', 'highlight.expired',
    'highlight.pinned', 'highlight.hidden'))
);
COMMENT ON TABLE public.memory_domain_events IS
  'Immutable Memory domain events (Highlights/Memories spec §17). Written only by public.memory_kernel_execute, in the same transaction as the canonical state change. UPDATE is refused by trigger; DELETE follows the Memory (cascade). Payloads are privacy-filtered (§23): ids and vocabulary, never the Memory body.';
CREATE INDEX IF NOT EXISTS idx_memory_domain_events_memory_seq ON public.memory_domain_events (memory_id, sequence);
CREATE INDEX IF NOT EXISTS idx_memory_domain_events_type_time  ON public.memory_domain_events (type, recorded_at DESC);

CREATE OR REPLACE FUNCTION public.memory_domain_events_refuse_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  RAISE EXCEPTION 'memory_domain_events is append-only: UPDATE refused (event_id=%)', OLD.event_id
    USING ERRCODE = 'restrict_violation';
END;
$fn$;

DROP TRIGGER IF EXISTS trg_memory_domain_events_append_only ON public.memory_domain_events;
CREATE TRIGGER trg_memory_domain_events_append_only
  BEFORE UPDATE ON public.memory_domain_events
  FOR EACH ROW EXECUTE FUNCTION public.memory_domain_events_refuse_update();

-- ── 2. Outbox (§17) ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.memory_event_outbox (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id     uuid        NOT NULL REFERENCES public.memory_domain_events(event_id) ON DELETE CASCADE,
  memory_id    uuid        NOT NULL,
  type         text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz NULL,
  attempts     integer     NOT NULL DEFAULT 0,
  last_error   text        NULL
);
COMMENT ON TABLE public.memory_event_outbox IS
  'Outbox rows written in the same transaction as memory_domain_events (Highlights/Memories spec §17). NO CONSUMER EXISTS YET — rows accumulate with published_at NULL until a §18 projection worker is built. src/lib/memoryOutbox.readUnpublishedOutbox is the reader that worker will use.';
CREATE INDEX IF NOT EXISTS idx_memory_outbox_unpublished
  ON public.memory_event_outbox (id) WHERE published_at IS NULL;

-- ── 3. Idempotency receipts (§17, §19) ───────────────────────────────────────
-- Keyed (actor_user_id, idempotency_key), NOT (memory_id, key): CREATE_MEMORY
-- has no memory id when the command arrives, and §19's operation id belongs to
-- the client's operation, not to a row it has not created yet. The consequence
-- is deliberate and is enforced by the function: an actor who reuses one key
-- for a DIFFERENT command type is refused (MEMORY_IDEMPOTENCY_KEY_REUSED)
-- rather than being handed the earlier command's answer.
CREATE TABLE IF NOT EXISTS public.memory_command_receipts (
  actor_user_id   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  idempotency_key text        NOT NULL,
  command_id      uuid        NOT NULL,
  command_type    text        NOT NULL,
  memory_id       uuid        NULL REFERENCES public.memories(id) ON DELETE CASCADE,
  event_id        uuid        NOT NULL REFERENCES public.memory_domain_events(event_id) ON DELETE CASCADE,
  event_type      text        NOT NULL,
  result_json     jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_user_id, idempotency_key),
  CONSTRAINT memory_command_receipts_key_len CHECK (char_length(idempotency_key) BETWEEN 1 AND 200)
);
COMMENT ON TABLE public.memory_command_receipts IS
  'One row per ACCEPTED MemoryCommand, keyed (actor_user_id, idempotency_key). A second command with the same key returns THIS row''s result_json and performs no second transition (spec §17/§19). Service-role only.';

-- ── 4. Command audit (§17 "audit", §24) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.memory_command_audit (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  command_id      uuid        NOT NULL,
  command_type    text        NOT NULL,
  memory_id       uuid        NULL,   -- deliberately NOT a foreign key; see header
  actor_user_id   uuid        NOT NULL,
  idempotency_key text        NOT NULL,
  outcome         text        NOT NULL,
  reason          text        NULL,   -- §24 reason code, on a rejection
  event_id        uuid        NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_command_audit_outcome CHECK (outcome IN ('accepted', 'duplicate', 'rejected')),
  CONSTRAINT memory_command_audit_reason_present
    CHECK ((outcome = 'rejected') = (reason IS NOT NULL)),
  CONSTRAINT memory_command_audit_event_present
    CHECK (outcome = 'rejected' OR event_id IS NOT NULL)
);
COMMENT ON TABLE public.memory_command_audit IS
  'One row per MemoryCommand ATTEMPT — accepted, duplicate AND rejected (spec §17 audit, §24 reason codes). Survives the Memory''s deletion on purpose: memory_id is a plain uuid, not a foreign key. Holds no Memory content (§24 "do not log sensitive raw content"). Service-role only.';
CREATE INDEX IF NOT EXISTS idx_memory_command_audit_memory ON public.memory_command_audit (memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_command_audit_actor  ON public.memory_command_audit (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_command_audit_reason ON public.memory_command_audit (reason, created_at DESC)
  WHERE reason IS NOT NULL;

-- ── 5. RLS and grants ────────────────────────────────────────────────────────
ALTER TABLE public.memory_domain_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_event_outbox     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_command_audit    ENABLE ROW LEVEL SECURITY;

-- Supabase's ALTER DEFAULT PRIVILEGES hands anon/authenticated the full DML set
-- (plus TRUNCATE, which RLS never polices) at CREATE TABLE. Take it all back,
-- then grant exactly what is meant.
REVOKE ALL ON public.memory_domain_events           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.memory_event_outbox     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.memory_command_receipts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.memory_command_audit    FROM PUBLIC, anon, authenticated;

-- §23: owner-only, and SELECT only. Participants get nothing: line 599,
-- "Participant membership alone does not grant full Memory access."
GRANT SELECT ON public.memory_domain_events TO authenticated;
DROP POLICY IF EXISTS memory_domain_events_owner_select ON public.memory_domain_events;
CREATE POLICY memory_domain_events_owner_select ON public.memory_domain_events
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.memories m
             WHERE m.id = public.memory_domain_events.memory_id
               AND m.owner_id = auth.uid())
  );

-- ── 6. Feature flag, seeded FALSE ────────────────────────────────────────────
-- NOTE: the feature_flags PK column is `flag` (0037_feature_flags.sql).
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('memory_kernel_enabled', false,
   'Memory Command Bus (Highlights/Memories spec §17): canonical Memory writes in routes/memories.ts go through public.memory_kernel_execute (domain event, outbox row, idempotency receipt and command audit in one transaction). FALSE = every write path is exactly what it was, and no event is emitted. The §5 lifecycle guard is NOT gated by this flag.')
ON CONFLICT (flag) DO NOTHING;

-- ── 7. Postconditions ────────────────────────────────────────────────────────
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename IN ('memory_domain_events', 'memory_event_outbox', 'memory_command_receipts', 'memory_command_audit')
     AND rowsecurity;
  IF n <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected RLS on 4 kernel tables, found %', n;
  END IF;

  -- Client roles: SELECT on memory_domain_events only; nothing anywhere else.
  IF has_table_privilege('anon', 'public.memory_domain_events', 'SELECT')
     OR has_table_privilege('authenticated', 'public.memory_domain_events', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.memory_event_outbox', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.memory_event_outbox', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.memory_command_receipts', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.memory_command_receipts', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.memory_command_audit', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.memory_command_audit', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a client role holds a grant on a kernel table it must not';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.memory_domain_events', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated cannot SELECT memory_domain_events';
  END IF;

  -- Exactly one policy on memory_domain_events, and none on the other three.
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'memory_domain_events';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_domain_events should carry exactly 1 policy, found %', n;
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('memory_event_outbox', 'memory_command_receipts', 'memory_command_audit');
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a service-only kernel table carries % policies', n;
  END IF;

  -- The flag exists and is FALSE.
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_kernel_enabled' AND enabled = false) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_kernel_enabled is missing or not false';
  END IF;

  -- The append-only trigger is installed.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_memory_domain_events_append_only' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: memory_domain_events append-only trigger is absent';
  END IF;
END $$;

COMMIT;
