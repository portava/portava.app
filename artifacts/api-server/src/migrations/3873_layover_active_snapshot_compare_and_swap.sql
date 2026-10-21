-- 3873_layover_active_snapshot_compare_and_swap.sql
--
-- Layover spec §24 "Race conditions — Version/compare-and-swap active snapshot; reject stale writes" (census-layover
-- L264), Appendix C6 "Never update the active snapshot with a stale engine result; use version/CAS semantics", and the
-- switch for §2.1 "All surfaces consume the same certified LayoverSnapshot" (census-layover L6). Owner directive
-- 2026-10-18 §6: "Active snapshot compare-and-swap ... Verify that concurrent snapshot updates cannot silently overwrite
-- each other." Layover 165 program, lane B2-RECS-A. POST-CUTOVER CANONICAL FORWARD MIGRATION (gap number 3873).
--
-- APPLIED TO NO DATABASE by the lane that wrote it. Additive: one nullable column, one trigger function, one trigger,
-- one flag row seeded FALSE. No existing row is written; no existing column, constraint or policy is changed.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT EXISTS BELOW THIS FILE
-- ══════════════════════════════════════════════════════════════════════════════
--   2700/2992  layover_certified_computations: one row per stored certified decision, identity snapshot_id.
--   3623       snapshot_version: a per-session sequence assigned by a BEFORE INSERT trigger under a per-session
--              transaction advisory lock (key 'layover_certcomp_version:' || session_id).
--   3828       layover_sessions.active_snapshot_id: the session's ACTIVE snapshot, moved by an AFTER INSERT trigger to
--              every newly stored computation (each one takes the highest version, so the newest insert is active).
-- So the newest INSERT always becomes active — whatever it was computed from. Two requests that each read the session,
-- certify and store can interleave so that the one computed from OLDER state commits last and is the one every surface
-- reads: the stale write App C6 forbids, silently.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE COMPARE-AND-SWAP
-- ══════════════════════════════════════════════════════════════════════════════
-- layover_certified_computations.expected_active_version INTEGER NULL (>= 0): the snapshot_version of the session's
-- active snapshot that the writer READ BEFORE it certified (0 = the session had no active snapshot). It is part of the
-- stored decision's provenance ("certified against active version N") and, like every column of the row, is never
-- rewritten (3896).
--
-- public.layover_certcomp_active_cas(), BEFORE INSERT FOR EACH ROW (trigger layover_certcomp_active_cas; it sorts before
-- 3623's layover_certcomp_snapshot_version and fires first). It takes 3623's per-session advisory lock (re-entrant, so
-- the version trigger after it is unaffected), so two writers of one session are serialised here, and then:
--   1. expected_active_version STATED:
--      a. it must equal the snapshot_version of the computation layover_sessions.active_snapshot_id names now
--         (0 when none). Otherwise another writer moved the active snapshot after this writer read it:
--         RAISE SQLSTATE 'LY409' "stale_snapshot_write". Nothing is stored; the newer active snapshot stands.
--      b. the session inputs the decision was certified from (inputs.session: arrival, departure, boarding, flight
--         type, immigration, checked bags, wants-to-leave) must equal layover_sessions' columns now. Otherwise the
--         session was edited after the writer read it: RAISE SQLSTATE 'LY412' "stale_session_inputs".
--      Both are checked AFTER the lock, so under READ COMMITTED each read takes a snapshot that includes every racer
--      that committed first (the same argument 3623 and 3906 rest on). Under REPEATABLE READ / SERIALIZABLE the read
--      after the lock would NOT see the racer, so a stated expectation is REFUSED at any other isolation level
--      (SQLSTATE 'LY409', naming the isolation) rather than decided on an old snapshot. PostgREST runs READ COMMITTED.
--   2. expected_active_version NULL (a writer that states nothing):
--      allowed while the flag below is OFF — the behaviour before this file, byte for byte — and REFUSED
--      (SQLSTATE 'LY428' "cas_expectation_required") while it is ON, so once the switch is thrown no writer can skip
--      the compare-and-swap.
-- The application maps LY409 -> `stale_snapshot_write`, LY412 -> `stale_session_inputs` and LY428 ->
-- `cas_expectation_required` (services/layover/LayoverDecisionStore.ts), re-reads the active snapshot and either
-- serves it (same decision) or retries once against the new version (services/layover/LayoverActiveSnapshot.ts).
-- A rejected writer never overwrites: its row is not stored.
--
-- THE FLAG: layover_canonical_snapshot_enabled, seeded FALSE. ON (with layover_decision_persistence_enabled ON): every
-- certified layover surface reads the session's ACTIVE snapshot, or certifies, stores it through this compare-and-swap
-- and serves the stored one (services/layover/LayoverActiveSnapshot.ts; the doors in services/airport/LayoverSnapshot.ts),
-- and every decision write states its expectation. OFF / absent / unreadable (the seed): nothing reads the pointer,
-- writers state nothing, and this trigger lets every insert through after one lock and one flag read.
--
-- NO COORDINATES, NO CLIENT WRITE: the column is an integer; layover_certified_computations keeps exactly SELECT for
-- clients (2700) — the postcondition re-asserts it.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ORDER (a gap number: applied at 3873 on a fresh replay, after 3999 on portava-ci and production)
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends on 0127 (layover_sessions), 2700 + 2992 (the table, snapshot_id), 3623 (snapshot_version and its lock key)
-- and 3828 (active_snapshot_id) — all numbered below, so present on a fresh replay; on production 2700/2992/3623 are
-- packet steps 055/090/197 (main run) and 3828 is a gap file applied before 3873 in filename order. The precondition
-- refuses otherwise. Nothing numbered above 3873 alters, drops or adds a trigger to layover_certified_computations or
-- layover_sessions, or names this column, function or flag (grep of every file 3874-3999, 2026-10-18: 3875, 3900 and
-- 3996 reference layover_sessions by foreign key / read only). 3896 (BEFORE UPDATE on the same table) is independent.
--
-- Rollback: db/rollback/2026-10-18-3873-layover-active-snapshot-compare-and-swap-rollback.sql (refuses while any
-- stored computation carries an expectation, while the flag is TRUE, or while feature_flag_audit_log holds its history).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.layover_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3873): public.layover_sessions does not exist (0127).';
  END IF;
  IF to_regclass('public.layover_certified_computations') IS NULL OR to_regclass('public.layover_certcomp_snapshot_uidx') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3873): layover_certified_computations with its unique snapshot_id does not exist. Apply 2700 then 2992 first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'layover_certified_computations' AND column_name = 'snapshot_version') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3873): layover_certified_computations.snapshot_version does not exist (3623).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'layover_sessions' AND column_name = 'active_snapshot_id') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3873): layover_sessions.active_snapshot_id does not exist (3828).';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'layover_certified_computations' AND column_name = 'expected_active_version') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3873): layover_certified_computations.expected_active_version already exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_canonical_snapshot_enabled' AND enabled IS NOT FALSE) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3873): layover_canonical_snapshot_enabled already exists and is not FALSE; this file seeds it OFF and will not overwrite an operator''s setting.';
  END IF;
END
$pre$;

ALTER TABLE public.layover_certified_computations
  ADD COLUMN expected_active_version INTEGER NULL
    CONSTRAINT layover_certcomp_expected_active_version_nonneg CHECK (expected_active_version IS NULL OR expected_active_version >= 0);

COMMENT ON COLUMN public.layover_certified_computations.expected_active_version IS
  '3873 (Layover §24 / App C6, census-layover L264): the snapshot_version of the session''s active snapshot the writer read before certifying (0 = none). Checked by layover_certcomp_active_cas at insert; a stale expectation is refused (LY409). NULL = the writer stated none (allowed only while layover_canonical_snapshot_enabled is OFF).';

CREATE OR REPLACE FUNCTION public.layover_certcomp_active_cas()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_active_id   text;
  v_active_ver  integer;
  v_arrival     timestamptz;
  v_departure   timestamptz;
  v_boarding    timestamptz;
  v_flight_type text;
  v_immigration boolean;
  v_bags        boolean;
  v_leave       boolean;
  v_found       boolean;
BEGIN
  IF NEW.expected_active_version IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.feature_flags f WHERE f.flag = 'layover_canonical_snapshot_enabled' AND f.enabled) THEN
      RAISE EXCEPTION 'cas_expectation_required (3873): layover_canonical_snapshot_enabled is ON, so a certified computation must state the active snapshot version it was certified against (session %).', NEW.session_id
        USING ERRCODE = 'LY428';
    END IF;
    RETURN NEW;
  END IF;

  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'stale_snapshot_write (3873): the compare-and-swap is decided only under READ COMMITTED (this transaction is %); refusing rather than comparing against an old snapshot.', pg_catalog.current_setting('transaction_isolation')
      USING ERRCODE = 'LY409';
  END IF;

  -- 3623's per-session lock: one writer of this session at a time from here to COMMIT.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('layover_certcomp_version:' || NEW.session_id::text, 0));

  SELECT true, s.active_snapshot_id, s.arrival_time, s.departure_time, s.boarding_time, s.flight_type,
         s.immigration_required, s.checked_bags, s.wants_to_leave
    INTO v_found, v_active_id, v_arrival, v_departure, v_boarding, v_flight_type, v_immigration, v_bags, v_leave
    FROM public.layover_sessions s
   WHERE s.id = NEW.session_id FOR UPDATE;
  IF v_found IS NOT TRUE THEN
    -- The foreign key would refuse it too; refusing here names it.
    RAISE EXCEPTION 'stale_session_inputs (3873): layover session % does not exist.', NEW.session_id
      USING ERRCODE = 'LY412';
  END IF;

  v_active_ver := 0;
  IF v_active_id IS NOT NULL THEN
    SELECT c.snapshot_version INTO v_active_ver
      FROM public.layover_certified_computations c
     WHERE c.snapshot_id = v_active_id;
    v_active_ver := COALESCE(v_active_ver, 0);
  END IF;

  IF NEW.expected_active_version <> v_active_ver THEN
    RAISE EXCEPTION 'stale_snapshot_write (3873): session % was certified against active snapshot version % but its active snapshot is now version %; refusing the stale write.', NEW.session_id, NEW.expected_active_version, v_active_ver
      USING ERRCODE = 'LY409';
  END IF;

  IF (NEW.inputs #>> '{session,arrivalTime}')::timestamptz IS DISTINCT FROM v_arrival
     OR (NEW.inputs #>> '{session,departureTime}')::timestamptz IS DISTINCT FROM v_departure
     OR (NEW.inputs #>> '{session,boardingTime}')::timestamptz IS DISTINCT FROM v_boarding
     OR (NEW.inputs #>> '{session,flightType}') IS DISTINCT FROM v_flight_type
     OR (NEW.inputs #>> '{session,immigrationRequired}')::boolean IS DISTINCT FROM v_immigration
     OR (NEW.inputs #>> '{session,checkedBags}')::boolean IS DISTINCT FROM v_bags
     OR (NEW.inputs #>> '{session,wantsToLeave}')::boolean IS DISTINCT FROM v_leave THEN
    RAISE EXCEPTION 'stale_session_inputs (3873): session % was edited after this decision was certified; its inputs are not the session''s inputs now. Refusing the stale write.', NEW.session_id
      USING ERRCODE = 'LY412';
  END IF;

  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.layover_certcomp_active_cas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS layover_certcomp_active_cas ON public.layover_certified_computations;
CREATE TRIGGER layover_certcomp_active_cas
  BEFORE INSERT ON public.layover_certified_computations
  FOR EACH ROW EXECUTE FUNCTION public.layover_certcomp_active_cas();

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_canonical_snapshot_enabled',
    false,
    'Layover §2.1 / §24 (census-layover L6, L264; migration 3873). ON (with layover_decision_persistence_enabled ON): every certified layover surface (overview, /safety, recommendations, Safe Return, notifications, constraints, Compass, Discovery) reads the session''s ACTIVE snapshot (layover_sessions.active_snapshot_id, 3828) when it certifies the same decision, or certifies once, stores it through the compare-and-swap (layover_certcomp_active_cas: stated expected active version; stale writes refused LY409/LY412) and serves the stored one; and every decision write must state its expectation (LY428). OFF / absent / unreadable (the seed): each surface certifies its own instant exactly as before 3873 and nothing reads the pointer. REQUIRES 2700, 2992, 3623, 3828 and 3873 applied. Fail-closed via isFlagEnabled.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (catalog only, re-runnable standalone) ─────────────────────
DO $post$
DECLARE
  n int;
  certcomp_grants text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'layover_certified_computations'
                    AND column_name = 'expected_active_version' AND is_nullable = 'YES' AND data_type = 'integer') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3873): layover_certified_computations.expected_active_version missing, not nullable or not integer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
                  WHERE tgrelid = 'public.layover_certified_computations'::regclass
                    AND tgname = 'layover_certcomp_active_cas' AND NOT tgisinternal AND tgenabled <> 'D' AND tgtype = 7) THEN
    -- tgtype 7 = ROW (1) | BEFORE (2) | INSERT (4)
    RAISE EXCEPTION 'POSTCONDITION FAILED (3873): the BEFORE INSERT FOR EACH ROW compare-and-swap trigger is missing, disabled or of another kind';
  END IF;
  IF has_function_privilege('authenticated', 'public.layover_certcomp_active_cas()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.layover_certcomp_active_cas()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3873): a client role may execute the compare-and-swap function';
  END IF;
  SELECT COALESCE(string_agg(DISTINCT privilege_type, ','), '<none>') INTO certcomp_grants
    FROM information_schema.column_privileges
   WHERE table_schema = 'public' AND table_name = 'layover_certified_computations'
     AND grantee IN ('anon', 'authenticated');
  IF certcomp_grants IS DISTINCT FROM 'SELECT' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3873): client grants on layover_certified_computations are (%), expected exactly SELECT', certcomp_grants;
  END IF;
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'layover_canonical_snapshot_enabled';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3873): layover_canonical_snapshot_enabled is not present';
  END IF;
END
$post$;
