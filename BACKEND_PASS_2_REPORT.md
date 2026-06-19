# BACKEND_PASS_2_REPORT.md — Trips wired + Live Map foundation (data/privacy only)

This pass: Trips fully wired to the backend, plus the Live Map DATA + PRIVACY foundation.
NO live user locations render in the UI yet — only safe placeholders. Privacy is enforced
by RLS in the DB; defaults are private/off.

## Trips — fully wired (with mock fallback when not signed in)
- app/(tabs)/trips.tsx → useMyTrips() (GET /trips via RLS). Loading / empty / error states.
  Live when configured + authed; mock list otherwise.
- app/trip/new.tsx → createTrip() (POST /trips). Real fields (title, city, country, dates),
  loading/error, redirects to the REAL /trip/[id] on success. Mock fallback if not authed.
- app/trip/[id].tsx → useTrip(id) (GET /trips/:id). Merges the real trip row into the hero
  (title, city, dates, status, visibility); keeps mock sub-sections until their tables land.
- Ownership-safe: trips RLS already restricts to owner/member/public (migration 0001).

## Live Map foundation — DATA + PRIVACY ONLY (migration 0002_map_privacy.sql)
Tables (4): circle_memberships, user_location_privacy, user_locations, map_pins.
Enums: location_sharing (private/circle/public), circle_status.
Privacy functions: in_accepted_circle(), can_see_location() — the core gate.
RLS (14 policies, 4 tables): enforced in DB, frontend hiding NOT trusted.

### Privacy rules implemented (DB-enforced)
- Location sharing DEFAULT = private/off. New users get a private user_location_privacy row
  (created by ensureProfile on signup/sign-in).
- can_see_location(viewer, target) returns true ONLY if: viewer==target, OR
  (ghost_mode=false AND ping not stale AND (public OR (circle AND mutually accepted circle))).
- Ghost Mode hides always. Stale pings (> stale_minutes) hidden. Private trips/pins never
  visible to unauthorized users (pins RLS checks can_see_trip for trip-linked pins).
- user_locations SELECT policy = can_see_location(); write only your own row.

## Services (scaffolded; UI does NOT render live locations yet)
- src/services/map.ts: listMapPins, createMapPin (private by default),
  getMyLocationPrivacy, updateMyLocationPrivacy (PATCH /me/location-privacy),
  listVisibleCircleLocations (returns only RLS-permitted rows; not rendered this pass).

## UI placeholders (no live locations)
- app/live-map.tsx — Live Map route, placeholder: "Map coming soon — location sharing is
  private by default", explains what it'll show + Ghost Mode + privacy guarantees.
- Discovery map card → links to /live-map ("private by default").
- Trip detail → TripMapPlaceholder ("Map coming soon", privacy note) replaces the old preview.

## Verification (run after applying + migration 0002)
- Trips list loads real trips (empty state if none).
- Create trip persists → redirects to real /trip/[id] → appears in list on return.
- /trip/[id] loads the real trip (hero shows your title/city/dates).
- Another user cannot see your private trip (RLS: trips_select).
- Map schema exists (4 tables). Location privacy defaults to private. Ghost mode field exists.
- NO UI renders live user locations (placeholders only). ✓ by design this pass.

## SETUP (manual, on your Mac / Supabase)
1. Supabase SQL editor → paste migrations/0002_map_privacy.sql → Run (AFTER 0001).
2. Apply the frontend patch, restart: npx expo start --clear
3. Sign in → Trips tab is now live. Create a trip → opens the real trip page.

## Static checks (this env)
- Escaped-backtick scan: CLEAN
- Whole-project missing-import audit: 0
- Changed TS/TSX balanced (template-literal false positives noted)
- SQL 0002: paren-balanced, 4 tables, 14 policies, 4 RLS-enabled, 5 privacy fn refs
- supabase access stays in services/hooks; screens read via hooks

## Files
NEW:  migrations/0002_map_privacy.sql, app/live-map.tsx, src/services/map.ts, BACKEND_PASS_2_REPORT.md
EDIT: app/(tabs)/trips.tsx (useMyTrips), app/trip/new.tsx (createTrip),
      app/trip/[id].tsx (useTrip + map placeholder), app/(tabs)/discovery.tsx (map card),
      src/services/auth.ts (ensureProfile also creates private location-privacy row)

## Next pass (Live Map UI — its own focused pass)
Turn on the map rendering against this proven schema, verification by verification:
pins on map → trip-linked pins → circle locations (opt-in only) → ghost/stale hiding tests
→ cross-user privacy tests. A real map lib (react-native-maps / web fallback) goes in then.

## Summary
Trips are now real: create one, it persists in Postgres, opens the real trip page, and only
you can see it. The Live Map's entire privacy-critical foundation — tables, RLS, ghost mode,
stale-ping hiding, circle gating, private-by-default — is in place and DB-enforced, with the
UI deliberately held at safe placeholders so no location can leak before the map UI is built
and tested. That's the responsible split.
