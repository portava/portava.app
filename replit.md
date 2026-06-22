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
| `0010_trip_plan.sql` | Creates `trip_plan_items` table with RLS policies (select/insert/update for trip members/owners) and a partial unique index on `(trip_id, source_type, source_id)` | 2026-06-21 |
| `0011_message_type.sql` | Adds `msg_type` (default `'text'`) and `subtype` columns to `messages`; partial index on `subtype` | 2026-06-21 |
| `0012_daily_briefs.sql` | Creates `daily_briefs` table with per-user/per-day uniqueness constraint and RLS (users read own rows only); service role handles all writes | 2026-06-21 |
| `0013_daily_briefs_cleanup.sql` | `daily_briefs_brief_date_idx` index on `daily_briefs(brief_date)` — keeps the nightly purge DELETE fast as the table grows | 2026-06-21 |
| `0014_profile_about_me.sql` | Adds `spoken_languages`, `default_language`, `travel_styles`, `travel_pace`, `budget_style`, `travel_group_style`, `looking_for`, `comfort_level`, `availability_tags`, `planning_style`, `public_social_links` to `profiles` | 2026-06-22 |
| `0015_blocks.sql` | Creates `blocks` table (blocker_id, blocked_id, unique constraint, RLS) and `is_blocked(a, b)` SECURITY DEFINER helper function | 2026-06-22 |
| `0016_thread_reads.sql` | Adds `last_read_at timestamptz` to `message_thread_members`; index for unread-count queries | 2026-06-22 |
| `0017_job_health.sql` | Creates `job_health` table (primary key: `job text`) to persist background-job last-run timestamps; used by `GET /api/healthz/cleanup` to report `cleanupHealthy` across server restarts | 2026-06-22 |
| `0018_preferred_language.sql` | Adds `preferred_language` (nullable text, BCP-47) to `profiles`; overrides `preferred_message_language` in the translation pipeline when set | 2026-06-22 |
| `0019_proposed_time.sql` | Adds `proposed_time TIME` (nullable) to `meetup_time_options` — stores exact HH:MM per time-poll slot alongside the coarse time_block | 2026-06-22 |
| `0020_notifications_inbox_viewed.sql` | Adds `notifications_inbox_viewed_at timestamptz` to `profiles`; used by `GET /api/me/unread-counts` to compute unread notification badge count | 2026-06-21 |
| `0021_plan_edit_permission.sql` | Adds `plan_edit_permission` column to `trips` (enum: `owner_only \| all_members \| specific_members`, default `all_members`) and creates `plan_editors` join table with RLS; used by plan permission system | 2026-06-22 |
| `0022_availability_nudges.sql` | Creates `availability_nudges` table (sender_id, recipient_id, trip_id, nudge_date, sent_on); UNIQUE(recipient_id,trip_id,sent_on) rate-limits to one nudge per recipient per trip per day; RLS: recipients read own rows | 2026-06-22 |
| `0023_push_tokens.sql` | Adds `expo_push_token TEXT` to `profiles`; stores Expo push token per device so the API server can send push notifications | 2026-06-22 |
| `0024_post_engagement.sql` | Creates `posts_likes` (post_id+user_id unique, RLS) and `posts_comments` (body, soft-delete, RLS) tables; adds `like_count`, `comment_count`, `share_count` integer columns (DEFAULT 0) to `posts` | pending |
| `0025_location_system.sql` | Creates `user_location_state` (per-user GPS/manual-city upsert, unique on user_id, RLS) and `passport_stamps_gps` (GPS-earned stamp events, unique on user+type+country+city, RLS) tables; adds `location_source`, `stamp_city/country/label/unlocked_at` columns to `postcards` if it exists | pending |

## Gotchas

- After any `pnpm add` in a workspace sibling (e.g. `api-server`), restart the `expo` workflow — pnpm temp dirs can crash Metro if it's already running.
- `artifacts/api-server/.env` must have both `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` or `/api/trips` returns 503.
- `DAILY_BRIEF_RETENTION_DAYS` (optional, default `60`) — how many days of daily briefs to keep before the cleanup job purges them. Set in `artifacts/api-server/.env` to tune without a code deploy.
- `DAILY_BRIEF_CLEANUP_INTERVAL_HOURS` (optional, default `24`) — how many hours between cleanup runs. Accepts decimals (e.g. `0.5` for every 30 minutes). Set in `artifacts/api-server/.env` to tune without a code deploy.
- `EXPO_PUBLIC_API_BASE_URL` in `artifacts/travel-buddy/.env` must point to the Replit dev domain (not the Expo domain) so the mobile app can reach the API server.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
