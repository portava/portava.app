---
name: Trip detail fixture pollution pattern
description: How to build TripDetail from TripRow safely, and the toggleSave return type contract
---

## TripDetail construction from TripRow

When mapping a real TripRow to TripDetail, build from real fields only — never spread mockTripDetail as a base:

```typescript
const trip: TripDetail = (live && realTrip) ? {
  id: realTrip.id,
  title: realTrip.title,
  destinationCity: realTrip.destinationCity,
  destinationCountry: realTrip.destinationCountry ?? '',
  neighborhoods: realTrip.neighborhoods,
  startDate: realTrip.startDate ?? '',
  endDate: realTrip.endDate ?? '',
  nights: (realTrip.startDate && realTrip.endDate)
    ? Math.max(0, Math.round((new Date(realTrip.endDate).getTime() - new Date(realTrip.startDate).getTime()) / 86_400_000))
    : 0,
  status: realTrip.status,
  visibility: realTrip.visibility,
  travelStyle: realTrip.travelStyle ?? '',
  openToMeet: realTrip.openToMeet,
  coverUrl: realTrip.coverUrl ?? '',
  progress: realTrip.progress,
  progressSteps: [],  // not in TripRow — no API endpoint yet
  timeline: [],       // not in TripRow — no API endpoint yet
  savedIdeas: [],     // not in TripRow — no API endpoint yet
  safetyStatus: 'unknown',
} : mockTripDetail;  // dev-preview fallback only
```

**Why:** The `...mockTripDetail` spread used to poison real trips with fixture data (Cebu placeholder title, fake coordinates, fake stamps). When `live=true && realTrip` exists, fixture data must never appear.

**Fields not in TripRow:** `progressSteps`, `timeline`, `savedIdeas` — these are always empty `[]` until dedicated API routes are added. `safetyStatus` is `'unknown'` (TripSafety component fetches its own data via tripId, not from this prop).

**Not-found state:** Add `if (live && !loading && !realTrip) { return <ErrorView /> }` between the loading spinner and the main render.

## toggleSave return type — ToggleSaveResult

`discoveryBookmarks.toggleSave` returns `Promise<ToggleSaveResult>` not `Promise<boolean>`:

```typescript
interface ToggleSaveResult {
  added: boolean;   // true if place was saved, false if removed
  synced: boolean;  // true if API call succeeded or user is unauthenticated
}
```

**Why:** Offline-first design — local state always commits, API is best-effort. `synced: false` signals the change is local-only and will reconcile on next `listSaved()`.

**Callers must destructure:** `const { added: nowSaved } = await toggleSave(place, listId)`.

**synced: true** when token is null (unauthenticated — local is canonical). **synced: false** on network error or non-2xx HTTP response.

**Tests:** All node:test assertions must use `result.added` / `result.synced`, not `result` directly. Jest mocks must return `{ added: true/false, synced: true }`.
