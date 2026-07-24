# APPLY — Country essentials (plugs, voltage, emergency numbers)

Curated travel-readiness reference data. Backend + mobile service. Flag-gated
OFF by default.

## What it is
Per-country plug types, mains voltage/frequency, drive side, and emergency
numbers for the readiness screen. 54 major destinations seeded. Curated static
data — no live provider (none worth using exists). Plug/voltage/frequency are
IEC-standardized and stable; emergency numbers are curated and EVERY response
carries a "confirm on arrival" disclaimer (safety-relevant).

## Honesty
- confidence='curated', source + last_verified_at on every response.
- Countries not covered return `essentials: null` — an honest "unknown", never
  a guess.
- DB row (admin-editable) wins over the in-code dataset; the in-code dataset is
  the fallback so it works even before 0182 runs.

## Endpoints (flag country_essentials_enabled)
- GET /api/countries/:code/essentials — ISO2 or a country name
- GET /api/trips/:tripId/essentials — essentials for the trip's destination
  country(ies), member-gated

Mobile service: src/services/countryEssentials.ts (fail-soft null). ALWAYS
render `disclaimer` next to emergency numbers.

## Steps (workspace root)
1. Unzip, `git apply -p1 portava-country-essentials.patch`
   (fallback: copy files/* over the workspace root).
2. Run 0182_country_essentials.sql in Supabase.
3. `cd artifacts/api-server && pnpm test 2>&1 | tail -6` → green
   (11 new tests incl. dataset-accuracy invariants).

## Turn on
    UPDATE feature_flags SET enabled = TRUE WHERE flag = 'country_essentials_enabled';

## UI (optional, hand to Replit agent)
Surface on the trip/readiness screen: a "Good to know" card per destination —
plug type + adapter hint, voltage, drive side, and emergency numbers WITH the
disclaimer. The service + contract are ready; no backend changes needed.

## Extending coverage
Add rows to COUNTRY_ESSENTIALS in lib/countryEssentials.ts (and re-seed) or via
admin edits to the country_essentials table. Keep plug letters valid (A–N),
voltage 100–240, frequency 50/60 — the test suite enforces these invariants.
