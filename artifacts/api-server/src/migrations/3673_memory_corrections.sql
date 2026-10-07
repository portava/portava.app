-- 3673_memory_corrections.sql
-- Highlights/Memories spec §3 `memory_corrections` ("Authoritative user
-- corrections and negative constraints") and §4's truth precedence. Census H28
-- (the table), H48 / H242 (a weaker inference never overwrites a correction),
-- H49 (a negative constraint is durable) and H73 (a correction beats automatic
-- entity resolution).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane H 3670-3689).
-- APPLIED TO NO DATABASE by the lane that wrote it. The plan was approved by the
-- lead on 2026-10-07. It is additive and idempotent: one table, one index, one
-- trigger on an existing function, and grants. No flag, no new function, no row.
--
-- ── WHAT A ROW MEANS ────────────────────────────────────────────────────────
-- One statement by a Memory's OWNER about that Memory's place.
--   kind = 'assert'  "this Memory's place reference is (place_id,
--                    canonical_location_id)". Either may be NULL, and both NULL
--                    is the statement "this Memory names no place". The latest
--                    assert is the owner's current word.
--   kind = 'reject'  "this Memory was NOT at this place": exactly one of
--                    place_id / canonical_location_id. It is a NEGATIVE
--                    CONSTRAINT: no resolution may land on it again until the
--                    owner asserts that same value later.
-- `field` is the fact corrected. Only 'place' is built; the CHECK names it so a
-- second field is a deliberate migration, never a free-text value.
--
-- ── APPEND-ONLY ─────────────────────────────────────────────────────────────
-- A correction is never edited: a change of mind is a new row. UPDATE is refused
-- by public.intel_append_only() (2130, "Corrections are new rows."). service_role
-- holds SELECT and INSERT only, so the server cannot DELETE a row either. Rows go
-- only by the two FK cascades below, which Postgres runs as the table owner.
--
-- ── WHO READS IT, AND HOW IT FAILS ─────────────────────────────────────────
-- services/memory/memoryCorrections.ts. An absent table (this file not applied)
-- means no correction can exist, so place resolution behaves as it did before.
-- An unreadable table makes the place UNREADABLE (503), never "uncorrected",
-- because a missed negative constraint would put the owner back at the place
-- they said was wrong.
--
-- ── ERASURE ─────────────────────────────────────────────────────────────────
-- memory_id cascades from public.memories (account deletion hard-deletes every
-- Memory) and owner_id from auth.users (the account deletion's final step).
--
-- Rollback: db/rollback/2026-10-07-3673-memory-corrections-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.memories') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3673): public.memories does not exist.';
  END IF;
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3673): auth.users is missing, so the erasure cascade cannot be created.';
  END IF;
  IF to_regprocedure('public.intel_append_only()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3673): public.intel_append_only() (2130) is missing, so the table cannot be made append-only.';
  END IF;
END $pre$;

CREATE TABLE IF NOT EXISTS public.memory_corrections (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id              uuid        NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE,
  owner_id               uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  field                  text        NOT NULL CHECK (field IN ('place')),
  kind                   text        NOT NULL CHECK (kind IN ('assert','reject')),
  place_id               text        NULL CHECK (place_id IS NULL OR length(place_id) BETWEEN 1 AND 200),
  canonical_location_id  uuid        NULL,
  source                 text        NOT NULL CHECK (source IN ('memory_edit','correction_route')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  -- A rejection names exactly one value. An assertion may name none ("no place").
  CONSTRAINT memory_corrections_reject_names_one CHECK (
    kind <> 'reject' OR ((place_id IS NULL) <> (canonical_location_id IS NULL))
  )
);

CREATE INDEX IF NOT EXISTS memory_corrections_memory_idx
  ON public.memory_corrections (memory_id, created_at);
CREATE INDEX IF NOT EXISTS memory_corrections_owner_idx
  ON public.memory_corrections (owner_id);

DROP TRIGGER IF EXISTS memory_corrections_no_update ON public.memory_corrections;
CREATE TRIGGER memory_corrections_no_update
  BEFORE UPDATE ON public.memory_corrections
  FOR EACH ROW EXECUTE FUNCTION public.intel_append_only();

ALTER TABLE public.memory_corrections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_corrections FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.memory_corrections TO service_role;

COMMENT ON TABLE public.memory_corrections IS
  'Spec §3 memory_corrections: the owner''s authoritative statements about a Memory''s place. assert = the place reference the owner states (latest wins); reject = a durable negative constraint (no resolution lands on it again). Append-only (intel_append_only refuses UPDATE; no DELETE grant). Read by services/memory/memoryCorrections.ts, which makes the place unreadable on a failed read. Erased by cascade from memories and auth.users. service_role only.';

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.memory_corrections') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3673): memory_corrections not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.memory_corrections'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3673): RLS is not enabled on memory_corrections';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.memory_corrections'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3673): memory_corrections must carry no policy';
  END IF;
  IF has_table_privilege('anon', 'public.memory_corrections', 'SELECT')
     OR has_table_privilege('anon', 'public.memory_corrections', 'INSERT')
     OR has_table_privilege('authenticated', 'public.memory_corrections', 'SELECT')
     OR has_table_privilege('authenticated', 'public.memory_corrections', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3673): a client role can reach memory_corrections';
  END IF;
  IF has_table_privilege('service_role', 'public.memory_corrections', 'UPDATE')
     OR has_table_privilege('service_role', 'public.memory_corrections', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3673): memory_corrections is append-only; the server may not edit or delete a correction';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.memory_corrections', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.memory_corrections', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3673): the writer (service_role) cannot record or read a correction';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.memory_corrections'::regclass
                   AND tgname = 'memory_corrections_no_update' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3673): the append-only trigger is missing';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
        WHERE conrelid = 'public.memory_corrections'::regclass AND contype = 'f' AND confdeltype = 'c') <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3673): both erasure cascades (memories, auth.users) must exist';
  END IF;
END $$;

COMMIT;
