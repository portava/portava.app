---
name: Compass item hydration
description: Why CompassItemHydrator must set top-level title/category so UI cards show real entity names, and the shared formatting utility pattern for subtitles/status.
---

# Compass item hydration

## The rule

When the API builds a `CompassItem` for feed/recommendation surfaces, the
hydrator must set **top-level** `title` and `category` fields directly on the
item object, not only embed them inside `item.data`.

The frontend response contract (and several card components) reads from these
top-level fields. When they are missing, components fall back to generic labels
such as `item.type ?? 'Compass Pick'`, which produces cards that only show
"Compass Pick" / "Upcoming Event" instead of the real event name, category, or
place name.

## Why this matters

- `CompassFeedItem` and `CompassRecommendation` both expose `title` and `category`
  at the top level.
- `item.data` is intended to carry raw DB identifiers and extra metadata for
  navigation (e.g., `id`, `name`, `city`, `startsAt`).
- The generic fallback is deliberately conservative, so missing hydration is
  visible as a bug rather than a blank card.

## How to apply

In `artifacts/api-server/src/compass/CompassItemHydrator.ts`, set `title` and
`category` for every branch:

- `event`: from `event.name`, `event.category`.
- `place`: from `place.name`, `place.category`.
- `hidden_gem`: from `gem.name`, `gem.category`.
- `post`: from a trimmed preview of `post.content`, category `"post"`.
- `buddy` / `traveler`: already resolved from profile data; keep as-is.

When the response shape changes, update both the hydrator and the shared
formatting utility `src/utils/compassFormat.ts` (and its standalone fork copy)
so that subtitle/date/status formatting stays in sync.

## Shared formatting utility

A single utility file `src/utils/compassFormat.ts` resolves titles and builds
compact subtitles:

- `resolveCompassTitle(item)` — reads `item.title`, `item.data.title`,
  `item.data.name`, `item.data.displayName`, then a type label, then the
  "Compass Pick" fallback.
- `formatCompassSubtitle(item)` — for events: date range + status + city +
  category; for other types: category + city.
- `formatCompassEventStatus(startsAt, endsAt)` — upcoming / starting soon /
  ongoing / ends soon / ended.

The utility type is intentionally permissive (`data?: unknown`) so the same
helpers work for `CompassFeedItem`, `CompassRecommendation`, and
`CompassBuddyResult` without forcing each concrete type to declare an index
signature.

## Standalone fork parity

`travel-buddy-standalone` is a divergent copy. Edits to `src/utils/` and the
Compass card components must be ported manually and its typecheck/tests run
separately (`cd travel-buddy-standalone && pnpm run typecheck && pnpm test`).
