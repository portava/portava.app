-- 2213_protected_locations.sql
--
-- Protected location policy (Map spec §24) — storage for the zones that
-- lib/protectedLocations.ts evaluates.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- §24: "Suppress sensitive locations before data reaches the client. Protected
-- examples may include private residences, medical facilities, shelters,
-- sensitive government locations and policy-defined protected zones."
--
-- THIS TABLE SHIPS EMPTY, AND THAT IS THE POINT
-- =============================================
-- There are NO seed rows. Populating it means writing down real-world addresses
-- of shelters, residences and secure sites — the single most sensitive dataset
-- this product could hold — and doing that from a code migration would mean an
-- engineer inventing protected locations from memory. Which places are
-- protected, in which jurisdiction, under which legal basis, is a policy
-- decision with a named owner; it is not a schema decision. So this migration
-- delivers the schema, the constraints and the lock, and the first row is an
-- explicit act by whoever owns that policy.
--
-- An empty table is also SAFE by construction: with no zones,
-- applyProtection() is an identity pass that reports zero suppressions. Nothing
-- changes on the map until a policy exists.
--
-- DELIBERATELY NOT FEATURE-FLAGGED
-- ================================
-- Every other map unit in this series lands behind a flag. This one does not.
-- A privacy gate with an off switch is not a gate — a flag would be a
-- one-UPDATE path to publishing every protected location, and the natural
-- default of a new flag (OFF) is the unsafe direction. The rollout control that
-- does exist is the table itself: no rows, no effect.
--
-- WHY THIS IS NOT geo_zones / plan_geofences
-- ==========================================
-- Migrations 0035/0039/2143 already define plan_geofences over geo_zones, but
-- those are TRIP geofences: enter/exit/dwell notification triggers whose RLS is
-- scoped to trip members. A protection policy must be readable by exactly one
-- principal (the service role that runs the projection) and by no user at all,
-- which is the opposite posture. Reusing them would have made the protected set
-- readable by every trip member of every trip.
--
-- THE ROW IS A SECRET
-- ===================
-- RLS is enabled with NO policies, and every grant to PUBLIC/anon/authenticated
-- is revoked. Only service_role — which bypasses RLS — can read or write. A
-- protected_zones row must never be exposed through PostgREST, never join into
-- a user-facing view, and never appear in an API response: the list of
-- protected places is a map of exactly what it protects.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: gen_random_uuid() must be available (pgcrypto or PG13+).';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.protected_zones (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Mirrors PROTECTED_CATEGORIES in lib/protectedLocations.ts. A category the
  -- server build does not recognise is treated as SUPPRESS at runtime, so the
  -- CHECK here is belt-and-braces rather than the only defence.
  category       text NOT NULL CHECK (category IN (
                   'private_residence',
                   'medical_facility',
                   'shelter',
                   'sensitive_government',
                   'policy_defined'
                 )),

  -- Per-row action override. NULL means "use the category default".
  -- 'allow' is NOT storable: a row whose effect is to permit is not a
  -- protection policy, it is a hole, and a hole must not be expressible in the
  -- protection table. For every category except policy_defined the runtime only
  -- lets this TIGHTEN the default; policy_defined takes it as written, which is
  -- what makes it the escape hatch §24 asks for.
  action         text CHECK (action IN ('coarsen', 'suppress')),

  -- Optional extra tightening of the coarsening floor. Runtime applies it
  -- through narrowestPrivacyClass(), so it can only ever reduce precision.
  privacy_floor  text CHECK (privacy_floor IN (
                   'none', 'aggregate_only', 'approximate', 'place_level', 'precise_temporary'
                 )),

  shape          text NOT NULL CHECK (shape IN ('circle', 'polygon')),

  -- circle
  center_lat     double precision CHECK (center_lat  BETWEEN -90  AND 90),
  center_lng     double precision CHECK (center_lng  BETWEEN -180 AND 180),
  radius_meters  double precision CHECK (radius_meters > 0),

  -- polygon: a linear ring as [[lng, lat], ...] in RFC 7946 order.
  ring           jsonb,

  -- Every row must justify itself. §24 calls these "policy-defined" zones, and
  -- a protected location with no recorded policy is someone's opinion: the
  -- reference is what makes the set reviewable and, later, removable.
  jurisdiction   text,
  policy_ref     text NOT NULL,

  -- Operator-facing label. NEVER serialized to a client.
  label          text,

  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- A row must actually describe a zone. A half-filled row would evaluate as
  -- unparseable geometry at runtime, which fails closed and suppresses
  -- everything in the viewport — loud, but better caught here.
  CONSTRAINT protected_zones_shape_fields_check CHECK (
    (shape = 'circle'
      AND center_lat IS NOT NULL
      AND center_lng IS NOT NULL
      AND radius_meters IS NOT NULL
      AND ring IS NULL)
    OR
    (shape = 'polygon'
      AND ring IS NOT NULL
      AND jsonb_typeof(ring) = 'array'
      AND jsonb_array_length(ring) >= 3
      AND center_lat IS NULL
      AND center_lng IS NULL
      AND radius_meters IS NULL)
  )
);

COMMENT ON TABLE public.protected_zones IS
  'Map spec §24 protected locations. Evaluated by lib/protectedLocations.ts as the last gate before serialization. SHIPS EMPTY BY DESIGN: which places are protected is a policy decision with a named owner, not a schema decision, and the list of rows is itself a map of exactly what it protects. service_role only — never expose through PostgREST, a view, or an API response.';

COMMENT ON COLUMN public.protected_zones.action IS
  'NULL = category default. ''allow'' is deliberately not storable: a protection row that permits is a hole. Only policy_defined rows have their action taken as written; other categories may only tighten their category default.';

COMMENT ON COLUMN public.protected_zones.policy_ref IS
  'Required. The statute, ruling or policy document this row implements — a protected location with no recorded policy cannot be reviewed or retired.';

COMMENT ON COLUMN public.protected_zones.ring IS
  'Linear ring as [[lng, lat], ...] in RFC 7946 order (longitude FIRST), matching lib/mapObjects.ts Position. A ring spanning more than 180 degrees of longitude is refused at runtime rather than answered wrongly.';

-- The projection loads the active set per request (or per cache window), so the
-- hot read is "all active rows", optionally narrowed by category.
CREATE INDEX IF NOT EXISTS protected_zones_active_idx
  ON public.protected_zones (active) WHERE active;
CREATE INDEX IF NOT EXISTS protected_zones_active_category_idx
  ON public.protected_zones (category) WHERE active;
-- Cheap pre-filter for circle zones when the set grows past a full scan.
CREATE INDEX IF NOT EXISTS protected_zones_circle_center_idx
  ON public.protected_zones (center_lat, center_lng) WHERE shape = 'circle' AND active;

-- RLS ON with NO POLICIES: the deny-by-default state. service_role bypasses RLS
-- and is the only principal with a grant, so the table is unreachable from
-- anon and authenticated even if a future grant is added by accident.
ALTER TABLE public.protected_zones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.protected_zones FROM PUBLIC;
REVOKE ALL ON public.protected_zones FROM anon;
REVOKE ALL ON public.protected_zones FROM authenticated;
REVOKE ALL ON public.protected_zones FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.protected_zones TO service_role;

-- NO SEED ROWS. See the header: inventing real-world addresses of shelters,
-- residences or secure sites in a code migration is exactly the harm §24
-- exists to prevent. The first row is an act of policy, not of engineering.

COMMIT;
