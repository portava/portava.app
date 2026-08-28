# Owner ruling — bulk place-photo pre-population (2026-08-28)

## Context

`artifacts/api-server/src/lib/discoveryPlacePhotoStore.ts` deliberately resolves a
place photo **lazily, per real viewer**, and lists bulk work as explicit non-goals:

> *"Explicit non-goals, each of which needs a NEW owner ruling before anyone
> starts: crawling photos, bulk enrichment, multiple candidates per place,
> quality scoring, cross-provider deduplication, pre-populating cities. This
> module writes ONE row for ONE place at the moment that place's photo was
> resolved for a real viewer, and does nothing on its own initiative."*

On prod, no place has a server-resolved image (0/2913 Da Nang canonical places),
`external_place_references` carries no image columns, and `discovery_place_photos`
was staged-but-unapplied — so discovery cards fall back to generic category art.

## The ruling

The owner authorised, on 2026-08-28, a **bounded, operator-run bulk
pre-population** of `discovery_place_photos` for pilot cities, lifting the
"pre-populating cities" non-goal for this specific, constrained use.

## Constraints (enforced in `scripts/backfillPlacePhotos.ts`)

1. **Operator-run only.** Never wired into a scheduler or the app. Requires an
   explicit `--confirm-bulk-prepopulation` flag; refuses to run otherwise.
2. **City-scoped.** Requires `--city "<name>"`; never global.
3. **Non-destructive.** Never overwrites an existing fresh store row, so a place
   already warmed FSQ-first by live traffic keeps its Foursquare photo. The
   backfill only fills the cold long tail.
4. **Same store, same invariants.** Writes through `writeStoredPlacePhoto`, so
   Google rows persist the photo RESOURCE NAME (never a key-bearing URL) and
   inherit the 30-day TTL. Nothing about the store's refresh/invalidation
   contract changes.
5. **Google-only (v1).** The live client still resolves Foursquare-first when a
   store row expires. Adding an FSQ leg to the backfill (reusing the live
   resolver's in-flight dedup + dead-CDN HEAD checks) is a documented follow-up,
   not part of this ruling.
6. **Idempotent + rate-limited.** Re-running skips warmed places; a per-place
   delay bounds Google API load.

## Not covered by this ruling

Crawling, multiple candidates per place, quality scoring, cross-provider dedup,
and building a place corpus as a side effect remain non-goals and would each need
their own ruling. This authorises warming the resolved-photo cache for a pilot
city — nothing more.
