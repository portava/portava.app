# Travel Buddy — Passport backend (Phase 1 + 2)

Backend foundation for Passport postcards + server-owned GPS verification.
Build sequence: backend (this) proven first, THEN UI.

## Files -> exact paths (place individually; never drop a folder over src/)
    migrations/0004_passport.sql              -> migrations/0004_passport.sql                    (RUN in Supabase SQL editor)
    api-server/src/lib/locationVerify.ts      -> artifacts/api-server/src/lib/locationVerify.ts   (NEW)
    api-server/src/lib/postSchemas.ts         -> artifacts/api-server/src/lib/postSchemas.ts      (REPLACE — adds location/GPS/passport fields)
    api-server/src/routes/posts.ts            -> artifacts/api-server/src/routes/posts.ts         (REPLACE — verification + postcard auto-create)
    api-server/src/test/locationVerify.test.ts-> artifacts/api-server/src/test/locationVerify.test.ts (NEW — 13 tests)

## 1. Run the migration (Supabase SQL editor, correct project ajrurzioarfkagpuxfnb)
Paste 0004_passport.sql, Run. Idempotent. Adds:
- posts columns: media_type, location_name/place_id/city/country/lat/lng,
  user_gps_lat/lng (PRIVATE), location_source, location_verified,
  location_verified_at, location_distance_meters, add_to_passport
- passport_postcards table (unique post_id), can_see_postcard(), RLS (4 policies)
Verify:
    select count(*) from information_schema.columns where table_name='posts' and column_name='location_verified';  -- 1
    select count(*) from pg_policies where tablename='passport_postcards';  -- 4

## 2. Build + test the API server
    cd artifacts/api-server
    pnpm run build
    node --import tsx/esm --test src/test/locationVerify.test.ts   # 13 tests, all pass
    pnpm run typecheck

## What this does
POST /api/posts now accepts (optional): mediaType, addToPassport, locationName,
locationPlaceId, locationCity, locationCountry, locationLat, locationLng,
userGpsLat, userGpsLng, locationSource ('gps'|'manual'|'none').

SERVER decides verification (verifyLocation, haversine, 1609m default):
  - locationSource 'gps' + tagged coords + userGPS + distance<=threshold
        -> location_verified=true, stamp_eligible=true, reason gps_within_radius
  - manual                -> stamp_eligible=false, manual_location_only
  - gps but too far       -> stamp_eligible=false, gps_location_mismatch
  - gps but no GPS coords -> stamp_eligible=false, gps_permission_denied
  - tagged w/o coords     -> tagged_location_missing_coordinates
  - none                  -> verification_unavailable

Postcard auto-create: when media present + add_to_passport + status active, one
passport_postcards row is created (unique post_id prevents duplicates). Postcard
failure is logged but does NOT fail the post (rollback-safe).

## Phase 1 acceptance — all enforced
1. media post creates exactly one postcard (unique post_id)         ✓
2. no media -> no postcard (shouldCreatePostcard false)             ✓
3. backend calculates GPS distance (haversine)                     ✓
4. GPS match -> stamp_eligible=true                                ✓
5. manual -> stamp_eligible=false                                  ✓
6. GPS mismatch -> stamp_eligible=false                            ✓
7. client cannot fake location_verified (not in schema; server-set) ✓
8. duplicate postcard blocked (unique post_id)                     ✓
9. private/trip_only postcards don't leak (RLS can_see_postcard)   ✓
10. public response excludes exact GPS (POST_COLUMNS has no GPS;
    postcard select has no GPS; user_gps_* never projected)        ✓

## Tests (13, all pass — run by author against real logic)
haversine (same/near/far) · GPS within radius -> stamp · manual -> none ·
mismatch -> none · permission denied -> none · missing coords -> none ·
no location -> none · threshold edge (<=) · default 1609m · client-fake ignored ·
postcard eligibility (media+toggle+active).

## CAVEAT
Could not run tsc here (no network for type packages). Run pnpm run typecheck on
Replit. The node:test suite runs via tsx (already present) — no vitest needed.

## Boundaries kept
Server owns verification. Client flags never trusted. Private GPS never exposed.
No stamp for manual/mismatch. Postcard failure never corrupts the post. RLS on.

## Next (after this passes): UI — composer Passport toggle + location/GPS picker,
Passport postcard cards, verified-stamp overlay vs manual-tag label, mobile view.
