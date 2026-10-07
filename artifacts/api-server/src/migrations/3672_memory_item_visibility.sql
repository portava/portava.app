-- 3672_memory_item_visibility.sql
-- Highlights/Memories spec §10: "Media visibility is independent from Memory
-- visibility." Census H80 (NOT-BUILT: "`memory_items` has no visibility of its
-- own; it inherits the memory's").
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane H 3670-3689).
-- APPLIED TO NO DATABASE by the lane that wrote it. Assigned by the lead
-- (2026-10-07) as a privacy fix ahead of corrections.
--
-- ── WHAT IT ADDS ────────────────────────────────────────────────────────────
-- `memory_items.visibility`, NULLABLE, with exactly one non-null value:
--     NULL      the photo inherits its Memory's audience (every existing row —
--               no backfill, no behaviour change on apply)
--     'only_me' the photo is the owner's alone, whoever else may see the Memory
-- Narrowing only. A photo can never be MORE visible than its Memory, so there
-- is no wider value to store.
--
-- ── THE CLIENT PATH, CLOSED IN THE SAME FILE ────────────────────────────────
-- `memory_items_public_read` (0067, as dumped in the 2026-08-19 baseline) lets
-- anon and authenticated SELECT every item of a published public Memory
-- straight through PostgREST. Adding the column without changing that policy
-- would hide an `only_me` photo from the API server and serve it to anyone who
-- asked the database directly. The policy is re-created with
-- `memory_items.visibility IS NULL` in front of its unchanged EXISTS. The owner
-- policy (`memory_items_via_memory`) is untouched: the owner sees every photo.
--
-- ── SERVER READERS ──────────────────────────────────────────────────────────
-- services/memory/memoryItemVisibility.ts. Before this file is applied, the
-- column does not exist: the reader gets 42703 on it, and no photo can be
-- `only_me`, so "nothing is hidden" is TRUE. Any other read failure refuses the
-- read (fail closed).
--
-- Rollback: db/rollback/2026-10-07-3672-memory-item-visibility-rollback.sql

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_items') IS NULL OR to_regclass('public.memories') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3672): public.memory_items / public.memories missing.';
  END IF;
  -- Remember whether THIS run adds the column, so the "no row changed audience"
  -- postcondition asserts a FIRST apply only and the file stays replayable after
  -- an owner has kept a photo private (transaction-local setting).
  PERFORM set_config('portava.m3672_first_apply',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public' AND table_name = 'memory_items' AND column_name = 'visibility')
         THEN 'false' ELSE 'true' END, true);
END $$;

ALTER TABLE public.memory_items ADD COLUMN IF NOT EXISTS visibility text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_items_visibility_check' AND conrelid = 'public.memory_items'::regclass) THEN
    ALTER TABLE public.memory_items
      ADD CONSTRAINT memory_items_visibility_check CHECK (visibility IS NULL OR visibility = 'only_me');
  END IF;
END $$;

COMMENT ON COLUMN public.memory_items.visibility IS
  'Spec §10: a photo''s own audience. NULL = inherits its Memory''s; ''only_me'' = the owner''s alone. Narrowing only. Enforced by memory_items_public_read (3672) and services/memory/memoryItemVisibility.ts.';

DROP POLICY IF EXISTS memory_items_public_read ON public.memory_items;
CREATE POLICY memory_items_public_read ON public.memory_items FOR SELECT USING (
  memory_items.visibility IS NULL
  AND EXISTS (
    SELECT 1 FROM public.memories m
    WHERE m.id = memory_items.memory_id
      AND m.state = 'published'
      AND m.visibility = 'public'
  )
);

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
DECLARE qual text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'memory_items' AND column_name = 'visibility') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3672): memory_items.visibility not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_items_visibility_check' AND conrelid = 'public.memory_items'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3672): memory_items_visibility_check missing';
  END IF;
  SELECT pg_get_expr(polqual, polrelid) INTO qual FROM pg_policy
   WHERE polrelid = 'public.memory_items'::regclass AND polname = 'memory_items_public_read';
  IF qual IS NULL OR position('visibility IS NULL' in qual) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3672): memory_items_public_read does not exclude an only_me photo (qual: %)', qual;
  END IF;
  IF current_setting('portava.m3672_first_apply', true) = 'true'
     AND EXISTS (SELECT 1 FROM public.memory_items WHERE visibility IS NOT NULL) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3672): a photo changed audience on first apply — this migration must change no row';
  END IF;
END $$;

COMMIT;
