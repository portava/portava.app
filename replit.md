# Travel Buddy

> **SOURCE OF TRUTH (updated 2026-08-14):** `travel-buddy-standalone/` is THE ONLY mobile app tree — make all mobile app edits there. The former canonical tree `artifacts/travel-buddy` was **archived on 2026-08-14 and no longer exists on disk**; its last state is `artifacts/travel-buddy` at commit `bc1bef404`, recoverable with `git show bc1bef404:artifacts/travel-buddy/<path>`. The legacy artifacts→standalone sync retired with it: `scripts/sync-standalone.sh`, `scripts/post-merge.sh`, the `PORTAVA_ENABLE_LEGACY_SYNC` machinery and the `STANDALONE_OWNED_FILES` ledger are all gone. Any instructions or docs below (or elsewhere in this repo) that call `artifacts/travel-buddy` canonical, or describe a canonical→mirror sync workflow, are historical. The API server remains canonical at `artifacts/api-server`.

[![Pre-release checks](https://github.com/passporttravelbuddy-ops/travel-buddy/actions/workflows/pre-release.yml/badge.svg?branch=main)](https://github.com/passporttravelbuddy-ops/travel-buddy/actions/workflows/pre-release.yml)

A social travel passport mobile app — log trips, track destinations, and share your travel story.

## Canonical mobile tree (single source of truth)

```
~/workspace/travel-buddy-standalone      ← THE mobile tree — all mobile dev work happens here
(artifacts/travel-buddy                   ← ARCHIVED 2026-08-14; gone from disk, see bc1bef404)
```

**The rule (updated 2026-08-14):** `travel-buddy-standalone` is the only mobile source tree — every mobile code change lands there, and EAS builds run from it. `artifacts/travel-buddy` was the pre-2026-08-04 canonical tree; it is archived at `bc1bef404` and there is nothing to sync from any more. The API server is unaffected — it remains canonical at `artifacts/api-server`.

- **The legacy sync is gone, not disabled.** `scripts/post-merge.sh`, `scripts/sync-standalone.sh`, `scripts/test-sync-standalone.sh`, `scripts/src/sync-standalone-check.test.ts` and the `PORTAVA_ENABLE_LEGACY_SYNC` gate were deleted with the tree they synced. Nothing replaces them: a one-tree repo cannot fall out of sync with itself.
- **The three drift checks retired with it** — `--check-source / --check-deps / --check-lockfile` were the read-only modes of that script, and all three compared against the archived tree. `scripts/pre-release-check.sh` now runs 9 checks, not 12.
- **The `STANDALONE_OWNED_FILES` ledger is gone.** It was the mirror-era divergence inventory (history in [docs/tree-sync-audit-2026-07-19.md](docs/tree-sync-audit-2026-07-19.md)); with no mirror there is nothing for it to protect. Its ~84 entries are recoverable from `bc1bef404` if the rationale is ever needed.
- **Web + native output** — the Replit workflows (dev server, tests, typecheck) and EAS builds all run from the standalone tree — see [docs/eas-runbook.md](docs/eas-runbook.md).

Physical-device dev loop (Metro serves the canonical standalone tree — edit it directly and Metro hot-reloads):

```bash
cd ~/workspace/travel-buddy-standalone
pnpm run dev           # prints the Android URL and starts Metro
pnpm run dev:android   # same, but clears Metro cache first (--clear)
```

The web preview shows the non-native build — MapLibre requires iOS or Android runtime.

## Physical Android device connection

The Replit preview QR code routes through a proxy that Android cannot reach. **Do not scan it.**

**Every time you start the dev server, the correct URL is printed in the terminal.**

Manual steps:
1. Install the **Travel Buddy EAS development build** on the device (not Expo Go).
2. Open the app → tap **Enter URL manually**.
3. Paste the `.expo.spock.replit.dev` URL printed by `pnpm run dev` and tap **Connect**.
4. If connection times out, run: `curl -I https://$REPLIT_EXPO_DEV_DOMAIN` from the Replit shell to confirm Metro is up.

The tunnel URL is read from `$REPLIT_EXPO_DEV_DOMAIN` at runtime — it updates automatically if Replit rotates the domain. The startup script is `travel-buddy-standalone/scripts/android-dev.sh`.

## Universal location service

Every location selection in the app flows through `GlobalPlacePicker` (`src/components/selectors/GlobalPlacePicker.tsx`) — no raw-text city inputs on user-facing save paths. Key pieces:

- **Canonical registry:** `canonical_locations` table (migration 0125). Provider variants ("Cebu" / "Cebu City" / a Foursquare id) resolve to one canonical id via `api-server/src/lib/canonicalLocations.ts` (normalized name + kind-class + proximity matching). `POST /api/locations/resolve` is find-or-create, tolerant of DB failures (returns `canonicalId: null`, never blocks a selection), rate-limited per user, and race-safe via the unique identity index from migration 0126 (23505 → re-match).
- **Popular on Portava:** `GET /api/locations/popular` ranks cities from real activity (posts/trips/events/profiles/discovery saves, 90-day window, proximity boost) with `SEED_CITIES` top-up; 15-min server cache. Client hook: `usePopularCities`.
- **Search:** `/api/places/search` fans out Nominatim + Foursquare in parallel and merges/dedupes; `type=city` restricts to settlements. Foursquare venue search silently no-ops until a valid `FOURSQUARE_API_KEY` is set (current key is rejected with 401 by both v3 and current-gen Foursquare APIs).
- **Client resolution:** selections resolve through `src/lib/location/resolveCanonical.ts` (≤1.3 s cap, falls back to the unresolved place). `ManualCityPicker` is a deprecated thin wrapper around `GlobalPlacePicker` in city mode.
- **Intentional exceptions to the picker rule:** admin tooling (`admin/rollout`, `admin/bookings` filter), text filter on events list, and optional display-label override fields in event creation / buddy application (their primary location comes from the picker).

## Run & Operate

- API server auto-starts: port 8080
- `pnpm run typecheck` — full typecheck across all packages, including `@workspace/travel-buddy` (whose script also runs the import-extension guard `scripts/check-import-extensions.mjs`). The old `--filter !@workspace/travel-buddy` exclusion was removed in July 2026: the package's tsc passes cleanly and quickly (~4 s warm), so the exclusion only served to silently skip the guard.
- `pnpm --filter @workspace/api-server run dev` — run API server manually
- Standalone typecheck: `cd travel-buddy-standalone && pnpm typecheck`

## Release checklist

Run all checks before cutting a release: `bash scripts/pre-release-check.sh`

To verify the check scripts themselves are not broken (i.e. they correctly detect failures), run the self-test: `bash scripts/pre-release-check.sh --self-test`

| Validation name        | Command                                          | Fix when failing |
|------------------------|--------------------------------------------------|-----------------|
| `typecheck`            | `pnpm run typecheck`                             | Fix TS errors in the relevant package |
| `typecheck-standalone` | `cd travel-buddy-standalone && pnpm typecheck`   | Fix TS errors in standalone |
| `dependency-drift`     | `bash scripts/sync-standalone.sh --check-deps`   | Run `--apply-deps` then `pnpm install` in standalone |
| `source-drift`         | `bash scripts/sync-standalone.sh --check-source` | Run `--fix-source` to re-sync |
| `api-server-build`     | `pnpm --filter @workspace/api-server run build`  | Fix esbuild errors in `artifacts/api-server/src/` |
| `lockfile-drift`       | `bash scripts/sync-standalone.sh --check-lockfile` | Run `--fix-lockfile` to re-sync resolved versions |
| `db-triggers`          | `export SUPABASE_PROJECT_TOKEN=<token> && bash scripts/pre-release-check.sh` | Apply migrations 0071–0074, 0090, 0092 via Supabase dashboard or psql; CI: set `SUPABASE_PROJECT_TOKEN` repo secret (Project Settings → API → Project API tokens); local: `export SUPABASE_ACCESS_TOKEN=sbp_...` from [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens); see [docs/eas-runbook.md](docs/eas-runbook.md) → "DB triggers check in CI" |
| `engagement-indexes`   | `export SUPABASE_ACCESS_TOKEN=sbp_... && bash scripts/pre-release-check.sh` | Apply `artifacts/api-server/src/migrations/0106_engagement_indexes.sql` via Supabase SQL editor or psql; skipped (warning only) when no token is set; psql mode is `ENGAGEMENT_QUERY_MODE=psql` + `ENGAGEMENT_PSQL_URL` (a libpq connection string); the API path via `SUPABASE_PROJECT_TOKEN` is the default. **Corrected 2026-08-11:** this cell previously named a `DB_URL` repo secret. No script has ever read `DB_URL` — `scripts/check-engagement-indexes.sh:91-94` reads `ENGAGEMENT_PSQL_URL`, and `scripts/check-db-triggers.sh:194-196` reads `TRIGGER_PSQL_URL`. **Do not set any of these in CI:** a libpq string carries no project ref, so `assert-nonprod-supabase.sh` has nothing to compare and now refuses outright when one is present. psql mode is for local use against a database you named on the command line. |
| `pre-release-self-test` | `bash scripts/pre-release-check.sh --self-test` | A verifier script exited 0 on known-bad data — fix the verifier (check-engagement-indexes.sh or check-db-triggers.sh) then re-run the self-test |

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Mobile: Expo SDK 54, React Native, Expo Router
- API: Express 5 (esbuild bundle, `artifacts/api-server`)
- DB: Supabase (PostgreSQL + RLS) — `@supabase/supabase-js`; Auth: Supabase Auth

## Where things live

- `travel-buddy-standalone/` — **CANONICAL Expo mobile app** (`app/`, `src/services/`, `src/lib/supabase.ts`, `src/context/SessionContext.tsx`) — all mobile edits happen here
- `artifacts/api-server/` — Express API server, **canonical** (`src/routes/trips.ts`, `src/lib/supabase.ts`, `.env`)

## Architecture decisions

- **Live search suggestions** — `GET /api/discovery/suggest` powers grouped typeahead under the global search bar. It reuses the same per-type search functions as `/discovery/search` (`dispatchSearch` — identical privacy/blocking/ranking paths, deliberately no parallel search system) with small per-type limits, merges canonical-location city rows (`suggestCanonicalLocations`) ahead of profile-derived cities, dedupes cross-group by entity id, and orders groups by best `matchTier` (higher = better: 3 exact > 2 prefix > 1 substring). Fail-soft: errors return 200 with empty groups. Client: `useSearchSuggestions` (250ms debounce, abort, LRU cache) + `SearchSuggestionsPanel`; `app/search.tsx` runs suggest mode while typing and full search only on explicit submit (return key, "Search for" row, tab/recent tap, deep link). Navigation for both surfaces lives in `components/search/searchNav.tsx` (`TypeIcon` + `resolveRoute`).
- **Discovery map travelers layer** — `GET /api/map/travelers` shows opt-in users on the live map. All privacy work is server-side (`api-server/src/lib/mapTravelers.ts`): eligibility mirrors discovery search (mode/paused/visibility, private/inactive profiles, discovery+location-sharing kill switches, age restriction, blocks — all fail-closed), and positions are coarsened before leaving the server (canonical city centroid, or grid snap + deterministic per-user jitter; ~11km cells for city precision, ~2.2km otherwise). Only coarse freshness buckets (`live` <15min, `recent` <60min) are exposed. Client polls every 45s foreground-only (`useMapTravelers`), clusters by zoom with a fan-out at high zoom, and the layer has its own persisted toggle (`discovery_map_travelers`).

- **Layover Mode** — end-to-end system behind feature flags (migration 0127: `airport_profiles`, `layover_sessions`, `layover_recommendations`, `layover_events`, `layover_plan_stops`). Time contract: the client sends airport-local wall times (`arrivalLocal`/`departureLocal`/`boardingLocal`, `YYYY-MM-DDTHH:mm`) plus a resolved airport (`iata`/`airportId`); the server converts in the airport's timezone via `services/airport/AirportTime.ts` and **rejects wall times when no airport resolves** (a UTC fallback would silently shift hard-return math). Safety math lives in `LayoverSafetyEngine.ts` (window tiers, hard-return anchored on boarding cutoff, explicit visa unknowns); recommendations (`LayoverRecommendationService.ts`) are time-of-day aware (`timeOfDayContext` samples 30-min steps to the boarding cutoff). Client dashboard is `app/layover/[id].tsx` fed by one `GET /api/airport/sessions/:id/overview` call; the countdown ticks locally but the overview silently re-fetches every 60s so usable-window/plan-fit numbers never overstate margin. Both trees (artifacts + standalone) carry the same layover client files.
- **Trip creation routes through the API server** — Supabase rotated its JWT key to ECC P-256; PostgREST hasn't fully picked up the new key so `auth.uid()` returns NULL and RLS fails. The API server verifies JWTs via `supabase.auth.getUser(token)` then inserts with the service role key, bypassing RLS.
- **Expo uses `sb_publishable_*` anon key** (new Supabase key format) for `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
- **Metro `_tmp` watcher blocklist** — `metro.config.js` blocks `*_tmp_\d+` paths to prevent ENOENT crashes when pnpm creates/deletes temp dirs during installs in workspace siblings.

## Product

Users sign in with Supabase Auth (email/password) to create and manage trips (destination, dates, status, visibility) and view trip details via a social travel passport.

## Gotchas

- After any `pnpm add` in a workspace sibling, restart the `expo` workflow — pnpm temp dirs can crash Metro.
- `artifacts/api-server/.env` must have `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` or `/api/trips` returns 503.
- `DAILY_BRIEF_RETENTION_DAYS` (default `60`, days) and `DAILY_BRIEF_CLEANUP_INTERVAL_HOURS` (default `24`) — set in `artifacts/api-server/.env` to tune without a deploy.
- `INVITE_SLOT_RECONCILE_INTERVAL_HOURS` (default `1`, hours) — how often the API server calls `reconcile_invite_link_slots` to fix stranded invite-link slots. Set to `0` in `artifacts/api-server/.env` to disable. `INVITE_SLOT_RECONCILE_MIN_AGE_MINUTES` (default `5`) controls the minimum slot age before a stranded entry is fixed (must be > 0 to avoid touching in-flight requests).
- `INVITE_SLOT_SWEEP_INTERVAL_HOURS` (default `1`, hours) — how often the complementary sweeper runs the same reconcile function. `INVITE_SLOT_SWEEP_TTL_HOURS` (default `24`) sets the minimum age in hours before a stranded attempt row is cleaned up. The sweeper targets older orphaned rows (pre-0110 crash survivors); the reconciler targets recent ones. Both use `FOR UPDATE SKIP LOCKED` so concurrent runs are safe. Set `INVITE_SLOT_SWEEP_INTERVAL_HOURS=0` to disable the sweeper.
- `EXPO_PUBLIC_API_BASE_URL` in `travel-buddy-standalone/.env` must point to the Replit dev domain (not the Expo domain).
- Feature-flag routes in `routes/*.ts` use paths without the `/api` prefix (the router is mounted at `app.use("/api", router)`).
- `rent_buddy_city_rollouts`: when the table has no rows at `public_mvp` or `beta_testing` status, all city-specific calls return `city_not_available`. Apply migration `0092_seed_rent_buddy_launch_cities.sql` (seeds Cebu, Manila, Davao City at `public_mvp`) or add rows via `POST /api/admin/rent-buddy/rollout/cities`. The `db-triggers` pre-release check now verifies at least one live city exists.

## Stamp catalog reconciliation

`POST /admin/stamps/reconcile` (requires admin role) runs the stamp catalog reconciliation: it reads every distinct `(stamp_type, country, city)` combination from `user_stamps` and `passport_stamps`, resolves or creates the matching `universal_stamp_catalog` entry, and writes `catalog_id` back onto any rows where it is `null`. The endpoint is idempotent and returns `{ ok: true, stats: { resolved, flagged, skipped, enqueued } }`.

**When to trigger**

| Trigger | How |
|---------|-----|
| After every deploy | Add `curl -s -X POST $API_URL/api/admin/stamps/reconcile -H "Authorization: Bearer $ADMIN_TOKEN"` as the final step in your CI/CD release job |
| Nightly cron | Schedule the same `curl` command via your cron provider (e.g. GitHub Actions `schedule`, Render cron job, or `pg_cron` on Supabase) |
| Manual one-off | Run the CLI script: `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx src/scripts/reconcileStampCatalog.ts` from `artifacts/api-server/` |

The shared logic lives in `artifacts/api-server/src/lib/stamps/reconcileStampCatalog.ts` and is called by both the API route and the CLI script.

**Stats meaning**
- `resolved` — combos that were successfully linked to a catalog entry (new or existing)
- `flagged` — combos that failed to resolve or insert; rows logged to `stamp_reconciliation_log` for admin review
- `skipped` — combos with neither a country nor a city (cannot build a canonical key)
- `enqueued` — new catalog entries that had artwork generation jobs queued

## Reference docs

- [docs/migrations.md](docs/migrations.md) — full applied migration log
- [docs/feature-flags.md](docs/feature-flags.md) — feature-flag launch runbook and recommended enable order
- [docs/eas-runbook.md](docs/eas-runbook.md) — EAS build setup, MapLibre owner steps, and react-native-maps migration note

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
