-- 2145_rent_buddy_profiles_write_boundary.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without the
--   owner's explicit approval — this is a live authorization change on an
--   ENABLED production feature (rent_buddy_enabled = true).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG, PROVEN BY EXECUTION ──────────────────────────────────────
-- Measured against portava-ci by assuming the `authenticated` role with a JWT
-- whose sub is the row owner, then attempting the write (self-rolling-back):
--
--   UPDATE rent_buddy_profiles
--      SET verified=true, id_verified=true, status='active',
--          admin_status='active', verification_status='verified'
--    WHERE user_id = auth.uid();
--   => 1 row affected; all values landed.
--
-- Pre-state: anon AND authenticated hold DELETE, INSERT, REFERENCES, SELECT,
-- TRIGGER, TRUNCATE, UPDATE, and column-level UPDATE on ALL 81 columns. RLS
-- policy lgp-style restricts the ROW (owner) but not the COLUMNS, and Postgres
-- applies the USING predicate as the implicit WITH CHECK — so the hole is not
-- re-pointing, it is that the authority columns are grantable and not named by
-- the ownership predicate.
--
-- Why this is worse than the guide table (2144): Rent-a-Buddy is a LIVE feature,
-- and these are the exact columns the booking gates read. verification_status
-- and id_verified clear the arrival/nightlife high-risk gate; status='active' +
-- admin_status='active' self-approves a bookable buddy, bypassing the admin +
-- 10-item safety-training approval. Exploitable directly via PostgREST with the
-- public anon key — the route-handler gates never see it. (0 rows on prod today,
-- so a live capability, not a live incident.)
--
-- ── HOW THE EDITABLE SET WAS DERIVED (not intuition) ────────────────────────
-- Every write path to rent_buddy_profiles across all four route files was
-- traced. ALL server writes use the service-role client, which bypasses grants
-- and RLS — so this migration affects only DIRECT client PostgREST writes, of
-- which the codebase and the standalone client have ZERO. The grant below
-- mirrors the columns the user-facing edit routes (PATCH /me/profile, PATCH
-- /dashboard/offer, PATCH /dashboard/availability/settings, POST /apply, POST
-- /me/available-now) write on the buddy's behalf, restricted further per the
-- rule "anything affecting trust, verification, approval, moderation, identity,
-- booking eligibility, platform status, payouts, ranking, or internal state is
-- non-client-writable". So category/city/status/approval columns are excluded
-- even though a user-facing route sets them (via service role), because they
-- bear on eligibility.
--
-- CLASS A — client-editable profile content / pricing / scheduling preference
--   (granted below). Carry no authority and gate nothing.
-- CLASS B — trusted-backend/admin only (verification, approval, status, risk,
--   reputation, ranking, featured/ambassador, payment policy, counters). NOT granted.
-- CLASS C — system/immutable (id, user_id, created_at, updated_at, *_count,
--   profile_views, verified*, *_approved). NOT granted.
--
-- MANDATORY (proven-required) non-writable minimum, all excluded below:
--   verified, id_verified, status, admin_status, verification_status
--   (plus age_verified, phone_verified, *_approved, nightlife_admin_approved,
--    training_completed, buddy_level, trust_score_override, featured,
--    city_ambassador, risk_*, deposit_percent, category_approvals, date_of_birth).
--
-- ── WHAT THIS DOES NOT CHANGE ───────────────────────────────────────────────
-- No application code path. Every server write is service-role. The standalone
-- client calls POST /api/hidden-gems… / /api/rent-a-buddy/* and never references
-- the table. No column/table/enum/index change — generated types untouched.
--
-- SAFE TO RE-RUN.

BEGIN;

-- ── Preconditions ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.rent_buddy_profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.rent_buddy_profiles does not exist.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rent_buddy_profiles'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: RLS is not enabled on rent_buddy_profiles.';
  END IF;
  -- Every granted column must exist (guards against a rename drifting the grant).
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='rent_buddy_profiles'
         AND column_name IN (
           'display_name','tagline','bio','intro_video_url','cover_photo_url','gallery_urls',
           'vibe_tags','languages','energy_type','hourly_rate_usd','half_day_rate_usd',
           'full_day_rate_usd','nightlife_rate_usd','arrival_rate_usd','max_group_size',
           'preferred_meetup_zones','meetup_base_lat','meetup_base_lng','availability_blocks',
           'available_now','available_now_until','min_notice_hours','buffer_minutes','max_bookings_per_day')
     ) <> 24 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: the class-A column set does not match the live schema (a rename or drop drifted it).';
  END IF;
END $$;

-- ── 1. Narrow the verbs for BOTH client roles ───────────────────────────────
REVOKE ALL ON TABLE public.rent_buddy_profiles FROM anon;
REVOKE ALL ON TABLE public.rent_buddy_profiles FROM authenticated;

-- ── 2. Reads stay open (RLS policies decide which rows) ──────────────────────
GRANT SELECT ON TABLE public.rent_buddy_profiles TO anon;
GRANT SELECT ON TABLE public.rent_buddy_profiles TO authenticated;

-- ── 3. Column-level UPDATE: profile content / pricing / scheduling only ──────
GRANT UPDATE (
  display_name, tagline, bio, intro_video_url, cover_photo_url, gallery_urls,
  vibe_tags, languages, energy_type,
  hourly_rate_usd, half_day_rate_usd, full_day_rate_usd, nightlife_rate_usd, arrival_rate_usd,
  max_group_size, preferred_meetup_zones, meetup_base_lat, meetup_base_lng,
  availability_blocks, available_now, available_now_until,
  min_notice_hours, buffer_minutes, max_bookings_per_day
) ON TABLE public.rent_buddy_profiles TO authenticated;

-- No policy change. The owner policy rb_profiles_own is FOR ALL with
-- USING (auth.uid() = user_id) and no explicit WITH CHECK — but Postgres applies
-- USING as the implicit WITH CHECK, so a write cannot re-point the row to another
-- user regardless. The load-bearing fix is the column-grant restriction above;
-- an authority column is no longer client-updatable at all, so the fact that the
-- ownership predicate does not name it no longer matters. Leaving the FOR ALL
-- policy untouched avoids any interaction with its INSERT/DELETE behaviour.

COMMENT ON TABLE public.rent_buddy_profiles IS
  'Buddy profile. verification (verified, id_verified, phone_verified, age_verified, '
  'verification_status), status/admin_status, all *_approved + training_completed, '
  'buddy_level, featured, risk_*, reputation counters and ranking are DERIVED or '
  'ADJUDICATED server-side and are NOT client-writable (2145): anon+authenticated '
  'hold SELECT only, plus column-level UPDATE on profile-content/pricing/scheduling '
  'fields for authenticated. Server paths use the service-role client and are unaffected.';

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $$
DECLARE anon_privs text; auth_privs text; forbidden text;
BEGIN
  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '')
    INTO anon_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='rent_buddy_profiles' AND grantee='anon';
  IF anon_privs <> 'SELECT' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon holds "%", expected SELECT only', anon_privs;
  END IF;

  SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '')
    INTO auth_privs FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='rent_buddy_profiles' AND grantee='authenticated';
  IF auth_privs <> 'SELECT' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authenticated holds table-level "%", expected SELECT only', auth_privs;
  END IF;

  -- The proven-required authority columns must NOT be client-updatable.
  SELECT string_agg(column_name, ',' ORDER BY column_name) INTO forbidden
    FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='rent_buddy_profiles'
     AND grantee IN ('anon','authenticated') AND privilege_type='UPDATE'
     AND column_name IN ('verified','id_verified','phone_verified','age_verified',
                         'verification_status','status','admin_status','buddy_level',
                         'nightlife_admin_approved','group_approved','nightlife_approved',
                         'arrival_approved','training_completed','category_approvals',
                         'featured','city_ambassador','risk_hold','risk_review_status',
                         'trust_score_override','average_rating','review_count','date_of_birth',
                         'user_id','deposit_percent');
  IF forbidden IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: authority columns still client-updatable: %', forbidden;
  END IF;

  -- The class-A set must be exactly the 24 content columns.
  SELECT string_agg(column_name, ',' ORDER BY column_name) INTO auth_privs
    FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='rent_buddy_profiles'
     AND grantee='authenticated' AND privilege_type='UPDATE';
  IF (SELECT count(*) FROM information_schema.column_privileges
       WHERE table_schema='public' AND table_name='rent_buddy_profiles'
         AND grantee='authenticated' AND privilege_type='UPDATE') <> 24 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 24 client-updatable columns, got: %', auth_privs;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.column_privileges
     WHERE table_schema='public' AND table_name='rent_buddy_profiles'
       AND grantee='anon' AND privilege_type='UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: anon retains a column-level UPDATE grant.';
  END IF;
END $$;

COMMIT;
