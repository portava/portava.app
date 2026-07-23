# Trip Brain wave — 2026-07-23

One build wave implementing the self-buildable portion of the Phase 0 audit
(`PORTAVA-PHASE0-AUDIT-REPORT.md`): foundation repairs plus six new backend
modules with tests, and minimal mobile wiring. All feature flags seed
**disabled**; nothing changes user-facing behavior until flags are flipped.

## Foundation repairs (Wave 1)

- **feature_flags column bug fixed** — 11 call sites queried `.eq("key", …)`
  against a table whose PK is `flag`, silently disabling Safe Return,
  geofence, trust engine, hidden-gems context, telegraph location context,
  and passport-stamp awards on those paths. All sites now read `flag`.
  Regression guard: `src/test/featureFlagColumnGuard.test.ts` fails the suite
  if the pattern ever returns.
- **Migration 0166** — idempotently seeds every flag those code paths read
  (`ON CONFLICT (flag) DO NOTHING`; never overrides live operator choices).
- **Migration 0167** — re-declares Safe Return + profile emergency-contacts
  DDL in the canonical chain (previously only in the frozen legacy dir).
- **Migration 0168** — declares `discovery_cache` + `discovery_geocode_cache`
  (read/written by `lib/discoveryPersistentCache.ts`, never declared before).

## Compass Trip Brain (always-on context + honest routing)

- `src/compass/CompassTripContext.ts` — `buildTripContextLines`: active or
  upcoming trip + today's/tomorrow's plan items injected into every `/ask`
  turn (skipped when a Compass Live session already grounds the chat).
- Intent classifier **promoted out of shadow mode** in `/ask`; legacy
  itinerary keyword regex deleted. `intent=itinerary && confidence ≥ 0.6`
  steers the itinerary payload format; everything else falls through to the
  normal tool loop.

## New modules (all flag-gated OFF, service-role authz checks in code)

| Module | Flag | Migration | Key endpoints |
|---|---|---|---|
| Entry intelligence (curated corridors) | `passport_entry_intelligence_enabled` | 0169 | `GET/POST/PATCH/DELETE /me/passports`, `PUT /trips/:id/travelers/me/passport`, `GET /trips/:id/entry-requirements`, `GET/POST/DELETE /admin/entry-requirements` |
| Trip readiness + next best action | `trip_readiness_enabled` | 0170 | `GET /trips/:id/readiness`, `GET /trips/:id/next-best-action`, `GET /trips/:id/arrival-board` (no flag) |
| Budget intelligence | `budget_intelligence_enabled` | 0171 | `GET /trips/:id/cost-estimate`, `POST /trips/:id/budget/sandbox`, `GET/POST/DELETE /admin/price-baselines` |
| Reservations import | `reservation_import_enabled` | 0172 | `POST /trips/:id/reservations/import` (paste → pending_confirm), reservations CRUD, `POST …/:id/confirm {addToPlan}` |
| NL trip draft | `nl_trip_creation_enabled` | 0172 | `POST /trips/draft-from-text` (returns a draft; NEVER writes) |
| Neighborhood match v1 (OSM) | `neighborhood_match_enabled` | 0173 | `GET /cities/neighborhoods`, `PUT /trips/:id/area-preferences`, `POST /trips/:id/neighborhood-match`, `POST /trips/:id/location-check` (no flag) |

Honesty contracts baked in: **zero** visa corridors and **zero** price
baselines are seeded — data enters only via the admin endpoints (corridors
REQUIRE an `official_source_url`; both stamp `last_verified_at` +
`verified_by`). Unknown corridors, missing baselines, and thin OSM data all
return explicit unknown/no-data responses. Reservation/NL extraction uses
`gpt-5-mini` at temperature 0, wraps user text in UGC delimiters, and never
auto-commits — everything lands `pending_confirm` for user review.

## Mobile (key wiring only)

- Services: `src/services/tripIntel.ts`, `entryRequirements.ts`,
  `neighborhoods.ts` (all fail-soft when flags are off).
- `useNextBestAction` hook + `TodayNextUp` on the trip page now renders the
  next best action when the server provides one; identical empty state
  otherwise. Full UI for the other modules ships via the Replit command doc.

## Verification state

- `tsc --noEmit` clean for api-server and travel-buddy.
- 107 new backend tests green (8 suites, registered in the api-server `test`
  script); regression slices green (safeReturn, compass-ask/tools, geofence,
  telegraphChat, tripsExpansion, TripDetail component tests).
- Standalone mirror: run `bash scripts/sync-standalone.sh --fix-source` after
  applying (mobile files changed in canonical only).

## Rollout order (after migrations 0166–0173 applied)

1. Verify Safe Return end-to-end, then flip `safe_return_enabled` when ready
   (the flag bug previously made this flag inert).
2. `trip_readiness_enabled` → readiness + TodayNextUp next-best-action.
3. `passport_entry_intelligence_enabled` after curating the first corridors
   via `POST /api/admin/entry-requirements`.
4. `budget_intelligence_enabled` after seeding `price_baselines` rows.
5. `neighborhood_match_enabled` (works immediately — OSM-derived).
6. `reservation_import_enabled`, `nl_trip_creation_enabled` (need
   `AI_INTEGRATIONS_OPENAI_*` configured).
