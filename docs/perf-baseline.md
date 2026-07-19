# Performance Baseline — Image Loading

## Phase 3: expo-image Disk Cache (list images)

### What was done
Replaced React Native's built-in `<Image>` (no disk cache) with `expo-image`
(`cachePolicy="disk"`, 200 ms fade-in transition) in list/feed contexts via the
`<CachedImage>` wrapper component (`src/components/CachedImage.tsx`).

**Adopted in:**
| Component | URL type | Transform params applied |
|---|---|---|
| `PulseFeedCard` — post media (PostCard) | Supabase storage | `?width=400&quality=80` |
| `PulseFeedCard` — author avatar (AuthorRow) | Supabase storage | `?width=100&quality=80` |
| `PulseFeedCard` — circle participant avatars (CircleCard) | Supabase storage | `?width=100&quality=80` |
| `EventDiscoveryCard` — event cover | Supabase storage | `?width=600&quality=80` |
| `PostcardsTab` — postcard grid thumbnail (PostcardTile) | Supabase storage | `?width=400&quality=80` |
| `ui.tsx` — `Avatar` component (used in event host row) | Supabase storage | `?width=100&quality=80` |

**Static local assets (`require(...)`) continue using RN `Image` directly.**
Non-list contexts (full-screen photo viewer, map overlays, static icons)
are also out of scope.

### Known gaps — no thumbnail variant available (Phase 4 scope)

The following image surfaces use `CachedImage` for the disk-cache benefit but
could not have Supabase transform params applied because the URL originates
from a source that does not support width/quality query params:

| Component | URL origin | Gap |
|---|---|---|
| `PulseFeedCard` — post media fallback (`item.mediaUrl`) | Legacy `media_urls` column — plain string, no structured media | No `thumbnail_url` in legacy path; transform params not added |
| `EventDiscoveryCard` — `event.coverUrl` from external providers (Foursquare, Google) | Third-party CDN URLs — transform params break them | Params only appended to Supabase storage URLs via `withStorageParams()` guard |

These gaps are tracked for Phase 4 API work (trim heaviest API payloads /
add resize transforms to endpoints that don't yet provide thumbnails).

### Measurement

`[PerfTiming]` warm-open log lines (Events tab, Pulse feed, Passport) should
show images rendering from disk cache on second open rather than re-downloading
from the network. Baseline cold-miss timings are logged per-screen via
`useScreenTiming`.
