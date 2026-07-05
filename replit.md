# Travel Buddy

[![Pre-release checks](https://github.com/passporttravelbuddy-ops/travel-buddy/actions/workflows/pre-release.yml/badge.svg?branch=main)](https://github.com/passporttravelbuddy-ops/travel-buddy/actions/workflows/pre-release.yml)

A social travel passport mobile app — log trips, track destinations, and share your travel story.

## Active mobile development target

```
~/workspace/travel-buddy-standalone      ← ALL mobile dev work goes here
~/workspace/artifacts/travel-buddy       ← BACKUP / reference only (do not run)
```

**Important:** The Replit preview pane runs the `artifacts/travel-buddy` Expo workflow (managed by the artifact system). Standalone development happens via the command line or a physical device:

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

## Run & Operate

- API server auto-starts: port 8080
- `pnpm run typecheck` — full typecheck across all packages
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
| `engagement-indexes`   | `export SUPABASE_ACCESS_TOKEN=sbp_... && bash scripts/pre-release-check.sh` | Apply `artifacts/api-server/src/migrations/0106_engagement_indexes.sql` via Supabase SQL editor or psql; skipped (warning only) when no token is set; CI: set `DB_URL` repo secret (libpq connection string) to use psql mode — falls back to `SUPABASE_PROJECT_TOKEN` Management API when `DB_URL` is absent |
| `pre-release-self-test` | `bash scripts/pre-release-check.sh --self-test` | A verifier script exited 0 on known-bad data — fix the verifier (check-engagement-indexes.sh or check-db-triggers.sh) then re-run the self-test |

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Mobile: Expo SDK 54, React Native, Expo Router
- API: Express 5 (esbuild bundle, `artifacts/api-server`)
- DB: Supabase (PostgreSQL + RLS) — `@supabase/supabase-js`; Auth: Supabase Auth

## Where things live

- `travel-buddy-standalone/` — **active Expo mobile app** (`app/`, `src/services/`, `src/lib/supabase.ts`, `src/context/SessionContext.tsx`)
- `artifacts/travel-buddy/` — **BACKUP / reference only** — do not edit or run
- `artifacts/api-server/` — Express API server (`src/routes/trips.ts`, `src/lib/supabase.ts`, `.env`)

## Architecture decisions

- **Trip creation routes through the API server** — Supabase rotated its JWT key to ECC P-256; PostgREST hasn't fully picked up the new key so `auth.uid()` returns NULL and RLS fails. The API server verifies JWTs via `supabase.auth.getUser(token)` then inserts with the service role key, bypassing RLS.
- **Expo uses `sb_publishable_*` anon key** (new Supabase key format) for `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
- **Metro `_tmp` watcher blocklist** — `metro.config.js` blocks `*_tmp_\d+` paths to prevent ENOENT crashes when pnpm creates/deletes temp dirs during installs in workspace siblings.

## Product

Users sign in with Supabase Auth (email/password) to create and manage trips (destination, dates, status, visibility) and view trip details via a social travel passport.

## Gotchas

- After any `pnpm add` in a workspace sibling, restart the `expo` workflow — pnpm temp dirs can crash Metro.
- `artifacts/api-server/.env` must have `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` or `/api/trips` returns 503.
- `DAILY_BRIEF_RETENTION_DAYS` (default `60`, days) and `DAILY_BRIEF_CLEANUP_INTERVAL_HOURS` (default `24`) — set in `artifacts/api-server/.env` to tune without a deploy.
- `EXPO_PUBLIC_API_BASE_URL` in `artifacts/travel-buddy/.env` must point to the Replit dev domain (not the Expo domain).
- Feature-flag routes in `routes/*.ts` use paths without the `/api` prefix (the router is mounted at `app.use("/api", router)`).
- `rent_buddy_city_rollouts`: when the table has no rows at `public_mvp` or `beta_testing` status, all city-specific calls return `city_not_available`. Apply migration `0092_seed_rent_buddy_launch_cities.sql` (seeds Cebu, Manila, Davao City at `public_mvp`) or add rows via `POST /api/admin/rent-buddy/rollout/cities`. The `db-triggers` pre-release check now verifies at least one live city exists.

## Reference docs

- [docs/migrations.md](docs/migrations.md) — full applied migration log
- [docs/feature-flags.md](docs/feature-flags.md) — feature-flag launch runbook and recommended enable order
- [docs/eas-runbook.md](docs/eas-runbook.md) — EAS build setup, MapLibre owner steps, and react-native-maps migration note

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
