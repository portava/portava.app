-- 3381_trail_lifecycle_transitions.sql
-- Discovery Trails (census-discovery DC-04, §51): `02_Trails.md` §7's two
-- lifecycles are enforced as TRANSITION RELATIONS by the database, not only by
-- the one TypeScript write path that checks them.
--
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
-- Rehearsed on the local PostgreSQL 16 harness only (scripts/local-db/up.sh).
--
-- ── WHAT ────────────────────────────────────────────────────────────────────
-- Two BEFORE UPDATE triggers, each refusing (23514 check_violation) a change of
-- state that the relation in lib/discoveryTrailObject.ts does not allow:
--   trails.lifecycle_status        LIFECYCLE_TRANSITIONS
--     proposed     → active | archived
--     active       → needs_update | stale | archived
--     needs_update → active | stale | archived
--     stale        → active | archived
--     archived     → (nothing — terminal)
--   content_trails.content_state   CONTENT_TRANSITIONS
--     just_arrived                  → growing | archived_from_active_rotation
--     growing                       → featured | archived_from_active_rotation
--     featured                      → evergreen | growing | archived_from_active_rotation
--     evergreen                     → archived_from_active_rotation
--     rediscovered                  → growing | featured | archived_from_active_rotation
--     archived_from_active_rotation → rediscovered
-- An UPDATE that leaves the state unchanged is not a transition and is not
-- judged; INSERT is not judged (2910's CHECKs already bound the vocabulary).
-- No row, column, CHECK, index, grant or policy is touched.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- 2910 CHECKs the five and six state NAMES; nothing at the database constrained
-- how a row moves between them. The relation lived only in
-- `moveTrailLifecycle` (services/trails/TrailService.ts), as read → compare →
-- write. Measured on the harness before this file
-- (src/test/db/trailsConstraints.db.test.ts): an UPDATE moved `archived →
-- active`, the one move the relation calls terminal; `proposed → stale` and
-- `just_arrived → rediscovered` were admitted; and two requests racing a
-- proposed Trail — one archiving it, one promoting it on first content — ended
-- `active` over the archive. 2910's own argument for its label-cap trigger ("a
-- cap that lives only in one write path stops being true the moment a second
-- write path exists") is the argument here, and §15's moderation actions and
-- `11` §8's "Trail archive" are exactly the second write paths still to come.
--
-- Under a race the losing UPDATE waits on the row lock and then runs the
-- trigger against the COMMITTED row, so a promotion that read `proposed`
-- before an archive committed is judged as `archived → active` and refused.
--
-- The relation is the TypeScript one, verbatim, and is not re-derived here;
-- trailsConstraints.db.test.ts T5 and C2 compare the database's answer with
-- isTrailLifecycleTransitionAllowed / isTrailContentTransitionAllowed for every
-- ordered pair of distinct states, so the two cannot drift apart silently.
--
-- ── `10` §4 — cardinality, index, EXPLAIN ───────────────────────────────────
-- No query path is added and no index is built: each trigger is a constant-time
-- comparison of OLD and NEW on the row being updated. Production holds 0 rows
-- in both tables. EXPLAIN is not meaningful for a row trigger.
--
-- Rollback: db/rollback/2026-09-27-3381-trail-lifecycle-transitions-rollback.sql
-- (drops both triggers and both functions; free, deletes nothing).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trails') IS NULL OR to_regclass('public.content_trails') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3381): public.trails / public.content_trails do not exist. Apply 2910_discovery_trails.sql first.';
  END IF;
  -- The relation below names exactly 2910's vocabularies; a CHECK with another
  -- vocabulary means another lane changed the states and this file is stale.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.trails'::regclass AND conname = 'trails_lifecycle_known'
                    AND pg_get_constraintdef(oid) LIKE '%proposed%active%needs_update%stale%archived%') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3381): trails_lifecycle_known is absent or names other states; resolve by hand.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.content_trails'::regclass AND conname = 'content_trails_state_known'
                    AND pg_get_constraintdef(oid) LIKE '%just_arrived%growing%featured%evergreen%rediscovered%archived_from_active_rotation%') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3381): content_trails_state_known is absent or names other states; resolve by hand.';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.trails_lifecycle_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  IF NEW.lifecycle_status IS DISTINCT FROM OLD.lifecycle_status AND NOT (
       (OLD.lifecycle_status = 'proposed'     AND NEW.lifecycle_status IN ('active', 'archived'))
    OR (OLD.lifecycle_status = 'active'       AND NEW.lifecycle_status IN ('needs_update', 'stale', 'archived'))
    OR (OLD.lifecycle_status = 'needs_update' AND NEW.lifecycle_status IN ('active', 'stale', 'archived'))
    OR (OLD.lifecycle_status = 'stale'        AND NEW.lifecycle_status IN ('active', 'archived'))
  ) THEN
    RAISE EXCEPTION '02 §7: Trail lifecycle % → % is not an allowed transition', OLD.lifecycle_status, NEW.lifecycle_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.trails_lifecycle_transition() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.trails_lifecycle_transition() IS
  '3381 / 02_Trails.md §7: the Trail lifecycle transition relation, verbatim from LIFECYCLE_TRANSITIONS in lib/discoveryTrailObject.ts. archived is terminal.';

DROP TRIGGER IF EXISTS trails_lifecycle_transition_trg ON public.trails;
CREATE TRIGGER trails_lifecycle_transition_trg
  BEFORE UPDATE OF lifecycle_status ON public.trails
  FOR EACH ROW EXECUTE FUNCTION public.trails_lifecycle_transition();

CREATE OR REPLACE FUNCTION public.content_trails_state_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  IF NEW.content_state IS DISTINCT FROM OLD.content_state AND NOT (
       (OLD.content_state = 'just_arrived'                  AND NEW.content_state IN ('growing', 'archived_from_active_rotation'))
    OR (OLD.content_state = 'growing'                       AND NEW.content_state IN ('featured', 'archived_from_active_rotation'))
    OR (OLD.content_state = 'featured'                      AND NEW.content_state IN ('evergreen', 'growing', 'archived_from_active_rotation'))
    OR (OLD.content_state = 'evergreen'                     AND NEW.content_state IN ('archived_from_active_rotation'))
    OR (OLD.content_state = 'rediscovered'                  AND NEW.content_state IN ('growing', 'featured', 'archived_from_active_rotation'))
    OR (OLD.content_state = 'archived_from_active_rotation' AND NEW.content_state IN ('rediscovered'))
  ) THEN
    RAISE EXCEPTION '02 §7: in-Trail content % → % is not an allowed transition', OLD.content_state, NEW.content_state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.content_trails_state_transition() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.content_trails_state_transition() IS
  '3381 / 02_Trails.md §7: the in-Trail content lifecycle transition relation, verbatim from CONTENT_TRANSITIONS in lib/discoveryTrailObject.ts. rediscovered is reachable only from archived_from_active_rotation.';

DROP TRIGGER IF EXISTS content_trails_state_transition_trg ON public.content_trails;
CREATE TRIGGER content_trails_state_transition_trg
  BEFORE UPDATE OF content_state ON public.content_trails
  FOR EACH ROW EXECUTE FUNCTION public.content_trails_state_transition();

-- ── Behavioural postcondition, inside the applying transaction ──────────────
DO $probe$
BEGIN
  BEGIN
    INSERT INTO public.trails (id, slug, title, lifecycle_status)
      VALUES ('00000000-0000-4000-8000-0000000033c0', 'migration-3381-probe', 'probe', 'archived');
    UPDATE public.trails SET lifecycle_status = 'active' WHERE id = '00000000-0000-4000-8000-0000000033c0';
    RAISE EXCEPTION 'POSTCONDITION FAILED (3381): archived → active was admitted';
  EXCEPTION
    WHEN check_violation THEN
      IF SQLERRM NOT LIKE '02 §7: Trail lifecycle archived → active%' THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3381): the probe was refused by something else: %', SQLERRM;
      END IF;
  END;
  BEGIN
    INSERT INTO public.trails (id, slug, title, lifecycle_status)
      VALUES ('00000000-0000-4000-8000-0000000033c1', 'migration-3381-probe-c', 'probe c', 'active');
    INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship)
      VALUES ('00000000-0000-4000-8000-0000000033c1', 'place', '00000000-0000-4000-8000-0000000033d0', 'primary');
    UPDATE public.content_trails SET content_state = 'rediscovered'
     WHERE trail_id = '00000000-0000-4000-8000-0000000033c1';
    RAISE EXCEPTION 'POSTCONDITION FAILED (3381): just_arrived → rediscovered was admitted';
  EXCEPTION
    WHEN check_violation THEN
      IF SQLERRM NOT LIKE '02 §7: in-Trail content just_arrived → rediscovered%' THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3381): the content probe was refused by something else: %', SQLERRM;
      END IF;
  END;
END
$probe$;

COMMIT;

-- ── Postconditions (read-only: what persisted) ──────────────────────────────
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.trails'::regclass
                    AND tgname = 'trails_lifecycle_transition_trg' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3381): trails_lifecycle_transition_trg is absent.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.content_trails'::regclass
                    AND tgname = 'content_trails_state_transition_trg' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3381): content_trails_state_transition_trg is absent.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.trails WHERE slug LIKE 'migration-3381-probe%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3381): a probe row persisted.';
  END IF;
END
$post$;
