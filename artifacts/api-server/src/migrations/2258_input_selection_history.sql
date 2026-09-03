-- 2258_input_selection_history.sql
--
-- RENUMBERED from 2222 (was 2222_input_selection_history.sql), on branch
-- claude/map-completion-20260831, to resolve a prefix collision with
-- 2222_map_telemetry_refusal_event.sql.
--
-- checkMigrationPrefixes says to renumber whichever file is UNAPPLIED, because
-- the filename is the record that a migration ran. Both databases were checked
-- rather than assumed: this file's objects are absent from CI and from prod, and
-- it has no row in schema_migration_ledger. The other 2222 IS applied to CI, has
-- a ledger row, and is named in 2254's backfill list — renaming THAT one would
-- have orphaned its ledger row and manufactured exactly the rename drift the
-- ledger gate warns about.
--
-- So this file moved, and this one is the free move: unapplied everywhere, no
-- ledger row, and no reference to its filename anywhere in src/ or docs/.
-- Nothing about its content changed.
--
--
-- Global Input Intelligence — Phase 8 (Personalization). §35 Selection Memory.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band; Input lane 2220-2249).
--
-- WHY THIS TABLE EXISTS, AND WHY NO EXISTING STORE WAS REUSED
-- ----------------------------------------------------------
-- §35 asks the input engine to learn from a user's REPEATED EXPLICIT SELECTIONS
-- (never inferred private facts): recently selected cities/places/users, the
-- frequently-selected abbreviation → canonical-entity mapping FOR THAT USER
-- ("BKK" → Bangkok improves that user's rank without changing the canonical
-- city), and previously-successful query→selection completions. The audit's §16
-- PersonalSuggestionService line names the gap precisely: strong per-surface
-- pieces exist (user_recent_places is Place-only + Json snapshots; search_history
-- stores the raw QUERY TEXT, not which canonical entity was chosen), but there is
-- NO unified per-user prior-selection signal across arbitrary INPUT CONTEXTS that
-- also carries the query→entity mapping the abbreviation feature needs. Neither
-- existing store holds (context, entity_type, entity_id, query_key, count), so a
-- purpose-built append-with-increment table is the smallest correct addition.
--
-- WHAT IT STORES (explicit selections only — the privacy boundary)
-- ---------------------------------------------------------------
-- ONE row per (user, input context, selected canonical entity, normalized query
-- that led to the selection), with a selection_count that increments on repeat.
-- It records only:
--   • the OWNER (user_id), so a user's memory is theirs alone;
--   • the INPUT CONTEXT the selection happened in (city_picker, global_search…),
--     so patterns stay context-specific (§35);
--   • the CANONICAL entity that was explicitly SELECTED (entity_type + entity_id
--     — a stable canonical id, never a private fact or free-text content);
--   • the NORMALIZED QUERY that produced the selection (query_key, '' for a
--     zero-character pick), which is the "BKK"→Bangkok mapping FOR THAT USER;
--   • a display label snapshot, so zero-character recents can render without a
--     second lookup, and counts/timestamps for recency + frequency ranking.
-- It records NO views, typing, dwell, or any inferred/behavioural signal — the
-- ONLY writer is the explicit POST /input-assistance/select endpoint, and it
-- writes only for contexts whose field policy sets allowPersonalization
-- (username / private-message / hidden-gem contexts never reach it).
--
-- HOW IT STAYS OWNER-SCOPED AND ERASABLE
-- --------------------------------------
-- RLS is enabled and every privilege is revoked from PUBLIC/anon/authenticated;
-- only service_role can touch it, and the API resolves the caller from the
-- session on every read/write (never a query parameter). user_id is a FK to
-- auth.users(id) ON DELETE CASCADE: account deletion deletes the auth user (the
-- deletion flow's final step), so a departed user's selection memory is erased by
-- the cascade with no separate sweep to forget. (profiles is kept as an
-- anonymised tombstone, so a profiles-FK cascade would NOT fire — hence the FK is
-- to auth.users, which IS deleted, exactly the erasure guarantee this needs.)
--
-- HOW PERSONALIZATION AUGMENTS BUT NEVER OVERRIDES (§2/§9/§15)
-- -----------------------------------------------------------
-- This table feeds a per-user PriorSelection SIGNAL only. It never changes any
-- canonical entity's name or data, and the read path (lib/inputAssistance/
-- personalization.ts) applies it as a bounded confidence nudge that reorders
-- candidates WITHIN their assistance-type rank — so a canonical entity always
-- still outranks an AI guess, the abbreviation mapping surfaces a canonical city
-- for that user only, and a user with no history gets today's behaviour exactly.
--
-- input_record_selection(): an atomic upsert-with-increment. SECURITY DEFINER and
-- keyed by a CALLER-SUPPLIED user id, so — like every memory_*/intel_* reader in
-- this band — it is REVOKEd from PUBLIC/anon/authenticated and GRANTed only to
-- service_role (Supabase's ALTER DEFAULT PRIVILEGES would otherwise hand EXECUTE
-- to anon+authenticated on a brand-new function). The postcondition re-checks it.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: auth.users is missing — the owner FK/erasure cascade cannot be created.';
  END IF;
END $$;

-- ── The selection-memory table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.input_selection_history (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- OWNER. FK → auth.users(id) ON DELETE CASCADE: the deletion flow deletes the
  -- auth user, so this row is erased with it. A user's memory is theirs alone.
  user_id           uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  -- The §5 InputContext the selection happened in (city_picker, global_search…).
  -- Kept as text (the registry is code-first, §6) so no enum has to track it.
  context           text NOT NULL,
  -- The canonical entity class + id that was EXPLICITLY selected. entity_id is
  -- text because id-spaces differ (canonical city uuid, place uuid, user uuid).
  entity_type       text NOT NULL,
  entity_id         text NOT NULL,
  -- The NORMALIZED query that produced the selection ('' for a zero-char pick).
  -- NOT NULL so the uniqueness key below has no NULL-distinct hole — this is the
  -- per-user abbreviation → canonical mapping ("bkk" → the Bangkok id).
  query_key         text NOT NULL DEFAULT '',
  -- Display snapshot so zero-character recents render without a second lookup.
  label             text,
  -- Frequency + recency signals. count increments on a repeated selection.
  selection_count   integer NOT NULL DEFAULT 1,
  first_selected_at timestamptz NOT NULL DEFAULT now(),
  last_selected_at  timestamptz NOT NULL DEFAULT now()
);

-- Guardrails: a selection is a real, positive event.
ALTER TABLE public.input_selection_history
  DROP CONSTRAINT IF EXISTS input_selection_history_count_positive_check;
ALTER TABLE public.input_selection_history
  ADD CONSTRAINT input_selection_history_count_positive_check
  CHECK (selection_count >= 1);

-- ONE row per (owner, context, entity, query_key). The upsert dedupes on this,
-- so a repeated selection increments a count rather than accumulating rows.
CREATE UNIQUE INDEX IF NOT EXISTS input_selection_history_unique_idx
  ON public.input_selection_history (user_id, context, entity_type, entity_id, query_key);

-- Read path: the user's recent selections in a context, newest first (zero-char
-- recents + the per-context prior-selection scan).
CREATE INDEX IF NOT EXISTS input_selection_history_owner_recent_idx
  ON public.input_selection_history (user_id, context, last_selected_at DESC);

COMMENT ON TABLE public.input_selection_history IS
  '§35 Selection Memory. One row per (owner, input context, explicitly-selected canonical entity, normalized query), with an incrementing selection_count. Records EXPLICIT selections only — no views/typing/inferred facts — and only for contexts whose field policy allows personalization. Owner-scoped (RLS, service_role only, session-derived) and erased by the auth.users ON DELETE CASCADE. Feeds a per-user PriorSelection ranking nudge + zero-char recents; changes NO canonical entity data.';
COMMENT ON COLUMN public.input_selection_history.query_key IS
  'The normalized query that produced the selection ('''' for a zero-character pick). This is the per-user abbreviation → canonical mapping (e.g. "bkk" → the Bangkok city id) — it improves THAT user''s rank only and never alters the canonical entity name.';

ALTER TABLE public.input_selection_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.input_selection_history FROM PUBLIC;
REVOKE ALL ON public.input_selection_history FROM anon;
REVOKE ALL ON public.input_selection_history FROM authenticated;
REVOKE ALL ON public.input_selection_history FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.input_selection_history TO service_role;

-- ── input_record_selection(): atomic upsert-with-increment ───────────────────
-- The single write path. INSERTs a first selection or increments the count of a
-- repeated one, in one statement, so concurrent explicit selections cannot race
-- to lose a count. Coalesces a NULL query to '' so the uniqueness key holds.
CREATE OR REPLACE FUNCTION public.input_record_selection(
  p_user_id     uuid,
  p_context     text,
  p_entity_type text,
  p_entity_id   text,
  p_query_key   text DEFAULT NULL,
  p_label       text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  IF p_user_id IS NULL OR p_context IS NULL OR p_entity_type IS NULL OR p_entity_id IS NULL THEN
    RAISE EXCEPTION 'input_record_selection: user, context, entity_type and entity_id are all required';
  END IF;

  INSERT INTO public.input_selection_history
    (user_id, context, entity_type, entity_id, query_key, label)
  VALUES
    (p_user_id, p_context, p_entity_type, p_entity_id, COALESCE(p_query_key, ''), p_label)
  ON CONFLICT (user_id, context, entity_type, entity_id, query_key)
  DO UPDATE SET
    selection_count  = public.input_selection_history.selection_count + 1,
    last_selected_at = now(),
    -- Keep the freshest non-null label; never overwrite a known label with NULL.
    label            = COALESCE(EXCLUDED.label, public.input_selection_history.label);
END
$fn$;

REVOKE ALL ON FUNCTION public.input_record_selection(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.input_record_selection(uuid, text, text, text, text, text) TO service_role;

COMMENT ON FUNCTION public.input_record_selection(uuid, text, text, text, text, text) IS
  '§35 write path: atomic upsert-with-increment into input_selection_history. Keyed by a caller-supplied user id, so REVOKEd from anon/authenticated and granted only to service_role. Records one explicit selection; never any inferred signal.';

-- ── Postconditions (observed inside this txn; each raises only on failure) ────
DO $$
BEGIN
  IF to_regclass('public.input_selection_history') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: input_selection_history table was not created.';
  END IF;
  IF to_regprocedure('public.input_record_selection(uuid, text, text, text, text, text)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: input_record_selection was not created.';
  END IF;
  -- Least-privilege: the write function is keyed by a caller-supplied user id, so
  -- an anon/authenticated grant would let any caller write another user's memory.
  -- Supabase's default grants hand EXECUTE to anon+authenticated after CREATE;
  -- fail the migration rather than ship that (the 2190/2214 lesson).
  IF has_function_privilege('anon', 'public.input_record_selection(uuid, text, text, text, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.input_record_selection(uuid, text, text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: input_record_selection is executable by anon/authenticated — re-REVOKE it.';
  END IF;
  -- The table must be service_role-only writable — no anon/authenticated grants.
  IF has_table_privilege('anon', 'public.input_selection_history', 'SELECT')
     OR has_table_privilege('authenticated', 'public.input_selection_history', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: input_selection_history is reachable by anon/authenticated — it must be service_role only.';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DROP FUNCTION IF EXISTS public.input_record_selection(uuid, text, text, text, text, text);
--   DROP TABLE IF EXISTS public.input_selection_history;
--   Reversing forgets every user's learned selection memory; the gateway degrades
--   to its cold-start behaviour (identical to pre-Phase-8), so it is non-breaking.
