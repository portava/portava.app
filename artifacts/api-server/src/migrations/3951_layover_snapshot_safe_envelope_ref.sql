-- 3951_layover_snapshot_safe_envelope_ref.sql
--
-- census-layover L25 (spec §4 `layover_snapshots`: "... safe_envelope_ref, candidate_set_version ..."; §5
-- EVALUATING → LANDSIDE_AVAILABLE "Create snapshot + safe envelope + candidate set"). Lane LAYOVER, census drive
-- 2026-10-23, batch 2. APPLIED TO NO DATABASE by the lane that wrote it.
--
-- ── WHAT THIS FILE IS ──────────────────────────────────────────────────────
-- One NULLABLE column, public.layover_certified_computations.safe_envelope_ref TEXT (2992's header: this table IS the
-- spec's layover_snapshots), one CHECK naming its exact vocabulary, and one feature-flag row,
-- `layover_snapshot_envelope_ref_enabled`, seeded FALSE. No table, index, function, trigger, policy or grant is added. READ ACCESS, stated rather than implied: `authenticated` already holds table-level SELECT on this table under the owner-read RLS policy `layover_certcomp_owner_read` (USING user_id = auth.uid()), read on production 2026-10-24, so a signed-in traveller can read the new column on their OWN snapshots and only those. What they read is the content hash of the envelope GET /overview already served them, or a withheld reason: not a leak.
--
--   env:<64 hex>                        sha256 of the canonical JSON of the safeEnvelope GET /overview published for
--                                       this snapshot (services/layover/LayoverSnapshotEnvelopeRef.ts)
--   env:withheld:landside_closed        the landside gate was closed, so no envelope was published
--   env:withheld:no_airport_coordinate  the airport has no coordinate to centre one on
--   NULL                                NOT RECORDED (the flag was off, or the row predates this file, or the route
--                                       fan-out RPC wrote it — 3908's INSERT names its columns and is off in
--                                       production). Never "no envelope".
--
-- Its only writer is LayoverDecisionStore.persistDecision's INSERT, and only while the flag is ON (fail-closed
-- `isFlagEnabled`; OFF / absent / unreadable sends exactly the pre-3951 payload). The flag lives in THIS file, so it
-- can be ON only where the column exists. Existing rows are not touched: ADD COLUMN with no default rewrites nothing
-- and fires no trigger, and 3896's BEFORE UPDATE immutability trigger is untouched (nothing here UPDATEs a row).
--
-- `candidate_set_version`, the other L25 member, is NOT added: in this tree the candidate set points at the snapshot
-- (layover_recommendations.snapshot_id), not the reverse, and an immutable snapshot row is written before its candidate
-- set exists, so what a "candidate set version" on it would number is a ruling (census-layover §83 L25), not a column.
--
-- ── ORDER INDEPENDENCE ─────────────────────────────────────────────────────
-- Depends on 2700 (the table), 2992 (snapshot_id) and public.feature_flags (0118). Of the files numbered above 3951,
-- none alters, drops or adds a trigger to layover_certified_computations (grep 2026-10-23: the later layover files are
-- 3971, 3982 stand-in excluded, and 3996, which reference layover_sessions only); 3908's fan-out INSERT names its own
-- columns, so it neither needs nor blocks this one, in either order.
--
-- Rollback: db/rollback/2026-10-23-3951-layover-snapshot-safe-envelope-ref-rollback.sql (refuses while the flag is
-- TRUE, while any row holds a ref, or while the flag has audit history).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.layover_certified_computations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3951): public.layover_certified_computations does not exist. Apply 2700 and 2992 first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'layover_certified_computations' AND column_name = 'snapshot_id') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3951): layover_certified_computations.snapshot_id is missing (2992).';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3951): public.feature_flags does not exist';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_snapshot_envelope_ref_enabled' AND enabled IS NOT FALSE) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3951): layover_snapshot_envelope_ref_enabled already exists and is not FALSE; this file seeds it OFF and will not overwrite an operator''s setting';
  END IF;
END
$pre$;

ALTER TABLE public.layover_certified_computations
  ADD COLUMN IF NOT EXISTS safe_envelope_ref TEXT;

DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.layover_certified_computations'::regclass
                    AND conname = 'layover_certcomp_safe_envelope_ref_shape') THEN
    ALTER TABLE public.layover_certified_computations
      ADD CONSTRAINT layover_certcomp_safe_envelope_ref_shape
      CHECK (safe_envelope_ref IS NULL
             OR safe_envelope_ref ~ '^env:([a-f0-9]{64}|withheld:(landside_closed|no_airport_coordinate))$');
  END IF;
END
$chk$;

COMMENT ON COLUMN public.layover_certified_computations.safe_envelope_ref IS
  'census-layover L25 (3951): which safe envelope GET /overview published under this snapshot. env:<sha256 of its canonical JSON>, env:withheld:landside_closed, or env:withheld:no_airport_coordinate. NULL = not recorded (flag off, pre-3951, or the route fan-out writer), never "no envelope". Written only under layover_snapshot_envelope_ref_enabled.';

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'layover_snapshot_envelope_ref_enabled',
    false,
    'Layover snapshot safe_envelope_ref (spec §4 layover_snapshots; census-layover L25; migration 3951). ON: persistDecision stores, on each new layover_certified_computations row, the content hash of the safe envelope the overview publishes for that snapshot (or env:withheld:<why>). OFF / absent / unreadable (the seed): the column is not sent and stays NULL (not recorded). Additive and reversible; no reader changes.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'layover_certified_computations'
                    AND column_name = 'safe_envelope_ref' AND is_nullable = 'YES' AND data_type = 'text') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3951): layover_certified_computations.safe_envelope_ref is not a nullable text column';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.layover_certified_computations'::regclass
                    AND conname = 'layover_certcomp_safe_envelope_ref_shape' AND contype = 'c') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3951): layover_certcomp_safe_envelope_ref_shape is missing';
  END IF;
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'layover_snapshot_envelope_ref_enabled';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3951): layover_snapshot_envelope_ref_enabled is not present';
  END IF;
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'layover_snapshot_envelope_ref_enabled' AND enabled IS NOT FALSE;
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3951): layover_snapshot_envelope_ref_enabled is ON; it must ship OFF';
  END IF;
END
$post$;
