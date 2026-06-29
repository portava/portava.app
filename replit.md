# Travel Buddy

A social travel passport mobile app — log trips, track destinations, and share your travel story.

## Active mobile development target

```
~/workspace/travel-buddy-standalone      ← ALL mobile dev work goes here
~/workspace/artifacts/travel-buddy       ← BACKUP / reference only (do not run)
```

**Important:** The Replit preview pane runs the `artifacts/travel-buddy` Expo workflow (managed by the artifact system). Standalone development happens via the command line or a physical device:

```bash
cd ~/workspace/travel-buddy-standalone
pnpm run dev   # includes all required Replit env vars
```

The web preview shows the non-native build — MapLibre requires iOS or Android runtime.

## Run & Operate

- API server auto-starts: port 8080
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-server run dev` — run API server manually
- Standalone typecheck: `cd travel-buddy-standalone && pnpm typecheck`

## Release checklist

Run all checks before cutting a release: `bash scripts/pre-release-check.sh`

| Validation name        | Command                                          | Fix when failing |
|------------------------|--------------------------------------------------|-----------------|
| `typecheck`            | `pnpm run typecheck`                             | Fix TS errors in the relevant package |
| `typecheck-standalone` | `cd travel-buddy-standalone && pnpm typecheck`   | Fix TS errors in standalone |
| `dependency-drift`     | `bash scripts/sync-standalone.sh --check-deps`   | Run `--apply-deps` then `pnpm install` in standalone |
| `source-drift`         | `bash scripts/sync-standalone.sh --check-source` | Run `--fix-source` to re-sync |

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
- `rent_buddy_city_rollouts`: when the table is empty all city-specific calls return `city_not_available`. Add rows with `status = 'live'` via the Supabase dashboard or `POST /api/rent-buddy/admin/cities`.

## Reference docs

- [docs/migrations.md](docs/migrations.md) — full applied migration log
- [docs/feature-flags.md](docs/feature-flags.md) — feature-flag launch runbook and recommended enable order
- [docs/eas-runbook.md](docs/eas-runbook.md) — EAS build setup, MapLibre owner steps, and react-native-maps migration note

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
