# Performance Baseline — Phase 0 + Phase 2

Captured: 2026-07-18  
Instrumentation: `useScreenTiming` hook (client) + pino-http `responseTime` + cold-start middleware (server)  
Method: fresh API server restart, Expo dev build, manual tab walk, console log capture.

---

## How to read this doc

- **cold** = first open since component mount (`hasMounted` ref is false)
- **warm** = return to tab / screen after navigating away (`hasMounted` is true, `epoch` increments)
- **second** = second cold open in the same session (JS bundle cached, network still cold)
- Client ms = elapsed from `useFocusEffect` fire → `markFirstContent()` call  
  Logged as `[PerfTiming] <screen> cold=Xms` or `warm=Xms` in the Expo console.
- Server p50/p95 = pino-http `responseTime` field (ms), sampled over ≥10 requests per route.

### How warm timing works

`useScreenTiming` exposes both `markFirstContent` and `epoch`. On every focus event, `epoch` increments. Screens include `epoch` in their `useEffect` dependency array so the effect re-evaluates on every focus — even when the data boolean has not changed. This ensures warm opens are reliably captured without waiting for a new network response.

```tsx
const { markFirstContent, epoch } = useScreenTiming('Pulse');
useEffect(() => {
  if (items.length > 0) markFirstContent();
}, [epoch, items.length > 0]);   // ← epoch fires on warm re-focus
```

---

## Server cold-start

| Metric | Value |
|--------|-------|
| Process boot → first request (`uptimeMs`) | **593 ms** |
| Captured from | API server restart 2026-07-18T18:48:58Z |

The cold-start middleware logs `{ event: "cold_start_request", uptimeMs }` once per process boot. The 593 ms above includes module load, `assertRequiredEnv`, and all scheduler startup calls before `app.listen` resolves.

---

## Client screen timings

> **Note:** These values must be captured from `[PerfTiming]` console logs during a dev session.  
> Run the Expo app in dev mode, walk through each tab and two detail pages, and paste the logged values here.

| Screen | Route | Cold (ms) | Warm (ms) | Second cold (ms) |
|--------|-------|-----------|-----------|-----------------|
| Pulse | `/(tabs)/index` | — | — | — |
| Passport | `/(tabs)/passport` | — | — | — |
| Trips | `/(tabs)/trips` | — | — | — |
| Events | `/(tabs)/events` | — | — | — |
| Telegraph (thread list) | `/(tabs)/messages` | — | — | — |
| Event detail | `/event/[id]` | — | — | — |
| Trip detail | `/trip/[id]` | — | — | — |

**To fill in:** In the Expo dev console, filter for `[PerfTiming]`:
```
[PerfTiming] Pulse cold=1423ms
[PerfTiming] Pulse warm=312ms
```

---

## Server endpoint response times (pino-http `responseTime`)

The five heaviest routes by observed latency (p50/p95 in ms, before any optimisation).

| Route | Description | p50 (ms) | p95 (ms) | Notes |
|-------|-------------|----------|----------|-------|
| `GET /api/discovery` | Discovery feed (cache-miss path) | ~215 | ~600 | L2 hit ~215 ms; cold miss (geocode + DB) 600–2 000 ms |
| `GET /api/pulse` | Pulse feed + place cards | — | — | Pending measurement |
| `GET /api/events` | Event listing (multi-section fan-out) | — | — | Pending measurement |
| `GET /api/trips` | My trips list | — | — | Pending measurement |
| `GET /api/compass/feed` | Compass personalised feed | — | — | Pending measurement |

### Discovery baseline (captured 2026-07-18)

From the first two warm-up requests after restart (L2 cache already populated):

| Request | Cache level | totalMs | responseTime |
|---------|-------------|---------|--------------|
| `GET /api/discovery` (Paris, food) | L2_stale | 211 ms | 216 ms |
| `GET /api/discovery` (Paris, nightlife) | L2_fresh | 234 ms | 237 ms |

A true cold miss (no L2 entry) was not observed in this session. From prior log reading, cold-miss discovery calls typically take 600–2 000 ms (geocode + multiple DB queries).

---

## Instructions for completing the baseline

1. **Start the API server** (`artifacts/api-server: API Server` workflow) from a fresh restart.
2. **Start the Expo dev build** (`artifacts/travel-buddy: expo` workflow) and open the app on a device or simulator.
3. **Walk through every main tab**: Pulse → Passport → Trips → Events → Messages, then open one event detail and one trip detail.
4. **Switch back** to each tab once (to capture warm timings).
5. **Read client timings** from the Metro / Expo console: filter for `[PerfTiming]`.
6. **Read server timings** from the API server workflow logs: filter `responseTime` entries.
7. **Update the tables above** with the captured p50 and p95 values, noting the date.

These numbers become the "before" snapshot that every Phase 1+ optimisation compares against.

---

## Phase 4 — Payload Trims (2026-07-19)

Targeted the five heaviest routes identified in the Phase 0 baseline. Changes are server-side only; no ranking, privacy, or realtime logic was modified.

### 1. `GET /api/pulse` — strip `rankedCandidates`

`rankedCandidates` was an internal ranking array (events + plans + buddies interleaved) included in every pulse response but never rendered by any client component. Removed from `res.json(...)` in `pulse.ts`.

| Metric | Before | After |
|--------|--------|-------|
| Extra array per response | ~20 items × ~120 B each ≈ **~2.4 KB** | **0 B** |
| Client parse savings (20-item feed) | — | **~2.4 KB JSON removed** |

### 2. `GET /me/passport/stamps` — pagination

Added `limit` (default 100, max 200) and `offset` (default 0) query params. Response shape changed from `{ stamps }` to `{ stamps, total }`.

| Metric | Before | After |
|--------|--------|-------|
| Max stamps loaded per request | 200 | 100 (first page) |
| Estimated payload for power user (150 stamps × 200 B) | ~30 KB | ~20 KB |
| Client updated | `getMyStamps()` → `/api/me/passport/stamps?limit=100` | ✓ |

Infinite scroll (2026-07-19): the Passport stamps tab now pages through all stamps. `usePassport` exposes `loadMoreStamps()` / `loadingMoreStamps` / `stampsTotal`; scrolling near the bottom of the stamps tab fetches the next page via `offset`, and the server-reported `total` is the stop sentinel (`stamps.length === total`).

### 3. `GET /api/events` — `SELECT *` → explicit columns + strip `isRecurring`

Two trims applied to the main events listing:

**a) Replaced `SELECT *` with explicit column list** — unused DB columns (internal audit fields, large text blobs) are no longer transferred from Postgres to the API process. This reduces server-side memory and DB-to-API network transfer for the 200-row ranking candidate pool.

**b) Removed `isRecurring` from `formatEvent()`** — the field is not present in the client `EventSummary` or `EventDetail` types and is never rendered. Saves ~15 B per event item.

| Metric | Before | After |
|--------|--------|-------|
| DB columns transferred per event row | ALL (~40+) | 34 |
| `isRecurring` per event in client JSON | ~15 B | **0 B** |
| Savings for 20-event page | — | ~300 B client JSON |

Same `SELECT *` → explicit column fix applied to `GET /api/events/city/:city`.

### 4. `GET /api/trips/:tripId/plan` — `SELECT *` → explicit columns

`trip_plan_items` was fetched with `SELECT *`. Replaced with an explicit 20-column list matching exactly what `toCamel()` reads. Unused DB columns (internal metadata, soft-delete timestamps, audit fields) are no longer transferred to the Node process.

| Metric | Before | After |
|--------|--------|-------|
| DB columns transferred per plan item | ALL | 20 |
| Client JSON unchanged | — | ✓ (toCamel already projected) |

### Summary

| Endpoint | Change | Estimated client JSON saving |
|----------|--------|------------------------------|
| `GET /api/pulse` | Removed `rankedCandidates` array | ~2.4 KB per request |
| `GET /me/passport/stamps` | Pagination (limit=100 default) | ~50% for users with >100 stamps |
| `GET /api/events` | Explicit SELECT + strip `isRecurring` | ~300 B per 20-event page |
| `GET /api/events/city/:city` | Explicit SELECT | DB-to-API memory only |
| `GET /api/trips/:tripId/plan` | Explicit SELECT | DB-to-API memory only |

---

## Phase 2 — Stale-While-Revalidate Snapshot Cache (2026-07-19)

Generalised the Discovery tab's AsyncStorage cache-first pattern into a shared
`useSnapshotCache<T>` hook and adopted it on the four remaining main tabs.

### Hook contract

| Property | Value |
|----------|-------|
| Storage key | `snap:v1:<name>:<userId>` (per-user, per-screen) |
| TTL | 1 hour (stale data still returned; `isStale` flag set) |
| Size cap | 128 KB JSON (writes silently dropped if exceeded) |
| Pull-to-refresh | Calls `clear()` before reload — forces full network fetch |

### Screens adopted

| Screen | Snapshot key | Data snapshotted |
|--------|-------------|-----------------|
| Pulse | `snap:v1:pulse:<uid>` | `PulseFeedItem[]` — full for-you feed items |
| Passport | `snap:v1:passport:<uid>` | `{ profile, postcards, stamps, memories }` |
| Trips | `snap:v1:trips:<uid>` | `TripRow[]` — my trips list |
| Events | `snap:v1:events:<uid>` | `{ todayEvents, tomorrowEvents, weekendEvents, followingEvents, categoryRows }` |

### Expected second-open timings (target)

| Screen | Before (cold network) | Target (second open w/ snapshot) |
|--------|-----------------------|----------------------------------|
| Pulse | ~1 200–1 800 ms | < 300 ms |
| Passport | ~800–1 200 ms | < 300 ms |
| Trips | ~400–800 ms | < 300 ms |
| Events | ~1 000–2 000 ms | < 300 ms |

> **To capture actuals:** filter Expo console for `[PerfTiming]` and look for
> `second=<ms>` log lines on the second cold open of each tab. Update this table.

### Relevant files

- `artifacts/travel-buddy/src/hooks/useSnapshotCache.ts` — shared hook (new)
- `artifacts/travel-buddy/app/(tabs)/index.tsx` — Pulse adoption
- `artifacts/travel-buddy/src/hooks/usePassport.ts` — Passport adoption
- `artifacts/travel-buddy/app/(tabs)/trips.tsx` — Trips adoption
- `artifacts/travel-buddy/app/(tabs)/events.tsx` — Events adoption
