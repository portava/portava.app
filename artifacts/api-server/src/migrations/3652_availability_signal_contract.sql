-- 3652_availability_signal_contract.sql
-- Telegraph §4.1 / §4.3 — the AvailabilitySignal contract, a separate Nearby permission and a
-- mutual ETA grant (census-telegraph T22, T23, T27). POST-CUTOVER CANONICAL FORWARD MIGRATION.
-- Lane T band 3650-3669.
--
-- Spec §4, verbatim:
--   "AVAILABLE ≠ ONLINE ≠ NEARBY ≠ SHARING LOCATION. Never collapse these states into one permission."
--   "type AvailabilitySignal = { … audiencePolicyId: UUID
--      proximityVisibility: 'HIDDEN' | 'NEARBY' | 'DISTANCE_BUCKET' | 'ETA_IF_MUTUAL'
--      geographyScope?: GeographyScope }"
--   "Exact ETA/location requires stronger mutual coordination permissions."
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THE CENSUS FOUND
-- ══════════════════════════════════════════════════════════════════════════════
-- T22 (W): Nearby reads the three consent stores that exist (availability, presence, location
--   sharing) — "the four-way separation is still a three-way one with a fourth surface reading them".
-- T23 (W): `audiencePolicyId`, `proximityVisibility` and `geographyScope` are absent from
--   availability_windows.
-- T27 (W): there is no mutual-coordination gate on anything ETA-shaped.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS CREATES (all read and written only behind availability_signal_contract_enabled,
-- seeded FALSE below; Nearby itself stays dark behind nearby_reachable_enabled)
-- ══════════════════════════════════════════════════════════════════════════════
-- public.availability_audience_policies — an owner's named audience for their availability
--   signals. PROPOSED RULING P-T10 (lane T, 2026-10-08, on the lead's instruction): a window with
--   NO policy has the DEFAULT audience, mutual follows and crew only; anything wider ('public')
--   exists only as a policy row the owner created by an explicit choice. The audience vocabulary
--   is closed (CHECK). (audience_policy_id, user_id) → (id, owner_id) is a COMPOSITE foreign key,
--   so a window can only ever point at its OWN owner's policy — structurally, not by a code check.
-- availability_windows.audience_policy_id / proximity_visibility / geography_scope — the three
--   §4.1 fields. proximity_visibility defaults to 'HIDDEN': an availability signal carries no
--   proximity unless its owner chose a rung. geography_scope (optional) is the coarsest area the
--   signal speaks for; proximity shown alongside it is never finer than it.
-- public.nearby_consents — NEARBY as its own opt-in (T22), separate from location sharing
--   (location_preferences), from availability (availability_windows) and from online status
--   (user_privacy_settings.show_online_status). Absent row = not opted in.
-- public.eta_coordination_grants — one person's time-boxed grant to another (≤ 12 hours, CHECKed);
--   an ETA-shaped value is shown only where BOTH directions are live (T27's "mutual").
--
-- All three tables: RLS on, no policy, no client privilege (rule 4 of
-- check:client-privilege-boundary); both user columns of each CASCADE on account deletion
-- (lib/deletionDispositions.ts ERASED_BY_CASCADE). availability_windows keeps its 2260 grants
-- (authenticated SELECT of the owner's own rows, no client write), so none of the three new columns
-- can be written through PostgREST.
--
-- ROLLBACK: db/rollback/2026-10-08-3652-availability-signal-contract-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3652): public.profiles must exist.';
  END IF;
  IF to_regclass('public.availability_windows') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3652): public.availability_windows must exist (2260).';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3652): public.feature_flags must exist.';
  END IF;
END $pre$;

-- ── Audience policies (T23 audiencePolicyId; proposed ruling P-T10) ─────────────
CREATE TABLE IF NOT EXISTS public.availability_audience_policies (
  id         UUID        NOT NULL DEFAULT gen_random_uuid(),
  owner_id   UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  audience   TEXT        NOT NULL DEFAULT 'mutual_follow_and_crew'
               CHECK (audience IN ('crew_only', 'mutual_follow_and_crew', 'public')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT availability_audience_policies_pkey PRIMARY KEY (id),
  -- The target of the composite FK below: a window may point only at its own owner's policy.
  CONSTRAINT availability_audience_policies_id_owner_key UNIQUE (id, owner_id)
);
CREATE INDEX IF NOT EXISTS availability_audience_policies_owner_idx
  ON public.availability_audience_policies (owner_id);

ALTER TABLE public.availability_audience_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.availability_audience_policies FROM PUBLIC;
REVOKE ALL ON public.availability_audience_policies FROM anon;
REVOKE ALL ON public.availability_audience_policies FROM authenticated;

COMMENT ON TABLE public.availability_audience_policies IS
  'Telegraph §4.1 AvailabilitySignal.audiencePolicyId (census-telegraph T23, migration 3652). An owner''s named audience for their availability signals: crew_only, mutual_follow_and_crew (the default a window WITHOUT a policy also has — proposed ruling P-T10) or public, which exists only by the owner''s explicit choice. Service role only; read and written only behind availability_signal_contract_enabled.';

-- ── The three §4.1 fields on the signal (T23) ───────────────────────────────────
ALTER TABLE public.availability_windows
  ADD COLUMN IF NOT EXISTS audience_policy_id UUID,
  ADD COLUMN IF NOT EXISTS proximity_visibility TEXT NOT NULL DEFAULT 'HIDDEN',
  ADD COLUMN IF NOT EXISTS geography_scope TEXT;

ALTER TABLE public.availability_windows
  DROP CONSTRAINT IF EXISTS availability_windows_proximity_visibility_check;
ALTER TABLE public.availability_windows
  ADD CONSTRAINT availability_windows_proximity_visibility_check
  CHECK (proximity_visibility IN ('HIDDEN', 'NEARBY', 'DISTANCE_BUCKET', 'ETA_IF_MUTUAL'));

ALTER TABLE public.availability_windows
  DROP CONSTRAINT IF EXISTS availability_windows_geography_scope_check;
ALTER TABLE public.availability_windows
  ADD CONSTRAINT availability_windows_geography_scope_check
  CHECK (geography_scope IS NULL OR geography_scope IN ('neighborhood', 'city', 'region'));

-- A window points only at ITS OWNER'S policy (MATCH SIMPLE: no policy = the default audience).
-- RESTRICT: a policy in use cannot be deleted out from under a window and silently change who sees it.
ALTER TABLE public.availability_windows
  DROP CONSTRAINT IF EXISTS availability_windows_audience_policy_owner_fkey;
ALTER TABLE public.availability_windows
  ADD CONSTRAINT availability_windows_audience_policy_owner_fkey
  FOREIGN KEY (audience_policy_id, user_id)
  REFERENCES public.availability_audience_policies (id, owner_id)
  ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS availability_windows_audience_policy_idx
  ON public.availability_windows (audience_policy_id) WHERE audience_policy_id IS NOT NULL;

COMMENT ON COLUMN public.availability_windows.audience_policy_id IS
  'Telegraph §4.1 audiencePolicyId (3652). NULL = the default audience, mutual follows and crew only (proposed ruling P-T10). Composite FK to the owner''s own policy.';
COMMENT ON COLUMN public.availability_windows.proximity_visibility IS
  'Telegraph §4.1 proximityVisibility (3652): HIDDEN (default — no proximity rides with the signal), NEARBY (only that the owner is near), DISTANCE_BUCKET (the coarse bucket), ETA_IF_MUTUAL (the bucket, plus the travel band only where both people hold a live eta_coordination_grants row for each other).';
COMMENT ON COLUMN public.availability_windows.geography_scope IS
  'Telegraph §4.1 geographyScope (3652): the coarsest area the signal speaks for; proximity shown with it is never finer (city → at most same_city, region → at most same_region). NULL = no cap beyond proximity_visibility.';

-- ── NEARBY as its own permission (T22) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.nearby_consents (
  user_id    UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  opted_in   BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT nearby_consents_pkey PRIMARY KEY (user_id)
);

ALTER TABLE public.nearby_consents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nearby_consents FROM PUBLIC;
REVOKE ALL ON public.nearby_consents FROM anon;
REVOKE ALL ON public.nearby_consents FROM authenticated;

COMMENT ON TABLE public.nearby_consents IS
  'Telegraph §4 "AVAILABLE ≠ ONLINE ≠ NEARBY ≠ SHARING LOCATION" (census-telegraph T22, migration 3652): the NEARBY opt-in, separate from location sharing, availability and online status. No row = not opted in. Service role only; read and written only behind availability_signal_contract_enabled.';

-- ── Mutual ETA coordination (T27) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.eta_coordination_grants (
  grantor_id UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  grantee_id UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT eta_coordination_grants_pkey PRIMARY KEY (grantor_id, grantee_id),
  CONSTRAINT eta_coordination_grants_not_self CHECK (grantor_id <> grantee_id),
  CONSTRAINT eta_coordination_grants_bounded CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '12 hours')
);
CREATE INDEX IF NOT EXISTS eta_coordination_grants_grantee_idx
  ON public.eta_coordination_grants (grantee_id);

ALTER TABLE public.eta_coordination_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.eta_coordination_grants FROM PUBLIC;
REVOKE ALL ON public.eta_coordination_grants FROM anon;
REVOKE ALL ON public.eta_coordination_grants FROM authenticated;

COMMENT ON TABLE public.eta_coordination_grants IS
  'Telegraph §4.3 "Exact ETA/location requires stronger mutual coordination permissions" (census-telegraph T27, migration 3652). One person''s time-boxed (≤ 12 h) grant to another; an ETA-shaped value is shown only where both directions are live. Service role only; read and written only behind availability_signal_contract_enabled.';

-- ── The flag ─────────────────────────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'availability_signal_contract_enabled',
    false,
    'Telegraph §4.1/§4.3 AvailabilitySignal contract (census-telegraph T22/T23/T27, 3652). ON: GET /nearby/reachable shows only people who opted in to Nearby, applies each signal''s audience (default mutual follows and crew only), proximity rung, geography cap and the mutual ETA grant; the /me/nearby-consent, /me/availability-audience-policies, /me/availability-windows/:id/signal and /me/eta-grants routes answer. REQUIRES 3652 applied. OFF / absent (the seed): none of it is read or written, and the routes answer 404. Nearby itself stays behind nearby_reachable_enabled.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $post$
DECLARE
  t TEXT;
  rls BOOLEAN;
  client_privs INT;
  policies INT;
  flag_on BOOLEAN;
BEGIN
  FOREACH t IN ARRAY ARRAY['availability_audience_policies', 'nearby_consents', 'eta_coordination_grants'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3652): % was not created', t;
    END IF;
    SELECT relrowsecurity INTO rls FROM pg_class WHERE oid = ('public.' || t)::regclass;
    IF NOT rls THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3652): RLS is not enabled on %', t;
    END IF;
    SELECT count(*) INTO policies FROM pg_policies WHERE schemaname = 'public' AND tablename = t;
    IF policies <> 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3652): % carries % polic(ies); service role only means none', t, policies;
    END IF;
    SELECT count(*) INTO client_privs FROM information_schema.table_privileges
     WHERE table_schema = 'public' AND table_name = t AND grantee IN ('anon', 'authenticated');
    IF client_privs <> 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3652): anon/authenticated hold % privilege(s) on %', client_privs, t;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'availability_windows'
       AND column_name = 'proximity_visibility' AND column_default LIKE '%HIDDEN%' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3652): availability_windows.proximity_visibility must be NOT NULL DEFAULT ''HIDDEN''';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.availability_windows'::regclass
       AND conname = 'availability_windows_audience_policy_owner_fkey' AND contype = 'f'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3652): the composite owner FK on availability_windows is missing';
  END IF;

  SELECT enabled INTO flag_on FROM public.feature_flags WHERE flag = 'availability_signal_contract_enabled';
  IF flag_on IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3652): availability_signal_contract_enabled must be seeded FALSE (found %)', flag_on;
  END IF;
END $post$;

COMMIT;
