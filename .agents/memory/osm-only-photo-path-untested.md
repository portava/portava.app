---
name: OSM-only Discovery places never exercise the live photo chain
description: DB-backed seeded destinations (Cebu, Manila, Bali, Bangkok, Singapore) have baked-in headerImageUrl values, so manual/QA checks that only use those cities never touch the live FSQ->Google photo fallback used by every other destination in the world.
---

## The gap

`discovery_places` seed rows (curated 0075 migration; 5 cities) ship with a
pre-set `headerImageUrl` (Unsplash URLs). `useFsqPhoto` in
`travel-buddy-standalone/src/hooks/useFsqPhoto.ts` returns immediately when
`existingUrl` is already set and never fires the live lookup chain
(`fsqPhotoLookup.ts` -> `/api/places/fsq-photo`, then
`googlePhotoLookup.ts` -> `/api/places/photo`) at all.

The server's `GET /api/discovery` route never attaches a photo URL for OSM
(non-DB) results — `headerImageUrl`/`photoUrl` are absent on every OSM place
in the response. Photo resolution for **every destination outside the five
curated cities** happens entirely client-side, per-card, 500ms after mount,
via that FSQ->Google chain.

**Why this matters:** any verification pass that only opens a DB-backed city
(Cebu is the default test city in most manual checks) will show correct
photos 100% of the time regardless of whether the live chain works, because
that path is never exercised. This makes "photos work" a false positive for
the majority of the app's actual destination coverage.

**How to apply:** when verifying place-card photo behavior, always pick a
destination with zero seeded DB rows (check `sourceSummary.seededDbCount` on
the `/api/discovery` response, or just use a city outside
Cebu/Manila/Bali/Bangkok/Singapore — e.g. Paris, the app's own default) in
addition to a DB-backed one. Check both `/api/places/fsq-photo` and
`/api/places/photo` responses directly (`reason` field) rather than trusting
only what renders, since a rate-limited or disabled upstream API degrades
silently to no-photo with no visible error.
