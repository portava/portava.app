-- 3811_memory_snapshots.sql
-- Highlights/Memories spec §3 storage (docs/specs/Portava_Highlights_Memories_
-- Development_Architecture_Spec_v1.txt:172-173): "memory_snapshots — Versioned
-- fact/evidence snapshots for replay", and §25 (:641-642): "Memory behavior must
-- be replayable from structured evidence, commands, and engine versions. This is
-- essential to diagnose false memories and migration changes." Census H35
-- (census-highlights-memories.md:1224, NOT-BUILT: "Zero occurrences").
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; B58 memories band
-- 3802-3819, cluster MEM-SNAPSHOTS). APPLIED TO NO DATABASE by the lane that
-- wrote it. ADDITIVE: one new table, two trigger functions, two triggers. No
-- flag (the plan has none): the trigger records history from the moment this
-- file is applied. NO EXISTING ROW IS WRITTEN: there is no backfill, so a Memory
-- last written before this file has no version until its next write (open owner
-- question Q-H35, fail-closed default: no history nobody asked for).
--
-- ── 1. WHAT A SNAPSHOT IS: FACTS ONLY (Q-H35, fail-closed default) ──────────
-- One row per VERSION of one Memory's facts. `facts` is a WHITELIST of fact
-- fields, and nothing else can be stored (CHECK memory_snapshots_facts_whitelist):
--   state                            the lifecycle state
--   visibility                       the visibility class
--   location_precision               the owner's precision rung (2338)
--   place_id, canonical_location_id  the place references
--   place_display_name_at_occurrence the place's name when recorded (3804)
--   starts_at, ends_at               the time window (UTC, millisecond ISO text)
--   source_mode, memory_type         provenance (3674) and the §4 type (3803)
--   item_count                       how many items the Memory held at the write
-- A later migration's column is in `facts` only where it exists (never null-filled).
-- NOT STORED: title, caption, coordinates, city/country text, people (the allowed/
-- hidden lists). BUT TWO FACTS ARE OWNER-CONTROLLED TEXT: place_id is free text (the
-- API takes any string <= 200; a pick is "fsq:…", and nothing stops prose), and
-- place_display_name_at_occurrence is the owner's own words for a pick (<= 300,
-- 3804 rule 3). Each version KEEPS them for the Memory's life: the owner cannot
-- retract a version (the guard below refuses it while the Memory is live); only
-- deleting the Memory (§21) or the account removes them. Open owner question
-- Q-H35-e: keep both as built / store canonical uuid place ids only and no name /
-- let the owner retract. item_count is counted at the MEMORY write (an item alone
-- does not version). engine_versions {"snapshot": "memory-snapshot@1"} names the
-- extractor. cause {command_id?, correction_id?} is read from the transaction
-- settings portava.memory_command_id / portava.memory_correction_id when a writer
-- set a uuid (anything else is ignored). NO WRITER SETS THEM TODAY (2711 is not
-- edited here), so cause is {} on every current path.
--
-- ── 2. WHO WRITES IT: AN AFTER ROW TRIGGER ON memories ───────────────────────
-- memory_snapshot_record() fires AFTER INSERT OR UPDATE on public.memories: every
-- writer (the API, 2711's kernel, 3676's merge/split) without editing any. A new
-- version ONLY when the facts differ from the newest (a title edit writes nothing),
-- none for a 'deleted' row (§21's RAW_EVIDENCE_PURGED purges what it had). One
-- version per changing WRITE: 2711's create (INSERT, then its precision UPDATE) can
-- leave two. Versions are serialised by the Memory row lock. FAIL-CLOSED: an error
-- inside the trigger fails the Memory write itself (a Memory write never lands
-- unrecorded); none is expected — the PK is serialised, the FKs hold by construction.
--
-- ── 3. THE CAP: 50 VERSIONS, THE OLDEST PRUNED (Q-H35) ───────────────────────
-- After writing version n the trigger deletes versions <= n - 50, so a Memory
-- keeps exactly its newest 50. Pruning the OLDEST is the rule that never loses
-- the LATEST: the alternative, to stop writing at 50, would freeze the history
-- at version 50 while the Memory kept changing, so its newest snapshot would
-- stop matching the Memory and every replay after that would diverge for good.
--
-- ── 4. WHO ELSE MAY CHANGE IT: NOBODY ────────────────────────────────────────
-- memory_snapshots_guard() (BEFORE UPDATE OR DELETE, per row) refuses every
-- UPDATE (a history that can be rewritten is not a replay record) and a DELETE
-- except on the four paths that are retention, not editing:
--   1. the §21 purge, after the Memory's soft delete (state = 'deleted');
--   2. the cascade from public.memories, when a Memory row is hard-deleted;
--   3. the cascade from auth.users, the account deletion's final step;
--   4. the cap's own prune (a version at least 50 below the newest).
-- Row-level only (2292's lesson: a statement trigger refuses an erasure cascade
-- whether or not there is anything to protect). 3673's memory_corrections_guard
-- is the same shape.
--
-- ── 5. WHY SECURITY DEFINER (both functions) ─────────────────────────────────
-- memory_snapshot_record() writes a table no API or client role may INSERT into
-- (service_role holds SELECT and DELETE only, so the server cannot forge a
-- version): as the table's owner it can, whichever role wrote the Memory. As
-- INVOKER, a write by a role without INSERT would FAIL the Memory write itself.
-- memory_snapshots_guard() reads auth.users and memories whatever role deletes.
-- Both: search_path pinned to pg_catalog, pg_temp, every name schema-qualified,
-- no dynamic SQL, EXECUTE revoked from PUBLIC / anon / authenticated, and RETURNS
-- trigger, so neither can be called as a function (3813's precondition accepts
-- a trigger function over memories by construction).
--
-- ── 6. ACCESS ────────────────────────────────────────────────────────────────
-- RLS ON with NO policy; every client privilege revoked (check:client-privilege-
-- boundary rule 4, and rule 7's SERVER_ONLY_TABLES); service_role holds exactly
-- SELECT (GET /memories/:id/history, owner only, and the §25 replay) and DELETE
-- (the §21 purge). Erased with the Memory: §21 per Memory, and the two FK
-- cascades (memories, auth.users) per account.
--
-- Rollback: db/rollback/2026-10-14-3811-memory-snapshots-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3811): auth.users is missing — the erasure cascade cannot be created.';
  END IF;
  IF to_regclass('public.memories') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3811): public.memories does not exist.';
  END IF;
  IF to_regclass('public.memory_items') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3811): public.memory_items does not exist — item_count reads it.';
  END IF;
  -- A second apply is accepted; a same-named table 3811 did not write (another key, or no facts whitelist) is not.
  IF to_regclass('public.memory_snapshots') IS NOT NULL
     AND (NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.memory_snapshots') AND conname = 'memory_snapshots_pkey' AND contype = 'p' AND pg_get_constraintdef(oid) = 'PRIMARY KEY (memory_id, version)')
          OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.memory_snapshots') AND conname = 'memory_snapshots_facts_whitelist' AND contype = 'c')) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3811): public.memory_snapshots exists without 3811''s key PRIMARY KEY (memory_id, version) or its facts whitelist — a table nobody wrote down is in the way, and applying over it would leave every Memory write failing.';
  END IF;
END $pre$;

-- ── 1. The table ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.memory_snapshots (
  memory_id       uuid        NOT NULL REFERENCES public.memories (id) ON DELETE CASCADE,
  owner_id        uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  version         integer     NOT NULL,
  facts           jsonb       NOT NULL,
  engine_versions jsonb       NOT NULL,
  cause           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_snapshots_pkey PRIMARY KEY (memory_id, version),
  CONSTRAINT memory_snapshots_version_positive CHECK (version >= 1),
  CONSTRAINT memory_snapshots_facts_whitelist CHECK (
    jsonb_typeof(facts) = 'object'
    AND (facts - ARRAY['state', 'visibility', 'location_precision', 'place_id', 'canonical_location_id',
                       'place_display_name_at_occurrence', 'starts_at', 'ends_at', 'source_mode', 'memory_type',
                       'item_count']) = '{}'::jsonb),
  CONSTRAINT memory_snapshots_engine_versions_shape CHECK (
    jsonb_typeof(engine_versions) = 'object' AND jsonb_typeof(engine_versions -> 'snapshot') = 'string'),
  CONSTRAINT memory_snapshots_cause_shape CHECK (
    jsonb_typeof(cause) = 'object' AND (cause - ARRAY['command_id', 'correction_id']) = '{}'::jsonb)
);

CREATE INDEX IF NOT EXISTS memory_snapshots_owner_idx ON public.memory_snapshots (owner_id);

COMMENT ON TABLE public.memory_snapshots IS
  'Spec §3 memory_snapshots / §25 replay (migration 3811, census H35): one row per version of one Memory''s FACTS — state, visibility, precision rung, place references and occurrence name, time window, source mode, type, item count; never title, caption, coordinates or people (CHECK memory_snapshots_facts_whitelist). Written only by memory_snapshot_record() (AFTER INSERT OR UPDATE ON memories), a new version only when the facts change, none for a deleted Memory, newest 50 kept. Append-only: memory_snapshots_guard() refuses UPDATE, and DELETE except the §21 purge of a deleted Memory, the memories / auth.users cascades and the cap''s prune. Read by GET /memories/:id/history (owner only) and the §25 replay. service_role holds SELECT and DELETE only.';

-- ── 2. The writer: one version per change of facts ───────────────────────────
CREATE OR REPLACE FUNCTION public.memory_snapshot_record()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE
  v_row     jsonb := to_jsonb(NEW);
  v_facts   jsonb;
  v_last    jsonb;
  v_newest  integer;
  v_version integer;
  v_cause   jsonb := '{}'::jsonb;
  v_setting text;
BEGIN
  -- A deleted Memory accrues no history; §21 purges what it had.
  IF NEW.state = 'deleted' THEN
    RETURN NULL;
  END IF;

  -- The facts. Baseline columns by name; later columns only where they exist.
  v_facts := jsonb_build_object(
    'state', NEW.state,
    'visibility', NEW.visibility,
    'place_id', NEW.place_id,
    'canonical_location_id', NEW.canonical_location_id,
    'starts_at', to_char(NEW.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'ends_at', to_char(NEW.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'item_count', (SELECT count(*) FROM public.memory_items i WHERE i.memory_id = NEW.id));
  IF v_row ? 'location_precision' THEN v_facts := v_facts || jsonb_build_object('location_precision', v_row -> 'location_precision'); END IF;
  IF v_row ? 'place_display_name_at_occurrence' THEN v_facts := v_facts || jsonb_build_object('place_display_name_at_occurrence', v_row -> 'place_display_name_at_occurrence'); END IF;
  IF v_row ? 'source_mode' THEN v_facts := v_facts || jsonb_build_object('source_mode', v_row -> 'source_mode'); END IF;
  IF v_row ? 'memory_type' THEN v_facts := v_facts || jsonb_build_object('memory_type', v_row -> 'memory_type'); END IF;

  -- Nothing changed, nothing written.
  SELECT s.version, s.facts INTO v_newest, v_last
    FROM public.memory_snapshots s
   WHERE s.memory_id = NEW.id
   ORDER BY s.version DESC
   LIMIT 1;
  IF v_last IS NOT NULL AND v_last = v_facts THEN
    RETURN NULL;
  END IF;
  v_version := coalesce(v_newest, 0) + 1;

  -- Why, when a writer said so. A value that is not a uuid is ignored.
  v_setting := lower(btrim(coalesce(current_setting('portava.memory_command_id', true), '')));
  IF v_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_cause := v_cause || jsonb_build_object('command_id', v_setting);
  END IF;
  v_setting := lower(btrim(coalesce(current_setting('portava.memory_correction_id', true), '')));
  IF v_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_cause := v_cause || jsonb_build_object('correction_id', v_setting);
  END IF;

  INSERT INTO public.memory_snapshots (memory_id, owner_id, version, facts, engine_versions, cause)
  VALUES (NEW.id, NEW.owner_id, v_version, v_facts, jsonb_build_object('snapshot', 'memory-snapshot@1'), v_cause);

  -- The cap: keep the newest 50, prune the oldest (section 3).
  DELETE FROM public.memory_snapshots s
   WHERE s.memory_id = NEW.id AND s.version <= v_version - 50;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.memory_snapshot_record() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS memory_snapshot_record ON public.memories;
CREATE TRIGGER memory_snapshot_record
  AFTER INSERT OR UPDATE ON public.memories
  FOR EACH ROW EXECUTE FUNCTION public.memory_snapshot_record();

-- ── 3. The guard: append-only, erased only with the Memory or by the cap ─────
CREATE OR REPLACE FUNCTION public.memory_snapshots_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'memory_snapshots is append-only: a recorded version is never rewritten (3811)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- DELETE. Permitted on the four retention paths only (header, section 4).
  IF NOT EXISTS (SELECT 1 FROM public.memories m WHERE m.id = OLD.memory_id AND m.state IS DISTINCT FROM 'deleted')
     OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.owner_id)
     OR OLD.version <= (SELECT max(s.version) FROM public.memory_snapshots s WHERE s.memory_id = OLD.memory_id) - 50 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'memory_snapshots: a version of a live Memory is deleted only by the cap (50 newest kept), by the §21 erasure of the deleted Memory, or with its account (3811)'
    USING ERRCODE = 'insufficient_privilege';
END
$fn$;
REVOKE ALL ON FUNCTION public.memory_snapshots_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS memory_snapshots_guard ON public.memory_snapshots;
CREATE TRIGGER memory_snapshots_guard
  BEFORE UPDATE OR DELETE ON public.memory_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.memory_snapshots_guard();

-- ── 4. Access: RLS on, no policy, no client privilege ────────────────────────
ALTER TABLE public.memory_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_snapshots FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, DELETE ON public.memory_snapshots TO service_role;

COMMIT;

-- ── Postconditions (separate transaction; catalog reads only, no session state) ─
DO $post$
DECLARE
  r text;
  p text;
BEGIN
  IF to_regclass('public.memory_snapshots') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3811): public.memory_snapshots was not created';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.memory_snapshots'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3811): row level security is off on public.memory_snapshots';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.memory_snapshots'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3811): public.memory_snapshots carries a policy — it must have none (service role only)';
  END IF;

  -- No client role or PUBLIC holds anything, at table or column level.
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.memory_snapshots', p) THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3811): % holds % on public.memory_snapshots — service role only', r, p;
      END IF;
    END LOOP;
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
      IF has_any_column_privilege(r, 'public.memory_snapshots', p) THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3811): % holds column % on public.memory_snapshots', r, p;
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) x
              WHERE c.oid = 'public.memory_snapshots'::regclass AND x.grantee = 0) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3811): PUBLIC holds a privilege on public.memory_snapshots';
  END IF;

  -- The server reads and purges; it can neither forge nor rewrite a version.
  IF NOT has_table_privilege('service_role', 'public.memory_snapshots', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.memory_snapshots', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3811): service_role cannot read or purge public.memory_snapshots';
  END IF;
  FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'TRUNCATE'] LOOP
    IF has_table_privilege('service_role', 'public.memory_snapshots', p) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3811): service_role holds % on public.memory_snapshots — only the trigger writes a version', p;
    END IF;
  END LOOP;

  -- The key, the whitelist, the two erasure cascades.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_snapshots'::regclass
                   AND conname = 'memory_snapshots_pkey' AND contype = 'p'
                   AND pg_get_constraintdef(oid) = 'PRIMARY KEY (memory_id, version)') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3811): PRIMARY KEY (memory_id, version) is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_snapshots'::regclass
                   AND conname = 'memory_snapshots_facts_whitelist' AND contype = 'c'
                   AND pg_get_constraintdef(oid) LIKE '%item_count%'
                   AND pg_get_constraintdef(oid) NOT LIKE '%caption%'
                   AND pg_get_constraintdef(oid) NOT LIKE '%title%'
                   AND pg_get_constraintdef(oid) NOT LIKE '%location_lat%'
                   AND pg_get_constraintdef(oid) NOT LIKE '%location_lng%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3811): the facts whitelist CHECK is missing or names a free-text or coordinate column';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_snapshots'::regclass
                   AND contype = 'f' AND confrelid = 'public.memories'::regclass AND confdeltype = 'c')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_snapshots'::regclass
                   AND contype = 'f' AND confrelid = 'auth.users'::regclass AND confdeltype = 'c') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3811): an erasure cascade (memories -> snapshots, auth.users -> snapshots) is missing';
  END IF;

  -- The two triggers, enabled, unconditional, on the definer functions.
  -- tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.memories'::regclass AND t.tgname = 'memory_snapshot_record'
                    AND NOT t.tgisinternal AND t.tgenabled <> 'D' AND t.tgqual IS NULL AND t.tgattr = ''::int2vector
                    AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 0 AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16 AND (t.tgtype & 8) = 0
                    AND t.tgfoid = 'public.memory_snapshot_record()'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3811): memory_snapshot_record is not an enabled, unconditional AFTER INSERT OR UPDATE FOR EACH ROW trigger on public.memories';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.memory_snapshots'::regclass AND t.tgname = 'memory_snapshots_guard'
                    AND NOT t.tgisinternal AND t.tgenabled <> 'D' AND t.tgqual IS NULL
                    AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 8) = 8 AND (t.tgtype & 16) = 16
                    AND t.tgfoid = 'public.memory_snapshots_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3811): memory_snapshots_guard is not an enabled BEFORE UPDATE OR DELETE FOR EACH ROW trigger on public.memory_snapshots';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE oid IN ('public.memory_snapshot_record()'::regprocedure, 'public.memory_snapshots_guard()'::regprocedure)
                AND NOT (prosecdef AND prorettype = 'trigger'::regtype
                         AND coalesce(proconfig, '{}') @> ARRAY['search_path=pg_catalog, pg_temp'])) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3811): a 3811 function is not a SECURITY DEFINER trigger function with a pinned search_path';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(r, 'public.memory_snapshot_record()', 'EXECUTE')
       OR has_function_privilege(r, 'public.memory_snapshots_guard()', 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3811): % may execute a 3811 function', r;
    END IF;
  END LOOP;
  RAISE NOTICE '3811 postcondition: memory_snapshots is service-role only (SELECT, DELETE), facts-whitelisted, append-only, and written by memory_snapshot_record on every Memory write.';
END $post$;
