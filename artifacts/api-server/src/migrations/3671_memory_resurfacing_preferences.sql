-- 3671_memory_resurfacing_preferences.sql
-- Highlights/Memories spec §3 `memory_resurfacing_preferences` and §11's per-Memory
-- user controls. Census H36 (the table), H87 / H88 / H187 (the controls on a
-- MEMORY rather than on a Highlight), and KEEP_PRIVATE_FOREVER on a Memory.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane H 3670-3689).
-- APPLIED TO NO DATABASE by the lane that wrote it. Approved by the lead
-- (2026-10-07). Additive and idempotent: one table, one index, grants. No flag,
-- no function, no trigger, no row.
--
-- ── WHY A SECOND TABLE AND NOT 2720 ─────────────────────────────────────────
-- `highlight_resurfacing_preferences` (2720, applied) keys a control on a
-- HIGHLIGHT, a person or a trip. §3 names a Memory-scoped store, and a control
-- the owner sets on their Memory must hold whatever Highlights are or are not
-- made from it — so it is keyed on `memory_id`, and it reuses 2720's control
-- NAMES verbatim (the four that are Memory-scoped; HIDE_PERSON_FROM_RESURFACING
-- and HIDE_TRIP are keyed on a person or a trip and stay in 2720).
--
-- ── WHAT A ROW MEANS ────────────────────────────────────────────────────────
-- Presence of (memory_id, control) is the control being ON. Clearing it deletes
-- the row. The row holds ids, a control name and a time — no Memory content.
--
-- ── WHO READS IT, AND HOW IT FAILS ─────────────────────────────────────────
-- services/memory/memoryResurfacingControls.ts. Absent table (this file not
-- applied): no row can exist, so "no control is set" is TRUE and every consumer
-- behaves as today. Unreadable table: every consumer FAILS CLOSED — a Memory
-- whose controls cannot be read is treated as kept private by the surfaces that
-- would publish it.
--
-- ── ERASURE ─────────────────────────────────────────────────────────────────
-- memory_id cascades from public.memories (account deletion hard-deletes every
-- Memory) and owner_id from auth.users (the account deletion's final step).
--
-- Rollback: db/rollback/2026-10-07-3671-memory-resurfacing-preferences-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memories') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3671): public.memories does not exist.';
  END IF;
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3671): auth.users is missing — the erasure cascade cannot be created.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.memory_resurfacing_preferences (
  memory_id   uuid NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE,
  owner_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  control     text NOT NULL
                CHECK (control IN ('DO_NOT_RESURFACE','DO_NOT_INCLUDE_IN_RECAPS','KEEP_PRIVATE_FOREVER','RETAIN_BUT_DO_NOT_PERSONALIZE')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, control)
);

CREATE INDEX IF NOT EXISTS memory_resurfacing_preferences_owner_idx
  ON public.memory_resurfacing_preferences (owner_id);

ALTER TABLE public.memory_resurfacing_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_resurfacing_preferences FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON public.memory_resurfacing_preferences TO service_role;

COMMENT ON TABLE public.memory_resurfacing_preferences IS
  'Spec §3/§11 per-Memory user controls (DO_NOT_RESURFACE, DO_NOT_INCLUDE_IN_RECAPS, KEEP_PRIVATE_FOREVER, RETAIN_BUT_DO_NOT_PERSONALIZE). A row is the control ON; clearing deletes it. Read by services/memory/memoryResurfacingControls.ts, which fails closed on an unreadable read. Erased by cascade from memories and auth.users. service_role only.';

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.memory_resurfacing_preferences') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3671): memory_resurfacing_preferences not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.memory_resurfacing_preferences'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3671): RLS is not enabled on memory_resurfacing_preferences';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.memory_resurfacing_preferences'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3671): memory_resurfacing_preferences must carry no policy';
  END IF;
  IF has_table_privilege('anon', 'public.memory_resurfacing_preferences', 'SELECT')
     OR has_table_privilege('authenticated', 'public.memory_resurfacing_preferences', 'SELECT')
     OR has_table_privilege('authenticated', 'public.memory_resurfacing_preferences', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3671): a client role can reach memory_resurfacing_preferences';
  END IF;
  IF has_table_privilege('service_role', 'public.memory_resurfacing_preferences', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3671): a control is set or cleared, never edited in place';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.memory_resurfacing_preferences', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.memory_resurfacing_preferences', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3671): the writer (service_role) cannot set or clear a control';
  END IF;
END $$;

COMMIT;
