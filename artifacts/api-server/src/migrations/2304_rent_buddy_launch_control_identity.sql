-- 2304_rent_buddy_launch_control_identity.sql
-- Make rent_buddy_launch_controls' identity actually unique.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2304.
-- Additive + idempotent. Safe to re-run.
--
-- ── THE DEFECT ──────────────────────────────────────────────────────────────
-- 0050_rent_a_buddy.sql gave this table
--
--     UNIQUE (country_code, city, category)
--
-- (baseline/20260819_baseline_structure.sql:14336) with all three columns
-- NULLABLE. A plain PostgreSQL UNIQUE constraint is NULLS DISTINCT: two rows of
-- (NULL, NULL, NULL) do not conflict with one another.
--
-- Every row in this table that matters carries at least one NULL. The GLOBAL
-- control -- the one POST /rent-a-buddy/admin/kill-switch writes, and the one
-- enforceBookingCreationGates falls back to when no country/city/category
-- control matches -- is exactly (NULL, NULL, NULL). Every category-level
-- control is (NULL, NULL, '<category>').
--
-- So the constraint never constrained those rows, and four admin endpoints in
-- src/routes/rentABuddySpec.ts wrote them with
--
--     .upsert(..., { onConflict: "country_code,city,category" })
--
-- whose ON CONFLICT arbiter is that same index. It could never fire. Each admin
-- press INSERTed a duplicate: the kill switch could be pressed but not lifted,
-- and once duplicated, `getLaunchControl`'s `.maybeSingle()` read of that key
-- returned PGRST116 + data:null -- reading a DUPLICATED control as a MISSING
-- one, and routing bookings into the deny-by-default branch.
--
-- The application-side halves of the fix ship alongside this file:
--   * src/lib/rentBuddyLaunchControls.ts -- NULL-safe select-then-write, and a
--     duplicate-tolerant read.
--   * the five admin writers now share it.
-- This migration is the database's own half, so a future caller that reaches
-- for ON CONFLICT gets the behaviour it expects instead of silent duplication.
--
-- ── WHAT THIS DOES ──────────────────────────────────────────────────────────
-- 1. De-duplicates any existing (country_code, city, category) group, keeping
--    the most recently updated row. On a database where no admin ever pressed
--    one of the four endpoints (production carries the 13 seeded rows) this
--    step deletes nothing.
-- 2. Replaces the constraint with UNIQUE NULLS NOT DISTINCT, so NULL-bearing
--    keys collide the way the code always assumed they did. Precedent for the
--    clause in this schema: 2064_shared_moments_foundation.sql:47 (and
--    baseline:14776), so the server is known to support it.
--
-- Step 1 is the only data change. It removes rows that could only have been
-- created by the defect and that no correct read could ever have returned.

BEGIN;

-- ── 1. De-duplicate ─────────────────────────────────────────────────────────
-- Keep the newest row per key (updated_at, then created_at, then id as a total
-- tiebreak so the result is deterministic). NULLS NOT DISTINCT semantics are
-- reproduced here with IS NOT DISTINCT FROM, via a grouping key that maps NULL
-- to a sentinel no real value can take.

DELETE FROM public.rent_buddy_launch_controls c
WHERE EXISTS (
  SELECT 1
  FROM public.rent_buddy_launch_controls keep
  WHERE keep.country_code IS NOT DISTINCT FROM c.country_code
    AND keep.city         IS NOT DISTINCT FROM c.city
    AND keep.category     IS NOT DISTINCT FROM c.category
    AND (
      COALESCE(keep.updated_at, keep.created_at, '-infinity'::timestamptz),
      COALESCE(keep.created_at, '-infinity'::timestamptz),
      keep.id
    ) > (
      COALESCE(c.updated_at, c.created_at, '-infinity'::timestamptz),
      COALESCE(c.created_at, '-infinity'::timestamptz),
      c.id
    )
);

-- ── 2. NULLS NOT DISTINCT identity ──────────────────────────────────────────
-- Idempotent: the DROP is IF EXISTS, and the ADD is skipped when a constraint
-- of the target name already exists. Named explicitly rather than relying on the
-- server-generated name so re-running is stable.

ALTER TABLE public.rent_buddy_launch_controls
  DROP CONSTRAINT IF EXISTS rent_buddy_launch_controls_country_code_city_category_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.rent_buddy_launch_controls'::regclass
      AND conname  = 'rent_buddy_launch_controls_key_nnd'
  ) THEN
    ALTER TABLE public.rent_buddy_launch_controls
      ADD CONSTRAINT rent_buddy_launch_controls_key_nnd
      UNIQUE NULLS NOT DISTINCT (country_code, city, category);
  END IF;
END $$;

-- ── Postconditions ──────────────────────────────────────────────────────────
-- Both are assertions about THIS migration's own effect, so a silent no-op
-- cannot pass as success. Raised inside a DO block that is reached only after
-- the work above, and only ever raises on real failure (see
-- src/test/migrationDeployability.test.ts on unconditional RAISE).

DO $$
DECLARE
  dup_groups integer;
  has_nnd    boolean;
BEGIN
  SELECT count(*) INTO dup_groups FROM (
    SELECT 1
    FROM public.rent_buddy_launch_controls
    GROUP BY country_code, city, category
    HAVING count(*) > 1
  ) d;
  IF dup_groups > 0 THEN
    RAISE EXCEPTION '2304: % duplicate launch-control key groups remain after de-duplication', dup_groups;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.rent_buddy_launch_controls'::regclass
      AND conname  = 'rent_buddy_launch_controls_key_nnd'
      AND contype  = 'u'
  ) INTO has_nnd;
  IF NOT has_nnd THEN
    RAISE EXCEPTION '2304: rent_buddy_launch_controls_key_nnd was not created';
  END IF;
END $$;

COMMIT;
