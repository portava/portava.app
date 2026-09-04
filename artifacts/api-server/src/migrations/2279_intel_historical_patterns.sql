-- 2279_intel_historical_patterns.sql
-- IG (unit I4b) — §12 historical pattern learning store + the IG-05 'typical'
-- fallback seam + the nightly pattern-learning flag.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Additive,
-- forward-only, idempotent.
--
-- WHAT THIS ADDS
-- ==============
-- 1. public.intel_historical_patterns — an APPEND-ONLY, derived cohort-aggregate
--    store: one row per (subject × zone × claim_family × pattern_kind × time_band
--    (× dow/season)) recurring pattern, written nightly by lib/intelPatternScheduler.ts
--    from FINALIZED outcomes only (spec §21 "Pattern learning nightly from
--    finalized outcomes; never from mutable live projection alone", Table 2
--    "Pattern learning … Consumes finalized outcomes only").
--
--    TABLE 18 ELIGIBILITY is a HARD DB CONSTRAINT, not a convention: a live
--    observation does not become a pattern until multiple independent finalized
--    outcomes satisfy the Table-19 minimum cohort / date coverage. The CHECK
--    below refuses to persist any pattern row below its kind's minimum — "never
--    persist below minimum". (An invalidation tombstone is exempt: it carries no
--    cohort of its own.)
--
--    DERIVED, NOT AUDIT DATA, and it carries NO actor identity — a pattern is a
--    cohort aggregate over many contributors, so there is no user-identifying
--    column and nothing for account deletion to erase here (the observations that
--    fed it are erased at their own table). It is therefore intentionally absent
--    from deletionDispositions' user-keyed buckets.
--
--    INVALIDATION IS BY SUPERSEDING ROW (spec §12 "Pattern invalidation"), not by
--    UPDATE: a correction/withdrawal, a materially-changed venue, or a stale
--    pattern is retired by INSERTing an `is_invalidation` tombstone that supersedes
--    the prior row. The read takes the latest row per scope; a tombstone means "no
--    typical pattern". This keeps the table append-only end to end.
--
-- 2. intel_state_snapshots.source_class (ADD COLUMN IF NOT EXISTS) — the IG-05
--    enrichment seam liveClaimRead.deriveSourceClass already reads. Added
--    order-safe (IF NOT EXISTS, no new CHECK) so it coexists with I1's 2273 if
--    that also touches the column; read-side validation against SOURCE_CLASSES is
--    the integrity guard, so no DB CHECK is needed here and none is added (adding
--    one could collide with a parallel migration).
--
-- 3. flag intel_pattern_learning — seeded OFF. Off ⇒ lib/intelPatternScheduler is
--    an inert no-op that writes nothing. The store exists regardless; the flag
--    gates only the writer.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
  IF to_regclass('public.places') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.places does not exist.';
  END IF;
  IF to_regclass('public.intel_state_snapshots') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_state_snapshots does not exist (migration 2130).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'intel_append_only'
                 AND pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_append_only() missing (migration 2130).';
  END IF;
END $$;

-- ── 1. intel_historical_patterns ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.intel_historical_patterns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id            uuid NOT NULL REFERENCES public.places(id) ON DELETE CASCADE,
  zone_id               text,                          -- null = subject-wide
  claim_family          text NOT NULL,
  -- Which Table-19 pattern this row expresses. Its value drives the minimum CHECK.
  pattern_kind          text NOT NULL
    CHECK (pattern_kind IN (
      'typical_crowd_by_weekday_hour',
      'peak_arrival_time',
      'typical_crowd_mix',
      'recurring_queue',
      'venue_to_venue_movement'
    )),
  -- Cohort dimensions (spec §12: "× time_band (× dow/season)").
  time_band             text NOT NULL,                 -- e.g. 'hour_18', 'window_20-22'
  dow                   smallint CHECK (dow IS NULL OR (dow >= 0 AND dow <= 6)),
  season                text,
  -- The typical value (normalised into registry ontology by the producer).
  value_json            jsonb NOT NULL,
  -- Table-18/19 evidence: independent qualifying visits, distinct contributors,
  -- and the distinct dates the cohort spans.
  cohort_size           integer NOT NULL DEFAULT 0 CHECK (cohort_size >= 0),
  distinct_contributors integer NOT NULL DEFAULT 0 CHECK (distinct_contributors >= 0),
  distinct_dates        integer NOT NULL DEFAULT 0 CHECK (distinct_dates >= 0),
  window_days           integer NOT NULL DEFAULT 0 CHECK (window_days >= 0),
  -- Optional calibration accuracy (0..1) from the daily calibration report.
  accuracy              numeric CHECK (accuracy IS NULL OR (accuracy >= 0 AND accuracy <= 1)),
  confidence            numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  -- Table 8 UI label: a pattern is ALWAYS 'historical_pattern' — never live.
  source_label          text NOT NULL DEFAULT 'historical_pattern'
    CHECK (source_label = 'historical_pattern'),
  -- Invalidation tombstone (spec §12): a superseding row that retires the prior
  -- pattern for this scope. When true the cohort minimums do not apply.
  is_invalidation       boolean NOT NULL DEFAULT false,
  invalidation_reason   text,
  supersedes_id         uuid REFERENCES public.intel_historical_patterns(id) ON DELETE SET NULL,
  computed_at           timestamptz NOT NULL DEFAULT now(),

  -- TABLE 19 MINIMUMS — never persist below minimum. Exempt only for tombstones.
  CONSTRAINT intel_historical_patterns_min_cohort CHECK (
    is_invalidation OR (
      CASE pattern_kind
        WHEN 'typical_crowd_by_weekday_hour' THEN cohort_size >= 8  AND distinct_dates >= 4
        WHEN 'peak_arrival_time'             THEN cohort_size >= 12 AND distinct_dates >= 6
        WHEN 'typical_crowd_mix'             THEN cohort_size >= 15 AND distinct_contributors >= 5
        WHEN 'recurring_queue'               THEN cohort_size >= 10 AND distinct_dates >= 5
        WHEN 'venue_to_venue_movement'       THEN distinct_contributors >= 15 AND distinct_dates >= 4
        ELSE false
      END
    )
  ),
  -- A tombstone must say why it retired the prior pattern.
  CONSTRAINT intel_historical_patterns_invalidation_reason CHECK (
    NOT is_invalidation OR (invalidation_reason IS NOT NULL AND length(invalidation_reason) > 0)
  )
);

-- Read path: latest row per (subject, zone, claim_family, pattern_kind, time_band).
CREATE INDEX IF NOT EXISTS intel_historical_patterns_scope_recent_idx
  ON public.intel_historical_patterns
     (subject_id, coalesce(zone_id,''), claim_family, pattern_kind, time_band, computed_at DESC);

-- ── APPEND-ONLY ENFORCEMENT (reuse 2130's intel_append_only guard) ────────────
-- Derived, but IMMUTABLE once written: invalidation is a new superseding row, not
-- an UPDATE. DELETE is refused unless inside an explicit erasure declaration —
-- though this table has no actor identity, so no erasure path targets it.
DROP TRIGGER IF EXISTS intel_historical_patterns_no_update_delete ON public.intel_historical_patterns;
CREATE TRIGGER intel_historical_patterns_no_update_delete
  BEFORE UPDATE OR DELETE ON public.intel_historical_patterns
  FOR EACH ROW EXECUTE FUNCTION public.intel_append_only();
DROP TRIGGER IF EXISTS intel_historical_patterns_no_update_delete_stmt ON public.intel_historical_patterns;
CREATE TRIGGER intel_historical_patterns_no_update_delete_stmt
  BEFORE UPDATE OR DELETE ON public.intel_historical_patterns
  FOR EACH STATEMENT EXECUTE FUNCTION public.intel_append_only_stmt();
DROP TRIGGER IF EXISTS intel_historical_patterns_no_truncate ON public.intel_historical_patterns;
CREATE TRIGGER intel_historical_patterns_no_truncate
  BEFORE TRUNCATE ON public.intel_historical_patterns
  FOR EACH STATEMENT EXECUTE FUNCTION public.intel_append_only();

-- ── RLS + grants (2130 shape: deny-default, REVOKE-first for anon AND authenticated) ─
ALTER TABLE public.intel_historical_patterns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_historical_patterns FROM PUBLIC;
REVOKE ALL ON public.intel_historical_patterns FROM anon;
REVOKE ALL ON public.intel_historical_patterns FROM authenticated;
REVOKE ALL ON public.intel_historical_patterns FROM service_role;
-- service_role writes (append-only) and reads. No UPDATE/DELETE — the trigger
-- would refuse it anyway, and the grant says the same thing. Clients never read
-- the table directly; the 'typical' fallback reaches them through the projection
-- read path (lib/liveClaimRead) and the §19 read models the server controls.
GRANT INSERT, SELECT ON public.intel_historical_patterns TO service_role;

COMMENT ON TABLE public.intel_historical_patterns IS
  'IG §12: append-only, derived recurring-pattern aggregates (Table 18/19). Cohort minimums enforced by CHECK — never persisted below minimum. Invalidation is a superseding is_invalidation row, never an UPDATE. No actor identity: a cohort aggregate, so nothing for account deletion to erase here.';

-- ── 2. IG-05 'typical' fallback seam: source_class on the snapshot ────────────
-- ADD COLUMN IF NOT EXISTS, order-safe with I1's 2273. No CHECK is added here so
-- it cannot collide with a parallel migration; deriveSourceClass validates the
-- value against SOURCE_CLASSES on read.
ALTER TABLE public.intel_state_snapshots ADD COLUMN IF NOT EXISTS source_class text;
COMMENT ON COLUMN public.intel_state_snapshots.source_class IS
  'IG-05 enrichment seam: the epistemic class of the projected claim (SOURCE_CLASSES). Read by lib/liveClaimRead.deriveSourceClass; a historical_pattern/portava_prediction is dropped before any Live label.';

-- ── 3. Flag: nightly pattern learning, seeded OFF ─────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'intel_pattern_learning',
    false,
    'Runs the IG §12 nightly pattern producer (lib/intelPatternScheduler): derives recurring cohort patterns from FINALIZED intel outcomes into intel_historical_patterns and writes invalidation tombstones on correction/withdrawal. Off = the scheduler writes nothing (inert no-op).'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postcondition ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.intel_historical_patterns') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_historical_patterns not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='intel_state_snapshots' AND column_name='source_class') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_state_snapshots.source_class missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'intel_pattern_learning') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_pattern_learning flag not seeded';
  END IF;
  -- Flag seeded OFF: on_count for this flag must be 0.
  IF (SELECT count(*) FROM public.feature_flags WHERE flag = 'intel_pattern_learning' AND enabled) <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_pattern_learning must be seeded OFF (on_count=0)';
  END IF;
  -- Append-only guard must be attached.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.intel_historical_patterns'::regclass
      AND tgname = 'intel_historical_patterns_no_update_delete') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: append-only trigger missing on intel_historical_patterns';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   DELETE FROM public.feature_flags WHERE flag = 'intel_pattern_learning';
--   ALTER TABLE public.intel_state_snapshots DROP COLUMN IF EXISTS source_class;
--   DROP TABLE IF EXISTS public.intel_historical_patterns;
