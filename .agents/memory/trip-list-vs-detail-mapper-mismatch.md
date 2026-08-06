---
name: Trip list vs detail field-casing mismatch
description: listMyTrips() and getTrip() must use different row mappers because they read different shapes (server-serialized camelCase vs raw Supabase snake_case).
---

`travel-buddy-standalone/src/services/trips.ts` has two trip fetchers that
look interchangeable but consume different shapes:
- `getTrip()` selects directly from Supabase (`trips` table) — raw
  **snake_case** columns (`destination_city`, `start_date`, ...).
- `listMyTrips()` calls `GET /api/trips/me`, whose server-side serializer
  (`toAuthorizedTripView` in api-server) already returns **camelCase**
  (`destinationCity`, `startDate`, ...).

Passing both through the same snake_case-expecting mapper silently blanks
every field on the list view (undefined property reads) while the detail
view — fed by the raw-row path — renders correctly. This produced a bug
where the Trips list showed "Dates TBD" / no location for a trip whose
detail screen displayed the same data correctly, even though a direct
authenticated API call confirmed the server was returning correct values.

**Why:** any endpoint that returns a server-serialized object (already
mapped to the client's field names) must not be re-run through a mapper
written for a raw DB row, and vice versa — the two look structurally similar
but use different casing conventions, and this fails silently (no error) as
`undefined ?? fallback` reads.

**How to apply:** when a service function's data source changes (raw table
select vs. an API route that serializes rows itself), check whether the
existing row-mapper's field names match the new source; don't assume it's
reusable just because it returns the same TypeScript type.
