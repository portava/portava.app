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
-- by public.intel_append_only() (2130, "Corrections are new rows."). DELETE is the
-- §21 ERASURE only (lead ruling H-13): granted, and refused by memory_corrections_
-- guard() unless the Memory is deleted or gone or the account is gone (below).
--
-- ── WHO READS IT, AND HOW IT FAILS ─────────────────────────────────────────
-- services/memory/memoryCorrections.ts. An absent table (this file not applied)
-- means no correction can exist, so place resolution behaves as it did before.
-- An unreadable table makes the place UNREADABLE (503), never "uncorrected",
-- because a missed negative constraint would put the owner back at the place
-- they said was wrong.
--
-- ── ERASURE ─────────────────────────────────────────────────────────────────
-- Per Memory: the §21 lifecycle purges a deleted Memory's corrections (H-13).
-- Per account: memory_id and owner_id cascade from memories and auth.users.
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

-- ── LEAD RULING H-13 (2026-10-07): a deleted Memory's corrections are erased ──
-- by the §21 deletion lifecycle (services/memory/memoryDeletionLifecycle.ts,
-- step RAW_EVIDENCE_PURGED, through memoryCorrections.eraseCorrectionsForDeleted-
-- Memory), not kept until account deletion. service_role is granted DELETE for
-- that erasure ONLY, and the database holds it to that: memory_corrections_guard()
-- refuses a DELETE while the correction's Memory is live AND its owner's account
-- exists. So the three paths that may delete are exactly
--   1. the §21 erasure, after the Memory's soft delete (state = 'deleted');
--   2. the cascade from public.memories, when a Memory row is hard-deleted;
--   3. the cascade from auth.users, the account deletion's final step.
-- The same guard refuses an INSERT onto a deleted Memory, so a correction racing
-- the deletion cannot be written after the purge and outlive it.
-- Row-level only (no statement trigger): 2292's lesson, a statement trigger
-- refuses an erasure cascade whether or not there is anything to protect.
GRANT DELETE ON public.memory_corrections TO service_role;

CREATE OR REPLACE FUNCTION public.memory_corrections_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM public.memories m WHERE m.id = NEW.memory_id AND m.state = 'deleted') THEN
      RAISE EXCEPTION 'memory_corrections: Memory % is deleted; a correction is never recorded on a deleted Memory (lead ruling H-13)', NEW.memory_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- DELETE. Refused only while BOTH the Memory is live and its owner exists:
  -- inside either cascade the parent row is already gone, and after the §21
  -- soft delete the Memory's state is 'deleted'.
  IF EXISTS (SELECT 1 FROM public.memories m WHERE m.id = OLD.memory_id AND m.state IS DISTINCT FROM 'deleted')
     AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.owner_id) THEN
    RAISE EXCEPTION 'memory_corrections is append-only: a correction is deleted only by the erasure of its deleted Memory (§21, lead ruling H-13) or of its account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END
$fn$;

-- Supabase's default privileges grant EXECUTE on a new public function to anon
-- and authenticated (2320's note); revoked at creation. A trigger function needs
-- no EXECUTE grant to fire.
REVOKE ALL ON FUNCTION public.memory_corrections_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS memory_corrections_erasure_only ON public.memory_corrections;
CREATE TRIGGER memory_corrections_erasure_only
  BEFORE INSERT OR DELETE ON public.memory_corrections
  FOR EACH ROW EXECUTE FUNCTION public.memory_corrections_guard();

COMMENT ON TABLE public.memory_corrections IS
  'Spec §3 memory_corrections: the owner''s authoritative statements about a Memory''s place. assert = the place reference the owner states (latest wins); reject = a durable negative constraint (no resolution lands on it again). Append-only (intel_append_only refuses UPDATE). DELETE is the erasure only (lead ruling H-13): memory_corrections_guard() refuses it while the Memory is live and its owner exists, so a row goes by the §21 lifecycle after the Memory''s soft delete or by the cascades from memories and auth.users. Read by services/memory/memoryCorrections.ts, which makes the place unreadable on a failed read. service_role only.';

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
  IF has_table_privilege('anon', 'public.memory_corrections', 'DELETE')
     OR has_table_privilege('authenticated', 'public.memory_corrections', 'DELETE')
     OR has_table_privilege('anon', 'public.memory_corrections', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.memory_corrections', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3673): a client role can change memory_corrections';
  END IF;
  IF has_table_privilege('service_role', 'public.memory_corrections', 'UPDATE')
     OR has_table_privilege('service_role', 'public.memory_corrections', 'TRUNCATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3673): memory_corrections is append-only; the server may not edit or truncate a correction';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.memory_corrections', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.memory_corrections', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.memory_corrections', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3673): the writer (service_role) cannot record, read or erase a correction';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                  WHERE t.tgrelid = 'public.memory_corrections'::regclass AND t.tgname = 'memory_corrections_erasure_only'
                    AND NOT t.tgisinternal AND p.proname = 'memory_corrections_guard' AND p.prosecdef
                    AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 8) = 8) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3673): the row-level BEFORE INSERT OR DELETE erasure guard is missing (lead ruling H-13)';
  END IF;
  IF has_function_privilege('anon', 'public.memory_corrections_guard()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.memory_corrections_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3673): a client role can execute memory_corrections_guard()';
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
