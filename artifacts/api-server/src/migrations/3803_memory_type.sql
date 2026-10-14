-- 3803_memory_type.sql
-- Highlights/Memories spec §4 `MemoryType` (docs/specs/Portava_Highlights_
-- Memories_Development_Architecture_Spec_v1.txt:185-186): PLACE, PERSON, MOMENT,
-- EPISODE, TRIP, EVENT, MILESTONE, CREW, DISCOVERY, ROUTE, EXPERIENCE, FIRST,
-- REUNION. Census H40 (census-highlights-memories.md:368, NOT-BUILT:
-- "`memory_projections.memory_type` is a different taxonomy for a different
-- object").
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; B58 memories band
-- 3802-3819, cluster MEM-CANON). APPLIED TO NO DATABASE by the lane that wrote
-- it. ADDITIVE: one nullable column, one CHECK, one flag seeded FALSE. NO
-- EXISTING ROW IS WRITTEN.
--
-- ── 1. THE COLUMN, WITHOUT TOUCHING A ROW ──────────────────────────────────
-- ADD COLUMN with no DEFAULT leaves every row that exists when this runs NULL:
-- its type is UNKNOWN, and it is never inferred (§22: legacy Memories are
-- imported as lower-provenance, "rather than upgraded into invented rich
-- context"). The DEFAULT is set AFTERWARDS, so it applies to inserts only: a
-- Memory created from now on without a type the owner chose is a MOMENT. That
-- default is the plan's fail-closed choice for open owner question Q-H40
-- (MOMENT vs no type at all); it is stated, not approved.
--
-- The writers that KNOW the type name it (routes/memories.ts: the owner's
-- choice on POST/PATCH, TRIP on POST /trips/:tripId/memory;
-- services/memory/episodeCandidates.ts: EPISODE on a kept candidate) — see
-- services/memory/memoryCanonicalFields.ts. The kernel (2711
-- memory_kernel_execute) names a fixed column list and is NOT changed here: on
-- that path the DEFAULT applies first and the route writes the intended type
-- straight after (reconcileCanonicalFields).
--
-- ── 2. THE FLAG ────────────────────────────────────────────────────────────
-- `memory_type_enabled`, seeded FALSE in this file, so the row exists exactly
-- where the column does. FALSE = the API neither accepts an owner's choice nor
-- serves the field; the server-determined types above are still written, so a
-- Memory's type is right from the moment this file is applied. Turning it on is
-- the owner's call.
--
-- Rollback: db/rollback/2026-10-14-3803-memory-type-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.memories') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3803): public.memories does not exist.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3803): public.feature_flags does not exist.';
  END IF;
END $pre$;

-- ── 1. memories.memory_type ─────────────────────────────────────────────────
ALTER TABLE public.memories ADD COLUMN IF NOT EXISTS memory_type text NULL;
ALTER TABLE public.memories ALTER COLUMN memory_type SET DEFAULT 'MOMENT';
ALTER TABLE public.memories DROP CONSTRAINT IF EXISTS memories_memory_type_check;
ALTER TABLE public.memories ADD CONSTRAINT memories_memory_type_check
  CHECK (memory_type IS NULL OR memory_type IN ('PLACE','PERSON','MOMENT','EPISODE','TRIP','EVENT','MILESTONE',
                                                'CREW','DISCOVERY','ROUTE','EXPERIENCE','FIRST','REUNION'));
COMMENT ON COLUMN public.memories.memory_type IS
  'Spec §4 MemoryType (migration 3803). NULL = unknown: every row that existed when 3803 ran, never inferred. New rows default to MOMENT (open owner question Q-H40); the owner''s choice, TRIP (create-from-trip) and EPISODE (a kept candidate) are written by the server.';

-- ── 2. The flag, FALSE ──────────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('memory_type_enabled', false,
   'Spec §4 MemoryType (migration 3803): the API accepts an owner''s memoryType on POST/PATCH /memories, serves memoryType on Memory reads, carries memory_type in the owner''s Timeline/Place derivatives and answers the §15 memoryType search filter. FALSE = none of these; an owner''s memoryType is refused (feature_disabled). Server-determined types (TRIP, EPISODE, the MOMENT default) are written either way.')
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (recomputed from the catalog; no session state) ─────────
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.memories'::regclass
                   AND attname = 'memory_type' AND NOT attnotnull AND NOT attisdropped) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3803): memories.memory_type is missing or NOT NULL';
  END IF;
  -- No row was given a type by this file: the column carries no missing value
  -- (pg_attribute.atthasmissing), so every row that existed reads NULL.
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.memories'::regclass
               AND attname = 'memory_type' AND atthasmissing) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3803): memory_type was added with a stored default; existing rows would read a type nobody chose';
  END IF;
  IF coalesce(pg_get_expr((SELECT adbin FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
                            WHERE d.adrelid = 'public.memories'::regclass AND a.attname = 'memory_type'), 'public.memories'::regclass), '')
     NOT LIKE '''MOMENT''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3803): a NEW memory must default to MOMENT (Q-H40)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memories'::regclass
                   AND conname = 'memories_memory_type_check'
                   AND pg_get_constraintdef(oid) LIKE '%REUNION%' AND pg_get_constraintdef(oid) LIKE '%PLACE%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3803): the MemoryType vocabulary CHECK is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_type_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3803): memory_type_enabled was not seeded';
  END IF;
END $post$;

COMMIT;
