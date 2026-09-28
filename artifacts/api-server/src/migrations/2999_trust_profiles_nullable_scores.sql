-- 2999_trust_profiles_nullable_scores.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band), trust lane.
--
-- ═══════════════════════════════════════
-- WHAT THIS IS FOR — Q1, owner decision 2026-09-22
-- ═══════════════════════════════════════
-- "Approve nullable trust scores. Make the nine category columns and
--  overall_score nullable, with NULL meaning not scored. Remove fabricated
--  neutral defaults and update calculations and consumers accordingly.
--  Unmeasured categories must not contribute an invented 50. Preserve
--  legitimate measured values; do not mass-convert existing 50s without
--  evidence of their origin."
--
-- Ten columns on public.trust_profiles are declared
--
--     numeric(5,2) DEFAULT 50.00 NOT NULL
--
-- (baseline/20260819_baseline_structure.sql:10940-10949). That declaration
-- makes "we have not measured this person" UNREPRESENTABLE: the only value the
-- column can hold is a number, so the absence of evidence is stored as the
-- neutral 50 — a fabricated measurement that is byte-identical to a real one.
--
-- The defect it produces is not theoretical. TrustScoreService.computeCategoryScore
-- returns a literal 50 for a category with no events, recalculateTrustScore
-- applies the nine weights (which sum to exactly 1.000) across all nine, and
-- so:
--
--   * a user with ZERO trust events scores exactly 50.00 overall and is
--     promoted to `reliable_traveler` (level_reliable = 50), and
--   * a user with ONE negative event is dragged back toward 50 by the eight
--     fabricated neutrals surrounding it — the single real measurement is
--     diluted by eight non-measurements.
--
-- After this migration NULL means NOT SCORED, and the engine writes NULL
-- rather than a substitute. Renormalisation over the categories actually
-- present is done in TrustScoreService, not here.
--
-- ═══════════════════════════════════════
-- THIS MIGRATION TOUCHES NO ROW'S DATA. READ THIS BEFORE ADDING A BACKFILL.
-- ═══════════════════════════════════════
-- There is NO UPDATE statement in this file and there must never be one added
-- to it. The decision says "preserve legitimate measured values; do not
-- mass-convert existing 50s without evidence of their origin", and in the
-- CURRENT schema there is no such evidence to be had:
--
--   A GENUINELY MEASURED 50 AND A SUBSTITUTED 50 ARE BYTE-IDENTICAL.
--
-- Both are `50.00` in a numeric(5,2). Nothing on the row distinguishes them.
-- `evidence_count`/`evidence_weight` (migration 2371) are per-PROFILE, not
-- per-category, so `evidence_count > 0` tells you the person has some events
-- somewhere — not which of the nine categories those events were in. A user
-- with three plan_attendance events and a real, measured 50.00 in
-- respect_safety is indistinguishable from one whose respect_safety 50.00 was
-- substituted, by every column on the table.
--
-- Therefore a statement of the shape
--
--     UPDATE public.trust_profiles SET <category> = NULL WHERE <category> = 50
--
-- WOULD DESTROY REAL MEASUREMENTS. It is forbidden by the decision, it is
-- forbidden here, and it is irreversible: once a measured 50 is nulled, the
-- event history it was computed from has already decayed differently and the
-- value cannot be recovered by recalculation. The honest position is that this
-- lane CONVERTS NOTHING and says so: every row keeps exactly the value it
-- held before this file ran, and the distinction between a measured 50 and a
-- substituted 50 on a PRE-EXISTING row remains permanently unknowable.
--
-- Rows written by the engine AFTER this migration carry the distinction
-- properly, because the engine will write NULL instead of substituting.
--
-- ═══════════════════════════════════════
-- WHY THE DEFAULT GOES TOO, AND NOT JUST THE NOT NULL
-- ═══════════════════════════════════════
-- DROP NOT NULL alone is not enough. With `DEFAULT 50.00` still in place, any
-- INSERT that omits a category column silently materialises the fabricated 50
-- again — the exact value this decision exists to stop inventing. An omitted
-- column must produce NULL ("not scored"), which is what dropping the default
-- makes happen. A writer that genuinely means 50 must now say 50.
--
-- `public_level` is deliberately NOT touched. It keeps `DEFAULT 'new_traveler'
-- NOT NULL` and its CHECK constraint. The decision names the nine category
-- columns and overall_score and nothing else, and 'new_traveler' is already
-- the non-stigmatizing label for a person nobody has measured (see
-- TrustPrivacyGuard.publicTrustLabel) rather than a fabricated measurement of
-- one. Widening it would be a separate decision.
--
-- ═══════════════════════════════════════
-- ENABLEMENT PRECONDITION — THE ORDER MATTERS AND IS NOT OPTIONAL
-- ═══════════════════════════════════════
-- feature_flags.trust_engine_enabled is seeded FALSE (0166_feature_flags_reconcile.sql)
-- and THIS FILE DOES NOT ENABLE IT. That ordering is load-bearing:
--
--   If the engine were writing NULL against a database where this migration
--   has NOT been applied, every score persist would raise 23502 (not-null
--   violation) and PostgREST would reject the WHOLE upsert — the same
--   whole-statement rejection migration 2371's header records for the
--   evidence columns, and the one lib/mediaAssets suffered silently for three
--   weeks (see 2336's header).
--
-- So: APPLY THIS FILE FIRST, record it in public.schema_migration_ledger, and
-- only then may anyone consider `trust_engine_enabled`. Enabling the engine
-- over a database without 2999 is the failure this paragraph exists to
-- prevent.
--
-- ═══════════════════════════════════════
-- REVERSIBLE BY
-- ═══════════════════════════════════════
--   ALTER TABLE public.trust_profiles
--     ALTER COLUMN <col> SET DEFAULT 50.00,
--     ALTER COLUMN <col> SET NOT NULL;   -- for each of the ten columns
--
-- The SET NOT NULL will FAIL if any row has acquired a NULL by then, and there
-- is no honest automatic repair for that: substituting 50 on the way back is
-- re-fabricating exactly what was removed. The reversal therefore requires a
-- deliberate decision about those rows, named here rather than discovered
-- during one.
--
-- NOT APPLIED BY THIS LANE. Written and rehearsed against scripts/local-db only.

-- ── 1. The ten columns become nullable, and stop defaulting to a fabrication ──
--
-- Idempotent: DROP NOT NULL and DROP DEFAULT on a column that already lacks
-- them are both no-ops. One statement so there is no window in which some
-- columns are converted and others are not.
--
-- NOTE THE ABSENCE OF ANY UPDATE. See "THIS MIGRATION TOUCHES NO ROW'S DATA"
-- above before you consider adding one.
ALTER TABLE public.trust_profiles
  ALTER COLUMN overall_score         DROP NOT NULL,
  ALTER COLUMN overall_score         DROP DEFAULT,
  ALTER COLUMN plan_attendance       DROP NOT NULL,
  ALTER COLUMN plan_attendance       DROP DEFAULT,
  ALTER COLUMN host_quality          DROP NOT NULL,
  ALTER COLUMN host_quality          DROP DEFAULT,
  ALTER COLUMN communication         DROP NOT NULL,
  ALTER COLUMN communication         DROP DEFAULT,
  ALTER COLUMN respect_safety        DROP NOT NULL,
  ALTER COLUMN respect_safety        DROP DEFAULT,
  ALTER COLUMN location_honesty      DROP NOT NULL,
  ALTER COLUMN location_honesty      DROP DEFAULT,
  ALTER COLUMN content_quality       DROP NOT NULL,
  ALTER COLUMN content_quality       DROP DEFAULT,
  ALTER COLUMN community_value       DROP NOT NULL,
  ALTER COLUMN community_value       DROP DEFAULT,
  ALTER COLUMN guide_accuracy        DROP NOT NULL,
  ALTER COLUMN guide_accuracy        DROP DEFAULT,
  ALTER COLUMN passport_authenticity DROP NOT NULL,
  ALTER COLUMN passport_authenticity DROP DEFAULT;

-- ═══════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS
--
-- Re-runnable standalone by `certify:migrations`: every assertion reads the
-- CURRENT catalog or runs a probe that rolls itself back. Nothing below depends
-- on this session having run the statement above, and nothing below writes a
-- row that survives.
-- ═══════════════════════════════════════════════════════════════════════════
DO $post$
DECLARE
  v_cols          text[] := ARRAY[
    'overall_score','plan_attendance','host_quality','communication',
    'respect_safety','location_honesty','content_quality','community_value',
    'guide_accuracy','passport_authenticity'
  ];
  v_col           text;
  v_notnull       boolean;
  v_default       text;
  v_still_notnull text[] := ARRAY[]::text[];
  v_still_default text[] := ARRAY[]::text[];
  v_level_notnull boolean;
BEGIN
  FOREACH v_col IN ARRAY v_cols LOOP
    SELECT a.attnotnull, pg_get_expr(d.adbin, d.adrelid)
      INTO v_notnull, v_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = 'public.trust_profiles'::regclass
      AND a.attname = v_col
      AND a.attnum > 0
      AND NOT a.attisdropped;

    -- 1. The column must still EXIST. A silently renamed or dropped column
    --    would otherwise read as "nullable" by virtue of returning no row.
    IF NOT FOUND THEN
      RAISE EXCEPTION '2999 postcondition 1 FAILED: public.trust_profiles.% does not exist', v_col;
    END IF;

    -- 2. It must be nullable. Read from the catalog, not inferred from the
    --    ALTER having run without error.
    IF v_notnull THEN
      v_still_notnull := v_still_notnull || v_col;
    END IF;

    -- 3. And it must have NO default. A surviving DEFAULT 50.00 re-materialises
    --    the fabricated neutral on every INSERT that omits the column, which
    --    would leave the decision half-applied in the way hardest to notice:
    --    the column reports nullable, and nothing is ever null.
    IF v_default IS NOT NULL THEN
      v_still_default := v_still_default || (v_col || ' => ' || v_default);
    END IF;
  END LOOP;

  IF array_length(v_still_notnull, 1) IS NOT NULL THEN
    RAISE EXCEPTION '2999 postcondition 2 FAILED: still NOT NULL, so "not scored" remains unrepresentable: %',
      array_to_string(v_still_notnull, ', ');
  END IF;

  IF array_length(v_still_default, 1) IS NOT NULL THEN
    RAISE EXCEPTION '2999 postcondition 3 FAILED: DEFAULT survives, so an omitted column still materialises a fabricated neutral: %',
      array_to_string(v_still_default, ', ');
  END IF;

  -- 4. public_level is NOT in scope and must NOT have been widened by accident.
  --    Asserting what this migration deliberately did NOT do is as much a part
  --    of the contract as asserting what it did.
  SELECT a.attnotnull INTO v_level_notnull
  FROM pg_attribute a
  WHERE a.attrelid = 'public.trust_profiles'::regclass
    AND a.attname = 'public_level'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF v_level_notnull IS NULL THEN
    RAISE EXCEPTION '2999 postcondition 4 FAILED: public.trust_profiles.public_level does not exist';
  END IF;
  IF NOT v_level_notnull THEN
    RAISE EXCEPTION '2999 postcondition 4 FAILED: public_level became nullable. This migration does not touch it and must not; widening it is a separate owner decision.';
  END IF;

  -- 5. A NULL is now actually ACCEPTED end to end, not merely permitted by the
  --    catalog. Probed inside a rolled-back subtransaction so no row survives
  --    this check, and skipped when there is no FK-satisfying subject — an
  --    empty table is not a failure of this migration.
  --
  --    The subject comes from public.profiles, NOT auth.users, because
  --    trust_profiles_user_id_fkey targets public.profiles. Rehearsing this
  --    file against scripts/local-db is what caught that: the probe against
  --    auth.users raised 23503 on a database where the migration was
  --    perfectly correct.
  DECLARE
    v_subject uuid;
  BEGIN
    SELECT id INTO v_subject FROM public.profiles LIMIT 1;
    IF v_subject IS NOT NULL THEN
      BEGIN
        INSERT INTO public.trust_profiles (user_id, overall_score, respect_safety)
        VALUES (v_subject, NULL, NULL)
        ON CONFLICT (user_id) DO NOTHING;
        -- Always undone: this probe must never leave a row behind, and must
        -- never overwrite a real profile (hence DO NOTHING above).
        RAISE EXCEPTION 'rollback_probe';
      EXCEPTION
        WHEN SQLSTATE 'P0001' THEN
          IF SQLERRM <> 'rollback_probe' THEN RAISE; END IF;
        WHEN not_null_violation THEN
          RAISE EXCEPTION '2999 postcondition 5 FAILED: inserting NULL scores still raises 23502 — the catalog says nullable but a write disagrees';
      END;
    END IF;
  END;
END
$post$;
