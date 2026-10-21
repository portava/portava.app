-- 3828_layover_sessions_active_snapshot.sql
--
-- Layover spec §4 `layover_sessions.active_snapshot_id` and `.confidence_band`
-- (census-layover L21, the two members 3827 leaves out). Layover 165 program,
-- lane B1-F.
--
-- WHAT THEY ARE, AND WHO WRITES THEM
-- ==================================
-- The session's ACTIVE snapshot is the newest certified computation persisted
-- for it — a row of layover_certified_computations (2700), identified by the
-- `snapshot_id` every consumer cites (2992's unique column: the id
-- /decisions/:snapshotId/explain takes and layover_recommendations.snapshot_id
-- references, 3623) and versioned per session by 3623's `snapshot_version` —
-- and its confidence band is that computation's `confidence` (INSUFFICIENT |
-- LOW | MEDIUM | HIGH, §4.1 ConfidenceBand, the vocabulary 2700's CHECK
-- already holds). Both columns are written by ONE writer, an AFTER INSERT
-- trigger on layover_certified_computations, in the transaction that persists
-- the snapshot, so the pointer cannot name a computation that was not stored
-- and cannot lag the store.
--
-- THE POINTER ONLY MOVES FORWARD (spec App C6, "never update the active
-- snapshot with a stale engine result"): a computation replaces the active one
-- only when its snapshot_version is HIGHER. Two requests persisting out of
-- order leave the pointer on the newer version. (3623's BEFORE trigger assigns
-- the version, so it is known here.) This is NOT §24's compare-and-swap on the
-- WRITE (census L264, a separate migration in another lane): a stale result is
-- still stored as history; it just never becomes active. A computation stored
-- without a snapshot_id is not a snapshot anything can cite, and moves nothing.
--
-- A client role may not set or change either column (42501), for 3827's reason:
-- layover_sessions' owner policy is column-blind until 3620 is applied.
--
-- NO FLAG. The writer runs only when a computation is persisted, and nothing
-- persists one until `layover_decision_persistence_enabled` (2992, seeded FALSE)
-- is ON. The API reads these columns only under
-- `layover_flight_connections_enabled` (3827).
--
-- ORDER: depends on 0127, 2700 (the store), 2992 (snapshot_id, unique) and 3623
-- (snapshot_version), all numbered below. Nothing numbered above 3828 alters
-- layover_sessions or layover_certified_computations (grep evidence in the lane
-- handback). This file does NOT depend on 3827: the two can be pressed
-- independently.
--
-- Rollback: db/rollback/2026-10-18-3828-layover-sessions-active-snapshot-rollback.sql
-- (refuses while any session points at a snapshot or carries a band).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.layover_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3828): public.layover_sessions does not exist (0127)';
  END IF;
  IF to_regclass('public.layover_certified_computations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3828): public.layover_certified_computations does not exist (2700)';
  END IF;
  IF to_regclass('public.layover_certcomp_snapshot_uidx') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3828): layover_certified_computations.snapshot_id is not a unique identity (2992)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'layover_certified_computations'
                    AND column_name = 'snapshot_version') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3828): layover_certified_computations.snapshot_version does not exist (3623)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'layover_sessions'
                AND column_name IN ('active_snapshot_id', 'confidence_band')) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3828): active_snapshot_id or confidence_band already exists on layover_sessions';
  END IF;
END
$pre$;

ALTER TABLE public.layover_sessions
  ADD COLUMN active_snapshot_id text NULL
    CONSTRAINT layover_sessions_active_snapshot_id_fkey REFERENCES public.layover_certified_computations(snapshot_id) ON DELETE SET NULL,
  ADD COLUMN confidence_band    text NULL,
  ADD CONSTRAINT layover_sessions_confidence_band_known
    CHECK (confidence_band IS NULL OR confidence_band IN ('HIGH','MEDIUM','LOW','INSUFFICIENT'));

COMMENT ON COLUMN public.layover_sessions.active_snapshot_id IS
  '3828 (Layover §4, census-layover L21): the snapshot_id of the newest persisted certified computation for this session (highest snapshot_version). Written only by layover_certcomp_track_active; never moves backwards. NULL = none persisted.';
COMMENT ON COLUMN public.layover_sessions.confidence_band IS
  '3828: the active computation''s confidence (HIGH | MEDIUM | LOW | INSUFFICIENT). Written with active_snapshot_id.';

CREATE INDEX layover_sessions_active_snapshot_idx
  ON public.layover_sessions (active_snapshot_id) WHERE active_snapshot_id IS NOT NULL;

-- The one writer.
CREATE OR REPLACE FUNCTION public.layover_certcomp_track_active()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.snapshot_id IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE public.layover_sessions s
     SET active_snapshot_id = NEW.snapshot_id,
         confidence_band    = NEW.confidence
   WHERE s.id = NEW.session_id
     AND (s.active_snapshot_id IS NULL
          OR (NEW.snapshot_version IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM public.layover_certified_computations c
                               WHERE c.snapshot_id = s.active_snapshot_id
                                 AND c.snapshot_version >= NEW.snapshot_version)));
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.layover_certcomp_track_active() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS layover_certcomp_track_active ON public.layover_certified_computations;
CREATE TRIGGER layover_certcomp_track_active
  AFTER INSERT ON public.layover_certified_computations
  FOR EACH ROW
  EXECUTE FUNCTION public.layover_certcomp_track_active();

-- §19.1: the client roles may not point a session at a snapshot or label it.
CREATE OR REPLACE FUNCTION public.layover_sessions_active_snapshot_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND ((TG_OP = 'INSERT' AND (NEW.active_snapshot_id IS NOT NULL OR NEW.confidence_band IS NOT NULL))
          OR (TG_OP = 'UPDATE' AND (NEW.active_snapshot_id IS DISTINCT FROM OLD.active_snapshot_id
                                    OR NEW.confidence_band IS DISTINCT FROM OLD.confidence_band))) THEN
    RAISE EXCEPTION 'layover_sessions: the active snapshot and its confidence band are written by the server only (3828)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.layover_sessions_active_snapshot_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS layover_sessions_active_snapshot_guard ON public.layover_sessions;
CREATE TRIGGER layover_sessions_active_snapshot_guard
  BEFORE INSERT OR UPDATE ON public.layover_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.layover_sessions_active_snapshot_guard();

DO $post$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'layover_sessions'
         AND column_name IN ('active_snapshot_id', 'confidence_band') AND is_nullable = 'YES') <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3828): active_snapshot_id / confidence_band missing or not nullable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.layover_sessions'::regclass
                  AND conname = 'layover_sessions_active_snapshot_id_fkey' AND contype = 'f'
                  AND confrelid = 'public.layover_certified_computations'::regclass AND confdeltype = 'n') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3828): active_snapshot_id must reference layover_certified_computations ON DELETE SET NULL';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.layover_sessions'::regclass
                  AND conname = 'layover_sessions_confidence_band_known' AND contype = 'c' AND convalidated) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3828): the confidence_band CHECK is missing';
  END IF;
  IF to_regclass('public.layover_sessions_active_snapshot_idx') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3828): layover_sessions_active_snapshot_idx missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.layover_certified_computations'::regclass
                  AND tgname = 'layover_certcomp_track_active' AND NOT tgisinternal AND tgenabled <> 'D')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.layover_sessions'::regclass
                  AND tgname = 'layover_sessions_active_snapshot_guard' AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3828): a trigger is missing or disabled';
  END IF;
  IF has_function_privilege('authenticated', 'public.layover_certcomp_track_active()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.layover_sessions_active_snapshot_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3828): a client role may execute a 3828 function';
  END IF;
END
$post$;

COMMIT;
