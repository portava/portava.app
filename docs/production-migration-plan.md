# Production Migration Readiness Plan

Generated: 2026-07-03  
Scope: Tasks #120, #128, #137, #147, #172, #175, #214, #223, #235

---

## MIGRATION INVENTORY

| #  | Task | Migration file | Status | Features affected |
|----|------|---------------|--------|-------------------|
| 1  | #120 | `0015_blocks.sql` | **APPLIED** (2026-06-22) | User blocking, hidden profiles, filtered feeds |
| 2  | #128 | `0023_push_tokens.sql` | **APPLIED** (2026-06-22) | Push notification delivery |
| 3  | #128 | `0062_notifications_schema.sql` | **APPLIED** (2026-06-28) | Full notification pipeline (Activity Centre, push retry queue) |
| 4  | #137 | `0016_thread_reads.sql` | **APPLIED** (2026-06-22) | Unread badge on Messages tab |
| 5  | #235 | `0028_highlights_last_viewed.sql` | **APPLIED** (2026-06-26) | New Highlights badge count (`newHighlights` in unread-counts) |
| 6  | #147 | *(see note)* | **RESOLVED** — all tracked migrations applied | Various pending migrations from earlier sprint |
| 7  | #172 | *(see note)* | **RESOLVED** — all tracked migrations applied | Various pending migrations from earlier sprint |
| 8  | #175 | *(see note)* | **RESOLVED** — all tracked migrations applied | Various pending migrations from earlier sprint |
| 9  | #214 | meetups base schema | **APPLIED** (pre-0010, in initial schema) | Meetup creation, time-polls, availability nudges |
| 10 | #223 | *(no DB migration)* | **NOT_A_DB_MIGRATION** — filter state stored in AsyncStorage on device | Discovery filter/sort persistence |

**Notes on #147 / #172 / #175:** These tasks were created as generic "apply pending migrations" ship-blockers. All migrations they could have referenced (0015, 0016, 0023, 0062) are now applied. No additional migration files are associated with them.

**Note on #214 (meetup availability):** The meetup system base tables (`meetups`, `meetup_invites`, `meetup_rsvps`, `meetup_time_options`, `meetup_time_votes`) were created in the initial Supabase schema before the numbered migration sequence began (pre-0010). `0019_proposed_time.sql` (applied 2026-06-22) added `proposed_time` to `meetup_time_options`. `0022_availability_nudges.sql` (applied 2026-06-22) added the `availability_nudges` rate-limiting table. No additional availability migration is pending.

**Note on #223 (filter/sort persistence):** Grep across all API server routes and mobile source confirmed no `filter_preference`, `sort_preference`, `user_filter`, or `discovery_filter` table exists or is referenced. Discovery filter state is persisted client-side via AsyncStorage in the mobile app. No database migration is required.

---

## DUPLICATE MIGRATION NUMBER AUDIT

| Number | File A (applied) | File B | Resolution |
|--------|-----------------|--------|------------|
| 0043 | `0043_tags_hashtags.sql` (log entry — applied via dashboard; superseded by 0044_tags_hashtags) | `0043_hidden_gems.sql` (file on disk, applied 2026-06-29) | Both applied. No conflict — they create different tables. Duplicate number is historical. |
| 0044 | `0044_hashtag_reports.sql` (log entry — applied via dashboard; later superseded) | `0044_tags_hashtags.sql` (file on disk, applied 2026-06-29) | Both applied. Duplicate number is historical. |
| 0065 | `0065_events.sql` (log: applied 2026-06-30, no file on disk — applied via dashboard) | `0065_phase7_safety.sql` (file on disk, applied 2026-06-30) | Both applied. No conflict — different tables. |
| 0069 | `0069_collections.sql` (file on disk, applied 2026-06-30) | `0069_reviews.sql` (file on disk, applied 2026-06-30) | Both applied. Both files exist; were applied sequentially. |
| **0076** | `0076_profile_emergency_contacts.sql` (applied 2026-07-02, no file on disk) | `0076_wishlist_places.sql` **(was on disk — PENDING, CONFLICT)** | **FIXED:** `0076_wishlist_places.sql` renamed to `0088_wishlist_places.sql`. The original file must NOT be applied at number 0076 since that slot is occupied. |

---

## CLASSIFICATION TABLE

| Migration | Status | Risk | Idempotent? | Ship-blocking? | Notes |
|-----------|--------|------|-------------|----------------|-------|
| `0077_trips_expansion.sql` | PENDING | Low | Yes (IF NOT EXISTS, ADD COLUMN IF NOT EXISTS) | Yes — trips.ts reads `status='archived'`/`'draft'` | Purely additive: enum values + new nullable/defaulted columns |
| `0078_trip_members_expansion.sql` | PENDING | Low | Yes (IF NOT EXISTS + DO $$ blocks) | Yes — trip membership status/role logic | Additive: new enum values + columns with defaults; backfill UPDATE |
| `0079_trip_sub_tables.sql` | PENDING | Medium | Yes (IF NOT EXISTS, DROP POLICY IF EXISTS) | No — routes not yet wired for sub-resource tables | Depends on `can_see_trip()` function (pre-0010 schema) and `co_host` enum value from 0078 |
| `0080_events_extension.sql` | PENDING | Low | Yes (IF NOT EXISTS, DO $$ exception guards) | Yes — events.ts uses event_invites, event_cohosts, event_saves, event_drafts, event_reminders | Additive; adds columns to `events` and creates 10 new tables |
| `0081_stamp_system_v2.sql` | PENDING | Low | **Yes** (fixed: DROP POLICY IF EXISTS guards added) | Yes — StampAwardEngine.ts writes user_stamps, stamp_award_events | Was non-idempotent; fixed in this pass. Service-role policies added. |
| `0082_stamp_definitions_v2.sql` | PENDING | Low | Yes (ON CONFLICT DO NOTHING) | Yes — trip completion stamp slugs must exist | Inserts only; safe to re-run |
| `0083_place_category_columns.sql` | PENDING | Low | Yes (IF NOT EXISTS guards + WHERE NULL backfill) | Yes — Discovery category filtering uses primary_category | Additive column + backfill UPDATE |
| `0084_reviews_place_entity.sql` | PENDING | Low | Yes (DO $$ enum existence check) | Yes — POST /api/reviews with entityType='place' | Additive enum value + RLS policy |
| `0085_enable_passport_flags.sql` | PENDING | Low | Yes (ON CONFLICT DO UPDATE) | Yes — passport_stamps_enabled and stamp_system_v2_enabled must be true | Flag-only migration |
| `0086_discovery_places_osm_id.sql` | PENDING | Low | Yes (IF NOT EXISTS) | Yes — wishlist OSM save-count tracking | Additive column + index + column DEFAULT |
| `0088_wishlist_places.sql` | PENDING | Low | Yes (IF NOT EXISTS, DROP TRIGGER IF EXISTS) | Yes — wishlist save endpoint writes to this table | Renamed from 0076; creates new table |

---

## ORDERED PRODUCTION SQL APPLICATION PLAN

Apply in this exact order. Each migration depends on the ones before it.

### 1. `0077_trips_expansion.sql`
**What it does:** Extends `trip_status` enum with `draft`/`archived`; adds 14 new columns to `trips` (trip_type, timezone, lat/lng, privacy booleans, etc.)  
**Features depend on it:** Trip draft/archive states, privacy settings  
**Safety:** Purely additive. Existing rows unaffected (safe defaults). Enum ADD VALUE is transactional in PG14+.  
**Risk:** Low  
**Idempotent:** Yes  

### 2. `0078_trip_members_expansion.sql`
**What it does:** Extends `member_role` enum with `co_host`/`viewer`; adds `status`, `permissions`, `joined_at` to `trip_members`; backfills existing rows  
**Features depend on it:** Co-host role logic in trip routes and 0079 policies  
**Safety:** Additive. The backfill UPDATEs are safe — they only touch rows matching specific role values.  
**Risk:** Low  
**Idempotent:** Yes (ADD VALUE IF NOT EXISTS; ADD COLUMN IF NOT EXISTS)  

### 3. `0079_trip_sub_tables.sql`
**What it does:** Creates 11 trip sub-resource tables (budget, documents, join_requests, invite_links, saved_places, notes, checklists, checklist_items, activity_log, reminders, destinations)  
**Features depend on it:** Future trip sub-resource endpoints (not yet wired in routes)  
**Safety:** Purely additive. No modifications to existing tables.  
**Prerequisites:** 0078 must be applied first (policies reference `co_host` enum value). `can_see_trip()` helper function must exist in the DB (it was created in the initial schema — verify with query below before applying).  
**Risk:** Medium (if `can_see_trip()` is missing, all policy CREATE statements will fail)  
**Idempotent:** Yes (IF NOT EXISTS, DROP POLICY IF EXISTS)  

### 4. `0080_events_extension.sql`
**What it does:** Adds 6 columns to `events` table; creates 10 new event sub-tables (saves, invites, cohosts, posts, media, reports, activity_log, share_links, reminders, drafts); seeds 5 feature flags  
**Features depend on it:** Event invites, co-hosts, posts, media, reports, reminders, share links, draft autosave — all live in events.ts  
**Safety:** Additive. No modifications to existing tables beyond `events`.  
**Risk:** Low  
**Idempotent:** Yes  

### 5. `0081_stamp_system_v2.sql`
**What it does:** Creates stamp_definitions, user_stamps, stamp_award_events, stamp_progress, stamp_collections, stamp_collection_items, stamp_campaigns; 8 indexes; 2 feature flags; ~40 starter definitions  
**Features depend on it:** StampAwardEngine.ts, all stamp routes, trip completion stamp awards  
**Safety:** Additive.  
**Risk:** Low  
**Idempotent:** Yes (fixed in this pass — all policies now have DROP IF EXISTS guards; INSERT uses ON CONFLICT DO NOTHING)  

### 6. `0082_stamp_definitions_v2.sql`
**What it does:** Inserts 12 new stamp definition slugs; activates 4 existing definitions  
**Features depend on it:** Trip completion stamps (first_trip_created, first_trip_completed, solo_traveler, group_tripper, etc.)  
**Safety:** Pure INSERTs with ON CONFLICT DO NOTHING + idempotent UPDATEs  
**Prerequisites:** 0081 must be applied first  
**Risk:** Low  
**Idempotent:** Yes  

### 7. `0083_place_category_columns.sql`
**What it does:** Adds `primary_category` and `secondary_categories` to `discovery_places`; backfills from existing data; adds 2 indexes  
**Features depend on it:** Discovery category tab filtering (food/beaches/nightlife/etc.)  
**Safety:** Additive. Backfill only touches rows where `primary_category IS NULL`.  
**Risk:** Low  
**Idempotent:** Yes  

### 8. `0084_reviews_place_entity.sql`
**What it does:** Adds `place` value to `review_entity_type` enum; creates DELETE RLS policy for place reviews  
**Features depend on it:** `POST /api/reviews` with `entityType='place'`, place rating on Discovery cards  
**Safety:** Additive. ALTER TYPE ADD VALUE in idempotent DO $$ block.  
**Risk:** Low  
**Idempotent:** Yes  

### 9. `0085_enable_passport_flags.sql`
**What it does:** Enables `passport_stamps_enabled`, `passport_memories_enabled`, `stamp_system_v2_enabled`, `stamp_admin_award_enabled` feature flags  
**Features depend on it:** Passport stamps and memories visible to all users; stamp award engine active  
**Safety:** Flag-only. Apply AFTER 0081 and 0082 so tables exist when the engine activates.  
**Prerequisites:** 0081, 0082 must be applied first  
**Risk:** Low — if stamps engine has a bug, disable flags quickly via SQL: `UPDATE feature_flags SET enabled = false WHERE flag LIKE 'stamp%';`  
**Idempotent:** Yes (ON CONFLICT DO UPDATE)  

### 10. `0086_discovery_places_osm_id.sql`
**What it does:** Adds `osm_id TEXT` column + partial unique index to `discovery_places`; sets `DEFAULT ''` on `city` column  
**Features depend on it:** Wishlist OSM place save-count tracking  
**Safety:** Additive. The `city DEFAULT ''` change does not affect existing rows or queries — it only sets a default for new inserts.  
**Risk:** Low  
**Idempotent:** Yes  

### 11. `0088_wishlist_places.sql`
**What it does:** Creates `wishlist_places` table (user bookmarks with full place JSONB); adds TRUNCATE guard trigger  
**Features depend on it:** `POST/DELETE /api/discovery/wishlist` save endpoint  
**Safety:** Purely additive.  
**Risk:** Low  
**Idempotent:** Yes  

---

## PRE-APPLY VERIFICATION QUERIES

Run these in the Supabase SQL editor **before** applying to confirm prerequisites are met.

```sql
-- Confirm can_see_trip() function exists (required by 0079)
SELECT routine_name FROM information_schema.routines
WHERE routine_name = 'can_see_trip' AND routine_schema = 'public';

-- Confirm trips table exists (required by 0077)
SELECT table_name FROM information_schema.tables
WHERE table_name = 'trips' AND table_schema = 'public';

-- Confirm trip_members exists (required by 0078)
SELECT table_name FROM information_schema.tables
WHERE table_name = 'trip_members' AND table_schema = 'public';

-- Confirm events table exists (required by 0080)
SELECT table_name FROM information_schema.tables
WHERE table_name = 'events' AND table_schema = 'public';

-- Confirm feature_flags table exists (required by 0081, 0085)
SELECT table_name FROM information_schema.tables
WHERE table_name = 'feature_flags' AND table_schema = 'public';
```

---

## POST-APPLY VERIFICATION QUERIES

Run these in the Supabase SQL editor **after** applying to confirm each migration succeeded.

### After 0077
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'trips'
  AND column_name IN ('trip_type','timezone','destination_lat','destination_lng',
                      'show_on_profile','show_in_discovery','allow_join_requests',
                      'delayed_posting_default','precise_location_visible');
-- Expect: 9 rows

SELECT enumlabel FROM pg_enum
JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
WHERE pg_type.typname = 'trip_status' AND enumlabel IN ('draft','archived');
-- Expect: 2 rows
```

### After 0078
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'trip_members'
  AND column_name IN ('status','permissions','joined_at');
-- Expect: 3 rows

SELECT enumlabel FROM pg_enum
JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
WHERE pg_type.typname = 'member_role' AND enumlabel IN ('co_host','viewer');
-- Expect: 2 rows
```

### After 0079
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'trip_budget','trip_documents','trip_join_requests','trip_invite_links',
    'trip_saved_places','trip_notes','trip_checklists','trip_checklist_items',
    'trip_activity_log','trip_reminders','trip_destinations'
  );
-- Expect: 11 rows
```

### After 0080
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'events'
  AND column_name IN ('show_exact_location','rsvp_closed','safety_notes','tags',
                      'is_recurring','recurring_config','ticket_url','circle_id','trip_id');
-- Expect: 9 rows

SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'event_attendees','event_saves','event_invites','event_cohosts','event_posts',
    'event_media','event_reports','event_activity_log','event_share_links',
    'event_reminders','event_drafts'
  );
-- Expect: 11 rows

SELECT flag FROM feature_flags
WHERE flag IN ('events_invites_enabled','events_cohosts_enabled',
               'events_reports_enabled','events_reminders_enabled',
               'events_share_links_enabled','events_join_leave_enabled');
-- Expect: 6 rows
```

### After 0081
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'stamp_definitions','user_stamps','stamp_award_events',
    'stamp_progress','stamp_collections','stamp_collection_items','stamp_campaigns'
  );
-- Expect: 7 rows

SELECT COUNT(*) FROM stamp_definitions;
-- Expect: ~40

SELECT flag, enabled FROM feature_flags
WHERE flag IN ('stamp_system_v2_enabled','stamp_admin_award_enabled');
-- Expect: 2 rows, both enabled = false
```

### After 0082
```sql
SELECT slug FROM stamp_definitions
WHERE slug IN ('first_trip_created','first_trip_completed','solo_traveler',
               'group_tripper','weekend_wanderer','first_postcard',
               'safe_return_ready','safe_return_completed','first_buddy_booking',
               'first_buddy_hosted','hidden_gem_explorer','verified_traveler');
-- Expect: 12 rows

SELECT slug, is_active FROM stamp_definitions
WHERE slug IN ('road_warrior','frequent_flyer','long_haul','international_voyager');
-- Expect: 4 rows, all is_active = true
```

### After 0083
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'discovery_places'
  AND column_name IN ('primary_category','secondary_categories');
-- Expect: 2 rows

SELECT primary_category, COUNT(*) FROM discovery_places GROUP BY primary_category;
-- Should show distribution across categories; no NULL values
```

### After 0084
```sql
SELECT enumlabel FROM pg_enum
JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
WHERE pg_type.typname = 'review_entity_type' AND enumlabel = 'place';
-- Expect: 1 row
```

### After 0085
```sql
SELECT flag, enabled FROM feature_flags
WHERE flag IN ('passport_stamps_enabled','passport_memories_enabled',
               'stamp_system_v2_enabled','stamp_admin_award_enabled');
-- Expect: 4 rows, all enabled = true
```

### After 0086
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'discovery_places' AND column_name = 'osm_id';
-- Expect: 1 row

SELECT indexname FROM pg_indexes
WHERE tablename = 'discovery_places' AND indexname = 'discovery_places_osm_id_idx';
-- Expect: 1 row
```

### After 0088
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'wishlist_places';
-- Expect: 1 row

SELECT trigger_name FROM information_schema.triggers
WHERE event_object_table = 'wishlist_places'
  AND trigger_name = 'block_wishlist_places_truncate';
-- Expect: 1 row
```

---

## ROLLBACK / RISK NOTES

All 11 pending migrations are **purely additive** (new columns with defaults, new tables, new enum values, new indexes, flag seeds, or data inserts). None of them drop columns, drop tables, rename anything, or change constraints on existing rows.

**Safe rollback approaches:**

| Migration | Rollback if needed |
|-----------|-------------------|
| 0077 (enum values + columns) | Drop the new columns: `ALTER TABLE trips DROP COLUMN IF EXISTS trip_type, DROP COLUMN IF EXISTS timezone, ...`. Enum values cannot be removed in PostgreSQL without recreating the type — but since they have safe defaults, leaving them is harmless. |
| 0078 (enum values + columns) | Drop `status`, `permissions`, `joined_at` columns from `trip_members`. Enum values cannot be removed; leave them. |
| 0079 (11 new tables) | `DROP TABLE IF EXISTS trip_destinations, trip_reminders, ...` in reverse dependency order. |
| 0080 (columns + 10 new tables) | Drop the new `events` columns; drop the 10 new tables. |
| 0081 (7 new tables + seed data) | `DROP TABLE IF EXISTS stamp_campaigns, stamp_collection_items, stamp_collections, stamp_progress, stamp_award_events, user_stamps, stamp_definitions` in dependency order. |
| 0082 (data inserts only) | `DELETE FROM stamp_definitions WHERE slug IN (...)` for the 12 new slugs; `UPDATE stamp_definitions SET is_active = false WHERE slug IN (...)` for the 4 reactivated ones. |
| 0083 (2 new columns) | `ALTER TABLE discovery_places DROP COLUMN IF EXISTS primary_category, DROP COLUMN IF EXISTS secondary_categories`. |
| 0084 (enum value + policy) | Policy can be dropped: `DROP POLICY IF EXISTS "Authors can delete own place reviews" ON reviews`. Enum value cannot be removed. |
| 0085 (flag updates) | `UPDATE feature_flags SET enabled = false WHERE flag IN ('passport_stamps_enabled', 'passport_memories_enabled', 'stamp_system_v2_enabled', 'stamp_admin_award_enabled');` |
| 0086 (column + index) | `DROP INDEX IF EXISTS discovery_places_osm_id_idx; ALTER TABLE discovery_places DROP COLUMN IF EXISTS osm_id;` |
| 0088 (new table) | `DROP TABLE IF EXISTS wishlist_places;` |

**Highest-risk migration:** 0079 — it references `can_see_trip()` in 11 RLS policies. If that function doesn't exist in the target DB, all 11 `CREATE POLICY` statements will fail. Verify with the pre-apply query above before running this migration.

**Second-highest-risk:** 0085 — enabling stamp_system_v2 activates the award engine for all users. Apply this LAST after confirming 0081 and 0082 landed cleanly.

---

## REMAINING REAL SHIP BLOCKERS

After applying all 11 migrations above, the following features are still pending work:

| Feature | Blocker | What's missing |
|---------|---------|----------------|
| Trip sub-resource screens (budget, checklist, join requests) | Code — no routes wired | 0079 tables exist but API routes not yet implemented |
| Stamp auto-award for location/post events | Code — trigger not wired | Slugs like `city_explorer`, `globe_trotter` have `is_active=false`; automatic triggers not yet implemented |
| Filter/sort persistence across sessions | Code — mobile only | Discovery filters live in AsyncStorage; no server-side persistence is planned |
| `0087_profiles_cover_photo_url.sql` file | File missing from migrations/ | Migration was applied via dashboard on 2026-07-03 but no SQL file was committed. Recommend creating the file for documentation completeness. |

---

## VALIDATION RESULTS

| Check | Command | Result |
|-------|---------|--------|
| `typecheck` | `pnpm run typecheck` | **PASS** |
| `typecheck-standalone` | `cd travel-buddy-standalone && pnpm typecheck` | **PASS** |
| `source-drift` | `bash scripts/sync-standalone.sh --check-source` | **PASS** (0 drifted files) |
| `dep-drift` | `bash scripts/sync-standalone.sh --check-deps` | **PASS** |
| `db-triggers` | Requires `SUPABASE_PROJECT_TOKEN` — run manually | Not run (token not available in this environment) |

---

## FIXES APPLIED IN THIS PASS

| File | Fix |
|------|-----|
| `artifacts/api-server/src/migrations/0081_stamp_system_v2.sql` | (1) Fixed wrong header comment (said `0080`); (2) Added `DROP POLICY IF EXISTS` guards before all 12+ `CREATE POLICY` statements (idempotent); (3) Added `service_role` write policies to `user_stamps`, `stamp_award_events`, and `stamp_progress`; (4) Added `REVOKE SELECT (lat, lng) ON user_stamps FROM authenticated, anon` — DB-level column privilege restriction so PostgREST cannot expose precise location to any authenticated or anonymous caller regardless of RLS row filtering; service_role retains full access |
| `artifacts/api-server/src/migrations/0076_wishlist_places.sql` | Renamed to `0088_wishlist_places.sql` to resolve number collision with the already-applied `0076_profile_emergency_contacts.sql` |
| `docs/migrations.md` | Added `0088_wishlist_places.sql` entry (pending); updated `0081` description to note idempotency fix |
