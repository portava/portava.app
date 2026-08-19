-- 2104_geo_zone_and_geofence_vocabulary_check.sql
--
-- STATUS: STAGED — NOT APPLIED. reconciliation-staging/, outside canonical.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q2 (column shape), Q5 (enum types + labels), Q6 (constraints)
--
-- Q5 must confirm `geo_zone_type` and `geofence_trigger_type` do not exist as
-- live enum types (the predicted state, since both `CREATE TYPE IF NOT
-- EXISTS` statements that would have created them are invalid Postgres —
-- RECONCILIATION-PACKET.md §3.2(d)). The precondition block below enforces
-- this prediction rather than assuming it. Q2/Q6 confirm which text-CHECK
-- vocabulary (legacy's uncontrolled TEXT, or root's narrower CHECK) and
-- which radius_meters type (integer vs double precision) is actually live.
--
-- ROLLBACK: derivable (§8 item 9f — CHECK ... NOT VALID / DROP CONSTRAINT is
-- reversible and takes no lock beyond a brief ACCESS EXCLUSIVE; the type
-- widen is a separate, smaller-risk reversal, see below).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS RESOLVES
-- ==================
-- RECONCILIATION-PACKET.md §3.2(d), §4.3, §7 row 2104 — INVALID_CANONICAL_DDL
-- with a live consequence. Canonical's `0034_geo_zones.sql:4` and
-- `0035_plan_geofences.sql:4` both open with `CREATE TYPE IF NOT EXISTS`,
-- which is not valid PostgreSQL in any released version — so neither file
-- applied as written, and canonical's description of these two columns as
-- enums is FALSE about production (a place no baseline alone can fix, since
-- a baseline would faithfully record an unconstrained column, not correct
-- canonical's belief about it).
--
-- geo_zones.zone_type union vocabulary, from every tree's attempt:
--   canonical (invalid enum attempt, 0034:4-6): circle, polygon, city,
--     neighborhood, venue
--   legacy (0034:9, plain TEXT, no CHECK — comment only): city,
--     neighborhood, district, venue_area, safety_zone
--   root (0034:7-8, TEXT + CHECK): city, neighborhood, venue, custom,
--     airport, hotel
--   Union: circle, polygon, city, neighborhood, venue, custom, airport,
--   hotel, district, venue_area, safety_zone. Legacy's three values were
--   never enforced by any CHECK anywhere (comment-only), so their presence
--   in live data is unconfirmed — included anyway because a CHECK narrower
--   than what may already be live would fail validation later for no
--   corrective benefit; NOT VALID defers that risk to a separate, reviewed
--   VALIDATE step.
--
-- plan_geofences.trigger_type union vocabulary:
--   canonical (invalid enum attempt, 0035:4-6): enter, exit, dwell
--   root (0035:9-10, TEXT + CHECK): enter, exit, both
--   legacy 0035 does not declare this column at all (legacy's 0035 merges a
--   different set of columns onto plan_geofences entirely —
--   check_in_radius_m and friends, per packet §1 — a separate, orthogonal
--   merge this migration does not touch).
--   Union: enter, exit, dwell, both.
--
-- radius_meters (geo_zones): canonical double precision (0034:14), root
-- integer (0034:11), legacy has no radius column (uses bounds_json
-- instead). If root's integer shape is what's live, this migration widens
-- it — widening an integer to double precision is lossless and requires no
-- data rewrite check.
--
-- WHY NOT VALID
-- =============
-- `CHECK ... NOT VALID` adds no table scan and no rewrite at ADD time;
-- `VALIDATE CONSTRAINT` is a separate, later, reviewable step (§7 row 2104:
-- "NOT VALID adds no scan and no rewrite; VALIDATE is a separate reviewable
-- step"). New writes are checked immediately; existing rows are not
-- inspected until VALIDATE runs.
--
-- INTENDED FINAL STATE
-- =====================
-- Does NOT create `geo_zone_type` or `geofence_trigger_type` as enum types —
-- the packet is explicit that the corrective is a CHECK constraint, not
-- retrying the invalid CREATE TYPE. `geo_zones.zone_type` and
-- `plan_geofences.trigger_type` each carry one CHECK NOT VALID over the
-- union vocabulary above, replacing whichever narrower CHECK (if any) was
-- already live under the default constraint name. `geo_zones.radius_meters`
-- is `double precision` if it was `integer`; untouched otherwise.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.geo_zones') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.geo_zones does not exist live.';
  END IF;
  IF to_regclass('public.plan_geofences') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.plan_geofences does not exist live.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'geo_zone_type'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: geo_zone_type exists as a live type, contradicting this migration''s assumption (derived from the invalid CREATE TYPE IF NOT EXISTS statement) that it does not. Re-author against an enum-typed column instead of a CHECK.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'geofence_trigger_type'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: geofence_trigger_type exists as a live type, contradicting this migration''s assumption.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'geo_zones' AND column_name = 'zone_type'
      AND data_type IN ('text', 'character varying')
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: geo_zones.zone_type is not a text/varchar column live. Re-derive from Q2/Q5.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plan_geofences' AND column_name = 'trigger_type'
      AND data_type IN ('text', 'character varying')
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: plan_geofences.trigger_type is not a text/varchar column live. Re-derive from Q2/Q5.';
  END IF;
END $$;

-- ── The change ───────────────────────────────────────────────────────────

ALTER TABLE public.geo_zones DROP CONSTRAINT IF EXISTS geo_zones_zone_type_check;
ALTER TABLE public.geo_zones
  ADD CONSTRAINT geo_zones_zone_type_check
  CHECK (zone_type IN (
    'circle', 'polygon', 'city', 'neighborhood', 'venue',
    'custom', 'airport', 'hotel',
    'district', 'venue_area', 'safety_zone'
  )) NOT VALID;

ALTER TABLE public.plan_geofences DROP CONSTRAINT IF EXISTS plan_geofences_trigger_type_check;
ALTER TABLE public.plan_geofences
  ADD CONSTRAINT plan_geofences_trigger_type_check
  CHECK (trigger_type IN ('enter', 'exit', 'dwell', 'both')) NOT VALID;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'geo_zones' AND column_name = 'radius_meters'
      AND data_type = 'integer'
  ) THEN
    EXECUTE 'ALTER TABLE public.geo_zones ALTER COLUMN radius_meters TYPE double precision USING radius_meters::double precision';
    COMMENT ON COLUMN public.geo_zones.radius_meters IS
      'Widened 2104 from integer (root-tree shape) to double precision (canonical shape). Lossless — no data was rewritten in a lossy way.';
  END IF;
END $$;

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'geo_zones_zone_type_check' AND conrelid = 'public.geo_zones'::regclass
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: geo_zones_zone_type_check was not created.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plan_geofences_trigger_type_check' AND conrelid = 'public.plan_geofences'::regclass
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: plan_geofences_trigger_type_check was not created.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'geo_zones' AND column_name = 'radius_meters'
      AND data_type = 'integer'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: geo_zones.radius_meters is still integer after the widen step ran.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role no longer has BYPASSRLS.';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- ALTER TABLE public.geo_zones DROP CONSTRAINT IF EXISTS geo_zones_zone_type_check;
-- ALTER TABLE public.plan_geofences DROP CONSTRAINT IF EXISTS plan_geofences_trigger_type_check;
-- -- The radius_meters widen is not rolled back automatically: narrowing
-- -- double precision back to integer is a lossy truncation of any
-- -- fractional values written since this migration ran. If a rollback of
-- -- the widen is truly needed, inspect for fractional data first:
-- --   SELECT count(*) FROM public.geo_zones WHERE radius_meters <> trunc(radius_meters);
-- -- A non-zero count means truncating back to integer would lose precision
-- -- — do not roll back the widen in that case.

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT conname, convalidated FROM pg_constraint
--  WHERE conname IN ('geo_zones_zone_type_check', 'plan_geofences_trigger_type_check');
--  -- expect both present, convalidated = false (NOT VALID, pending a
--  -- separate reviewed VALIDATE CONSTRAINT)
-- SELECT data_type FROM information_schema.columns
--  WHERE table_name = 'geo_zones' AND column_name = 'radius_meters'; -- expect double precision
