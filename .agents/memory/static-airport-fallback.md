---
name: Static airport fallback dataset
description: airport_profiles DB table is empty; AirportProfileService falls back to StaticAirportData.ts
---

## Rule

Never rely on the `airport_profiles` Supabase table alone for airport search. Always chain DB → static fallback.

**Why:** The `airport_profiles` table exists (migration `0044_airport_layover.sql` applied) but has no rows. Airport search, IATA resolve, GPS resolve, and city resolve all returned empty/null without the fallback, making Layover Mode completely non-functional.

**Where the static dataset lives:**
`artifacts/api-server/src/services/airport/StaticAirportData.ts`
- ~150 airports: Asia-Pacific heavy, plus Middle East, Europe, North America, Latin America, Africa
- Exports: `STATIC_AIRPORTS`, `searchStaticAirports(query, limit)`, `resolveStaticByIata(iata)`, `resolveStaticByCity(city)`, `resolveStaticByGps(lat, lng)`
- GPS fallback: returns match only within ~200km (1.8 degree threshold)

**How to apply:**
All four resolver functions in `AirportProfileService.ts` already have the fallback pattern:
1. Try DB query
2. If DB returns data → use it (DB records have real buffer configs)
3. If DB returns nothing or errors → fall back to static data via `staticToProfile()`
4. `staticToProfile()` uses standard FALLBACK_PROFILE buffer values (60/90m domestic, 120/180m intl)

**To add an airport to the system** (without needing DB admin):
Add an entry to `STATIC_AIRPORTS` in `StaticAirportData.ts`. For production airports with custom buffers, use the admin endpoint `POST /api/admin/airport/profiles`.
