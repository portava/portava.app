# Map card fields the projection does not carry

**Status:** open findings, 2026-09-03. Nothing here is a regression introduced by
that day's change — every item was already dead on the gateway path, and several
were dead on both paths.

## Why this file exists

The map's card renderers (`src/components/map/MapCarousel.tsx`,
`MapEntityPreviewCard.tsx`, `MapEntityActionRow.tsx`) used to read raw service
DTO fields off `MapEntity.payload`. Their producers stopped emitting that shape
when the Map Intelligence Gateway landed: `payload` is now a `MapObject`
(spec §18), whose own `payload` is the small, deliberate subset the projector
chose to expose.

The cards now read the projected shape. That is correct per spec §19 — *"Never
place raw database rows directly on the map"* — but it means some things the
cards used to display have nowhere to come from. Restoring any of them is a
**projector** change, not a renderer change; reaching around the projection to
fetch the row again would rebuild exactly the coupling the layer exists to
remove.

Each item below names the field, where it would have to be added, and what it
would cost.

---

## Hidden gems

`projectGem` (server, `artifacts/api-server/src/lib/mapProjection.ts`) and its
client mirror `projectGemLocal` emit:

```
category, city, thumbnailUrl, verificationLevel, coordsPrecision
```

| Dropped from the card | Was shown as | To restore |
| --- | --- | --- |
| `vibeTags` | up to 3 `#tag` chips | add to both `projectGem` payloads |
| `saveCount` | a save-count chip | add to both `projectGem` payloads |
| `description` | full-detent body text | add to both `projectGem` payloads |
| `bestTimeToGo` | full-detent "Best time" row | add to both `projectGem` payloads |
| `priceRange` | full-detent "Price range" row | add to both `projectGem` payloads |
| `neighborhood` | full-detent location row | `subtitle` already carries `category · city` |
| `layoverSafe` | "Layover safe" chip (preview card) | add to both `projectGem` payloads |

**Separate server defect — user-visible today.** `projectGem` reads
`g.thumbnail_url`, but the row it is given comes from `findNearbyGems`, which
selects `image_url`; `hidden_gems` has no `thumbnail_url` column at all. So
`thumbnailUrl` is **always null on the gateway path** and gem cards there have no
image. The client mirror uses `gem.imageUrl` and does show one, so the two paths
disagree on pixels while agreeing on shape. The fix is one expression in
`projectGem` (`g.thumbnail_url ?? g.image_url ?? null`), but it lives in the
api-server package, whose tests do not run under
`travel-buddy-standalone`'s `check:all` — so it is reported here rather than
changed blind.

---

## Events

`projectEvent` and its client mirror `projectEventLocal` emit:

```
locationName, startsAt, coverUrl, visibility, hasStarted
```

| Dropped from the card | Was shown as | To restore |
| --- | --- | --- |
| `hostName` | "by <host>" secondary line | add to both `projectEvent` payloads |
| `goingCount` | "<n> going" chip, and the §35 `plan_joined` participant bucket | add to both `projectEvent` payloads |
| `priceType` | "Free" chip | add to both `projectEvent` payloads |
| `myRsvp` / `myWaitlistPosition` | seeded the Join button's "Going" / "Waitlisted" state, and the preview card's waitlist-position chip | viewer-relative, so it must come from the server projector, which already has the viewer |
| `endsAt` | "Ends in <n>m" chip | **available**: the object's `expiresAt` is `ends_at`, and the card uses it |
| `description`, `address` | full-detent body | add to both `projectEvent` payloads |

`myRsvp` is the one worth doing first: without it the Join button silently forgets
a confirmed RSVP as soon as the card is re-mounted.

---

## Trips

`projectTrip` (client only — trips have no gateway projector yet) emits:

```
tripId, destinationCity, destinationCountry, startDate, endDate, coverUrl, visibility
```

| Dropped from the card | Was shown as | Note |
| --- | --- | --- |
| `memberAvatarUrls` | a 3-avatar stack on the carousel card | **`TripRow` has never had this field.** The read was `(trip as any).memberAvatarUrls`, so the stack has never rendered. Restoring it needs the field added to `GET /api/trips/me` first. |
| `description` | full-detent body text | **`TripRow` has never had this field either** — it has `tripNotes`. Whether a user's own trip notes belong on a map card is a product call, so nothing was substituted. |

---

## Buddies and circle members

Nothing is missing. `projectBuddy` and `projectFriend` are client-side and were
extended in the same change to carry every field their cards render.

Three reads there were already broken and are now fixed:

- `projectBuddy` read `buddy.headline`; `BuddyProfile` has `tagline`. Every buddy
  pin's subtitle had collapsed to just the city.
- `projectTrip` read `trip.destination`; `TripRow` has `destinationCity`. Every
  trip pin's subtitle was only the date range.
- `projectFriend` read `loc.displayName ?? loc.handle`; `CircleMemberLocation`
  has neither. **Every circle member's card was titled "Friend".**

---

## The reason this class of bug keeps recurring

`travel-buddy-standalone/tsconfig.json` excludes `**/*.test.ts` and
`**/*.test.tsx` from the typecheck. Test fixtures therefore get no compiler help
at all, which is how `headline`, `destination` and `handle` were written into
`clientProjection.test.ts` fixtures and asserted as correct behaviour.

The mitigation used here is to put fixtures in `src/__fixtures__/mapEntities.ts`
— a normal, typechecked module — and build them as
`typed service DTO → real projector → real mapObjectToEntity`. A fixture field
the DTO does not have is now a compile error, and a card test cannot construct a
payload shape the app never produces.

Removing the tsconfig exclusion would be the general fix. It is a repo-wide
change and was not attempted here.
