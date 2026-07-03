# Supabase Production SQL Runbook — Beta Launch
*Source of truth: `docs/beta-closeout-report.md` (2026-07-03)*
*All steps below are manual. Nothing in this document has been applied to production yet.*

---

## Pre-apply Checklist

Before running any SQL, confirm every item below. Do not proceed until all are checked.

| # | Check | How to verify |
|---|-------|---------------|
| ☐ 1 | You are connected to the **production** Supabase project, not a dev/staging project | Supabase dashboard URL matches the `SUPABASE_URL` in `artifacts/api-server/.env` (`https://ajrurzioarfkagpuxfnb.supabase.co`) |
| ☐ 2 | You have access to **Supabase SQL Editor** with a service-role or admin postgres connection | Open Dashboard → SQL Editor and verify you can run `SELECT NOW();` |
| ☐ 3 | Last applied migration in production is **0087** | `SELECT MAX(name) FROM schema_migrations;` — or manually confirm `profiles.cover_photo_url` exists |
| ☐ 4 | No active writes to the database during migration window | Schedule a low-traffic window or put the API server in maintenance mode |
| ☐ 5 | You have read through each migration SQL below before executing it | — |
| ☐ 6 | All migration files are present in `artifacts/api-server/src/migrations/` | `ls artifacts/api-server/src/migrations/` shows 0077–0088 |

---

## Step 0 — Backup / Snapshot

**Supabase does not auto-snapshot before SQL Editor runs.**

> Manual action required before applying any migrations:
>
> 1. Go to **Supabase Dashboard → Database → Backups**
> 2. Trigger a **manual backup** (or confirm an automatic backup exists from today)
> 3. Record the backup ID/timestamp here before continuing: `_______________`
>
> If anything fails mid-run, restore from this backup. **Stop and restore before retrying any failing migration.**

---

## Migration Apply Order

Apply in exactly this order. Do not skip steps. Apply and verify one at a time.

```
0077 → 0078 → 0079 → 0080 → 0086 → 0088 → 0089 (inline) → 0085
```

---

## Migration 1 of 8 — `0077_trips_expansion.sql`

### What it does
- Adds `draft` and `archived` values to the `trip_status` enum
- Adds 14 new columns to the `trips` table: `trip_type`, `timezone`, `destination_lat`, `destination_lng`, `destination_place_id`, `trip_notes`, and 8 privacy/discoverability boolean columns

All new columns have safe defaults. Existing trip rows are not affected.

### Why beta needs it
- The trip edit screen writes `trip_notes`, `destination_lat/lng`, and privacy columns (`show_destination_city`, `show_exact_dates`, etc.). Without this migration, all privacy settings from the edit screen silently save to an API response but never persist in the database.
- The lifecycle routes (`/trips/me/past`, `/trips/me/active`) need `draft` and `archived` status values in the enum.

### Dependency / risk
- Must run before 0078 and 0079.
- Idempotent: all `ADD COLUMN IF NOT EXISTS` and `ADD VALUE IF NOT EXISTS` — safe to re-run.
- Enum `ADD VALUE` requires PostgreSQL 12+. Supabase runs Postgres 14+ — no issue.

### SQL to apply
Copy the full contents of `artifacts/api-server/src/migrations/0077_trips_expansion.sql` and paste into **Supabase SQL Editor → Run**.

```sql
-- Paste exact file contents of 0077_trips_expansion.sql
```

### Verification SQL — run after applying
```sql
-- Confirm new enum values
SELECT enumlabel
FROM pg_enum
JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
WHERE typname = 'trip_status'
ORDER BY enumlabel;
-- Expected output includes: archived, cancelled, completed, draft, in_progress, planned, planning

-- Confirm new columns on trips
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'trips'
  AND column_name IN (
    'trip_notes', 'trip_type', 'destination_lat', 'destination_lng',
    'show_destination_city', 'show_exact_dates', 'allow_join_requests'
  )
ORDER BY column_name;
-- Expected: 7 rows returned
```

> **Stop if:** The verification query returns fewer than 7 rows, or `trip_status` enum does not include `draft` and `archived`. Check for error output in SQL Editor before continuing.

---

## Migration 2 of 8 — `0078_trip_members_expansion.sql`

### What it does
- Adds `co_host` and `viewer` values to the `member_role` enum
- Adds three columns to `trip_members`: `status` (text, default `'accepted'`), `permissions` (JSONB), `joined_at` (timestamptz)
- Backfills `status = 'invited'` for existing rows where `role = 'invited'`
- Backfills `joined_at = created_at` for existing owner/member rows

### Why beta needs it
- Trip join-request approve/decline routes update `trip_members.status = 'accepted'`. Without this column, approve/decline returns a PostgreSQL error.
- The `requireTripMember` middleware reads `trip_members.status` to filter out pending invites.

### Dependency / risk
- Must run after 0077.
- Backfill is safe on existing data.
- The API server was already fixed to use `.neq("role","invited")` instead of enumerating `co_host`/`viewer` — so applying 0078 will not break currently-working routes.

### SQL to apply
Paste the full contents of `artifacts/api-server/src/migrations/0078_trip_members_expansion.sql` into Supabase SQL Editor.

### Verification SQL — run after applying
```sql
-- Confirm new enum values
SELECT enumlabel
FROM pg_enum
JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
WHERE typname = 'member_role'
ORDER BY enumlabel;
-- Expected: co_host, invited, member, owner, viewer

-- Confirm new columns on trip_members
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'trip_members'
  AND column_name IN ('status', 'permissions', 'joined_at')
ORDER BY column_name;
-- Expected: 3 rows

-- Confirm backfill ran
SELECT COUNT(*) FROM trip_members WHERE role = 'invited' AND status != 'invited';
-- Expected: 0 (all invited rows should now have status='invited')
```

> **Stop if:** `member_role` enum is missing `co_host` or `viewer`, or the column query returns fewer than 3 rows.

---

## Migration 3 of 8 — `0079_trip_sub_tables.sql`

### What it does
Creates 11 new trip sub-resource tables, each with RLS enabled and trip-member policies:

| Table | Purpose |
|-------|---------|
| `trip_budget` | One-row-per-trip budget tracker (currency, total, spent, breakdown JSONB) |
| `trip_documents` | Trip-scoped documents (itinerary, packing list, visa, insurance, other) |
| `trip_join_requests` | Join requests with status (pending/approved/declined/cancelled) |
| `trip_invite_links` | Shareable invite tokens with max_uses, expiry, revocation |
| `trip_saved_places` | Per-user place bookmarks within a trip |
| `trip_notes` | Trip-scoped notes (public or private to author) |
| `trip_checklists` | Named checklists per trip |
| `trip_checklist_items` | Individual checklist items with assignment + due date |
| `trip_activity_log` | Append-only audit log of trip events |
| `trip_reminders` | Per-user trip reminders with remind_at timestamp |
| `trip_destinations` | Multi-city destination list per trip |

### Why beta needs it
Every `trips-expansion.ts` sub-resource route (budget, documents, notes, checklists, join-requests, invite-links, saved-places, destinations) queries one of these tables. Without this migration, all such routes return:
`ERROR: relation "trip_budget" does not exist`

### Dependency / risk
- Must run after 0078 (the `co_host` role in policies references the expanded enum).
- All 11 `CREATE TABLE IF NOT EXISTS` — idempotent.
- `can_see_trip(trip_id)` helper function must exist (applied in an earlier migration). If any policy fails with "function does not exist", check that an earlier migration created `can_see_trip`.

### SQL to apply
Paste the full contents of `artifacts/api-server/src/migrations/0079_trip_sub_tables.sql` into Supabase SQL Editor.

### Verification SQL — run after applying
```sql
-- Confirm all 11 tables created
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'trip_budget', 'trip_documents', 'trip_join_requests',
    'trip_invite_links', 'trip_saved_places', 'trip_notes',
    'trip_checklists', 'trip_checklist_items', 'trip_activity_log',
    'trip_reminders', 'trip_destinations'
  )
ORDER BY table_name;
-- Expected: 11 rows

-- Confirm RLS is enabled on all tables
SELECT tablename, rowsecurity
FROM pg_tables
WHERE tablename IN (
    'trip_budget', 'trip_documents', 'trip_join_requests',
    'trip_invite_links', 'trip_saved_places', 'trip_notes',
    'trip_checklists', 'trip_checklist_items', 'trip_activity_log',
    'trip_reminders', 'trip_destinations'
  )
ORDER BY tablename;
-- Expected: 11 rows, all with rowsecurity = true
```

> **Stop if:** Fewer than 11 tables returned, or any table has `rowsecurity = false`. Check SQL Editor for the failing CREATE TABLE statement.

---

## Migration 4 of 8 — `0080_events_extension.sql`

### What it does
Extends the `events` table with new columns and creates 10 new event sub-tables:

**New columns on `events`:**
- `show_exact_location` (boolean, default false)
- `rsvp_closed` (boolean, default false)
- `safety_notes` (text)
- `tags` (text[], default `{}`)
- `is_recurring` (boolean, default false)
- `recurring_config` (JSONB)
- `ticket_url` (text)
- `circle_id` (UUID)
- `trip_id` (UUID)

**New tables:**

| Table | Purpose |
|-------|---------|
| `event_attendees` | Confirmed attendees (denormalised from RSVP) |
| `event_saves` | User saves/bookmarks for events |
| `event_invites` | Per-user invitations to events |
| `event_cohosts` | Co-host assignments |
| `event_posts` | Posts scoped to an event |
| `event_media` | Media attached to events |
| `event_reports` | Moderation reports for events |
| `event_activity_log` | Append-only event audit log |
| `event_share_links` | Shareable event links |
| `event_reminders` | Per-user event reminders |

Also seeds event-related feature flags in `feature_flags`.

### Why beta needs it
All extended `events.ts` routes (invites, co-hosts, posts, media, reports, drafts, share-links, reminders) query these tables. Without this migration, those routes return "relation does not exist" errors. Core event CRUD and RSVP already work — this migration unblocks the extended events feature surface.

### Dependency / risk
- Must run after 0079.
- All `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` — idempotent.
- The `event_roles` table is referenced in a policy (`event_attendees_participant_read`). If `event_roles` does not exist, this policy will fail. Wrap the failing policy in a `DO $$ BEGIN ... EXCEPTION WHEN others THEN NULL; END $$` block if needed (the migration already does this with `DO $$ BEGIN` blocks).

### SQL to apply
Paste the full contents of `artifacts/api-server/src/migrations/0080_events_extension.sql` into Supabase SQL Editor.

### Verification SQL — run after applying
```sql
-- Confirm new columns on events
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'events'
  AND column_name IN ('show_exact_location', 'rsvp_closed', 'safety_notes', 'tags', 'ticket_url')
ORDER BY column_name;
-- Expected: 5 rows

-- Confirm all 10 new event tables
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'event_attendees', 'event_saves', 'event_invites', 'event_cohosts',
    'event_posts', 'event_media', 'event_reports', 'event_activity_log',
    'event_share_links', 'event_reminders'
  )
ORDER BY table_name;
-- Expected: 10 rows

-- Confirm feature flag seeds from 0080
SELECT flag, enabled
FROM feature_flags
WHERE flag LIKE 'event%'
ORDER BY flag;
-- Expected: at least 1 row (event-specific feature flags)
```

> **Stop if:** Fewer than 5 columns on `events`, or fewer than 10 new event tables. Check SQL Editor error output for the specific failing statement.

---

## Migration 5 of 8 — `0086_discovery_places_osm_id.sql`

### What it does
- Adds `osm_id` (text, nullable) column to `discovery_places`
- Creates a partial unique index `discovery_places_osm_id_idx ON discovery_places(osm_id) WHERE osm_id IS NOT NULL`
- Sets `DEFAULT ''` on the `city` column (so OSM-sourced rows can be inserted without a city name)

### Why beta needs it
`wishlist.ts` calls `trackOsmPlaceSave()` which upserts a row into `discovery_places` using `ON CONFLICT (osm_id)`. Without the `osm_id` column, this upsert fails with a column-not-found error for any OSM-sourced place (Overpass API results). All wishlist saves for OSM places fail until this is applied.

### Dependency / risk
- Must run before 0088.
- `ADD COLUMN IF NOT EXISTS` and `CREATE UNIQUE INDEX IF NOT EXISTS` — idempotent.
- Partial unique index: existing rows with `osm_id IS NULL` are unaffected.

### SQL to apply
Paste the full contents of `artifacts/api-server/src/migrations/0086_discovery_places_osm_id.sql` into Supabase SQL Editor.

```sql
ALTER TABLE discovery_places
  ADD COLUMN IF NOT EXISTS osm_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS discovery_places_osm_id_idx
  ON discovery_places (osm_id)
  WHERE osm_id IS NOT NULL;

ALTER TABLE discovery_places
  ALTER COLUMN city SET DEFAULT '';
```

### Verification SQL — run after applying
```sql
-- Confirm column exists
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'discovery_places'
  AND column_name = 'osm_id';
-- Expected: 1 row, data_type = text, is_nullable = YES

-- Confirm partial unique index exists
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'discovery_places'
  AND indexname = 'discovery_places_osm_id_idx';
-- Expected: 1 row

-- Confirm city column has default
SELECT column_name, column_default
FROM information_schema.columns
WHERE table_name = 'discovery_places'
  AND column_name = 'city';
-- Expected: column_default = ''
```

> **Stop if:** `osm_id` column does not appear, or the index is missing. The wishlist save flow will fail for OSM places without this.

---

## Migration 6 of 8 — `0088_wishlist_places.sql`

### What it does
- Creates the `wishlist_places` table with columns: `id`, `user_id`, `place_id`, `place_data` (JSONB), `list_id`, `saved_at`
- Enables RLS with an owner-only `FOR ALL` policy
- Creates index `wishlist_places_user_list_idx ON wishlist_places(user_id, list_id, saved_at DESC)`
- Creates `prevent_wishlist_places_truncate()` function and `block_wishlist_places_truncate` trigger (prevents accidental TRUNCATE from wiping all wishlists)

### Why beta needs it
Every wishlist route depends on this table:
- `GET /api/wishlist` → SELECT from `wishlist_places`
- `POST /api/wishlist` → INSERT into `wishlist_places`
- `DELETE /api/wishlist/:placeId` → DELETE from `wishlist_places`

Without this migration, all three routes return: `ERROR: relation "wishlist_places" does not exist`

### Dependency / risk
- Must run after 0086 (`osm_id` index must exist before the wishlist insert uses the upsert on `discovery_places`).
- `CREATE TABLE IF NOT EXISTS` — idempotent.
- The API server uses the **service role key** to write to this table (bypasses RLS). The RLS policy is a belt-and-suspenders guard for any direct database access.

### SQL to apply
Paste the full contents of `artifacts/api-server/src/migrations/0088_wishlist_places.sql` into Supabase SQL Editor.

### Verification SQL — run after applying
```sql
-- Confirm table exists
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'wishlist_places';
-- Expected: 1 row

-- Confirm RLS is enabled
SELECT tablename, rowsecurity
FROM pg_tables
WHERE tablename = 'wishlist_places';
-- Expected: rowsecurity = true

-- Confirm index exists
SELECT indexname
FROM pg_indexes
WHERE tablename = 'wishlist_places' AND indexname = 'wishlist_places_user_list_idx';
-- Expected: 1 row

-- Confirm trigger exists
SELECT trigger_name, event_manipulation, event_object_table
FROM information_schema.triggers
WHERE trigger_name = 'block_wishlist_places_truncate';
-- Expected: 1 row

-- Confirm function exists
SELECT routine_name
FROM information_schema.routines
WHERE routine_name = 'prevent_wishlist_places_truncate';
-- Expected: 1 row
```

> **Stop if:** Any of the 5 checks above returns 0 rows. All 5 objects must exist before continuing.

---

## Migration 7 of 8 — `decrement_discovery_place_saved_count` function (inline SQL)

### What it does
Creates the `decrement_discovery_place_saved_count(p_id uuid)` PostgreSQL function.
This function atomically decrements `discovery_places.saved_count` for a given place row ID, floors at 0, and returns the new count.

### Why beta needs it
`wishlist.ts` DELETE route calls:
```
svc.rpc("decrement_discovery_place_saved_count", { p_id: <discovery_places.id> })
```
Without this function, unwishlisting any DB-sourced place returns:
`ERROR: function decrement_discovery_place_saved_count(uuid) does not exist`

### Note on file status
**There is no `0089_*.sql` file in `artifacts/api-server/src/migrations/`.** This function must be applied manually using the inline SQL below. This is a known gap in the migration file inventory — the function is referenced in code but its creation SQL was never committed to a migration file.

### SQL to apply
Copy and paste this SQL directly into **Supabase SQL Editor → Run**:

```sql
CREATE OR REPLACE FUNCTION decrement_discovery_place_saved_count(p_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_count integer;
BEGIN
  UPDATE discovery_places
  SET saved_count = GREATEST(0, COALESCE(saved_count, 0) - 1)
  WHERE id = p_id
  RETURNING saved_count INTO new_count;

  RETURN COALESCE(new_count, 0);
END;
$$;
```

### Verification SQL — run after applying
```sql
-- Confirm function exists with correct signature
SELECT routine_name, data_type AS return_type
FROM information_schema.routines
WHERE routine_name = 'decrement_discovery_place_saved_count'
  AND routine_schema = 'public';
-- Expected: 1 row, return_type = integer

-- Smoke test (does not change any real row — replace with a real discovery_places.id if available)
-- This is safe to run: GREATEST(0,...) means no row goes negative
-- If you have a real place row:
-- SELECT decrement_discovery_place_saved_count('<real-uuid-here>');
```

> **Stop if:** The function does not appear in `information_schema.routines`. Do not proceed to 0085 until the wishlist unsave path is fully unblocked.

---

## Migration 8 of 8 — `0085_enable_passport_flags.sql`

### What it does
Sets the following feature flags to `enabled = true` in the `feature_flags` table (using `ON CONFLICT DO UPDATE` — safe to re-run):

| Flag | Feature |
|------|---------|
| `passport_stamps_enabled` | Passport stamps for all users |
| `passport_memories_enabled` | Passport memories for all users |
| `stamp_system_v2_enabled` | Stamp system v2 tables (requires 0081 for full effect) |
| `stamp_admin_award_enabled` | Admin stamp award endpoint |

### Why beta needs it
Migrations 0037 and 0042 seeded `passport_stamps_enabled` and `passport_memories_enabled` as `false` (feature-gate defaults). Without 0085, the passport stamps and memories features are globally disabled for all users, even though the UI, routes, and tables are fully deployed.

### Dependency / risk
- Apply last — after all table-creating migrations are confirmed.
- `ON CONFLICT (flag) DO UPDATE SET enabled = true` — idempotent, safe to re-run.
- **`stamp_system_v2_enabled` will become `true`** via this migration, but the stamp system v2 routes are gated by a separate check that also verifies the `stamp_definitions` table exists (from migration 0081, which is NOT applied yet). Setting the flag will not break anything — stamps routes will still return 503 until 0081 is applied separately.

### SQL to apply
Paste the full contents of `artifacts/api-server/src/migrations/0085_enable_passport_flags.sql` into Supabase SQL Editor.

```sql
INSERT INTO feature_flags (flag, enabled, description)
VALUES
  ('passport_stamps_enabled',    true, 'Passport stamps feature'),
  ('passport_memories_enabled',  true, 'Passport memories feature'),
  ('stamp_system_v2_enabled',    true, 'Stamp system v2 (user_stamps table)'),
  ('stamp_admin_award_enabled',  true, 'Admin stamp award endpoint')
ON CONFLICT (flag) DO UPDATE SET enabled = true;
```

### Verification SQL — run after applying
```sql
SELECT flag, enabled
FROM feature_flags
WHERE flag IN (
  'passport_stamps_enabled',
  'passport_memories_enabled',
  'stamp_system_v2_enabled',
  'stamp_admin_award_enabled'
)
ORDER BY flag;
-- Expected: 4 rows, all with enabled = true
```

> **Stop if:** Any of the 4 flags shows `enabled = false`. The passport stamps / memories UI will remain globally disabled.

---

## Storage Bucket Setup

Supabase Storage buckets must be created manually via the Supabase Dashboard.

### How to create a bucket
1. Go to **Supabase Dashboard → Storage**
2. Click **New bucket**
3. Set the bucket name exactly as listed below
4. Set **Public bucket: ON** for all three buckets
5. Leave file size and MIME type limits at default unless you have specific requirements
6. Click **Create bucket**

---

### Bucket 1 — `profile-media`

| Property | Value |
|----------|-------|
| Bucket name | `profile-media` |
| Visibility | **Public** |
| Used by | Avatar upload (`POST /api/me/profile/avatar`), cover photo upload (`POST /api/me/profile/cover`) |
| Path convention | `avatars/{userId}/{uuid}.{ext}`, `covers/{userId}/{uuid}.{ext}` |
| Notes | `profile.ts` calls `ensureStorageBucket("profile-media")` at startup, which attempts to auto-create via service role. The bucket still needs to exist — `ensureStorageBucket` only handles the case where creation is idempotent, not the case where the API server lacks bucket-create permission. |

**Verification:**
```
Supabase Dashboard → Storage → confirm "profile-media" appears in bucket list
```
Or via API:
```bash
curl -H "apikey: <SUPABASE_ANON_KEY>" \
  https://ajrurzioarfkagpuxfnb.supabase.co/storage/v1/bucket \
  | grep profile-media
```

---

### Bucket 2 — `post-media`

| Property | Value |
|----------|-------|
| Bucket name | `post-media` |
| Visibility | **Public** |
| Used by | Post image/video upload (`POST /api/media/upload`) |
| Path convention | `posts/{userId}/{uuid}.{ext}` |
| Accepted types | `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `video/mp4` (enforced in route) |
| Notes | No auto-create logic — bucket must exist before any post upload is attempted |

**Verification:**
```
Supabase Dashboard → Storage → confirm "post-media" appears in bucket list
```

---

### Bucket 3 — `memories`

| Property | Value |
|----------|-------|
| Bucket name | `memories` |
| Visibility | **Public** |
| Used by | Memory media deletion cleanup (`DELETE /api/memories/:id` removes storage file on delete) |
| Path convention | `{userId}/{uuid}.{ext}` (from memory media upload path) |
| Notes | Not auto-created. If the bucket is missing, memory delete will throw a storage error (non-fatal — the DB row is still deleted, but the orphaned file warning will appear in logs) |

**Verification:**
```
Supabase Dashboard → Storage → confirm "memories" appears in bucket list
```

> **Stop if:** Any of the three buckets is missing after the creation step. The related upload/delete routes will fail in production without them.

---

## Required Environment Variables

Set these on the **deployed API server** (not just the local `.env` file). If you are deploying via Replit Deployments, set them in the Deployment environment variable panel.

### Critical — app is broken without these

| Variable | Where to get it | Used by |
|----------|----------------|---------|
| `SUPABASE_URL` | Supabase Dashboard → Settings → API → Project URL | All DB routes |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Settings → API → `service_role` key (secret) | All DB writes, storage uploads |
| `SESSION_SECRET` | Any strong random string (already set as Replit secret) | Express session middleware |
| `PORT` | Set by workflow config (default 8080) | Express listen |

> **Verify `SUPABASE_SERVICE_ROLE_KEY` is set:** `GET /api/healthz` should return HTTP 200. If it returns 503 with `{"error":"service unavailable"}`, the service role key is missing or wrong.

### Important — AI features and admin routes degrade without these

| Variable | Where to get it | What breaks if missing |
|----------|----------------|----------------------|
| `AI_INTEGRATIONS_OPENAI_API_KEY` | Replit AI Integrations proxy (see `.local/skills/ai-integrations-openai`) | Telegraph AI chat, Daily Brief generation, Compass feed |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | Same as above | Same |
| `COMPASS_TOKEN_SECRET` | Any strong random string | Compass feed token validation fails; Compass returns 401 |
| `INTERNAL_API_SECRET` | Any strong random string | Internal admin API calls rejected |

### Mobile app — must be set in `travel-buddy-standalone/.env.local`

| Variable | Value |
|----------|-------|
| `EXPO_PUBLIC_SUPABASE_URL` | Same as `SUPABASE_URL` |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase Dashboard → Settings → API → `anon` key (use `sb_publishable_*` format) |
| `EXPO_PUBLIC_API_BASE_URL` | Deployed API server URL (e.g. `https://your-app.replit.app/api`) |

### Tunable — have safe defaults, set if you want custom values

| Variable | Default | Description |
|----------|---------|-------------|
| `DAILY_BRIEF_RETENTION_DAYS` | `60` | Days to keep daily brief rows |
| `DAILY_BRIEF_CLEANUP_INTERVAL_HOURS` | `24` | How often the cleanup job runs |
| `WEATHER_CACHE_RETENTION_HOURS` | Internal default | Weather cache TTL |
| `MUTE_RATE_LIMIT_PER_DAY` | Internal default | Mute actions per user per day |
| `REPORT_RATE_LIMIT_PER_HOUR` | Internal default | Report submissions per user per hour |
| `LOG_LEVEL` | `info` | Pino log level (`debug`, `info`, `warn`, `error`) |
| `NODE_ENV` | `development` | Set to `production` in deployment |
| `TICKETMASTER_API_KEY` | — | External event discovery; returns empty results if missing |
| `TRANSLATION_ENABLED` | `false` | Enable/disable message translation pipeline |

---

## Admin User Bootstrap

At least one user must have `role = 'admin'` in the `profiles` table for admin routes to work (`/api/admin/*`, `/api/feature-flags`, stamp award admin).

### Step 1 — Find the user to promote

```sql
-- Find by email (replace with the admin user's email)
SELECT id, email, username, role
FROM profiles
WHERE email = 'your-admin-email@example.com';
-- Note the UUID in the id column
```

If profiles does not have an email column, query via auth.users:
```sql
SELECT p.id, p.username, p.role, u.email
FROM profiles p
JOIN auth.users u ON u.id = p.id
WHERE u.email = 'your-admin-email@example.com';
```

### Step 2 — Promote to admin

```sql
-- Replace the UUID with the actual user ID from Step 1
UPDATE profiles
SET role = 'admin'
WHERE id = '<paste-user-uuid-here>';
```

> **Caution:** Only promote users you intend to have full admin access. Admin routes include: moderation actions, feature flag control, stamp award, compass config.

### Step 3 — Verify

```sql
SELECT id, username, role
FROM profiles
WHERE role = 'admin';
-- Expected: at least 1 row
```

> **Stop if:** 0 rows returned. Admin routes (`GET /api/feature-flags`, `POST /api/admin/*`) will return 403 for all users until an admin exists.

---

## Final Post-Apply Verification Checklist

Run all queries below in **Supabase SQL Editor** after all steps above are complete.

```sql
-- ── 1. Trip sub-resource tables (0079) ────────────────────────────────────────
SELECT COUNT(*) AS trip_sub_table_count
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'trip_budget', 'trip_documents', 'trip_join_requests',
    'trip_invite_links', 'trip_saved_places', 'trip_notes',
    'trip_checklists', 'trip_checklist_items', 'trip_activity_log',
    'trip_reminders', 'trip_destinations'
  );
-- Expected: 11

-- ── 2. Event extension tables (0080) ──────────────────────────────────────────
SELECT COUNT(*) AS event_ext_table_count
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'event_attendees', 'event_saves', 'event_invites', 'event_cohosts',
    'event_posts', 'event_media', 'event_reports', 'event_activity_log',
    'event_share_links', 'event_reminders'
  );
-- Expected: 10

-- ── 3. Wishlist table (0088) ───────────────────────────────────────────────────
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'wishlist_places';
-- Expected: 1 row

-- ── 4. OSM column (0086) ──────────────────────────────────────────────────────
SELECT column_name FROM information_schema.columns
WHERE table_name = 'discovery_places' AND column_name = 'osm_id';
-- Expected: 1 row

-- ── 5. Decrement RPC (inline) ─────────────────────────────────────────────────
SELECT routine_name FROM information_schema.routines
WHERE routine_name = 'decrement_discovery_place_saved_count';
-- Expected: 1 row

-- ── 6. Passport feature flags (0085) ──────────────────────────────────────────
SELECT flag, enabled FROM feature_flags
WHERE flag IN ('passport_stamps_enabled', 'passport_memories_enabled')
ORDER BY flag;
-- Expected: 2 rows, both enabled = true

-- ── 7. Trip expansion columns (0077) ──────────────────────────────────────────
SELECT COUNT(*) AS trip_col_count FROM information_schema.columns
WHERE table_name = 'trips'
  AND column_name IN ('trip_notes', 'trip_type', 'destination_lat', 'show_destination_city');
-- Expected: 4

-- ── 8. Trip member expansion (0078) ───────────────────────────────────────────
SELECT COUNT(*) AS tm_col_count FROM information_schema.columns
WHERE table_name = 'trip_members' AND column_name IN ('status', 'permissions', 'joined_at');
-- Expected: 3

-- ── 9. Admin user ─────────────────────────────────────────────────────────────
SELECT COUNT(*) AS admin_count FROM profiles WHERE role = 'admin';
-- Expected: >= 1

-- ── 10. All flags summary ─────────────────────────────────────────────────────
SELECT flag, enabled FROM feature_flags
WHERE flag IN (
  'passport_stamps_enabled', 'passport_memories_enabled',
  'stamp_system_v2_enabled', 'stamp_admin_award_enabled'
)
ORDER BY flag;
-- Expected: 4 rows, all enabled = true
```

> **All 10 checks must pass before opening the app to beta users.**
> If any check fails, re-apply the corresponding migration and re-run the check before continuing.

---

## Smoke Test Checklist

After all migrations and setup steps are applied, perform these manual tests with a real device on the production build:

| # | Test | Pass criteria |
|---|------|--------------|
| ☐ 1 | **Create a trip** | Trip appears in Trips tab; title, destination, dates saved correctly |
| ☐ 2 | **Edit trip** | Open trip → Edit → change title + destination → save → changes persist on reload |
| ☐ 3 | **Trip privacy settings** | Edit trip → toggle "Show destination city" → save → verify via a second account's view |
| ☐ 4 | **Delete trip** | Trip disappears from Trips tab |
| ☐ 5 | **Add trip plan item** | Trip detail → Plan tab → add item → item appears in list |
| ☐ 6 | **Trip join request** | Second user requests to join a private trip → first user sees and approves → second user appears in member list |
| ☐ 7 | **Event invite** | Create event → invite a user → invited user sees event in notification/inbox |
| ☐ 8 | **Event co-host** | Add co-host to event → co-host sees elevated access |
| ☐ 9 | **Event media upload** | Attach media to event → media appears in event detail |
| ☐ 10 | **Save place to wishlist** | Tap save on a discovery place (OSM or DB-sourced) → appears in wishlist |
| ☐ 11 | **Unsave wishlist place** | Remove saved place → disappears from wishlist → `saved_count` decrements |
| ☐ 12 | **Passport stamps load** | Navigate to Passport tab → stamps section loads without error |
| ☐ 13 | **Passport memories load** | Passport tab → memories section loads without error |
| ☐ 14 | **Upload profile photo** | Edit Profile → upload avatar → new photo appears in profile header |
| ☐ 15 | **Upload post media** | Create post with image → image appears in post feed |
| ☐ 16 | **Admin route access** | Log in as admin user → `GET /api/feature-flags` returns 200 with flag list (not 403) |
| ☐ 17 | **Non-admin route blocked** | Log in as regular user → `GET /api/feature-flags` returns 403 |
| ☐ 18 | **Blocked user not in My Circle** | Block a user → they no longer appear in My Circle list |
| ☐ 19 | **Unblock from profile** | View blocked user's profile → tap Unblock → user is unblocked |
| ☐ 20 | **Accept trip invite navigates** | Trips tab → pending invite → accept → lands on trip detail screen |

---

## What NOT to Apply Yet

The following migrations and features are intentionally deferred. Do not apply them as part of the beta launch.

| Item | Why deferred | When to apply |
|------|-------------|---------------|
| **`0081_stamp_system_v2.sql`** | Stamp system v2 tables — routes are gated by `stamp_system_v2_enabled` flag and return 503 cleanly. Feature is not in beta scope. | When stamp system v2 is ready for users |
| **`0082_stamp_definitions_v2.sql`** | Seeds stamp definitions — depends on 0081 tables existing | Apply immediately after 0081 |
| **RAB 501 stubs** (reschedule, dispute CRUD, refund-eligibility, no-show in `rentABuddy.ts`) | Payment/dispute module not implemented. No UI calls these routes. | When payment module is built |
| **`upsert_city_stamp` and `increment_counter` functions** | Not found in any local migration file. Origin unknown. Referenced only by stamp system (gated) and hidden gems feature. Not blocking for beta. | Verify in Supabase dashboard; write migration files if found missing |
| **Redis / queue infrastructure** | `REDIS_URL` env var is referenced in code but no active Redis usage found. All background work is in-process `setInterval`. | When scale requires it |
| **Translation pipeline** | `TRANSLATION_ENABLED` defaults to `false`. No beta requirement. | When translation feature is ready |

---

*Runbook generated 2026-07-03. Source: `docs/beta-closeout-report.md`.*
*All SQL is idempotent where noted — safe to re-run if a step was interrupted.*
*Confirm production status of every item in this document in the Supabase dashboard before treating any step as complete.*
