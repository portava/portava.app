# Travel Buddy — Passport composer (media + passport toggle + location/GPS)

Composer slice: media required, Passport toggle, location (current GPS via
expo-location + manual), sends location/GPS/passport fields to the API. Backend
(Phase 1+2) already proven. expo-location ~19 and expo-image-picker ~17 are
already installed (no new deps).

## STEP 1 — Storage bucket (Supabase SQL editor, project ajrurzioarfkagpuxfnb)
Run migrations/0005_storage_post_media.sql. Creates the public `post-media`
bucket + 4 RLS policies (authenticated users upload only to their own folder).
Verify:
    select id, public from storage.buckets where id='post-media';            -- public=true
    select count(*) from pg_policies where tablename='objects' and policyname like 'post-media%';  -- 4

## STEP 2 — Files -> exact paths (place individually; never drop folder over src/)
    travel-buddy/src/services/media.ts        -> artifacts/travel-buddy/src/services/media.ts       (NEW)
    travel-buddy/src/services/location.ts     -> artifacts/travel-buddy/src/services/location.ts    (NEW)
    travel-buddy/src/services/posts.ts        -> artifacts/travel-buddy/src/services/posts.ts       (REPLACE — sends passport/location/GPS fields)
    travel-buddy/src/lib/composerLogic.ts     -> artifacts/travel-buddy/src/lib/composerLogic.ts    (NEW)
    travel-buddy/src/lib/composerLogic.test.ts-> artifacts/travel-buddy/src/lib/composerLogic.test.ts (NEW)
    travel-buddy/app/create.tsx               -> artifacts/travel-buddy/app/create.tsx              (REPLACE — full composer)

## STEP 3 — verify
    cd artifacts/travel-buddy
    npx tsc --noEmit                                   # clean (or only pre-existing TripPage2 error)
    node --import tsx/esm --test src/lib/composerLogic.test.ts   # 10 tests pass

## What the composer does
- Media REQUIRED: Share is disabled until a photo is picked (expo-image-picker).
- Passport toggle "Add this post to my Passport": default ON once media exists.
- Location section:
    * "Use my current location" -> expo-location permission + GPS coords +
      reverse-geocode to city/country. Sends locationSource=gps with both tagged
      and userGps coords (current-location case).
    * Manual text -> locationSource=manual, label only, NO coordinates.
    * Permission denied / GPS fail -> does NOT block posting; user can go manual.
- Submit flow: upload media to post-media bucket -> get public URL -> POST
  /api/posts with content, visibility, mediaUrls, mediaType, addToPassport, and
  location fields. If media upload FAILS, the post is NOT created (no fake URL).
- location_verified is NEVER sent — the backend decides (proven by tests).

## Tests (10, pass locally)
media-required · cannot submit while submitting · passport default ON ·
gps payload (tagged+userGps) · manual payload (no coords) · empty manual->none ·
gps-without-coords->none · no-location->none · payload never has trusted
location_verified · forbidden-key detector.

## CAVEATS (verify on Replit)
1. tsc: could not run here. expo-image-picker v17 API used: launchImageLibraryAsync
   with mediaTypes:['images'] (string form, not the deprecated MediaTypeOptions).
   If tsc flags the asset shape, adjust PickedMedia mapping in create.tsx.
2. expo-location: requestForegroundPermissionsAsync / getCurrentPositionAsync /
   reverseGeocodeAsync. On web, GPS may be limited; manual fallback always works.
3. Web blob upload: media.ts does fetch(uri)->blob; works on web + native. On
   native, if blob upload has size issues, the documented alternative is
   FileSystem + base64, but blob is the spec's recommended path.
4. The post-media bucket MUST exist (Step 1) or uploads 400. Run the SQL first.

## Live test (the real proof)
Sign in -> + -> Post Update -> pick a photo (Share enables) -> optionally "Use my
current location" or type a manual place -> Share.
  - media uploads, POST /api/posts returns 201
  - check: select id, media_urls, location_source, location_verified,
           add_to_passport from posts order by created_at desc limit 3;
  - check: select id, post_id, stamp_eligible, stamp_reason, verification_method
           from passport_postcards order by created_at desc limit 3;
Expect: GPS-near -> stamp_eligible=true gps_within_radius; manual ->
stamp_eligible=false manual_location_only.

## Boundaries kept
Media required, no fake URLs, upload-fail aborts post. Server owns verification;
client never sends location_verified. Private GPS not shown publicly. Posting
never blocked by GPS unavailability.

## Next: Passport display (postcard cards + verified-stamp vs manual-tag UI + map/stats).
