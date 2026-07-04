# Travel Buddy — SQL / Backend Database Audit
**Date:** 2026-07-04  
**Method:** Static analysis of all migration files, backend route files, and frontend service interfaces.  
**Scope:** Full stack — migrations → API routes → frontend services.

---

## Executive Summary

The schema is broadly healthy for the core features (trips, posts, messaging, stamps v2, rent-a-buddy). However several significant gaps were found:

| Severity | Count | Examples |
|----------|-------|---------|
| P0 — Security / Privacy | 3 | Thread-ID type mismatch; no generated DB types; GPS coordinate leakage risk |
| P1 — UI broken / insert failures | 2 | `post_saves`, `posts.category`, and translation profile columns **applied manually 2026-07-04** and wired to backend. Remaining: `trust_score` column missing; `post_impressions` table unconfirmed |
| P2 — Schema/code mismatch | 5 | TripRow missing 15+ DB columns; redundant report tables; notification migration dupe |
| P3 — Performance / integrity | 4 | Missing indexes on hashtag_usage, notifications, posts |
| P4 — Future / analytics | 4 | Compass logs; RAB payments; stamp artwork; recommendation analytics |

**9 migration files exist on disk but are NOT logged in `docs/migrations.md`** — applied status in production is unknown for: `0027`, `0030`, `0031`, `0038`, `0040`, `0095`, `20260620`, `20260621`, `20260702`.

---

## 1. Migration Inventory

### 1a. Files in `artifacts/api-server/migrations/` — status in `docs/migrations.md`

| File | Logged as Applied | Notes |
|------|:-----------------:|-------|
| 0011–0026 | ✅ | Core spine, messaging, posts engagement, discovery |
| 0027_verification_status | ❌ **MISSING FROM LOG** | Adds `profiles.verification_status` |
| 0028–0029 | ✅ | |
| 0030_message_reports | ❌ **MISSING FROM LOG** | Older per-message report table |
| 0031_thread_reports | ❌ **MISSING FROM LOG** | Older per-thread report table (thread_id TEXT — see P0) |
| 0032–0039 | ✅ | |
| 0040_safe_return | ❌ **MISSING FROM LOG** | Safe Return session tables |
| 0041–0094 | ✅ | |
| 0095_post_category | ❌ **PENDING** | Adds `posts.category` column — used by POST /api/posts |
| 20260620_telegraph_intelligence | ❌ **PENDING** | Telegraph intent/suggestion tables |
| 20260621_weather_cache | ❌ **PENDING** | `weather_cache` table |
| 20260702_crew_location_flags_reseed | ❌ **PENDING** | Reseeds crew location feature flags |

**Action required:** Verify which of the unlisted files are applied in production. If 0040 is not applied, Safe Return has no schema. If 0095 is not applied, `POST /api/posts` with a category will fail with "column does not exist".

### 1b. No Generated Database Types

No `database.types.ts` or Supabase type export exists anywhere in the project. The API server's `supabase.ts` client is initialized without type parameters. This means **all table/column access is untyped** — typos in column names produce silent `undefined` responses rather than compile errors.

**Recommendation:** Run `supabase gen types typescript --project-id <id> > lib/database.types.ts` and wire it into `createClient<Database>(...)`.

---

## 2. Feature-by-Feature Findings

### A. Auth / Profiles / Onboarding

**Tables confirmed:** `profiles`, `profile_privacy_settings`, `user_deletion_requests`, `user_preference_profiles`

| Column | In DB | In API | Notes |
|--------|:-----:|:------:|-------|
| `display_name` | ✅ (mig 0087) | ✅ | Fallback code in routes suggests it may be missing in some envs |
| `username` / `handle` | ✅ | ✅ | |
| `avatar_url` | ✅ | ✅ | |
| `bio` | ✅ | ✅ | |
| `home_city` / `home_country` | ✅ | ✅ | |
| `current_city` | ✅ | ✅ | |
| `spoken_languages` / `default_language` | ✅ | ✅ | |
| `travel_style` / `travel_styles` | ✅ | ✅ | |
| `interests` | ✅ | ✅ | |
| `date_of_birth` / `dob_verified` | ✅ | ✅ | |
| `verification_status` / `verified_at` | ✅ (mig 0027) | ✅ | 0027 not in log — verify applied |
| `trust_score` (current value) | ❌ **MISSING** | ❌ | No column on `profiles`; no dedicated `user_trust_scores` table confirmed |
| `account_status` / deactivation | ✅ (mig 0094) | ✅ | `user_account_states` table added in 0094 |
| **`preferred_message_language`** | ✅ **APPLIED** | ✅ read | Applied manually 2026-07-04; `messaging.ts` reads it |
| **`auto_translate_messages`** | ✅ **APPLIED** | ✅ read | Applied manually 2026-07-04 |
| **`show_original_messages`** | ✅ **APPLIED** | ✅ read | Applied manually 2026-07-04 |
| **`translation_updated_at`** | ✅ **APPLIED** | ✅ read | Applied manually 2026-07-04 |
| **`tag_permission`** | ✅ **APPLIED** | ✅ read | Applied manually 2026-07-04; `telegraph.ts` checks it |

**Missing:** `trust_score` current value is never stored on the profile. The trust engine (mig 0043) has `trust_admin_actions` and `trust_score_events` but there is no column or table holding the user's current trust score that API routes return.

**Required SQL (P1):**
```sql
-- If messaging translation prefs are missing from profiles:
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS preferred_message_language text,
  ADD COLUMN IF NOT EXISTS auto_translate_messages boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_original_messages boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS translation_updated_at timestamptz;

-- If tag_permission is missing:
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS tag_permission text NOT NULL DEFAULT 'friends';
```

---

### B. Pulse / Posts / Postcards / Memories

**Tables confirmed:** `posts`, `posts_likes`, `posts_comments`, `hashtags`, `hashtag_usage`, `tags`, `user_hashtag_follows`

| Feature | DB Support | Notes |
|---------|:----------:|-------|
| Post creation / editing | ✅ | |
| Media attachments | ✅ | `media_urls` (array), `media_type`, `media_thumbnail_url`, `media_duration_seconds` |
| Location privacy / delayed posting | ✅ | `geofence_radius_meters`, `publish_after_exit`, `publish_after_time`, `location_sensitivity_level` |
| Post status (`draft`/`pending_publish`/`published`) | ✅ | `post_status` column |
| Likes | ✅ | `posts_likes` with RLS |
| Comments | ✅ | `posts_comments` with RLS; `reply_to_id` added in mig 0057 (replies) |
| **Post saves / bookmarks** | ✅ **APPLIED** | `post_saves` table + RLS applied manually 2026-07-04. `POST /api/posts/:id/save` and `DELETE /api/posts/:id/save` routes added. `savedByMe` and `saveCount` now populated in all feed responses. `SaveButton` (`collections.ts`) redirects post saves to the dedicated route. |
| Shares | ✅ counter only | `share_count` column exists; no `post_shares` join table for tracking who shared |
| Tags (user mentions) | ✅ | `tags` table in mig 0044 |
| Hashtags | ✅ | `hashtag_usage` with `source_type='post'` pattern |
| Linked trip | ✅ | `posts.trip_id` |
| Linked place / event / gem | ⚠️ partial | `posts.venue_id`, `posts.venue_name` exist; no FK to `hidden_gems` or `events` |
| Reports | ✅ | Unified `reports` table (mig 0063) |
| Moderation status | ✅ | `posts.status` column |
| **`posts.category`** | ✅ **APPLIED** | Applied manually 2026-07-04 (0095_post_category.sql). Already in `POST_COLUMNS` and wired through `mapPost()` and Pulse feed stamp. |
| **`post_impressions`** | ❌ **UNCONFIRMED** | `GET /me/profile/analytics` has fail-open for this table; it may not exist |
| Comment reply_to_id | ✅ | `posts_comments.reply_to_id` added mig 0057 |

**Applied (2026-07-04):** `post_saves` table, RLS policies, and `posts.save_count` column were applied manually. `posts.category` was applied via 0095_post_category.sql. The SQL below is kept for reference / future environments:

```sql
-- post_saves table (applied 2026-07-04)
CREATE TABLE IF NOT EXISTS post_saves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS post_saves_user_idx ON post_saves(user_id);
CREATE INDEX IF NOT EXISTS post_saves_post_idx ON post_saves(post_id);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS save_count integer NOT NULL DEFAULT 0;
ALTER TABLE post_saves ENABLE ROW LEVEL SECURITY;
CREATE POLICY post_saves_owner_read ON post_saves FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY post_saves_insert ON post_saves FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY post_saves_delete ON post_saves FOR DELETE USING (auth.uid() = user_id);

-- posts.category (applied 2026-07-04 via 0095_post_category.sql)
ALTER TABLE posts ADD COLUMN IF NOT EXISTS category text;
```

---

### C. Discovery / Places / Hidden Gems

**Tables confirmed:** `discovery_places`, `hidden_gems`, `hidden_gem_verifications`, `hidden_gem_reports`, `hidden_gem_saves`, `hidden_gem_visits`, `local_guide_profiles`, `local_guide_contributions`

| Feature | DB Support | Notes |
|---------|:----------:|-------|
| Discovery places (OSM-merged) | ✅ | `discovery_places` with `lat`, `lng`, `primary_category` |
| Hidden gem creation | ✅ | All core fields present |
| Coordinate privacy (approx vs exact) | ✅ | `latitude`/`longitude` (exact) + `approx_latitude`/`approx_longitude` with sensitivity_level |
| Hidden gem saves | ✅ | `hidden_gem_saves` table |
| Gem visits | ✅ | `hidden_gem_visits` table |
| Gem save count | ✅ | `hidden_gems.save_count` |
| Approval / moderation | ✅ | `hidden_gems.status` enum, `guide_verified_by` |
| Discovery place saves | ✅ | mig 0062 `discovery_place_saves` |
| Reviews / ratings | ⚠️ partial | `buddy_reviews` exists for RAB; no generic `place_reviews` table |

**No critical gaps** found in hidden gems. Privacy policy (approx coordinates for sensitive gems) is properly designed. The `local_guide_profiles` and `local_guide_contributions` tables exist but have no confirmed API route.

---

### D. Trips / Plans / Saved Ideas / Itinerary

**Tables confirmed:** `trips`, `trip_members`, `trip_plan_items`, `trip_destinations`, `trip_saved_places`, `wishlist_places`, `collections`, `collection_items`

#### TripRow Interface Gap (P2)

The frontend `TripRow` interface in `trips.ts` is **missing 15+ columns** that exist in the database since migration 0077. These fields are persisted but never returned to the client:

| Missing from TripRow | DB Column | Migration |
|---------------------|-----------|-----------|
| Trip type | `trip_type` (default 'leisure') | 0077 |
| Timezone | `timezone` | 0077 |
| Destination coordinates | `destination_lat`, `destination_lng`, `destination_place_id` | 0077 |
| Trip notes | `trip_notes` | 0077 |
| Profile visibility | `show_on_profile` (default true) | 0077 |
| Discovery listing | `show_in_discovery` (default false) | 0077 |
| Friend suggestions | `allow_friend_suggestions` | 0077 |
| Crew invites | `allow_trip_crew_invites` | 0077 |
| Join requests | `allow_join_requests` | 0077 |
| Date visibility | `show_exact_dates` | 0077 |
| City visibility | `show_destination_city` | 0077 |
| Delayed posting default | `delayed_posting_default` | 0077 |
| Precise location visible | `precise_location_visible` | 0077 |
| Plan edit permission | `plan_edit_permission` | 0021 |

**Action:** The API `GET /api/trips` select clause needs to include these columns and the TripRow interface needs updating. No migration needed — columns already exist.

#### Saved Ideas / Collections

| Feature | DB Support | Notes |
|---------|:----------:|-------|
| Trip plan items (itinerary) | ✅ | `trip_plan_items` with category, day_date, starts_at |
| Trip-scoped saved places | ✅ | `trip_saved_places` (mig 0079) |
| Global wishlist | ✅ | `wishlist_places` (mig 0088) |
| Unified collections | ✅ | `collections` + `collection_items` (mig 0069) — supports posts, events, trips, places |
| "Add to Trip" from hidden gem / discovery | ⚠️ partial | `trip_plan_items` has `source_type` + `source_id`; unique constraint `(trip_id, source_type, source_id)` exists — but the API route for `POST /api/trips/:id/plan-items` needs to handle hidden_gem and discovery_place source types |

---

### E. Events / Plans

**Tables confirmed:** `events` (inferred from routes + mig 0080 extension), `meetups`, `meetup_invites`, `meetup_time_options`, `meetup_time_votes`, `trip_plan_items`

| Feature | DB Support | Notes |
|---------|:----------:|-------|
| Event creation | ✅ | `events` table (base in 0001, extended 0080) |
| RSVP | ✅ | `meetup_invites.status` |
| Age/group-size filters | ✅ | `meetups.min_age`, `max_age`, `age_limit_enabled` |
| Chat linkage | ✅ | `meetups.chat_thread_id` |
| Capacity / waitlist | ⚠️ | `events` table has capacity fields; `meetups` table does not — split creates ambiguity |
| Event reports | ✅ | Unified `reports` table with `target_type='event'` |

---

### F. Telegraph Messaging

**Tables confirmed:** `message_threads`, `message_thread_members`, `messages`, `message_requests`, `message_translations`, `saved_messages`, `message_reports`, `thread_reports`

#### Gap 1 — Thread Reports ID Type Mismatch (P0) — SKIPPED

Migration `0031_thread_reports.sql` defines `thread_id` as **TEXT**, but `message_threads.id` is **UUID**. Routes pass UUID values. This may cause `ERROR: operator does not exist: text = uuid` in strict PostgreSQL environments.

**Status (2026-07-04):** Fix skipped — `thread_reports` table does not exist in the production database (0031 was never applied). No live data at risk. If 0031 is applied in the future, apply the column type fix below at the same time.

```sql
-- Apply only if/when thread_reports is created in production
ALTER TABLE thread_reports
  ALTER COLUMN thread_id TYPE uuid USING thread_id::uuid;
```

#### Gap 2 — Redundant Report Tables (P2)

The old `message_reports` (mig 0030) and `thread_reports` (mig 0031) tables co-exist with the unified `reports` table (mig 0063). `messaging.ts` still writes to the old domain-specific tables. This creates a split audit trail.

**Recommendation:** Migrate `messaging.ts` to write to the unified `reports` table (`target_type='message'` or `'thread'`) and deprecate the old tables. No immediate migration needed but technical debt.

#### Gap 3 — Translation Profile Columns — RESOLVED ✅

`messaging.ts` reads `profiles.preferred_message_language`, `profiles.auto_translate_messages`, `profiles.show_original_messages`, `profiles.translation_updated_at`, and `profiles.tag_permission`. All five columns were applied manually on 2026-07-04 and are now confirmed present in the database. No further action required.

(See required SQL under section A.)

#### Gap 4 — `saved_messages` table (confirmed ✅)

Created in mig 0057. Table has the required columns.

#### Group Chat

| Feature | DB Support | Notes |
|---------|:----------:|-------|
| Direct threads | ✅ | `thread_type='direct'` |
| Trip group chat | ✅ | `thread_type='trip'`, `message_threads.trip_id` |
| Circle group chat | ✅ | `thread_type='circle'`, `circle_owner_id` |
| Message requests | ✅ | `message_requests` table with full status enum |
| Read receipts | ✅ | `message_thread_members.last_read_at` |
| Reply threading | ✅ | `messages.reply_to_id` (mig 0057) |
| Message translation persistence | ✅ | `message_translations` table |
| Typing / presence | ❌ | Not persisted (expected — ephemeral via realtime) |
| Attachments | ⚠️ | `messages.body` stores text only; no `message_attachments` table |

---

### G. Passport / Stamps / Trust / Verification

**Tables confirmed:** `stamp_definitions`, `user_stamps`, `trust_admin_actions`, `trust_score_events` (mig 0043)

| Feature | DB Support | Notes |
|---------|:----------:|-------|
| Stamp definitions | ✅ | Full v2 schema in mig 0081 |
| Earned stamps | ✅ | `user_stamps` with GPS proof columns (lat/lng REVOKED for public) |
| Stamp source linking | ✅ | `source_type` + `source_id` on `user_stamps` |
| Duplicate prevention | ✅ | `is_repeatable` + `max_awards_per_user` on definitions |
| Stamp artwork (custom per stamp) | ✅ (mig 0075) | `stamp_artwork` table added |
| **Trust score (current value)** | ❌ **MISSING** | `trust_score_events` logs deltas but no column holds the current score. API presumably computes it on-the-fly or reads a cached value not confirmed in schema. |
| Verification records | ✅ (mig 0027) | `profiles.verification_status`, `verified_at` — but 0027 not in migrations.md log |
| ID verification workflow | ⚠️ | Columns exist but no `verification_requests` queue table found |

**Required SQL (P2):**
```sql
-- Option A: cached column on profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS trust_score integer NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS trust_score_updated_at timestamptz;

-- Option B: dedicated table (cleaner for audit):
CREATE TABLE IF NOT EXISTS user_trust_scores (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  score integer NOT NULL DEFAULT 50,
  computed_at timestamptz NOT NULL DEFAULT now()
);
```

---

### H. Safety / Safe Return / Reports / Blocking

**Tables confirmed:** `blocks`, `reports` (unified, mig 0063), `moderation_actions`, `user_interaction_cooldowns`, `report_evidence`

**Note:** Migration 0040 (safe_return tables) is NOT in `docs/migrations.md`. If not applied in production, Safe Return has no schema at all.

| Feature | DB Support | Notes |
|---------|:----------:|-------|
| Block list | ✅ | `blocks` with unique `(blocker_id, blocked_id)` |
| Content reports | ✅ | Unified `reports` table |
| Moderation actions | ✅ | `moderation_actions` (13 action types) |
| Admin audit log | ✅ | `trust_admin_actions` table |
| **Safe Return sessions** | ⚠️ **UNCONFIRMED** | mig 0040 not in log — verify applied |
| **Trusted contacts** | ⚠️ **UNCONFIRMED** | Same — part of mig 0040 |
| SOS events | ⚠️ **UNCONFIRMED** | Same |
| Emergency contacts | ✅ (mig 0076) | `profile_emergency_contacts` table |
| Check-in schedules | ⚠️ **UNCONFIRMED** | Depends on mig 0040 |

**Action:** Verify mig 0040 is applied in production. If not, run it before the Safe Return feature is live.

---

### I. Rent a Buddy

**Tables confirmed:** `buddy_profiles`, `buddy_bookings`, `buddy_availability`, `buddy_saved`, `buddy_reviews`, `rent_buddy_launch_controls`, `rent_buddy_training_checklist`

| Feature | DB Support | Notes |
|---------|:----------:|-------|
| Buddy profile | ✅ | Full schema including `risk_review_status`, `average_rating` |
| Listings / services | ✅ | `buddy_profiles` with `hourly_rate_usd`, tags |
| Availability | ✅ | `buddy_availability` with unique `(user_id, date)` |
| Bookings | ✅ | `buddy_bookings` with full state machine |
| Reviews | ✅ | `buddy_reviews` table |
| **Payment schema** | ❌ | No payment/deposit/transaction tables exist — placeholders only |
| Disputes | ✅ | `rb_support_category` enum + support ticket table |
| Safety SOS linkage | ✅ | `stay_connected_traveler` field in `buddy_bookings` |
| City rollout gates | ✅ | `rent_buddy_launch_controls` |

No critical gaps. Payment schema is intentionally deferred.

---

### J. Notifications / Activity

**Tables confirmed:** `notifications`, `notification_devices`, `push_retry_queue`, `activity_events`

| Feature | DB Support | Notes |
|---------|:----------:|-------|
| Notification record | ✅ | Full schema with `category`, `event_type`, `priority`, `metadata` JSONB |
| Push tokens | ✅ | `notification_devices` with platform and `last_used_at` |
| Read/dismiss state | ✅ | `read_at`, `dismissed_at` |
| Delivery retry | ✅ | `push_retry_queue` |
| Deep link target | ✅ | `action_url` |
| Actor linkage | ✅ | `actor_id`, `source_type`, `source_id` |
| **Notification schema duplication** | ⚠️ | Both `artifacts/api-server/migrations/0041_notifications.sql` and `artifacts/api-server/src/migrations/0062_notifications_schema.sql` create notification tables. Risk of double-apply or schema divergence. |
| Unread count | ✅ | Computed server-side from `read_at IS NULL` |
| Activity feed | ✅ | `activity_events` table (used by notifications route) |

---

### K. Compass AI / Recommendations

**Tables confirmed:** `user_preference_profiles`, `compass_feed_cache` (mig 0054/0055), `compass_admin` (mig 0055)

| Feature | DB Support | Notes |
|---------|:----------:|-------|
| User preference snapshots | ✅ | `user_preference_profiles` with `explicit_preferences_json`, `inferred_preferences_json` |
| Recommendation feed cache | ✅ | `compass_feed_cache` |
| Feedback / dismissed state | ⚠️ | `POST /api/compass/feedback` exists; table backing it unconfirmed in explored migrations |
| Recommendation explanation | ✅ | `explanationKey` in response (scoring engine field) |
| Telegraph recommendation injection | ✅ | `20260620_telegraph_intelligence.sql` (PENDING — verify applied) |
| Click / impression analytics | ❌ | No `compass_interaction_log` table found |

---

### L. Media / Storage

**Tables confirmed:** `posts.media_urls` (array column), `posts.media_thumbnail_url`, `posts.media_duration_seconds`

| Feature | DB Support | Notes |
|---------|:----------:|-------|
| Media URLs | ✅ | Stored as array in `posts.media_urls` |
| Thumbnail / duration | ✅ | `media_thumbnail_url`, `media_duration_seconds` on posts |
| **Dedicated media_attachments table** | ❌ | No standalone `media_attachments` table found — owner_id, mime_type, size, width/height, moderation status are not tracked independently |
| Storage buckets / policies | ⚠️ | Not visible in codebase migrations — must be configured in Supabase dashboard directly |
| Failed upload tracking | ❌ | No `failed_uploads` or upload-state table |

---

### M. Admin / Moderation

**Tables confirmed:** `feature_flags`, `moderation_actions`, `trust_admin_actions`, `reports`, `report_evidence`, `user_account_states` (mig 0094)

| Feature | DB Support | Notes |
|---------|:----------:|-------|
| Feature flags | ✅ | `feature_flags.flag` (PK), `enabled`, `metadata` JSONB |
| Role checks | ✅ | `profiles.role = 'admin'` used by admin guard |
| Moderation queue | ⚠️ | `reports` table exists but no `moderation_queue` view or status workflow table |
| Admin audit log | ✅ | `trust_admin_actions` and `moderation_actions` |
| Hidden gem approval queue | ⚠️ | `hidden_gems.status` column acts as queue; no separate approval_queue table |
| Verification queue | ❌ | No `verification_requests` or `id_verification_queue` table found |
| App config | ✅ | `feature_flags` doubles as app config; `metadata` JSONB stores extended config |

---

## 3. Code-to-SQL Mapping — Critical Gaps

| Service / File | Table Expected | Column Expected | Exists in DB | Risk |
|----------------|---------------|-----------------|:------------:|------|
| `messaging.ts` | `profiles` | `preferred_message_language` | ⚠️ Unconfirmed | Translation silently broken |
| `messaging.ts` | `profiles` | `auto_translate_messages` | ⚠️ Unconfirmed | Translation silently broken |
| `messaging.ts` | `profiles` | `tag_permission` | ⚠️ Unconfirmed | Telegraph tag gating broken |
| `posts.ts` (API) | `posts` | `category` | ❌ Pending (0095) | POST /api/posts fails if 0095 not applied |
| `posts.ts` (frontend) | `post_saves` | whole table | ❌ Missing | savedByMe always false |
| `stamps.ts` (API) | `profiles` | `trust_score` | ❌ Missing | Trust score not persisted |
| `analytics.ts` (API) | `post_impressions` | whole table | ❌ Unconfirmed | Analytics fail-open only |
| `thread_reports` | `thread_reports` | `thread_id` (UUID) | ❌ Type mismatch | Query error in strict PG |
| `hiddenGems.ts` (API) | `local_guide_profiles` | all | ✅ | No route exposing it |
| Safe Return routes | safe_return tables | all | ⚠️ Unconfirmed (0040 not in log) | Feature broken if 0040 missing |

---

## 4. UI-to-SQL Mapping

| Screen | Feature | DB Support | Backend Route | Persistence |
|--------|---------|:----------:|:-------------:|-------------|
| Post detail | Like | ✅ | ✅ | Real |
| Post detail | Comment | ✅ | ✅ | Real |
| Post detail | **Save / Bookmark** | ❌ | ❌ | **None — local/mock** |
| Post detail | Share counter | ✅ counter | ❌ no join table | Counter only |
| Trips list | Trip settings (privacy, crew, dates) | ✅ in DB | ⚠️ not returned | **DB has it; API doesn't expose it** |
| Trips / Post create | Category tag | ❌ Pending | ✅ (route written) | **Fails if 0095 not applied** |
| Messages | Auto-translate | ⚠️ Unconfirmed | ✅ | **Silently broken if columns missing** |
| Passport | Trust score display | ❌ | ❌ | **Not persisted** |
| Profile | Verification badge | ✅ (0027) | ✅ | Real if 0027 applied |
| Safe Return | Session / check-in | ⚠️ Unconfirmed | ✅ | **Broken if 0040 not applied** |
| Admin | Verification queue | ❌ | ❌ | No table or route |
| Compass | Feedback / dismiss | ⚠️ | ✅ route | Table existence unconfirmed |

---

## 5. Missing SQL Action Plan

### Priority 0 — Security / Privacy

#### P0-1: Fix `thread_reports.thread_id` type mismatch

```sql
-- Migration: 0096_fix_thread_reports_id_type.sql
BEGIN;
ALTER TABLE thread_reports
  ALTER COLUMN thread_id TYPE uuid USING thread_id::uuid;
COMMIT;
```
*Backfill:* Rows already in the table with non-UUID text values will fail the cast — inspect `SELECT count(*) FROM thread_reports WHERE thread_id !~ '^[0-9a-f-]{36}$'` before applying.  
*Rollback:* `ALTER TABLE thread_reports ALTER COLUMN thread_id TYPE text USING thread_id::text;`

#### P0-2: Add generated database types (no migration — tooling)

```bash
supabase gen types typescript --project-id <project-id> \
  > lib/database.types.ts
```
Wire into API server `supabase.ts`:
```typescript
import type { Database } from '../../lib/database.types';
export const supabase = createClient<Database>(url, key);
```

#### P0-3: Verify pending safety migrations are applied

Run in Supabase SQL editor (read-only check):
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'safe_return_sessions', 'safe_return_trusted_contacts',
    'safe_return_events', 'weather_cache', 'post_impressions'
  );
```
If any are missing, apply the corresponding migration files.

---

### Priority 1 — UI broken / insert failures

#### P1-1: Apply `0095_post_category.sql` in production

Already written. Run via Supabase dashboard or psql. Adds `posts.category text`.

#### P1-2: Create `post_saves` table

```sql
-- Migration: 0097_post_saves.sql
BEGIN;

CREATE TABLE IF NOT EXISTS post_saves (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  post_id     uuid        NOT NULL REFERENCES posts(id)    ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, post_id)
);

CREATE INDEX IF NOT EXISTS post_saves_user_idx ON post_saves(user_id);
CREATE INDEX IF NOT EXISTS post_saves_post_idx ON post_saves(post_id);

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS save_count integer NOT NULL DEFAULT 0;

ALTER TABLE post_saves ENABLE ROW LEVEL SECURITY;

CREATE POLICY post_saves_owner_read ON post_saves
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY post_saves_insert ON post_saves
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY post_saves_delete ON post_saves
  FOR DELETE USING (auth.uid() = user_id);

-- Decrement trigger
CREATE OR REPLACE FUNCTION decrement_post_save_count()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE posts SET save_count = GREATEST(0, save_count - 1)
  WHERE id = OLD.post_id;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE TRIGGER trg_decrement_post_save_count
  AFTER DELETE ON post_saves
  FOR EACH ROW EXECUTE FUNCTION decrement_post_save_count();

COMMIT;
```

*Dependencies:* `posts` and `profiles` tables.  
*Rollback:* `DROP TABLE post_saves; ALTER TABLE posts DROP COLUMN save_count;`

#### P1-3: Add translation preference columns to `profiles`

```sql
-- Migration: 0098_profile_translation_prefs.sql
BEGIN;
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS preferred_message_language   text,
  ADD COLUMN IF NOT EXISTS auto_translate_messages      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_original_messages       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS translation_updated_at       timestamptz,
  ADD COLUMN IF NOT EXISTS tag_permission               text    NOT NULL DEFAULT 'friends';
COMMIT;
```

*Risk:* Low — all additions with safe defaults.

#### P1-4: Add trust score to profiles

```sql
-- Migration: 0099_trust_score_column.sql
BEGIN;
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS trust_score            integer     NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS trust_score_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS profiles_trust_score_idx ON profiles(trust_score);
COMMIT;
```

*Backfill:* After applying, compute initial scores from `trust_score_events` if records exist.

---

### Priority 2 — Schema / code mismatches

#### P2-1: Expose trip expansion fields in API

No migration needed. Update `GET /api/trips` select clause in `artifacts/api-server/src/routes/trips.ts` to include the 15+ missing columns from migration 0077, and update the `TripRow` TypeScript interface in `travel-buddy-standalone/src/services/trips.ts`.

#### P2-2: Consolidate report tables

No immediate migration. Plan: update `messaging.ts` to write to unified `reports` table with `target_type = 'message'` or `'thread'`. Mark `message_reports` and `thread_reports` as deprecated. After traffic fully migrated, a future migration can DROP the old tables (out of scope for this audit).

#### P2-3: Resolve notification migration duplication

Audit which migration file is actually authoritative — `artifacts/api-server/migrations/0041_notifications.sql` or `artifacts/api-server/src/migrations/0062_notifications_schema.sql`. Ensure only one is applied. Add 0041 to `docs/migrations.md` if not already tracked.

---

### Priority 3 — Performance / Integrity

#### P3-1: Missing indexes

```sql
-- Migration: 0100_missing_indexes.sql
BEGIN;

-- hashtag_usage: fast lookup of all hashtags on a post
CREATE INDEX IF NOT EXISTS hashtag_usage_source_idx
  ON hashtag_usage(source_type, source_id);

-- notifications: unread count query
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications(user_id, read_at)
  WHERE read_at IS NULL;

-- posts: author + status for feed queries
CREATE INDEX IF NOT EXISTS posts_author_status_idx
  ON posts(author_id, post_status);

-- post_saves: post-level count refresh
CREATE INDEX IF NOT EXISTS post_saves_post_created_idx
  ON post_saves(post_id, created_at DESC);

COMMIT;
```

---

### Priority 4 — Future feature support

#### P4-1: Compass interaction log

```sql
-- Migration: future_compass_interaction_log.sql
CREATE TABLE IF NOT EXISTS compass_interaction_log (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  recommendation_token text        NOT NULL,
  entity_type          text        NOT NULL,
  entity_id            uuid,
  action               text        NOT NULL, -- 'click','dismiss','save','share'
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cil_user_idx ON compass_interaction_log(user_id, created_at DESC);
```

#### P4-2: Verification request queue

```sql
-- Migration: future_verification_queue.sql
CREATE TABLE IF NOT EXISTS verification_requests (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  method      text        NOT NULL, -- 'id_document','selfie','social'
  status      text        NOT NULL DEFAULT 'pending', -- 'pending','approved','rejected'
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at  timestamptz,
  reviewed_by  uuid        REFERENCES profiles(id),
  notes        text
);
```

#### P4-3: RAB payment placeholder

Schema deferred per existing decision. When ready, add `buddy_transactions` table referencing `buddy_bookings`.

---

## 6. Summary Checklist

| # | Action | Priority | Migration | Risk |
|---|--------|----------|-----------|------|
| 1 | Fix `thread_reports.thread_id` to UUID | P0 | 0096 | Check for non-UUID rows first |
| 2 | Generate + wire `database.types.ts` | P0 | None (tooling) | Low |
| 3 | Verify mig 0040 (Safe Return) applied in prod | P0 | Verify only | None |
| 4 | Apply `0095_post_category.sql` in prod | P1 | 0095 (exists) | Low |
| 5 | Create `post_saves` table | P1 | 0097 | Low |
| 6 | Add translation pref columns to `profiles` | P1 | 0098 | Low |
| 7 | Add `trust_score` column to `profiles` | P1 | 0099 | Low |
| 8 | Expose trip 0077 fields in API + TripRow | P2 | None (code) | Low |
| 9 | Consolidate `message_reports` / `thread_reports` → unified `reports` | P2 | Future | Medium |
| 10 | Resolve notification migration duplication | P2 | None (audit) | Low |
| 11 | Add missing indexes (hashtag_usage, notifications, posts) | P3 | 0100 | None |
| 12 | Compass interaction log table | P4 | Future | None |
| 13 | Verification request queue | P4 | Future | None |
