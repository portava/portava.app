# Travel Buddy

A social travel passport mobile app — log trips, track destinations, and share your travel story.

## Run & Operate

- Workflows auto-start: `expo` (port 20682), `api-server` (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/travel-buddy run dev` — run Expo app manually
- `pnpm --filter @workspace/api-server run dev` — run API server manually

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Mobile: Expo SDK 54, React Native, Expo Router
- API: Express 5 (esbuild bundle, `artifacts/api-server`)
- DB: Supabase (PostgreSQL + RLS), accessed via `@supabase/supabase-js`
- Auth: Supabase Auth

## Where things live

- `artifacts/travel-buddy/` — Expo mobile app
  - `app/` — Expo Router screens
  - `src/services/` — Supabase service layer (trips, auth, profiles)
  - `src/lib/supabase.ts` — Supabase client
  - `src/context/SessionContext.tsx` — auth session context
  - `metro.config.js` — Metro bundler config (includes `_tmp` watcher blocklist fix)
- `artifacts/api-server/` — Express API server
  - `src/routes/trips.ts` — POST /api/trips (server-side trip creation)
  - `src/lib/supabase.ts` — service role client
  - `.env` — `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`

## Architecture decisions

- **Trip creation routes through the API server**, not directly to Supabase PostgREST. The Supabase project rotated its JWT signing key to ECC P-256; PostgREST hasn't fully picked up the new key, so `auth.uid()` returns NULL and RLS fails. The API server verifies the user JWT via `supabase.auth.getUser(token)` (calls Auth directly, not PostgREST) then inserts with the service role key, bypassing RLS.
- **Expo uses `sb_publishable_*` anon key** (new Supabase key format) for `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
- **Metro `_tmp` watcher blocklist** — `metro.config.js` blocks `*_tmp_\d+` paths to prevent ENOENT crashes when pnpm creates/deletes temp dirs during installs in workspace siblings.

## Product

- Users sign in with Supabase Auth (email/password)
- Create and manage trips (destination, dates, status, visibility)
- View trip details; social passport for sharing travel history

## Applied migrations

| Migration | Description | Applied |
|-----------|-------------|---------|
| `0013_daily_briefs_cleanup.sql` | `daily_briefs_brief_date_idx` index on `daily_briefs(brief_date)` — keeps the nightly purge DELETE fast as the table grows | 2026-06-21 |

## Gotchas

- After any `pnpm add` in a workspace sibling (e.g. `api-server`), restart the `expo` workflow — pnpm temp dirs can crash Metro if it's already running.
- `artifacts/api-server/.env` must have both `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` or `/api/trips` returns 503.
- `DAILY_BRIEF_RETENTION_DAYS` (optional, default `60`) — how many days of daily briefs to keep before the cleanup job purges them. Set in `artifacts/api-server/.env` to tune without a code deploy.
- `EXPO_PUBLIC_API_BASE_URL` in `artifacts/travel-buddy/.env` must point to the Replit dev domain (not the Expo domain) so the mobile app can reach the API server.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
