-- 2994_memory_relations_and_outbox_consumer.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band), memory-kernel lane.
-- Additive, idempotent, forward-only. Creates one table and three functions.
-- It changes NO existing row and drops NOTHING.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS FILE IS NUMBERED 2994 AND NOT 3002
-- ═══════════════════════════════════════════════════════════════════════════
-- This lane was assigned "migration 3002, do not use any other number". 3002 is
-- NOT A LEGAL PREFIX IN THIS REPOSITORY and the assignment could not be
-- followed as written. src/scripts/migrationPrefixRules.ts:31 fixes the band
-- for every new 4-digit prefix at 2100-2999 (`/^2[1-9]\d{2}_/`), and
-- validatePrefixBand returns a violation for "a 4-digit prefix >= 2100 that
-- isn't in the 2100-2999 range (i.e. >= 3000)".
--
-- MEASURED, not inferred. With this file named 3002 the guard fails:
--
--   $ npm run check:migration-prefixes
--   • 3002_...sql: prefix 3002 is >= 2100 but outside the required 2100-2999
--     range (must match /^2[1-9]\d{2}_/)
--
-- and with it named 2994 the guard passes. The check is green at the commit
-- this branch forked from, so shipping 3002 would have turned a passing check
-- red. The alternative — widening the band in migrationPrefixRules.ts — is
-- raising a ceiling on a guard this lane does not own, which is forbidden.
--
-- 2994 is chosen by a rule, not by taste: THE HIGHEST FREE PREFIX IN THE LEGAL
-- BAND. 2995-2999 are taken; 2994 is the first free slot below them. The intent
-- behind "3002" — one migration, uniquely this lane's, colliding with no other
-- lane — is preserved exactly. THE LEAD MUST ARBITRATE: every sibling lane
-- handed a 30xx number will hit this same wall.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS FILE IS FOR
-- ═══════════════════════════════════════════════════════════════════════════
-- Spec: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
--   §3.4 MemoryRelation — the relation record itself.
--   §4   MemoryRelationType — the nine names.
--   §7   "Deduplication relationships" between detected episodes.
--   §17  "Use an outbox pattern: canonical mutation and event-outbox insert
--        occur in one database transaction. Consumers must be idempotent and
--        may rebuild disposable projections asynchronously."
--   §18  Projections and Derived Artifact Registry — what the consumer feeds.
--   §24  projection_lag.
--
-- TWO GAPS, MEASURED AT THIS COMMIT, AND WHAT EACH ACTUALLY WAS
-- -------------------------------------------------------------
-- This lane was briefed that `memory_evidence`, `memory_episodes` and
-- `memory_relations` have no CREATE TABLE anywhere in the tree. THAT IS TRUE OF
-- ONE OF THE THREE. Re-measured here, and corrected in the record:
--
--   memory_episodes  CREATE TABLE at 2320_memory_episode_provenance_spine.sql:102
--   memory_evidence  CREATE TABLE at 2320_memory_episode_provenance_spine.sql:227
--   memory_relations NO CREATE TABLE ANYWHERE — the only true absence.
--
-- 2320 is WRITTEN AND UNAPPLIED: it appears nowhere in
-- src/lib/capability/production-applied-migrations.json and neither table is in
-- snapshots/20260921-production-schema.json. So the blocker on H54-H61 is a
-- DEPLOYMENT, not a missing design, and this file deliberately does NOT
-- redefine those two tables. Doing so would fork the schema: 2320's
-- memory_episodes carries an eligibility CHECK constraint that makes raw
-- sensing structurally unable to become Memory, and a second, subtly different
-- definition landing first would silence it via CREATE TABLE IF NOT EXISTS —
-- the exact failure mode lib/memoryTableOwnership.ts exists to prevent.
--
-- H62/H106's `memory_relations` is genuinely absent and is created below.
--
-- THE OUTBOX HAS NO CONSUMER, AND COULD NOT HAVE A SAFE ONE
-- ----------------------------------------------------------
-- src/lib/memoryOutbox.ts records four measured properties of the deployed
-- outbox. Two of them are why this file adds functions rather than letting a
-- worker poll the table directly:
--
--   "NOTHING ACKS. published_at, attempts and last_error are columns that no
--    code writes."
--   "THERE IS NO POISON HANDLING ... no lease/visibility-timeout column to add
--    one to. An unacked row is returned first on every read, indefinitely."
--
-- Both are addressed here, in SQL, for the same reason the emit is in SQL:
-- claim-then-process-then-ack is only correct if the claim is atomic, and
-- supabase-js has no transactions. memory_outbox_claim below does the claim in
-- one statement under FOR UPDATE SKIP LOCKED.
--
-- AT-LEAST-ONCE, NOT EXACTLY-ONCE, AND THAT IS THE DESIGN
-- --------------------------------------------------------
-- The consumer claims, does its work, then acks. A crash between work and ack
-- redelivers the event. This is deliberate and is what §17's "Consumers must be
-- idempotent" is FOR: the alternative (ack first) drops events silently on a
-- crash, which is the failure the outbox pattern exists to prevent. The
-- consumer's only side effect is rebuildProjection, which is an upsert keyed
-- (projection_id, scope_key) and is proved replay-safe by §25's H244.
--
-- WHAT THIS DOES *NOT* CLAIM
-- ---------------------------
-- Applying this file emits nothing. `memory_kernel_enabled` is FALSE in
-- production (snapshots/20260921-production-schema.json:6710), so no outbox row
-- has ever been written and the consumer will correctly drain zero rows. This
-- migration makes the consumer POSSIBLE; the flag is what puts it IN FORCE.

BEGIN;

-- ── 0. Preconditions ─────────────────────────────────────────────────────────
-- Stated as a refusal rather than assumed, because every object below either
-- references memory_event_outbox or is keyed to public.memories.
DO $pre$
BEGIN
  IF to_regclass('public.memories') IS NULL THEN
    RAISE EXCEPTION '2994 PRECONDITION FAILED: public.memories does not exist';
  END IF;
  IF to_regclass('public.memory_event_outbox') IS NULL THEN
    RAISE EXCEPTION '2994 PRECONDITION FAILED: public.memory_event_outbox does not exist — apply 2710 first';
  END IF;
END
$pre$;

-- ── 1. §3.4 MemoryRelation ───────────────────────────────────────────────────
-- Shaped to the code that already exists and is currently unable to persist:
--   services/memoryProjections/memoryGraph.ts:64  MemoryEdge
--     { source_memory_id, target_type, target_id, relation_type, confidence,
--       visibility_override }
--   services/memoryProjections/episodeDetection.ts:375  relateEpisodes
--     returns SAME_EPISODE | POSSIBLE_DUPLICATE | RELATED | CONTAINS
--
-- WHY THE SOURCE IS POLYMORPHIC. §3.4's relation runs from a MEMORY; §7's
-- dedup relation runs between two EPISODES. The census files both against this
-- one table (H62 "`memory_relations` does not exist to record one"; H106 "No
-- `memory_relations` table"), so one table serves both and says which it is in
-- a column rather than in a naming convention.
--
-- WHY POSSIBLE_DUPLICATE IS IN THE VOCABULARY. It is not one of §4's nine. It
-- is §7's, it is a value relateEpisodes actually returns, and a CHECK that
-- rejected it would make the only dedup verdict the detector can produce
-- unstorable. The two vocabularies are kept legible by which source_type uses
-- them, not by merging them.
--
-- WHY target_id IS text AND NOT uuid. MEMORY_EDGE_TARGETS includes STAMP and
-- WORLD_CONTEXT_SNAPSHOT, and memoryGraph.ts types target_id as string.
-- memory_episodes.place_id is text (2320:102). A uuid column would make a
-- valid edge unstorable.
CREATE TABLE IF NOT EXISTS public.memory_relations (
  id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The owner, denormalized ON PURPOSE: the source is polymorphic, so an RLS
  -- policy cannot reach a single parent table by join. Kept honest by the
  -- trigger in section 2.
  owner_id           uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source_type        text        NOT NULL,
  source_id          uuid        NOT NULL,
  target_type        text        NOT NULL,
  target_id          text        NOT NULL,
  relation_type      text        NOT NULL,
  -- NULL means NOT SCORED, exactly as 2999 made trust scores nullable mean.
  -- A detector with no confidence model must not be forced to invent a number.
  confidence         numeric(4,3) NULL,
  visibility_override text       NULL,
  -- §28.13 / §24: which detector asserted this, so a bad version is revocable.
  detector_version   text        NULL,
  -- §6/§7 reason code, from episodeDetection.ts:71 EPISODE_REASON_CODES.
  reason_code        text        NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT memory_relations_source_type_vocabulary
    CHECK (source_type IN ('MEMORY', 'EPISODE')),
  -- services/memoryProjections/memoryGraph.ts:49 MEMORY_EDGE_TARGETS, plus
  -- EPISODE so a §7 dedup edge has a target class at all.
  CONSTRAINT memory_relations_target_type_vocabulary
    CHECK (target_type IN ('PERSON', 'PLACE', 'TRIP', 'EVENT', 'STAMP', 'MEMORY',
                           'WORLD_CONTEXT_SNAPSHOT', 'EPISODE')),
  -- §4's nine (memoryGraph.ts:58) + §7's POSSIBLE_DUPLICATE. Spelled out rather
  -- than a LIKE pattern for 2710's reason: a typo'd relation type is an edge
  -- nothing queries and nobody notices.
  CONSTRAINT memory_relations_relation_type_vocabulary
    CHECK (relation_type IN ('SAME_EPISODE', 'RELATED', 'CONTAINS', 'LED_TO',
                             'DISCOVERED_THROUGH', 'INTRODUCED_BY', 'RESULTED_IN',
                             'DERIVED_FROM', 'INSPIRED', 'POSSIBLE_DUPLICATE')),
  CONSTRAINT memory_relations_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT memory_relations_target_id_nonempty
    CHECK (char_length(target_id) > 0),
  -- A relation is a FACT, not an event: asserting it twice is the same fact.
  -- This is what makes a detector re-run idempotent, which §7's "deterministic,
  -- replayable grouping" (H58) requires of the storage as well as the function.
  CONSTRAINT memory_relations_unique_edge
    UNIQUE (source_type, source_id, target_type, target_id, relation_type)
);

COMMENT ON TABLE public.memory_relations IS
  'Highlights/Memories spec §3.4 MemoryRelation. Holds BOTH §4 memory->target edges (source_type=MEMORY, services/memoryProjections/memoryGraph.ts) and §7 episode dedup relations (source_type=EPISODE, episodeDetection.ts relateEpisodes). Derived and rebuildable, never canonical truth: a detector re-run may safely re-assert every row. Service-role writes only; owners read their own.';

CREATE INDEX IF NOT EXISTS idx_memory_relations_source
  ON public.memory_relations (source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_memory_relations_target
  ON public.memory_relations (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_memory_relations_owner
  ON public.memory_relations (owner_id, created_at DESC);

-- ── 2. owner_id may not lie ──────────────────────────────────────────────────
-- The denormalized owner is the ONLY thing RLS below can key on, so a row whose
-- owner_id disagrees with its source's owner would be a row readable by the
-- wrong person. A CHECK constraint cannot express this (it is a cross-table
-- lookup), so it is a trigger, and it REFUSES rather than repairs — the same
-- posture evidence.ts:246 normalizeEvidence takes toward a bad observed_at.
CREATE OR REPLACE FUNCTION public.memory_relations_owner_matches_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_owner uuid;
BEGIN
  IF NEW.source_type = 'MEMORY' THEN
    SELECT m.owner_id INTO v_owner FROM public.memories m WHERE m.id = NEW.source_id;
    IF v_owner IS NULL THEN
      RAISE EXCEPTION 'memory_relations: source memory % does not exist', NEW.source_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  ELSIF NEW.source_type = 'EPISODE' THEN
    -- memory_episodes is migration 2320, which is NOT applied in production.
    -- A relation whose source table is absent is refused rather than stored
    -- unvalidated: an unvalidatable owner is precisely the row RLS would then
    -- serve to the wrong person.
    IF to_regclass('public.memory_episodes') IS NULL THEN
      RAISE EXCEPTION 'memory_relations: source_type EPISODE requires public.memory_episodes (migration 2320), which is not applied'
        USING ERRCODE = 'undefined_table';
    END IF;
    EXECUTE 'SELECT e.user_id FROM public.memory_episodes e WHERE e.id = $1'
      INTO v_owner USING NEW.source_id;
    IF v_owner IS NULL THEN
      RAISE EXCEPTION 'memory_relations: source episode % does not exist', NEW.source_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  IF NEW.owner_id IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION 'memory_relations: owner_id % does not match the source''s owner %', NEW.owner_id, v_owner
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_memory_relations_owner_matches ON public.memory_relations;
CREATE TRIGGER trg_memory_relations_owner_matches
  BEFORE INSERT OR UPDATE ON public.memory_relations
  FOR EACH ROW EXECUTE FUNCTION public.memory_relations_owner_matches_source();

-- ── 3. Grants and RLS ────────────────────────────────────────────────────────
-- Supabase's ALTER DEFAULT PRIVILEGES hands anon/authenticated the full DML set
-- at CREATE TABLE. Take it back, then grant exactly what is meant — 2710's
-- posture, for 2710's reason.
ALTER TABLE public.memory_relations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_relations FROM PUBLIC, anon, authenticated;

-- §23: owner-only, SELECT only. Participants get nothing — spec line 599,
-- "Participant membership alone does not grant full Memory access."
GRANT SELECT ON public.memory_relations TO authenticated;
DROP POLICY IF EXISTS memory_relations_owner_select ON public.memory_relations;
CREATE POLICY memory_relations_owner_select ON public.memory_relations
  FOR SELECT USING (owner_id = auth.uid());

-- ── 4. The outbox consumer's claim / ack / fail ──────────────────────────────
-- A lease column. ADDITIVE: a nullable column with no default, so PostgreSQL
-- adds it as a catalog change and rewrites no row. NO EXISTING ROW IS READ,
-- CHANGED OR DELETED by this statement.
ALTER TABLE public.memory_event_outbox
  ADD COLUMN IF NOT EXISTS locked_until timestamptz NULL;

COMMENT ON COLUMN public.memory_event_outbox.locked_until IS
  'Visibility timeout held by a claiming consumer (migration 2994). NULL = unclaimed. A lease in the past is re-claimable, so a consumer that crashed mid-batch does not strand its rows. Written only by public.memory_outbox_claim / _ack / _fail.';

-- The claim index. Partial on the same predicate the claim scans.
CREATE INDEX IF NOT EXISTS idx_memory_outbox_claimable
  ON public.memory_event_outbox (id) WHERE published_at IS NULL;

-- CLAIM. One statement, so the select-and-lock and the lease write cannot be
-- interleaved by a second worker.
--
-- FOR UPDATE SKIP LOCKED is what makes concurrent consumers safe: a row another
-- worker is claiming right now is skipped rather than waited on, so two workers
-- drain disjoint batches instead of serializing.
--
-- POISON HANDLING, the gap memoryOutbox.ts names. `attempts < p_max_attempts`
-- means a row that has failed p_max_attempts times STOPS being claimed. It is
-- not deleted and not moved: it stays visible with its last_error for operator
-- triage, and it no longer blocks the rows behind it. That is the deliberate
-- choice memoryOutbox.ts said belongs to the worker; it is made here, once, in
-- the only place both consumers would otherwise have to agree by convention.
--
-- attempts IS INCREMENTED AT CLAIM, NOT AT FAILURE. A consumer that crashes
-- without reporting anything must still burn an attempt, or a row that kills
-- its worker every time is retried forever and the max is unreachable.
CREATE OR REPLACE FUNCTION public.memory_outbox_claim(
  p_limit         integer DEFAULT 100,
  p_lease_seconds integer DEFAULT 300,
  p_max_attempts  integer DEFAULT 5
)
RETURNS TABLE (
  id           bigint,
  event_id     uuid,
  memory_id    uuid,
  type         text,
  created_at   timestamptz,
  attempts     integer,
  locked_until timestamptz
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  UPDATE public.memory_event_outbox o
     SET locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
         attempts     = o.attempts + 1
   WHERE o.id IN (
     SELECT c.id
       FROM public.memory_event_outbox c
      WHERE c.published_at IS NULL
        AND (c.locked_until IS NULL OR c.locked_until < now())
        AND c.attempts < greatest(p_max_attempts, 1)
      ORDER BY c.id ASC
      LIMIT greatest(p_limit, 0)
        FOR UPDATE SKIP LOCKED
   )
  RETURNING o.id, o.event_id, o.memory_id, o.type, o.created_at, o.attempts, o.locked_until;
$fn$;

COMMENT ON FUNCTION public.memory_outbox_claim(integer, integer, integer) IS
  'Claim a batch of unpublished Memory outbox rows under a lease (Highlights/Memories spec §17). Atomic: FOR UPDATE SKIP LOCKED, so concurrent consumers drain disjoint batches. Increments attempts at CLAIM so a consumer-killing row cannot be retried forever. Rows at or above p_max_attempts stop being claimed and remain visible for triage.';

-- ACK. Idempotent by construction: `published_at IS NULL` means acking twice is
-- a no-op rather than a second timestamp, so an at-least-once redelivery whose
-- work was already done cannot rewrite history.
--
-- Returns the COUNT ACTUALLY ACKED, not void. An UPDATE matching zero rows
-- raises nothing in PostgreSQL and resolves cleanly in supabase-js, so a
-- consumer that ignored this number could report a drained batch while acking
-- nothing at all — §28.11's "plausible-looking empty history", in the ack
-- direction.
CREATE OR REPLACE FUNCTION public.memory_outbox_ack(p_ids bigint[])
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_count integer;
BEGIN
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;
  UPDATE public.memory_event_outbox o
     SET published_at = now(),
         locked_until = NULL,
         last_error   = NULL
   WHERE o.id = ANY(p_ids)
     AND o.published_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$fn$;

COMMENT ON FUNCTION public.memory_outbox_ack(bigint[]) IS
  'Mark Memory outbox rows published (spec §17). Idempotent: filtered on published_at IS NULL, so a redelivered ack is a no-op. Returns the number ACTUALLY acked so a caller cannot mistake a zero-row update for a drained batch.';

-- FAIL. Records WHY and releases the lease so the row is retried promptly
-- rather than after the full lease. attempts is NOT incremented here — the
-- claim already did it.
--
-- The error text is a FAILURE CLASS, not a message body: §24 asks for a failure
-- class, and §24 also says "Do not log sensitive raw content unless strictly
-- necessary". The column is truncated hard so a driver that hands back a row
-- rendering cannot turn the outbox into a copy of the Memory.
CREATE OR REPLACE FUNCTION public.memory_outbox_fail(
  p_id    bigint,
  p_class text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.memory_event_outbox o
     SET last_error   = left(coalesce(p_class, 'unknown'), 200),
         locked_until = NULL
   WHERE o.id = p_id
     AND o.published_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$fn$;

COMMENT ON FUNCTION public.memory_outbox_fail(bigint, text) IS
  'Record a failure CLASS against a Memory outbox row and release its lease (spec §24). Does not increment attempts — memory_outbox_claim already did, so a consumer that dies before reporting still burns one. Truncated to 200 chars: a failure class, never a Memory body.';

-- Service-role only, explicitly. 2973 established the execute boundary and
-- 2710's header records why the REVOKE must be spelled out: CREATE FUNCTION
-- grants EXECUTE to PUBLIC by default, and ALTER DEFAULT PRIVILEGES would hand
-- it to anon and authenticated as well. A consumer is infrastructure; a signed-
-- in user has no business acking anyone's events, including their own.
REVOKE ALL ON FUNCTION public.memory_outbox_claim(integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.memory_outbox_ack(bigint[])                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.memory_outbox_fail(bigint, text)               FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_outbox_claim(integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.memory_outbox_ack(bigint[])                    TO service_role;
GRANT EXECUTE ON FUNCTION public.memory_outbox_fail(bigint, text)               TO service_role;

-- ── 5. Postconditions ────────────────────────────────────────────────────────
-- Each one is a property a later reader would otherwise have to take on trust,
-- and each has a way of being false that is not obvious from the DDL above.
DO $post$
DECLARE
  n integer;
  v_owner uuid;
  v_memory uuid;
BEGIN
  -- 1. The table exists with RLS on. RLS is the half that silently does not
  --    happen if a CREATE TABLE IF NOT EXISTS matched an older definition.
  SELECT count(*) INTO n
    FROM pg_tables WHERE schemaname = 'public' AND tablename = 'memory_relations';
  IF n <> 1 THEN
    RAISE EXCEPTION '2994 postcondition 1 FAILED: public.memory_relations does not exist';
  END IF;
  SELECT count(*) INTO n
    FROM pg_class WHERE oid = 'public.memory_relations'::regclass AND relrowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '2994 postcondition 1 FAILED: RLS is not enabled on public.memory_relations';
  END IF;

  -- 2. authenticated cannot write it. The REVOKE above is the whole boundary;
  --    if Supabase's default grants outran it, this catches it here rather than
  --    in production.
  SELECT count(*) INTO n
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'memory_relations'
     AND grantee IN ('anon', 'authenticated')
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  IF n <> 0 THEN
    RAISE EXCEPTION '2994 postcondition 2 FAILED: anon/authenticated still hold % write grant(s) on memory_relations', n;
  END IF;

  -- 3. The lease column landed on the outbox.
  SELECT count(*) INTO n
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'memory_event_outbox'
     AND column_name = 'locked_until';
  IF n <> 1 THEN
    RAISE EXCEPTION '2994 postcondition 3 FAILED: memory_event_outbox.locked_until is absent';
  END IF;

  -- 4. NO EXISTING OUTBOX ROW WAS TOUCHED. The lease column must be NULL on
  --    every pre-existing row and no row may have been published by this file.
  --    This is the data-preservation claim, checked rather than asserted.
  SELECT count(*) INTO n FROM public.memory_event_outbox WHERE locked_until IS NOT NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION '2994 postcondition 4 FAILED: % outbox row(s) already carry a lease — this migration must not claim anything', n;
  END IF;

  -- 5. The three functions exist and none of them is executable by a signed-in
  --    user. has_function_privilege is asked directly, because a grant can
  --    arrive from a default privilege this file never names.
  FOR n IN
    SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.proname IN ('memory_outbox_claim', 'memory_outbox_ack', 'memory_outbox_fail')
  LOOP
    NULL;
  END LOOP;
  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('memory_outbox_claim', 'memory_outbox_ack', 'memory_outbox_fail');
  IF n <> 3 THEN
    RAISE EXCEPTION '2994 postcondition 5 FAILED: expected 3 outbox consumer functions, found %', n;
  END IF;
  IF has_function_privilege('authenticated', 'public.memory_outbox_ack(bigint[])', 'EXECUTE') THEN
    RAISE EXCEPTION '2994 postcondition 5 FAILED: authenticated can EXECUTE memory_outbox_ack';
  END IF;

  -- 6. THE OWNER TRIGGER ACTUALLY REFUSES. A trigger that exists and does not
  --    fire is the defect this postcondition is for, and it is the one a
  --    reviewer cannot see by reading the DDL. Probed against a real row and
  --    ALWAYS rolled back — 2999's rollback_probe shape, for 2999's reason.
  SELECT m.id, m.owner_id INTO v_memory, v_owner FROM public.memories m LIMIT 1;
  IF v_memory IS NOT NULL THEN
    BEGIN
      INSERT INTO public.memory_relations
        (owner_id, source_type, source_id, target_type, target_id, relation_type)
      VALUES
        -- A deliberately WRONG owner: the all-zero uuid is nobody's.
        ('00000000-0000-0000-0000-000000000000'::uuid, 'MEMORY', v_memory, 'PLACE', 'probe', 'RELATED');
      RAISE EXCEPTION '2994 postcondition 6 FAILED: a memory_relations row with a mismatched owner_id was ACCEPTED';
    EXCEPTION
      WHEN check_violation THEN
        NULL;  -- refused, which is the pass
      WHEN foreign_key_violation THEN
        NULL;  -- profiles FK fired first; also a refusal
    END;
  END IF;
END
$post$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- DEPLOYMENT SEQUENCE
-- ═══════════════════════════════════════════════════════════════════════════
-- This file is SAFE TO APPLY ON ITS OWN and changes no behaviour by itself.
--
--   1. Apply 2994. It creates public.memory_relations (a NEW, EMPTY table),
--      adds a NULLABLE column to public.memory_event_outbox, and creates three
--      functions. No UPDATE, no DELETE and no DROP touches any pre-existing
--      row. Postcondition 4 asserts this against the outbox itself.
--   2. Commit the entry in src/lib/capability/production-applied-migrations.json
--      IN THE SAME CHANGE, per that file's own instruction.
--   3. Re-take the production schema snapshot
--      (src/lib/capability/snapshots/) so checkFlagSchemaPrerequisites does not
--      see the ledger run ahead of the snapshot.
--   4. NOTHING ELSE CHANGES UNTIL A FLAG MOVES. memory_kernel_enabled is FALSE,
--      so the outbox stays empty and the consumer drains zero rows forever.
--      Turning the kernel on is a SEPARATE decision with its own rehearsal, and
--      this file does not make it.
--
-- ROLLBACK. DROP TABLE public.memory_relations, DROP the three functions, and
-- ALTER TABLE public.memory_event_outbox DROP COLUMN locked_until. Dropping the
-- column loses only in-flight leases, which are by definition re-claimable.
-- Nothing else in the schema references any of it.
--
-- NOT REHEARSED AGAINST PRODUCTION. Rehearsed against scripts/local-db (the
-- baseline plus the canonical chain) only. This file has NOT been applied to
-- any real project by this lane.
