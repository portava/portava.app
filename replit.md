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
| `0024_post_engagement.sql` | Creates `posts_likes` (post_id+user_id unique, RLS) and `posts_comments` (body, soft-delete, RLS) tables; adds `like_count`, `comment_count`, `share_count` integer columns (DEFAULT 0) to `posts` | 2026-06-22 |
| `0025_location_system.sql` | Creates `user_location_state` (per-user GPS/manual-city upsert, unique on user_id, RLS) and `passport_stamps_gps` (GPS-earned stamp events, unique on user+type+country+city, RLS) tables; adds `location_source`, `stamp_city/country/label/unlocked_at` columns to `postcards` if it exists | 2026-06-22 |
| `0026_highlights.sql` | Creates `highlights`, `highlight_views`, `highlight_likes`, `highlight_replies`, `highlight_reports` tables with RLS; visibility enum (public/travelers_nearby/circle_only/trip_only/private); 24h default expiry, soft-delete, view/like/reply/report engagement | 2026-06-22 |
| `0028_highlights_last_viewed.sql` | Adds `highlights_last_viewed_at timestamptz` to `profiles`; updated by `POST /api/me/highlights/mark-viewed`; used by `GET /api/me/unread-counts` to compute `newHighlights` badge count | 2026-06-26 |
| `0029_discovery_places.sql` | Creates `discovery_places` table (id, city, name, place_type, category, neighborhood, blurb, image_url, submitted_by→profiles, saved_count, tag, note, rating, source, status, verified, created_at); RLS (public read, auth insert/update/delete own); indexes on city, place_type, created_at; used by `GET /api/discovery/community` | 2026-06-26 |
| `0032_location_preferences.sql` | Creates `location_preferences` table (user_id PK→profiles, location_mode enum, sharing_paused, pulse/discovery visibility enums, safe_return_enabled, trusted_circle_share, hotel_blur_enabled, updated_at); RLS (users manage own row) | 2026-06-26 |
| `0033_location_sessions.sql` | Creates `location_sessions` table (id, user_id, session_type enum, started_at, ended_at, resolved_city/country, trip_id, plan_item_id, metadata); RLS (users manage own rows, service-role all) | 2026-06-26 |
| `0034_geo_zones.sql` | Creates `geo_zones` table (id, name, zone_type enum, center_lat/lng, radius_meters, polygon_geojson, country_code, city, created_by→profiles, is_system, metadata); RLS (public read, auth create own, service-role all) | 2026-06-26 |
| `0035_plan_geofences.sql` | Creates `plan_geofences` table (id, trip_id→trips, plan_item_id→trip_plan_items, zone_id→geo_zones, trigger_type enum, notify_members bool, message_template, last_triggered_at); RLS (trip members read/manage) | 2026-06-26 |
| `0036_pulse_geo_tags.sql` | Creates `pulse_geo_tags` table (id, post_id→posts, geo_zone_id→geo_zones, tag_type enum, display_label, confidence_score, source enum, created_at); RLS (public read); used by Pulse location context display | 2026-06-26 |
| `0037_feature_flags.sql` | Creates `feature_flags` table (flag text PK, enabled bool, description, updated_at); seed rows for location intelligence phases 1–6; service-role manages flags | 2026-06-26 |
| `0039_plan_geofence_full.sql` | Expands `plan_geofences` (public_preview_level, exact_visibility, check_in_required, window start/end, arrival_status_visible, no_show_affects_reliability, location_name, city, neighborhood, venue_name, host_revealed, UNIQUE trip_id); adds `plan_checkins` (per-member attendance status with upsert), `plan_attendance_events` (audit log: suspicious/late/override events), `geofence_admin_settings` (single-row id=1 default/min/max radius config) | 2026-06-26 |
| `0041_trip_crew_location.sql` | Creates `trip_crew_location_preferences` (per-user/per-trip ghost mode + visibility defaults, RLS), `trip_crew_location_sessions` (timed live-share sessions with allowed_member_ids, expires_at, RLS), `trip_crew_location_events` (audit log for ghost mode on/off and live share events, RLS); feature flag seeds for `trip_crew_map_enabled`, `trip_crew_live_share_enabled`, `trip_crew_ghost_mode_enabled` | 2026-06-26 |
| `0042_passport_stamps.sql` | Creates `passport_stamps` (dedup unique index on user/stamp_type/country/city, NO lat/lng stored), `passport_memories` (suggested→active→dismissed lifecycle), `passport_contribution_events` (append-only, no Trust Score modification), `passport_visibility_preferences`; feature flag seeds for passport_stamps/memories/map/contribution | 2026-06-26 |
| `0043_tags_hashtags.sql` | Creates `tags` (per-@mention dedup on source_type+source_id+tagged_user_id), `hashtags` (canonical slug registry with block/trending flags), `hashtag_usage` (dedup per hashtag+source), `user_hashtag_follows`; adds `tag_permission` enum (`anyone\|interacted\|friends_only\|nobody`, default `anyone`) to `profiles`; `increment_hashtag_usage_count(uuid)` SECURITY DEFINER helper | 2026-06-26 |
| `0044_hashtag_reports.sql` | Creates `hashtag_reports` table (hashtag_id, reporter_id, reason enum: spam/misleading/abusive, created_at); RLS: auth users insert own rows, service role reads all; indexes on hashtag_id and reporter_id | 2026-06-26 |
| `0046_tag_suppression.sql` | Adds `suppressed BOOLEAN NOT NULL DEFAULT FALSE` + `suppressed_at TIMESTAMPTZ NULL` to `tags`; partial indexes for active-by-source and suppressed-by-user lookups; used by soft-delete self-tag removal flow | 2026-06-26 |
| `0047_rent_buddy.sql` | Creates all `rent_buddy_*` tables: profiles, applications, availability, packages, addons, saved, waitlist, bookings, booking_extensions, route_stops, route_change_requests, safety_checkins, safety_events, user_limits, emergency_contacts_snapshot, reviews, disputes, policy_flags, admin_actions; seeds `rent_buddy_enabled` feature flag | 2026-06-26 |
| `0048_booking_stay_connected.sql` | Adds `stay_connected_traveler BOOLEAN NOT NULL DEFAULT FALSE` and `stay_connected_buddy BOOLEAN NOT NULL DEFAULT FALSE` to `rent_buddy_bookings`; replaces ephemeral in-memory Map so stay-connected opt-ins survive server restarts and work across multiple API instances | 2026-06-26 |
| `0049_delayed_geotag_posts.sql` | Adds `location_privacy_mode` enum, `delayed_post_status` enum, `location_sensitivity_level` enum; new columns to `posts` (`post_status`, `location_privacy_mode`, `original_lat/lng`, `public_lat/lng`, `public_location_label`, `venue_name/id`, `geofence_radius_meters`, `publish_after_exit`, `publish_after_time`, `publish_eligible_at`, `exited_geofence_at`, `published_at`, `geotag_credit_awarded`, `location_sensitivity_level`, `user_gps_lat/lng`); creates `delayed_post_location_events` table (audit log: exit_detected/manually_released/geotag_credit_awarded/privacy_changed/publish_skipped/safe_return_hold/canceled) with RLS | 2026-06-26 |
| `0050_suggestion_seen.sql` | Creates `user_suggestion_seen` table (user_id PK→profiles, seen_ids text[], expires_at, updated_at); RLS enabled (service role only — no user-facing policies); `user_suggestion_seen_expires_idx` on expires_at for fast nightly purge; backs the hybrid L1/L2 suggestion-seen cache so the 7-day freshness window survives server restarts | 2026-06-26 |
| `0051_trip_members_user_role_idx.sql` | `trip_members_user_role_idx` composite index on `trip_members(user_id, role)` — lets Postgres seek directly to a user's trip memberships instead of seq-scanning the full table; hot path for the shared-destination caller query in GET /users/search and GET /users/suggestions | 2026-06-26 |
| *(inline — task 520)* | Creates `rent_buddy_global_controls` (id=1 singleton, all pause flags default false) and `rent_buddy_city_rollouts` (city + status enum, RLS public-read) tables not included in migration 0047; both are required by `checkRentBuddyAccess` in `rentABuddyRollout.ts`; `rent_buddy_enabled` feature flag flipped to `true` | 2026-06-26 |
| `0062_notifications_schema.sql` | Creates full push notification pipeline schema: `notifications` (in-app Activity Centre rows), `notification_devices` (Expo push tokens per device, UNIQUE user+token), `notification_preferences` (global per-user delivery toggles), `notification_category_preferences` (per-category overrides), `notification_delivery_attempts` (audit log for every dispatch), `push_retry_queue` (transient-failure retry with exponential backoff), `activity_events` (raw event log); seeds feature flags `notifications_enabled`, `push_notifications_enabled`, `realtime_activity_enabled`, `safety_notifications_enabled` (all enabled), `notification_digests_enabled` (disabled). RLS on all tables — service role writes, users read own rows. Required for `POST /api/me/devices` (token registration) to succeed against a real Supabase DB in any dev build or production. | ⚠️ PENDING — run `artifacts/api-server/src/migrations/0062_notifications_schema.sql` in Supabase SQL editor |
| `0063_push_retry_queue.sql` | Adds supplemental indexes for `push_retry_queue`: `prq_status_next_retry_idx` (partial on `status='queued'`) and `prq_user_idx`; `CREATE TABLE IF NOT EXISTS` is a no-op when 0062 is applied first; also enables RLS. Must be run after 0062. | ⚠️ PENDING — run `artifacts/api-server/migrations/0063_push_retry_queue.sql` in Supabase SQL editor after 0062 |

## Gotchas

- After any `pnpm add` in a workspace sibling (e.g. `api-server`), restart the `expo` workflow — pnpm temp dirs can crash Metro if it's already running.
- `artifacts/api-server/.env` must have both `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` or `/api/trips` returns 503.
- `DAILY_BRIEF_RETENTION_DAYS` (optional, default `60`) — how many days of daily briefs to keep before the cleanup job purges them. Set in `artifacts/api-server/.env` to tune without a code deploy.
- `DAILY_BRIEF_CLEANUP_INTERVAL_HOURS` (optional, default `24`) — how many hours between cleanup runs. Accepts decimals (e.g. `0.5` for every 30 minutes). Set in `artifacts/api-server/.env` to tune without a code deploy.
- `EXPO_PUBLIC_API_BASE_URL` in `artifacts/travel-buddy/.env` must point to the Replit dev domain (not the Expo domain) so the mobile app can reach the API server.
- `GET /api/feature-flags` was registered as `"/api/feature-flags"` in `featureFlags.ts` but the Express app mounts the router at `app.use("/api", router)` — the route path must be `"/feature-flags"` (no `/api` prefix). All other routes in `routes/*.ts` follow this pattern; `featureFlags.ts` was the exception and is now fixed.
- `rent_buddy_city_rollouts` city check: when the table is empty, all city-specific browse/book calls return `city_not_available`. Add rows with `status = 'live'` for each launch city via the Supabase dashboard or the admin API (`POST /api/rent-buddy/admin/cities`).

## Feature-flag launch runbook

All flags seeded by migrations 0037, 0041, and 0042 start as `enabled = false`. Flip them on one at a time as each feature ships using the admin API:

```
# List all flags (requires admin role)
GET /api/admin/feature-flags

# Toggle a single flag
PATCH /api/admin/feature-flags/<flag-name>
Body: { "enabled": true }
```

Or directly via Supabase SQL:
```sql
UPDATE feature_flags SET enabled = true, updated_at = now() WHERE flag = '<flag-name>';
```

> **Tip:** Always call `GET /api/admin/feature-flags` first to confirm the exact canonical flag names stored in the database before toggling in production. The names below match migrations 0037, 0041, and 0042 exactly, but verifying live state avoids surprises.

### Recommended enable order

**Location intelligence** (enable phases in sequence — each phase builds on the previous):
| Flag | Feature | Enable when |
|------|---------|-------------|
| `location_phase1_gps` | GPS capture + `user_location_state` upsert | Location service wired up in the mobile app |
| `location_phase2_zones` | Geo-zone detection | `geo_zones` table has data; zone matching logic shipped |
| `location_phase3_geofence` | Plan geofencing + check-ins | `plan_geofences` UI shipped; `plan_checkins` flow tested |
| `location_phase4_discovery` | Discovery location context | Discovery screen wired to user location |
| `location_phase5_pulse` | Pulse geo-tags | `pulse_geo_tags` ingestion shipped |
| `location_phase6_crew` | Trip crew map (depends on flags below) | All three `trip_crew_*` flags already on |

**Trip crew location** (can enable independently from the phases above):
| Flag | Feature | Enable when |
|------|---------|-------------|
| `trip_crew_map_enabled` | Crew map tab on trip detail | Map UI merged |
| `trip_crew_live_share_enabled` | Live-share sessions | Session expiry + member filtering tested |
| `trip_crew_ghost_mode_enabled` | Ghost mode toggle | Ghost-mode UI + audit events verified |

**Passport stamps** (enable in order):
| Flag | Feature | Enable when |
|------|---------|-------------|
| `passport_stamps_enabled` | Stamp earning + display | `passport_stamps` screen shipped |
| `passport_map_enabled` | Stamps on a map | Map view of stamps shipped |
| `passport_memories_enabled` | Suggested trip memories | Memory suggestion pipeline wired up |
| `passport_contribution_enabled` | Contribution event logging | Append-only events verified non-disruptive |

**Other flags seeded in 0037** (toggle as needed):
| Flag | Default | Notes |
|------|---------|-------|
| `safe_return_enabled` | false | Enable with `safe_return_trusted_circle_alerts_enabled` |
| `plan_geofence_full_enabled` | false | Full check-in geofence (migration 0039) |
| `notifications_digest_enabled` | false | Notification digest batching |
| `hidden_gems_enabled` | **true** | Already live |
| `telegraph_suggestions_enabled` | **true** | Already live |

## EAS Dev-Build & MapLibre — Manual Owner Steps

The project is scaffolded for EAS builds and MapLibre native maps. The following steps require the project owner to complete before triggering a real device build.

### Applied EAS monorepo fixes (already in the repo)

Four fixes are applied so EAS cloud builds detect pnpm and use the correct node-linker for React Native native modules (MapLibre, etc.):

| Fix | File | What it does |
|-----|------|--------------|
| `packageManager` field | `package.json` | Forces EAS/corepack to detect `pnpm@10.26.1` instead of guessing npm (eas-cli #2978 workaround) |
| `eas-build-pre-install` hook | `artifacts/travel-buddy/package.json` scripts | Runs `corepack enable` before install so pnpm is available on the EAS build server |
| `node-linker=hoisted` | `.npmrc` | Uses the hoisted linker so React Native native modules (MapLibre, etc.) resolve correctly; the isolated linker (pnpm default) breaks native module lookup |
| Metro config | `artifacts/travel-buddy/metro.config.js` | Already uses `getDefaultConfig` from `expo/metro-config` with only a blocklist and web shims — safe for monorepo, no changes needed |

> **Note:** The hoisted linker takes effect on the next fresh `pnpm install`. The existing Replit dev environment continues to work as-is.

### TODO (owner must finalize)

| Item | What to do |
|------|-----------|
| **Bundle ID / package name** | `com.travelbuddy.app` is a placeholder in `app.json`. Replace with your actual Apple App Store / Google Play identifier. |
| **`version`, `buildNumber`, `versionCode`** | Currently `1.0.0` / `1` / `1`. Bump as needed for each release. |
| **Apple / Google store setup** | Register the app on App Store Connect and Google Play Console before a production build. |
| **`eas login`** | Run `eas login` with the Expo account that owns the project. |
| **`eas init`** | Run `eas init` in `artifacts/travel-buddy/` to link this project to your EAS project ID and write `extra.eas.projectId` into `app.json`. |
| **MapTiler API key** | Create a free account at https://www.maptiler.com/, generate an API key, and set `EXPO_PUBLIC_MAPTILER_KEY` in `artifacts/travel-buddy/.env` (dev) and as an EAS secret (CI builds). |
| **iOS permission copy** | Review all `infoPlist` usage description strings in `app.json` and replace placeholder copy with your final wording before App Store submission. |

### EAS build commands (after completing the above)

```bash
# Development build — installs expo-dev-client, runs on a real device or simulator
eas build --profile development --platform ios
eas build --profile development --platform android

# Internal preview build
eas build --profile preview --platform all

# Production build (store submission)
eas build --profile production --platform all
```

### react-native-maps migration note

`react-native-maps` is still installed. It is used in:
- `src/components/itinerary/MapView.tsx`
- `src/components/discovery/DiscoveryMapView.tsx`
- `src/components/RouteMinimapView.tsx`
- `src/components/RouteFullMapModal.tsx`

TODO: Migrate all four components to `@maplibre/maplibre-react-native` as a follow-up task, then remove `react-native-maps`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
