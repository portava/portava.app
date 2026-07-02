---
name: Place system taxonomy and ratings
description: Canonical category mapper, DB column, and user ratings for discovery_places
---

## Category taxonomy
`artifacts/api-server/src/lib/placeCategories.ts` is the single source of truth.
Maps 60+ raw category/place_type strings → 8 canonical values matching Discovery tabs.
`queryDbPlaces` in discovery.ts prefers `primary_category` from DB; falls back to `toCanonicalCategory()` for pre-migration rows.

## Migrations needed before production use
- **0083**: adds `primary_category` column + backfill + indexes
- **0084**: adds `'place'` to `review_entity_type` enum + DELETE RLS policy

**Why:** Without these migrations, category filter silently falls back to regex (slow), and place rating POSTs fail with a DB enum error.

## Place ratings eligibility
Any authenticated user may rate an active `discovery_places` row.
The `checkEligibility('place', ...)` check: queries `discovery_places` for `id + status='active'`.
Route: `GET /api/places/:id/reviews` mirrors `GET /api/trips/:id/reviews` shape.

## Frontend wiring
- `ReviewEntityType` in `src/services/reviews.ts` includes `'place'`
- `ReviewsSection` has a `place` branch calling `getPlaceReviews()`
- `gems/[id].tsx` renders `<ReviewsSection entityType="place" entityId={gem.id} canReview={isAuthed} />`
- Review composer (`review/[entityType]/[entityId].tsx`) handles `place` in validType and entityLabel

## GPS accuracy
`getCurrentGps()` in `src/services/location.ts`:
1. Tries `getCurrentPositionAsync({accuracy: Balanced})`
2. If that fails, falls back to `getLastKnownPositionAsync({maxAge: 5min, requiredAccuracy: 500m})`
3. Returns `cached: true` on fallback
`useActiveLocation.ts` converts `cached` flag → `source: 'gps_cached'` / `'gps_fresh'`, and sets `freshness: 'recent'` for cached fixes.

## Test pattern note
Fake client's `then` handler: when `_insert !== null` AND `_singleMode`, return `inserted[0] ?? null` not the array.
The existing `reviews.test.ts` fake client had this bug too but wasn't caught because those tests don't assert on the returned insert body.
