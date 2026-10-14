-- 3804_memory_place_occurrence_name.sql
-- Highlights/Memories spec §9 "Entity Resolution and Historical Identity": a
-- Memory keeps "both canonical identity and occurrence-time display context.
-- Historical records cannot silently rewrite themselves when places rename,
-- merge, close, or move", and "Entity merges may repoint canonical identity
-- while preserving occurrence-time display text" (spec:316). Census H71
-- (census-highlights-memories.md:417, restated at :8177: "The missing piece is
-- a `display_name_at_occurrence`").
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; B58 memories band
-- 3802-3819, cluster MEM-CANON). APPLIED TO NO DATABASE by the lane that wrote
-- it. ADDITIVE: one nullable column, one CHECK, one trigger function, one
-- trigger, one flag seeded FALSE. NO EXISTING ROW IS WRITTEN: legacy Memories
-- read NULL and are never backfilled, because today's catalog name may already
-- be the name AFTER a rename (that is the whole point of the column).
--
-- ── WHAT THE TRIGGER KEEPS TRUE, ON EVERY WRITER ───────────────────────────
-- Writers are the API's direct writes, the kernel (2711, which names a fixed
-- column list and never this column), 3676's split (which copies the whole
-- source row) and anything else. The rules, in order:
--   1. No place, no place name. A Memory whose place_id is NULL or blank has no
--      occurrence name.
--   2. The text never rewrites itself. An UPDATE that keeps the same place_id
--      keeps the recorded text, whatever the writer sent. The one exception is
--      a FIRST capture: a row whose text is still NULL may be given one (the
--      route's follow-up after a kernel write — never a backfill: the route
--      only sends a name with a place it has just written).
--   3. A new place gets its own text, never the old place's. On INSERT, or on
--      an UPDATE that changes place_id, the writer's text is used when the
--      writer named one (on UPDATE: named a DIFFERENT text than the row had).
--      Otherwise, when place_id is a catalog id (uuid-shaped) the catalog's
--      name AT THIS MOMENT is recorded; any other reference (a provider pick)
--      without text reads NULL.
--   (3676's split copies the source row's text, which rule 3 keeps as the
--   writer's: a split never re-reads today's catalog name.)
--
-- Reads THROUGH THE API SERVER: services/memory/memoryCanonicalFields.ts. The
-- OWNER sees the stored text. Anyone else sees it ONLY while the row they are
-- served still carries the SAME non-empty stored place reference — lead rulings
-- H-16/H-17: a place the owner rejected (3673), or one the owner's precision
-- rung or a Hidden Gem withholds, takes its name with it.
--
-- ── CEILING: THE POSTGREST DOOR (PR #716 verifier; owner question OQ-716-1) ──
-- Everything above about who READS the name, and about the client never
-- choosing a catalog place's name, holds for the API server ONLY. The
-- 2026-08-19 baseline grants ALL on public.memories to anon and authenticated
-- (baseline/20260819_baseline_structure.sql, `GRANT ALL ON TABLE
-- public.memories`), and 0067's RLS lets any signed-in non-owner SELECT every
-- column of a published public Memory (memories_public_read) and an owner write
-- any column of their own (memories_owner_all). No migration in the chain
-- revokes either. So once this file is applied, straight through PostgREST:
--   * a non-owner can read place_display_name_at_occurrence of a published
--     public Memory with no H-16/H-17 correction, §10 precision rung or
--     Hidden-Gem ceiling applied — exactly as place_id, canonical_location_id
--     and the exact location_lat/lng already leak today. This file WIDENS that
--     existing door by one human-readable column;
--   * an owner can INSERT their own Memory with any text for a catalog place
--     (rule 3 keeps a writer's text on INSERT, for 3676's split copy) and set
--     memory_type directly (3803) — the API's own rules are not in the way.
-- `memory_place_occurrence_name_enabled` does NOT gate any of this: the trigger
-- records names from the moment this file is applied. OQ-716-1: close the door
-- (REVOKE the client roles' privileges on public.memories, as 2150 and 2161 did
-- for passport_memories and compass_memories; a SEPARATE migration, not this
-- band) BEFORE this file is applied, or accept the widening explicitly.
--
-- ── THE FLAG ───────────────────────────────────────────────────────────────
-- `memory_place_occurrence_name_enabled`, seeded FALSE in this file, so the row
-- exists exactly where the column does. FALSE = the API does not serve the
-- field (PostgREST does, see the ceiling above); the API still records a
-- provider pick's text and the trigger still records catalog names, so the
-- history is kept from the moment this file is applied. An UNREADABLE flag
-- means the API names nothing, so a provider pick's text is DROPPED on that
-- write (the trigger still records catalog names). Turning it on is the
-- owner's call.
--
-- Rollback: db/rollback/2026-10-14-3804-memory-place-occurrence-name-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.memories') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3804): public.memories does not exist.';
  END IF;
  IF to_regclass('public.places') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.places'::regclass AND attname = 'name' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3804): public.places(name) (2028) does not exist.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3804): public.feature_flags does not exist.';
  END IF;
END $pre$;

-- ── 1. memories.place_display_name_at_occurrence ────────────────────────────
ALTER TABLE public.memories ADD COLUMN IF NOT EXISTS place_display_name_at_occurrence text NULL;
ALTER TABLE public.memories DROP CONSTRAINT IF EXISTS memories_place_display_name_at_occurrence_check;
ALTER TABLE public.memories ADD CONSTRAINT memories_place_display_name_at_occurrence_check
  CHECK (place_display_name_at_occurrence IS NULL
         OR (char_length(place_display_name_at_occurrence) BETWEEN 1 AND 300
             AND place_display_name_at_occurrence = btrim(place_display_name_at_occurrence)));
COMMENT ON COLUMN public.memories.place_display_name_at_occurrence IS
  'Spec §9 display_name_at_occurrence (migration 3804): the place''s name as it was when the Memory recorded that place. Kept by trigger memory_place_occurrence_name_fill: it never changes while place_id does not, and a new place never inherits the old one''s text. NULL = no place, a legacy row (never backfilled) or a provider pick recorded without text. Served to a non-owner only with its unchanged stored place reference (lead rulings H-16/H-17).';

-- ── 2. The trigger ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.memory_place_occurrence_name_fill()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $fn$
DECLARE
  v_place text := NULLIF(btrim(NEW.place_id), '');
  v_given text := left(NULLIF(btrim(NEW.place_display_name_at_occurrence), ''), 300);
  v_catalog text;
BEGIN
  -- Rule 2: the same place keeps its recorded text.
  IF TG_OP = 'UPDATE' AND NEW.place_id IS NOT DISTINCT FROM OLD.place_id THEN
    IF OLD.place_display_name_at_occurrence IS NOT NULL THEN
      NEW.place_display_name_at_occurrence := OLD.place_display_name_at_occurrence;
    ELSIF v_place IS NULL THEN
      NEW.place_display_name_at_occurrence := NULL;
    ELSE
      NEW.place_display_name_at_occurrence := v_given; -- a first capture only; never a catalog backfill
    END IF;
    RETURN NEW;
  END IF;
  -- Rule 1: no place, no place name.
  IF v_place IS NULL THEN
    NEW.place_display_name_at_occurrence := NULL;
    RETURN NEW;
  END IF;
  -- Rule 3: a changed place never keeps the old place's text.
  IF TG_OP = 'UPDATE' AND NEW.place_display_name_at_occurrence IS NOT DISTINCT FROM OLD.place_display_name_at_occurrence THEN
    v_given := NULL;
  END IF;
  IF v_given IS NULL AND v_place ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT left(NULLIF(btrim(p.name), ''), 300) INTO v_catalog FROM public.places p WHERE p.id = v_place::uuid;
    v_given := v_catalog;
  END IF;
  NEW.place_display_name_at_occurrence := v_given;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.memory_place_occurrence_name_fill() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS memory_place_occurrence_name_fill ON public.memories;
CREATE TRIGGER memory_place_occurrence_name_fill
  BEFORE INSERT OR UPDATE OF place_id, place_display_name_at_occurrence ON public.memories
  FOR EACH ROW EXECUTE FUNCTION public.memory_place_occurrence_name_fill();

-- ── 3. The flag, FALSE ──────────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('memory_place_occurrence_name_enabled', false,
   'Spec §9 display_name_at_occurrence (migration 3804): Memory reads serve placeDisplayNameAtOccurrence — to the owner always, to anyone else only with the unchanged stored place reference (H-16/H-17) — and the owner''s Place derivative carries it. FALSE = not served. The text is recorded either way (the API for a provider pick, the trigger for a catalog place).')
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions (recomputed from the catalog; no session state) ─────────
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.memories'::regclass
                   AND attname = 'place_display_name_at_occurrence' AND NOT attnotnull AND NOT attisdropped
                   AND NOT atthasdef AND NOT atthasmissing) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3804): memories.place_display_name_at_occurrence is missing, NOT NULL, or has a default (a legacy row must read NULL, never a backfill)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.memories'::regclass
                   AND conname = 'memories_place_display_name_at_occurrence_check') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3804): the occurrence-name CHECK is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.memory_place_occurrence_name_fill()'::regprocedure
                   AND prosecdef AND coalesce(proconfig, '{}') @> ARRAY['search_path=pg_catalog, pg_temp']) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3804): memory_place_occurrence_name_fill must be SECURITY DEFINER with a pinned search_path';
  END IF;
  IF has_function_privilege('anon', 'public.memory_place_occurrence_name_fill()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.memory_place_occurrence_name_fill()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3804): a client role can execute memory_place_occurrence_name_fill';
  END IF;
  -- tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 16 UPDATE; tgattr names exactly the two columns.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.memories'::regclass AND t.tgname = 'memory_place_occurrence_name_fill'
                    AND NOT t.tgisinternal AND t.tgenabled <> 'D'
                    AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16
                    AND t.tgqual IS NULL
                    AND t.tgfoid = 'public.memory_place_occurrence_name_fill()'::regprocedure
                    AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                           FROM unnest(t.tgattr::int2[]) k JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k)
                        = ARRAY['place_display_name_at_occurrence', 'place_id']) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3804): the occurrence-name trigger is missing, disabled, conditional, or not BEFORE INSERT OR UPDATE OF place_id, place_display_name_at_occurrence FOR EACH ROW';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_place_occurrence_name_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3804): memory_place_occurrence_name_enabled was not seeded';
  END IF;
END $post$;

COMMIT;
