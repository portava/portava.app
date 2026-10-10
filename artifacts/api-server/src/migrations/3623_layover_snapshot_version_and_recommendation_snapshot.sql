-- 3623_layover_snapshot_version_and_recommendation_snapshot.sql
-- census-layover L25 (snapshot `version`) and L64 (every recommendation stores
-- the snapshot it was certified under). Lane L-DATA, band 3623-3631.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION. APPLIED TO NO DATABASE by the lane
-- that wrote it. Additive + idempotent: two nullable columns, one trigger, two
-- indexes, one FK, one flag row seeded FALSE. No UPDATE, no DELETE, no backfill,
-- nothing dropped, no existing column's type/nullability/default changed.
--
-- ── NO NEW TABLE, DELIBERATELY ─────────────────────────────────────────────
-- The spec's §4 `layover_snapshots` IS `layover_certified_computations` (2700,
-- completed by 2992's five §20 columns) — 2992's header argues this at length:
-- a second snapshot table would be two surfaces owning one answer. This file
-- adds the ONE L25 member that table still lacked, the per-session `version`,
-- and gives `layover_recommendations` the citation L64 asks for.
--
-- ── snapshot_version ──────────────────────────────────────────────────────
-- A per-session, gap-free-at-insert sequence (1, 2, 3 ...) assigned by a
-- BEFORE INSERT trigger under a per-session transaction advisory lock, so two
-- concurrent certifications of one session cannot both take the same number;
-- the unique index is the backstop. A writer never supplies it (a supplied
-- value is overwritten). NULL only on rows written before this migration —
-- the honest "unversioned" state; no number is invented for them. A row that
-- loses the (session_id, input_hash) race aborts before it commits, so it
-- consumes no version. Compaction (DELETE) may later leave gaps: a version is
-- an identity, never a count.
--
-- ── layover_recommendations.snapshot_id ───────────────────────────────────
-- Nullable TEXT referencing layover_certified_computations(snapshot_id), ON
-- DELETE SET NULL: a card whose certifying computation has been compacted
-- away loses its citation instead of citing a row that no longer exists, and
-- the card itself is not destroyed by ledger retention. NULL = the card was
-- written with stamping OFF, or before this migration, or when the
-- computation could not be stored — never a guess.
-- Written ONLY behind `layover_recommendation_snapshot_enabled` (seeded FALSE
-- here) AND only after persistDecision confirmed the parent row exists, so the
-- FK can never be violated by the writer
-- (services/layover/LayoverDecisionStore.ts#recommendationSnapshotStamp).
--
-- ── NO COORDINATES ─────────────────────────────────────────────────────────
-- Neither column is a location. The postcondition re-asserts 2992's
-- no-coordinate rule on layover_certified_computations.
--
-- ── GRANTS ─────────────────────────────────────────────────────────────────
-- No new table, so no new REVOKE is owed (rule 4 of
-- check:client-privilege-boundary covers CREATE TABLE). The postcondition
-- asserts this file did NOT widen client access: layover_certified_computations
-- keeps exactly SELECT for clients (2700's owner-read) and no client role can
-- write layover_recommendations.snapshot_id.
--
-- ── APPLY ORDER ────────────────────────────────────────────────────────────
-- Requires 0127, 2700 and 2992 (the precondition refuses otherwise). On
-- portava-ci all three are recorded applied. On production 2700 and 2992 are
-- NOT applied; production applies 2700 -> 2992 -> 3623 together, and only then
-- may the flag be turned on (an owner press).
--
-- Rollback: db/rollback/2026-10-10-3623-layover-snapshot-version-and-recommendation-snapshot-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.layover_sessions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3623): public.layover_sessions does not exist (0127).';
  END IF;
  IF to_regclass('public.layover_recommendations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3623): public.layover_recommendations does not exist (0127).';
  END IF;
  IF to_regclass('public.layover_certified_computations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3623): public.layover_certified_computations does not exist. Apply 2700 then 2992 first.';
  END IF;
  IF to_regclass('public.layover_certcomp_snapshot_uidx') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3623): layover_certcomp_snapshot_uidx does not exist. Apply 2992 first -- the recommendation FK needs a unique snapshot_id.';
  END IF;
END $pre$;

-- ── L25: the per-session snapshot version ────────────────────────────────
ALTER TABLE public.layover_certified_computations
  ADD COLUMN IF NOT EXISTS snapshot_version INTEGER
    CHECK (snapshot_version IS NULL OR snapshot_version >= 1);

CREATE UNIQUE INDEX IF NOT EXISTS layover_certcomp_session_version_uidx
  ON public.layover_certified_computations(session_id, snapshot_version)
  WHERE snapshot_version IS NOT NULL;

CREATE OR REPLACE FUNCTION public.layover_certcomp_assign_snapshot_version()
RETURNS TRIGGER
LANGUAGE plpgsql
-- SECURITY INVOKER (the default) with a pinned empty search_path: every name
-- below is schema-qualified.
SET search_path = ''
AS $fn$
BEGIN
  -- One certification of a session at a time takes a number.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('layover_certcomp_version:' || NEW.session_id::text, 0));
  SELECT COALESCE(MAX(c.snapshot_version), 0) + 1
    INTO NEW.snapshot_version
    FROM public.layover_certified_computations c
   WHERE c.session_id = NEW.session_id;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS layover_certcomp_snapshot_version ON public.layover_certified_computations;
CREATE TRIGGER layover_certcomp_snapshot_version
  BEFORE INSERT ON public.layover_certified_computations
  FOR EACH ROW EXECUTE FUNCTION public.layover_certcomp_assign_snapshot_version();

-- ── L64: the recommendation cites its snapshot ───────────────────────────
ALTER TABLE public.layover_recommendations
  ADD COLUMN IF NOT EXISTS snapshot_id TEXT;

DO $fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'layover_recommendations_snapshot_fk'
       AND conrelid = 'public.layover_recommendations'::regclass
  ) THEN
    ALTER TABLE public.layover_recommendations
      ADD CONSTRAINT layover_recommendations_snapshot_fk
      FOREIGN KEY (snapshot_id)
      REFERENCES public.layover_certified_computations(snapshot_id)
      ON DELETE SET NULL;
  END IF;
END $fk$;

CREATE INDEX IF NOT EXISTS layover_recommendations_snapshot_idx
  ON public.layover_recommendations(snapshot_id)
  WHERE snapshot_id IS NOT NULL;

-- No grant statement: 2335 already leaves client roles SELECT-only on
-- layover_recommendations (a column-level REVOKE could not narrow a
-- table-level grant anyway). The postcondition asserts no client role can
-- write the citation, so a database still carrying 0127's grants refuses here
-- rather than shipping a certification field a traveller can forge (L201).

-- ── the gate, seeded OFF ────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_recommendation_snapshot_enabled',
    false,
    'Layover L64: when ON (and layover_decision_persistence_enabled is ON), recommendation generation stores the certified computation it rated the cards against and stamps its snapshot_id on every layover_recommendations row it writes. OFF / absent (the seed): no snapshot is stored by this path and rows are written exactly as before, without snapshot_id. REQUIRES 2700, 2992 and 3623 applied first (the payload names snapshot_id). Fail-closed via isFlagEnabled.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- Postconditions: catalog state only, re-runnable standalone.
DO $post$
DECLARE
  n int;
  certcomp_grants text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'layover_certified_computations'
                    AND column_name = 'snapshot_version') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3623): layover_certified_computations.snapshot_version missing';
  END IF;

  SELECT count(*) INTO n
    FROM pg_catalog.pg_trigger tg
    JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relname = 'layover_certified_computations'
     AND tg.tgname = 'layover_certcomp_snapshot_version' AND NOT tg.tgisinternal;
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3623): snapshot version trigger missing';
  END IF;

  IF to_regclass('public.layover_certcomp_session_version_uidx') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3623): (session_id, snapshot_version) unique index missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'layover_recommendations'
                    AND column_name = 'snapshot_id') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3623): layover_recommendations.snapshot_id missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conname = 'layover_recommendations_snapshot_fk'
                    AND conrelid = 'public.layover_recommendations'::regclass
                    AND confdeltype = 'n') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3623): layover_recommendations_snapshot_fk missing or not ON DELETE SET NULL';
  END IF;

  SELECT count(*) INTO n
    FROM information_schema.column_privileges
   WHERE table_schema = 'public' AND table_name = 'layover_recommendations'
     AND column_name = 'snapshot_id' AND grantee IN ('anon', 'authenticated')
     AND privilege_type IN ('INSERT', 'UPDATE');
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3623): a client role can write layover_recommendations.snapshot_id (% grants) -- apply 2335 (client write boundary) first', n;
  END IF;

  SELECT COALESCE(string_agg(DISTINCT privilege_type, ','), '<none>') INTO certcomp_grants
    FROM information_schema.column_privileges
   WHERE table_schema = 'public' AND table_name = 'layover_certified_computations'
     AND grantee IN ('anon', 'authenticated');
  IF certcomp_grants IS DISTINCT FROM 'SELECT' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3623): client grants on layover_certified_computations are (%), expected exactly SELECT', certcomp_grants;
  END IF;

  SELECT count(*) INTO n
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'layover_certified_computations'
     AND column_name IN ('lat','lng','latitude','longitude','location','geog','geom','point','coords');
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3623): coordinate column on layover_certified_computations';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_recommendation_snapshot_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3623): layover_recommendation_snapshot_enabled has no feature_flags row';
  END IF;
END $post$;
