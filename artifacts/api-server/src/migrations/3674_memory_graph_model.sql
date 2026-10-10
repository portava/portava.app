-- 3674_memory_graph_model.sql
-- Highlights/Memories spec §3.4 MemoryRelation, §3.6 memory_entity_links /
-- memory_relations, §4 MemorySourceMode, §22 "avoid a big-bang migration;
-- existing IDs and URLs should remain stable". Census H20, H26, H27, H39, H194,
-- H195, H196. Decision and plan: docs/architecture/memories-graph-model-decision.md.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane H 3670-3689).
-- APPLIED TO NO DATABASE by the lane that wrote it. ADDITIVE: two columns, one
-- view, two tables, five functions, five triggers, three flags seeded FALSE. No
-- existing column changes meaning and NO EXISTING ROW IS WRITTEN (see 1).
--
-- ── 1. memories.source_mode WITHOUT TOUCHING A ROW ─────────────────────────
-- ADD COLUMN ... NOT NULL DEFAULT 'LEGACY_IMPORTED' stores the constant as the
-- column's missing value (pg_attribute.attmissingval): every row that exists at
-- this moment reads LEGACY_IMPORTED, and no row is rewritten, so no row trigger
-- fires and no updated_at moves. The default is THEN changed to USER_CREATED,
-- which applies to inserts only — every writer of `memories` today is an
-- explicit user action (POST /memories, POST /trips/:id/memory, POST
-- /memories/from-layover/:id, the kernel's CREATE_MEMORY). §22: legacy rows are
-- imported as lower-provenance Memories.
--
-- ── 2. ONE RELATION STORE ──────────────────────────────────────────────────
-- 2994's memory_relations already takes PERSON/PLACE/TRIP/EVENT targets (§3.4's
-- own MemoryRelation does). §3.6's memory_entity_links is a security_invoker
-- VIEW over its entity rows, not a second table that could disagree with it.
-- memory_relations.source_mode says how an EDGE came to exist: LEGACY_IMPORTED
-- = mirrored from the scalar/tag model (3675's backfill and the triggers below),
-- USER_CREATED = an explicit owner command (3676's split lineage), NULL = older.
--
-- ── 3. THE MIRROR (dual-write) AND THE ERASURE ──────────────────────────────
-- Legacy writers are unchanged. AFTER triggers keep the LEGACY_IMPORTED edges
-- equal to memories.trip_id / event_id / coalesce(canonical_location_id,
-- place_id) and the APPROVED memory_tags. Two halves, two failure postures:
--   * REMOVAL is never swallowed. A tag deleted (account deletion clears tags by
--     tagged_user_id) or moved out of 'approved' takes its PERSON edge in the
--     same statement; a Memory soft-deleted loses its legacy edges; a Memory
--     hard-deleted (account deletion sweeps every Memory) takes every relation it
--     sources or targets. If the edge cannot be removed the triggering write
--     fails: fail closed for consent.
--   * INSERTION is wrapped. It can never fail a legacy write: on error it raises
--     a WARNING (ids only) and skips, and the shadow comparison on GET
--     /memories/graph counts the drift.
--
-- ── 4. memory_id_redirects ──────────────────────────────────────────────────
-- A merged-away Memory's id keeps resolving to its survivor (3676). Both ends and
-- the owner CASCADE, so a redirect never outlives either Memory or the account.
--
-- ── 5. memory_graph_shadow_daily ────────────────────────────────────────────
-- Counts only, per UTC day and surface. No user id, no Memory id, no content.
--
-- Rollback: db/rollback/2026-10-10-3674-memory-graph-model-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.memories') IS NULL OR to_regclass('public.memory_tags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3674): public.memories / public.memory_tags do not exist.';
  END IF;
  IF to_regclass('public.memory_relations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3674): public.memory_relations (2994) does not exist; apply 2993 then 2994 first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_relations'::regclass
                   AND conname = 'memory_relations_unique_edge') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3674): memory_relations_unique_edge (2994) is missing; the mirror depends on it for idempotency.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL OR to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3674): public.feature_flags / auth.users missing.';
  END IF;
END $pre$;

-- ── 1. memories.source_mode ─────────────────────────────────────────────────
ALTER TABLE public.memories ADD COLUMN IF NOT EXISTS source_mode text NOT NULL DEFAULT 'LEGACY_IMPORTED';
ALTER TABLE public.memories ALTER COLUMN source_mode SET DEFAULT 'USER_CREATED';
ALTER TABLE public.memories DROP CONSTRAINT IF EXISTS memories_source_mode_check;
ALTER TABLE public.memories ADD CONSTRAINT memories_source_mode_check
  CHECK (source_mode IN ('AUTO_PRIVATE','SUGGESTED','USER_CREATED','SHARED_CONFIRMED','IMPORTED','LEGACY_IMPORTED'));
COMMENT ON COLUMN public.memories.source_mode IS
  'Spec §4 MemorySourceMode (migration 3674). Rows that existed when 3674 ran read LEGACY_IMPORTED (the ADD COLUMN default, stored as the missing value: no row rewritten); rows inserted afterwards default to USER_CREATED.';

-- ── 2. memory_relations.source_mode + the entity view ───────────────────────
ALTER TABLE public.memory_relations ADD COLUMN IF NOT EXISTS source_mode text NULL;
ALTER TABLE public.memory_relations DROP CONSTRAINT IF EXISTS memory_relations_source_mode_check;
ALTER TABLE public.memory_relations ADD CONSTRAINT memory_relations_source_mode_check
  CHECK (source_mode IS NULL OR source_mode IN ('AUTO_PRIVATE','SUGGESTED','USER_CREATED','SHARED_CONFIRMED','IMPORTED','LEGACY_IMPORTED'));
COMMENT ON COLUMN public.memory_relations.source_mode IS
  'How the EDGE came to exist (migration 3674): LEGACY_IMPORTED = mirrored from memories.trip_id/event_id/place_id/canonical_location_id and approved memory_tags; USER_CREATED = an explicit owner command (SPLIT_MEMORY lineage, 3676); NULL = written before 3674.';

CREATE OR REPLACE VIEW public.memory_entity_links WITH (security_invoker = true) AS
  SELECT r.id, r.owner_id, r.source_id AS memory_id, r.target_type AS entity_type, r.target_id AS entity_id,
         r.relation_type, r.confidence, r.source_mode, r.reason_code, r.detector_version, r.created_at
    FROM public.memory_relations r
   WHERE r.source_type = 'MEMORY' AND r.target_type IN ('PERSON','PLACE','TRIP','EVENT');
COMMENT ON VIEW public.memory_entity_links IS
  'Spec §3.6 memory_entity_links (migration 3674): the Memory-to-entity rows of memory_relations. security_invoker; client roles revoked; read by the server only.';
REVOKE ALL ON public.memory_entity_links FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.memory_entity_links TO service_role;

-- ── 3. memory_id_redirects ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.memory_id_redirects (
  old_memory_id uuid        PRIMARY KEY REFERENCES public.memories(id) ON DELETE CASCADE,
  new_memory_id uuid        NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE,
  owner_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason        text        NOT NULL CHECK (reason IN ('merged')),
  command_id    uuid        NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_id_redirects_not_self CHECK (old_memory_id <> new_memory_id)
);
CREATE INDEX IF NOT EXISTS memory_id_redirects_new_idx ON public.memory_id_redirects (new_memory_id);
CREATE INDEX IF NOT EXISTS memory_id_redirects_owner_idx ON public.memory_id_redirects (owner_id);
ALTER TABLE public.memory_id_redirects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_id_redirects FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.memory_id_redirects TO service_role;
COMMENT ON TABLE public.memory_id_redirects IS
  'A merged-away Memory id -> the Memory it was merged into (MERGE_MEMORY, migration 3676). One hop always: a merge repoints earlier redirects into an absorbed Memory. Read by GET /memories/:id, which serves the survivor through the full read ladder or answers 404. Erased by cascade from both Memories and from auth.users. service_role only.';

-- ── 4. memory_graph_shadow_daily ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.memory_graph_shadow_daily (
  day                 date        NOT NULL,
  surface             text        NOT NULL CHECK (surface IN ('memories_graph')),
  compared            bigint      NOT NULL DEFAULT 0 CHECK (compared >= 0),
  mismatched          bigint      NOT NULL DEFAULT 0 CHECK (mismatched >= 0),
  trip_mismatches     bigint      NOT NULL DEFAULT 0 CHECK (trip_mismatches >= 0),
  place_mismatches    bigint      NOT NULL DEFAULT 0 CHECK (place_mismatches >= 0),
  people_mismatches   bigint      NOT NULL DEFAULT 0 CHECK (people_mismatches >= 0),
  graph_read_failures bigint      NOT NULL DEFAULT 0 CHECK (graph_read_failures >= 0),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, surface),
  CONSTRAINT memory_graph_shadow_daily_mismatch_bound CHECK (mismatched <= compared)
);
ALTER TABLE public.memory_graph_shadow_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_graph_shadow_daily FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.memory_graph_shadow_daily TO service_role;
COMMENT ON TABLE public.memory_graph_shadow_daily IS
  'Dual-read shadow comparison counts (spec §22 step 4; migration 3674): per UTC day and surface, how many Memories the legacy and graph paths were compared on, how many differed (and on which field) and how many graph reads failed. Counts only: no user id, no Memory id, no content. Read by the cutover gate (services/memory/memoryGraphShadow.ts). service_role only.';

CREATE OR REPLACE FUNCTION public.memory_graph_shadow_record(
  p_surface text, p_compared integer, p_mismatched integer,
  p_trip integer, p_place integer, p_people integer, p_read_failures integer)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp
AS $fn$
BEGIN
  IF least(p_compared, p_mismatched, p_trip, p_place, p_people, p_read_failures) < 0
     OR p_mismatched > p_compared THEN
    RAISE EXCEPTION 'memory_graph_shadow_record: counts must be non-negative and mismatched <= compared'
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.memory_graph_shadow_daily AS d
    (day, surface, compared, mismatched, trip_mismatches, place_mismatches, people_mismatches, graph_read_failures, updated_at)
  VALUES ((now() AT TIME ZONE 'UTC')::date, p_surface, p_compared, p_mismatched, p_trip, p_place, p_people, p_read_failures, now())
  ON CONFLICT (day, surface) DO UPDATE SET
    compared            = d.compared + EXCLUDED.compared,
    mismatched          = d.mismatched + EXCLUDED.mismatched,
    trip_mismatches     = d.trip_mismatches + EXCLUDED.trip_mismatches,
    place_mismatches    = d.place_mismatches + EXCLUDED.place_mismatches,
    people_mismatches   = d.people_mismatches + EXCLUDED.people_mismatches,
    graph_read_failures = d.graph_read_failures + EXCLUDED.graph_read_failures,
    updated_at          = now();
END
$fn$;
REVOKE ALL ON FUNCTION public.memory_graph_shadow_record(text, integer, integer, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_graph_shadow_record(text, integer, integer, integer, integer, integer, integer) TO service_role;

-- ── 5. The mirror: one Memory's LEGACY_IMPORTED edges, recomputed ───────────
-- Desired set, from the row and its APPROVED tags only (a pending or removed tag
-- is not a consented link, §22 "never fabricate participant links"):
--   TRIP   trip_id                                         LEGACY_TRIP_ID
--   EVENT  event_id                                        LEGACY_EVENT_ID
--   PLACE  coalesce(canonical_location_id, place_id)       LEGACY_PLACE  (GET /memories/graph's identity rule)
--   PERSON tagged_user_id of each approved tag             LEGACY_APPROVED_TAG
-- relation_type RELATED (the weakest of §4's nine), confidence 0.500 (fixed and
-- conservative), detector_version legacy-mirror@1. A deleted/removed/absent
-- Memory has no legacy edges. Returns the number of edges inserted + deleted.
CREATE OR REPLACE FUNCTION public.memory_graph_mirror_memory(p_memory_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE
  m record;
  v_place text;
  -- 'TYPE|id' keys. A type never contains '|', so the id is everything after
  -- the first one (a provider place id may itself contain '|').
  v_desired text[];
  v_del integer := 0;
  v_ins integer := 0;
BEGIN
  SELECT id, owner_id, state, trip_id, event_id, place_id, canonical_location_id
    INTO m FROM public.memories WHERE id = p_memory_id;
  IF NOT FOUND OR m.state IN ('deleted', 'removed') THEN
    DELETE FROM public.memory_relations
     WHERE source_type = 'MEMORY' AND source_id = p_memory_id AND source_mode = 'LEGACY_IMPORTED';
    GET DIAGNOSTICS v_del = ROW_COUNT;
    RETURN v_del;
  END IF;

  v_place := nullif(coalesce(m.canonical_location_id::text, nullif(m.place_id, '')), '');
  v_desired := ARRAY[]::text[];
  IF m.trip_id IS NOT NULL THEN v_desired := v_desired || ('TRIP|' || m.trip_id::text); END IF;
  IF m.event_id IS NOT NULL THEN v_desired := v_desired || ('EVENT|' || m.event_id::text); END IF;
  IF v_place IS NOT NULL THEN v_desired := v_desired || ('PLACE|' || v_place); END IF;
  v_desired := v_desired || coalesce(
    (SELECT array_agg('PERSON|' || t.tagged_user_id::text ORDER BY t.tagged_user_id)
       FROM public.memory_tags t WHERE t.memory_id = m.id AND t.status = 'approved'),
    ARRAY[]::text[]);

  DELETE FROM public.memory_relations r
   WHERE r.source_type = 'MEMORY' AND r.source_id = m.id AND r.source_mode = 'LEGACY_IMPORTED'
     AND (r.relation_type <> 'RELATED' OR NOT ((r.target_type || '|' || r.target_id) = ANY (v_desired)));
  GET DIAGNOSTICS v_del = ROW_COUNT;

  INSERT INTO public.memory_relations
    (owner_id, source_type, source_id, target_type, target_id, relation_type, confidence,
     source_mode, detector_version, reason_code)
  SELECT m.owner_id, 'MEMORY', m.id, k.t, k.i, 'RELATED', 0.500, 'LEGACY_IMPORTED', 'legacy-mirror@1',
         CASE k.t WHEN 'TRIP' THEN 'LEGACY_TRIP_ID' WHEN 'EVENT' THEN 'LEGACY_EVENT_ID'
                  WHEN 'PLACE' THEN 'LEGACY_PLACE' ELSE 'LEGACY_APPROVED_TAG' END
    FROM (SELECT split_part(x, '|', 1) AS t, substr(x, strpos(x, '|') + 1) AS i FROM unnest(v_desired) AS x) k
  ON CONFLICT ON CONSTRAINT memory_relations_unique_edge DO NOTHING;
  GET DIAGNOSTICS v_ins = ROW_COUNT;

  RETURN v_del + v_ins;
END
$fn$;
REVOKE ALL ON FUNCTION public.memory_graph_mirror_memory(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_graph_mirror_memory(uuid) TO service_role;

-- Keyset batches for an operator-paced (re)run; 3675 calls it to completion.
-- Idempotent: a second pass over unchanged data changes nothing. SECURITY
-- INVOKER: its callers are the migration and service_role, and the one write it
-- causes is memory_graph_mirror_memory's (DEFINER, referenced by the triggers).
CREATE OR REPLACE FUNCTION public.memory_graph_backfill_legacy(p_after uuid DEFAULT NULL, p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE
  r record;
  v_n integer := 0;
  v_changed integer := 0;
  v_last uuid := NULL;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'memory_graph_backfill_legacy: p_limit must be 1..5000' USING ERRCODE = 'check_violation';
  END IF;
  FOR r IN SELECT id FROM public.memories
            WHERE (p_after IS NULL OR id > p_after)
            ORDER BY id LIMIT p_limit LOOP
    v_changed := v_changed + public.memory_graph_mirror_memory(r.id);
    v_n := v_n + 1;
    v_last := r.id;
  END LOOP;
  RETURN jsonb_build_object('processed', v_n, 'changed', v_changed, 'last_id', v_last, 'done', v_n < p_limit);
END
$fn$;
REVOKE ALL ON FUNCTION public.memory_graph_backfill_legacy(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_graph_backfill_legacy(uuid, integer) TO service_role;

-- ── 6. Triggers ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.memory_graph_on_memory_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Hard delete (account deletion sweeps every Memory). NOT swallowed.
    DELETE FROM public.memory_relations
     WHERE (source_type = 'MEMORY' AND source_id = OLD.id)
        OR (target_type = 'MEMORY' AND target_id = OLD.id::text);
    RETURN OLD;
  END IF;
  IF NEW.state IN ('deleted', 'removed') THEN
    -- Soft delete / moderation removal. NOT swallowed.
    DELETE FROM public.memory_relations
     WHERE source_type = 'MEMORY' AND source_id = NEW.id AND source_mode = 'LEGACY_IMPORTED';
    RETURN NEW;
  END IF;
  BEGIN
    PERFORM public.memory_graph_mirror_memory(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    -- Never fails the legacy write. Ids and the SQLSTATE only (§24).
    RAISE WARNING 'memory_graph mirror skipped for memory % (SQLSTATE %)', NEW.id, SQLSTATE;
  END;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.memory_graph_on_memory_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS memory_graph_mirror_memories ON public.memories;
CREATE TRIGGER memory_graph_mirror_memories
  AFTER INSERT OR UPDATE OF trip_id, event_id, place_id, canonical_location_id, state ON public.memories
  FOR EACH ROW EXECUTE FUNCTION public.memory_graph_on_memory_write();
DROP TRIGGER IF EXISTS memory_graph_erase_memories ON public.memories;
CREATE TRIGGER memory_graph_erase_memories
  AFTER DELETE ON public.memories
  FOR EACH ROW EXECUTE FUNCTION public.memory_graph_on_memory_write();

CREATE OR REPLACE FUNCTION public.memory_graph_on_tag_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $fn$
BEGIN
  -- Removal half, NOT swallowed: any edge naming this person on this Memory
  -- goes when the tag goes, moves, or leaves 'approved' (consent withdrawn).
  IF TG_OP = 'DELETE'
     OR (TG_OP = 'UPDATE' AND (OLD.memory_id <> NEW.memory_id OR OLD.tagged_user_id <> NEW.tagged_user_id)) THEN
    DELETE FROM public.memory_relations
     WHERE source_type = 'MEMORY' AND source_id = OLD.memory_id
       AND target_type = 'PERSON' AND target_id = OLD.tagged_user_id::text;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.status IS DISTINCT FROM 'approved' THEN
    DELETE FROM public.memory_relations
     WHERE source_type = 'MEMORY' AND source_id = NEW.memory_id
       AND target_type = 'PERSON' AND target_id = NEW.tagged_user_id::text;
    RETURN NEW;
  END IF;
  BEGIN
    PERFORM public.memory_graph_mirror_memory(NEW.memory_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'memory_graph mirror skipped for memory % (SQLSTATE %)', NEW.memory_id, SQLSTATE;
  END;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.memory_graph_on_tag_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS memory_graph_mirror_tags ON public.memory_tags;
CREATE TRIGGER memory_graph_mirror_tags
  AFTER INSERT OR UPDATE OR DELETE ON public.memory_tags
  FOR EACH ROW EXECUTE FUNCTION public.memory_graph_on_tag_write();

-- An episode's relations go with the episode (2320; account deletion's
-- erase_memory_for_user deletes episodes). Created only where 2320 is applied:
-- where it is not, memory_relations refuses every EPISODE-sourced row anyway
-- (2994's owner trigger), so there is nothing to erase.
CREATE OR REPLACE FUNCTION public.memory_graph_on_episode_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $fn$
BEGIN
  DELETE FROM public.memory_relations
   WHERE (source_type = 'EPISODE' AND source_id = OLD.id)
      OR (target_type = 'EPISODE' AND target_id = OLD.id::text);
  RETURN OLD;
END
$fn$;
REVOKE ALL ON FUNCTION public.memory_graph_on_episode_delete() FROM PUBLIC, anon, authenticated;

DO $episodes$
BEGIN
  IF to_regclass('public.memory_episodes') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS memory_graph_erase_episodes ON public.memory_episodes';
    EXECUTE 'CREATE TRIGGER memory_graph_erase_episodes AFTER DELETE ON public.memory_episodes '
         || 'FOR EACH ROW EXECUTE FUNCTION public.memory_graph_on_episode_delete()';
  END IF;
END $episodes$;

-- ── 7. Flags, all FALSE ─────────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('memory_merge_split_enabled', false,
   'MERGE_MEMORY / SPLIT_MEMORY (Highlights/Memories spec §17; migrations 3674/3676): POST /memories/merge and POST /memories/:id/split. FALSE = both routes answer feature_disabled. Redirect resolution of an already merged id is NOT gated by this flag.'),
  ('memory_graph_shadow_read_enabled', false,
   'Dual-read shadow comparison (spec §22 step 4; migration 3674): GET /memories/graph keeps serving the legacy answer and, after responding, compares it with memory_entity_links and records COUNTS in memory_graph_shadow_daily. FALSE = no graph read happens.'),
  ('memory_graph_read_cutover_enabled', false,
   'Cutover (spec §22 step 4 -> 5; migration 3674): GET /memories/graph reads entity links from memory_entity_links, ONLY while the 7-day shadow gate is open (services/memory/memoryGraphShadow.ts evaluateCutoverGate). FALSE, or a closed/unreadable gate = the legacy answer. Owner flips this after shadow data exists.')
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (recomputed from the catalog; no session state) ─────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.memories'::regclass
                   AND attname = 'source_mode' AND attnotnull AND NOT attisdropped) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3674): memories.source_mode missing or nullable';
  END IF;
  IF pg_get_expr((SELECT adbin FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
                   WHERE d.adrelid = 'public.memories'::regclass AND a.attname = 'source_mode'), 'public.memories'::regclass)
     NOT LIKE '''USER_CREATED''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3674): a NEW memory must default to USER_CREATED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memories'::regclass AND conname = 'memories_source_mode_check')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memory_relations'::regclass AND conname = 'memory_relations_source_mode_check') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3674): a source_mode vocabulary CHECK is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.memory_entity_links'::regclass
                   AND relkind = 'v' AND coalesce(reloptions, '{}') @> ARRAY['security_invoker=true']) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3674): memory_entity_links must be a security_invoker view';
  END IF;
  IF has_table_privilege('anon', 'public.memory_entity_links', 'SELECT')
     OR has_table_privilege('authenticated', 'public.memory_entity_links', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3674): a client role can read memory_entity_links';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.memory_id_redirects'::regclass AND relrowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.memory_graph_shadow_daily'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3674): RLS is off on a new table';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid IN ('public.memory_id_redirects'::regclass, 'public.memory_graph_shadow_daily'::regclass)) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3674): a new service-only table carries a policy';
  END IF;
  IF has_table_privilege('anon', 'public.memory_id_redirects', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.memory_id_redirects', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.memory_graph_shadow_daily', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.memory_graph_shadow_daily', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3674): a client role holds a privilege on a new table';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.memory_id_redirects'::regclass
        AND contype = 'f' AND confdeltype = 'c') <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3674): memory_id_redirects must cascade from both Memories and auth.users';
  END IF;
  IF has_function_privilege('anon', 'public.memory_graph_mirror_memory(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.memory_graph_mirror_memory(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.memory_graph_backfill_legacy(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.memory_graph_backfill_legacy(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.memory_graph_shadow_record(text, integer, integer, integer, integer, integer, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.memory_graph_shadow_record(text, integer, integer, integer, integer, integer, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.memory_graph_on_memory_write()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.memory_graph_on_tag_write()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3674): a client role can execute a memory_graph function';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
        ('memory_graph_mirror_memories', 'memory_graph_erase_memories', 'memory_graph_mirror_tags')) <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3674): a mirror/erasure trigger is missing';
  END IF;
  IF to_regclass('public.memory_episodes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'memory_graph_erase_episodes'
                       AND tgrelid = 'public.memory_episodes'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3674): memory_episodes exists but its relation-erasure trigger does not';
  END IF;
  IF (SELECT count(*) FROM public.feature_flags
        WHERE flag IN ('memory_merge_split_enabled', 'memory_graph_shadow_read_enabled', 'memory_graph_read_cutover_enabled')
          AND enabled = false) <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3674): the three memory-graph flags must exist and be FALSE';
  END IF;
END $$;

COMMIT;
