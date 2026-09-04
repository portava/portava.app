-- 2260_availability_windows.sql
--
-- Open-to-Plans / Temporary Intent (Passport spec §8, TABLE 7/8/10) — storage + flag.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- WHAT §8 ASKS FOR, AND WHY THE EXISTING AVAILABILITY TABLES CANNOT ANSWER IT
-- ==========================================================================
-- §6 "Availability answers 'Can I do something?'" — that is the weekly grid in
-- `user_availability` and the four-value `quick_availability_status`, and those
-- stay exactly as they are. §8 is a DIFFERENT question: "Open to Plans answers
-- 'Do I want social invitations?'" It is time-bounded, carries an INTENT LIST
-- (Food · Drinks · Nightlife · Explore · Events · Meet Travelers), a group
-- preference, a travel radius and its OWN visibility, and it EXPIRES. None of
-- that fits a single-row-per-user enum, so this table adds the §8 model
-- (TABLE 8 `AvailabilityWindow`) alongside the grid rather than reshaping it.
--
-- THE ONE RULE THIS SCHEMA REFUSES TO LET A WRITER BREAK (§7)
-- ==========================================================
--   "Never publicly convert inferred availability into an explicit-looking
--    status. Inference may trigger a private prompt such as 'Free tonight?';
--    only an explicit answer should become public/shared availability."
--
-- That is a CHECK here, not a convention in the service:
--
--   CHECK (source = 'explicit' OR visibility = 'private')
--
-- A `plan_derived` (inferred) window whose visibility is anything other than
-- 'private' is UNREPRESENTABLE. The service applies the same rule when it
-- projects, but this constraint means a writer that bypasses the service — or a
-- future bug that forgets the rule — still cannot store an inferred window that
-- would leak as public/shared. The inference can seed a private prompt; it can
-- never seed a public status.
--
-- EXPIRY IS FIRST-CLASS (§8 "carry a TTL or explicit clear", §31 "explicitly
-- expire ... temporary intent")
-- =====================================================================
-- `end_at` bounds the window itself and `expires_at` is the optional TTL/clear
-- horizon. The read path (services/passport/OpenToPlansService.ts) re-evaluates
-- BOTH on every request, so a stalled sweep can never render an expired window
-- as current — the sweep costs disk, never truth.
--
-- OWNER-SCOPED, SERVICE-AUTHORITATIVE
-- ===================================
-- RLS is enabled. An owner may SELECT their OWN windows directly; nobody may
-- write except service_role, so `source` and `visibility` cannot be self-set
-- through PostgREST to forge an explicit public window. There is NO cross-user
-- read policy: a viewer sees another traveler's window only through the service
-- projection, which enforces explicit-source + active + visibility together.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: feature_flags must exist.';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: profiles must exist.';
  END IF;
  IF to_regclass('public.trips') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trips must exist — trip-scoped windows reference it.';
  END IF;
END $$;

-- ── AvailabilityWindow (TABLE 8) ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.availability_windows (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- TABLE 7/8 window kinds. 'derived' is the inferred/plan-derived shape.
  type               text NOT NULL,
  -- The window itself. end_at > start_at is enforced below.
  start_at           timestamptz NOT NULL,
  end_at             timestamptz NOT NULL,
  -- Trip-scoped windows attach to a trip; cascade so a deleted trip takes its
  -- trip-scoped windows with it. NULL for non-trip windows.
  trip_id            uuid REFERENCES public.trips(id) ON DELETE CASCADE,
  -- §8 "Do I want social invitations?"
  open_to_plans      boolean NOT NULL DEFAULT false,
  -- §8 current intent list. Every element must be a member of the closed set
  -- (empty array is allowed — a window can be open-to-plans without a specific
  -- intent yet). Enforced by the <@ containment CHECK below.
  intents            text[] NOT NULL DEFAULT '{}'::text[],
  -- TABLE 7 "Group" (Small groups / crew only) and "Radius" (~20 min).
  group_preference   text,
  max_travel_minutes integer,
  -- This window's OWN visibility (TABLE 23 VisibilityPolicy). Default private.
  visibility         text NOT NULL DEFAULT 'private',
  -- §7 provenance. 'explicit' = the user answered; 'plan_derived' = inferred.
  source             text NOT NULL DEFAULT 'explicit',
  -- SocialAvailability enum surface (TABLE 10). Optional coarse state that
  -- accompanies the window; the closed set is enforced by CHECK.
  social_availability text,
  -- §8/§31 TTL / explicit-clear horizon. NULL = no separate TTL (bounded by
  -- end_at alone). The read path treats now() >= COALESCE(expires_at, end_at)
  -- as expired.
  expires_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Window kinds (TABLE 8 `type`).
ALTER TABLE public.availability_windows
  DROP CONSTRAINT IF EXISTS availability_windows_type_check;
ALTER TABLE public.availability_windows
  ADD CONSTRAINT availability_windows_type_check
  CHECK (type IN ('recurring', 'trip', 'one_time', 'derived'));

-- The window must open before it closes.
ALTER TABLE public.availability_windows
  DROP CONSTRAINT IF EXISTS availability_windows_bounds_check;
ALTER TABLE public.availability_windows
  ADD CONSTRAINT availability_windows_bounds_check
  CHECK (end_at > start_at);

-- If a TTL is set it cannot predate the window's start.
ALTER TABLE public.availability_windows
  DROP CONSTRAINT IF EXISTS availability_windows_expiry_check;
ALTER TABLE public.availability_windows
  ADD CONSTRAINT availability_windows_expiry_check
  CHECK (expires_at IS NULL OR expires_at >= start_at);

-- §8 IntentType closed set. `intents <@ ARRAY[...]` is true for the empty array
-- and false the instant any element is outside the set.
ALTER TABLE public.availability_windows
  DROP CONSTRAINT IF EXISTS availability_windows_intents_check;
ALTER TABLE public.availability_windows
  ADD CONSTRAINT availability_windows_intents_check
  CHECK (
    intents <@ ARRAY['Food', 'Drinks', 'Nightlife', 'Explore', 'Events', 'MeetTravelers']::text[]
  );

-- GroupPreference closed set (nullable).
ALTER TABLE public.availability_windows
  DROP CONSTRAINT IF EXISTS availability_windows_group_pref_check;
ALTER TABLE public.availability_windows
  ADD CONSTRAINT availability_windows_group_pref_check
  CHECK (
    group_preference IS NULL
    OR group_preference IN ('solo', 'one_on_one', 'small_group', 'crew_only', 'large_group', 'any')
  );

-- A travel radius, when present, is a positive number of minutes bounded to a
-- day so a fat-fingered value cannot mean "anywhere on earth".
ALTER TABLE public.availability_windows
  DROP CONSTRAINT IF EXISTS availability_windows_travel_minutes_check;
ALTER TABLE public.availability_windows
  ADD CONSTRAINT availability_windows_travel_minutes_check
  CHECK (max_travel_minutes IS NULL OR (max_travel_minutes > 0 AND max_travel_minutes <= 1440));

-- Visibility (TABLE 23 VisibilityPolicy).
ALTER TABLE public.availability_windows
  DROP CONSTRAINT IF EXISTS availability_windows_visibility_check;
ALTER TABLE public.availability_windows
  ADD CONSTRAINT availability_windows_visibility_check
  CHECK (visibility IN ('public', 'followers', 'following', 'crew', 'private'));

-- §7 provenance closed set.
ALTER TABLE public.availability_windows
  DROP CONSTRAINT IF EXISTS availability_windows_source_check;
ALTER TABLE public.availability_windows
  ADD CONSTRAINT availability_windows_source_check
  CHECK (source IN ('explicit', 'plan_derived'));

-- SocialAvailability enum surface (TABLE 10), nullable.
ALTER TABLE public.availability_windows
  DROP CONSTRAINT IF EXISTS availability_windows_social_availability_check;
ALTER TABLE public.availability_windows
  ADD CONSTRAINT availability_windows_social_availability_check
  CHECK (
    social_availability IS NULL
    OR social_availability IN ('open', 'maybe', 'crew_only', 'following_only', 'not_open')
  );

-- ── THE §7 BACKSTOP ────────────────────────────────────────────────────────────
-- An inferred window can never be public/shared. Only an explicit answer earns a
-- visibility other than 'private'. This is the single most important line here.
ALTER TABLE public.availability_windows
  DROP CONSTRAINT IF EXISTS availability_windows_inferred_stays_private_check;
ALTER TABLE public.availability_windows
  ADD CONSTRAINT availability_windows_inferred_stays_private_check
  CHECK (source = 'explicit' OR visibility = 'private');

COMMENT ON TABLE public.availability_windows IS
  'Passport spec §8 Open-to-Plans / Temporary Intent (TABLE 8 AvailabilityWindow). Time-bounded social-intent windows with an intent list, group preference, travel radius, own visibility and a TTL — distinct from the §6 weekly grid (user_availability) and quick-status enum (quick_availability_status), which are unchanged. §7 is enforced structurally: CHECK (source = ''explicit'' OR visibility = ''private'') makes an inferred window that is not private unrepresentable, so inference can seed a private prompt but never a public status. Expiry is enforced on every READ, so a stalled sweep cannot render an expired window as current (§31).';

COMMENT ON COLUMN public.availability_windows.source IS
  '§7 provenance. ''explicit'' = the traveler answered; ''plan_derived'' = inferred. A plan_derived row is pinned to visibility=''private'' by availability_windows_inferred_stays_private_check.';

COMMENT ON COLUMN public.availability_windows.expires_at IS
  '§8/§31 TTL / explicit-clear horizon. NULL means the window is bounded by end_at alone. The read path treats now() >= COALESCE(expires_at, end_at) as expired and never serves it as current.';

COMMENT ON COLUMN public.availability_windows.social_availability IS
  'TABLE 10 SocialAvailability enum surface: open | maybe | crew_only | following_only | not_open. A coarse companion to the window; NULL when unset.';

-- ── Indexes ────────────────────────────────────────────────────────────────────

-- Owner's windows, newest-ending first — the list/read path.
CREATE INDEX IF NOT EXISTS availability_windows_user_idx
  ON public.availability_windows (user_id, end_at DESC);

-- Sweep / expiry evaluation.
CREATE INDEX IF NOT EXISTS availability_windows_expiry_idx
  ON public.availability_windows (expires_at)
  WHERE expires_at IS NOT NULL;

-- Trip-scoped lookups.
CREATE INDEX IF NOT EXISTS availability_windows_trip_idx
  ON public.availability_windows (trip_id)
  WHERE trip_id IS NOT NULL;

-- ── RLS ────────────────────────────────────────────────────────────────────────

ALTER TABLE public.availability_windows ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.availability_windows FROM PUBLIC;
REVOKE ALL ON public.availability_windows FROM anon;
REVOKE ALL ON public.availability_windows FROM authenticated;
REVOKE ALL ON public.availability_windows FROM service_role;

-- Owner may read their OWN windows directly (owner-scoped). No write grant to
-- authenticated: source/visibility cannot be forged through PostgREST.
GRANT SELECT ON public.availability_windows TO authenticated;
-- service_role is authoritative for all writes and cross-user projection reads.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.availability_windows TO service_role;

DROP POLICY IF EXISTS availability_windows_owner_read ON public.availability_windows;
CREATE POLICY availability_windows_owner_read ON public.availability_windows
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS availability_windows_service_all ON public.availability_windows;
CREATE POLICY availability_windows_service_all ON public.availability_windows
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── Flag ───────────────────────────────────────────────────────────────────────
-- OFF by default. With it off the §8 window routes answer an explicitly-disabled
-- envelope ({ ok: true, enabled: false } / { windows: [], enabled: false }) and
-- store nothing. The existing §6 grid and quick-status routes are NOT gated by
-- it and keep working exactly as before.

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('open_to_plans_windows_enabled', FALSE,
   'Passport spec §8 Open-to-Plans / Temporary Intent: AvailabilityWindow CRUD (routes/availability.ts, services/passport/OpenToPlansService.ts). Time-bounded social-intent windows with intent list, group preference, travel radius, own visibility and TTL. Inferred (plan_derived) windows can never be public/shared (§7); expiry is enforced on every read (§31). Does not affect the §6 weekly grid or quick-status.')
ON CONFLICT (flag) DO NOTHING;

-- Postcondition: the table and the §7 backstop must both exist, or fail loudly.
DO $$
BEGIN
  IF to_regclass('public.availability_windows') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: availability_windows was not created.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'availability_windows_inferred_stays_private_check'
      AND conrelid = 'public.availability_windows'::regclass
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the §7 inferred-stays-private CHECK is missing.';
  END IF;
END $$;

COMMIT;
