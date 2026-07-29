---
name: Compass For You real data dropped by hydrator, not fabricated
description: "For You" cards looked fake (no image, no coords, bogus Directions) but the underlying events/discovery_places rows have real lat/lng/images — the hydrator SELECTs just omitted those columns.
---

`CompassItemHydrator.ts`'s `fetchEvents`/`fetchPlaces` SELECTs did not include `location_lat/location_lng/location_name/cover_url` (events) or `lat/lng/blurb/header_image_url` (discovery_places), even though those columns hold real data. The client (`ForYouTab.tsx` `compassItemToPlace`) then hardcoded `lat: null, lng: null` on top of that, discarding anything that leaked through.

**Why:** `PlaceDetailSheet`'s Directions/map buttons fell back to a name-only Google Maps query when lat/lng were null. For event titles like "Beach bonfire & music" that aren't geocodable addresses, this silently anchored on the *viewer's* current location and produced wildly wrong directions (700+ km off) instead of failing loudly.

**How to apply:** Before assuming Compass recommendation data is AI-fabricated/fake, check whether the source table (events, discovery_places) actually has real geo/image columns that a hydrator/mapper simply forgot to select — this was the actual root cause, not missing venue-resolution. When lat/lng are genuinely absent, hide Directions rather than falling back to a name-based map query (never silently substitute the viewer's own location as if it were the place's).

Separately, `CompassUiBlocks.ts` (the `/api/compass/ask` chat surface) also hardcodes `lat: null, lng: null` for place/event candidates — but there it's accurate: `toolSearchPlaces`/`toolSearchEvents` in `CompassTools.ts` never select lat/lng columns to begin with. Not yet fixed; would need the same column-plumbing treatment if chat-surfaced directions are ever wanted.
