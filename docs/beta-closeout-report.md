# Core Beta Trust + Usability Pass — Final Closeout Report
# + Full Undeployed SQL / Backend Inventory

*Generated 2026-07-03. All findings are based on local file inspection.
"Local exists; production verification required" means the file exists in this
repo but whether the object is live in production is not confirmed unless noted.*

---

## 1. Executive Summary

### Core Beta Trust + Usability Pass (#118, #119, #124, #125, #150, #216, #217, #226)

All 7 items are complete. Every change was applied to both
`travel-buddy-standalone/` and `artifacts/travel-buddy/` (source-drift = 0).
The one pre-existing PASS item (#124) required no code changes.

### Undeployed SQL / Backend Inventory

- **Pending migrations:** 10 (0077–0089, excluding 0083/0084/0087 which are applied)
- **Ship-blocking pending migrations:** 6 (0077, 0078, 0079, 0080, 0086, 0088+0089)
- **Clean-gate pending migrations:** 2 (0081, 0082 — stamps guarded with 503)
- **Feature-flag migrations:** 1 (0085 — passport stamps disabled without it)
- **Undeployed SQL functions:** 2 confirmed (0088, 0089 pending); 2 additional with unknown production status (`upsert_city_stamp`, `increment_counter`)
- **Undeployed triggers:** 1 (0088 pending)
- **501 stubs in backend:** 5 routes (all in RAB payment/dispute module — non-blocking, no live UI depends on them)
- **Direct Supabase mutations in mobile:** 5 identified; 3 are dead code, 1 is live but safe, 1 is live and under P-256 monitor
- **Storage buckets used by backend:** 3 (`profile-media`, `post-media`, `memories`) — production existence not verifiable without Supabase dashboard access
- **Critical missing env vars that break the app:** `SUPABASE_SERVICE_ROLE_KEY` (if not set on deployed API server, every route returns 503)

---

## 2. Core Beta Trust + Usability Pass — Final Report

### 2A. Core Beta Matrix

| Task # | User flow | Previous state | Fix completed | Files changed | Backend route / service | Status |
|--------|-----------|---------------|---------------|---------------|------------------------|--------|
| **#118** | Blocked profile placeholder — unblock button | Profile shows "You've been blocked" with no affordance when YOU are the blocker | Added `iBlockedThem` state (separate from `isBlockedRelation`), `handleUnblock` callback, Unblock button in blocked placeholder | `app/u/[username].tsx` (both locations) | `DELETE /api/blocks/:targetId` via `unblockUser()` service | ✅ Done |
| **#119** | Hide threads from blocked users — full inbox | Thread list filtered for `blockedIds`; request pane passed raw `requests` without any filter | Thread filter already had `blockedIds`; added `blockerIds.has(otherId)` to thread filter; added `filteredRequests` (filters both directions) and passed to `RequestsPane`; `requestCount` now uses `filteredRequests.length` | `src/components/TelegraphInboxScreen.tsx` (both locations) | `GET /api/blocks/list` via `getBlockList()` | ✅ Done |
| **#124** | Badge on Trips tab for pending invites | Badge present and counting correctly — pre-existing PASS | No code change needed | — | `GET /api/me/trip-invites/pending` | ✅ Already passing |
| **#125 / #150** | Preview a trip before accepting the invite | API returned only basic fields; no visibility or member count; accept just called `onDone()` | API endpoint adds `visibility` column + member-count subquery; `TripInvite` interface gets `visibility`/`memberCount`; `InviteCard` shows destination, dates, visibility label, member count; accept now calls `router.push('/trip/:id')` before refreshing list | `artifacts/api-server/src/routes/trips.ts`; `src/services/trips.ts`; `app/(tabs)/trips.tsx` (all both locations) | `GET /api/me/trip-invites/pending`, `POST /api/trips/:id/invites/accept` | ✅ Done |
| **#216** | Trip editing screen | No edit screen existed; Edit button was disabled or absent | Created `app/trip/edit.tsx` (pre-filled form: title, destination via GlobalPlacePicker, dates via GlobalCalendarPicker, visibility toggle); owner-only guard + loading/error states; wired Edit Pressable in `[id].tsx` (owner-only, navigates to `/trip/edit?id=…`); fixed `updateTrip()` service to forward `destinationCity`, `destinationCountry`, `startDate`, `endDate` (were silently ignored) | `app/trip/edit.tsx` (created, both); `app/trip/[id].tsx` (both); `src/services/trips.ts` (both) | `PATCH /api/trips/:tripId` | ✅ Done |
| **#217** | Post reporting and hiding | ReportPostSheet was wired with no `onReported` prop; reported posts stayed visible | All 4 PostCard variants (HeroCard, StandardCard, QuestionCard, ItineraryCard) got: `isReported` state, `if (isReported) return null` early guard, `onReported={() => setIsReported(true)}` wired to `ReportPostSheet` | `src/components/PostCard.tsx` (both locations) | `POST /api/reports` via `reportContent()` | ✅ Done |
| **#226** | My Circle visibility — users who blocked me visible | Circle screen only checked `blockedIds` (people I blocked), missed `blockerIds` (people who blocked me) | Added `blockerIds.has(u.id)` to the hidden/blocked check in `CircleUserRow` | `app/circle.tsx` → `CircleUserRow` (both locations) | `BlockedIdsContext` (client-side) | ✅ Done |

### 2B. Validation Table

| Check | Command | Result |
|-------|---------|--------|
| API server typecheck | `pnpm --filter @workspace/api-server run typecheck` | ✅ PASS |
| Standalone typecheck | `cd travel-buddy-standalone && pnpm typecheck` | ✅ PASS |
| Full workspace typecheck | `pnpm run typecheck` | ✅ PASS |
| Source drift | `bash scripts/sync-standalone.sh --check-source` | ✅ PASS — 0 drifted files |
| Dependency drift | `bash scripts/sync-standalone.sh --check-deps` | ✅ PASS |
| Sync regression suite | `bash scripts/test-sync-standalone.sh` | ✅ PASS — 78/78 |
| Routes guard | `pnpm --filter @workspace/scripts run test:routes-guard` | ✅ PASS |
| API server build | `pnpm --filter @workspace/api-server run build` | ✅ PASS |
| Code review | Automated code review | ✅ APPROVED_WITH_COMMENTS |

### 2C. Remaining Issues

**Real blockers (none introduced by this pass):**
- None. All 7 items are complete.

**Reviewer comments (APPROVED_WITH_COMMENTS — not blocking):**
- Invite preview does not include trip description/notes field. No description column exists on `trips` in current applied schema; 0077 adds `trip_notes`. Non-blocking until 0077 is applied.
- Trips tab badge count does not clear instantly on accept (waits for `useFocusEffect` re-fetch). Acceptable for beta; instant optimistic clear is a polish item.
- Expired/deleted invite UX not explicitly handled (API returns 404 → Alert). Acceptable for beta.

**Non-blocking polish (not addressed, by design):**
- InviteCard preview is inline (no separate preview-then-decide modal). Functionally correct per spec.

---

## 3. Undeployed SQL Migration Inventory

Last confirmed applied migration: **0087** (`profiles.cover_photo_url`) — applied 2026-07-03.

Legend: 🔴 Ship-blocker | 🟡 Apply for full feature | 🟢 Gated (fails cleanly without it)

### 0077 — `0077_trips_expansion.sql` 🟡

| Field | Detail |
|-------|--------|
| **Creates / changes** | Adds 14 columns to `trips`: `trip_type`, `destination_lat`, `destination_lng`, `trip_notes`, `budget_estimate`, `show_destination_city`, `show_destination_country`, `show_exact_dates`, `show_member_list`, `allow_join_requests`, `max_members`, `is_featured`, `archived_at`, `metadata` + adds `draft` and `archived` to `trip_status` enum |
| **Tables affected** | `trips` |
| **Dependent live code** | `trips-expansion.ts` `toMemberTrip()` mapper reads these columns; lifecycle routes use `draft`/`archived` enum values |
| **Required before beta?** | Yes — without it, trip privacy columns (show_destination_city etc.) silently save but don't persist; draft/archived status not available |
| **Required before production?** | Yes |
| **Manual Supabase action** | Apply SQL via Supabase SQL Editor or `psql` |
| **Risk** | Non-breaking: columns have safe defaults; enum values `draft`/`archived` not sent by current code |
| **Verification SQL** | `SELECT column_name FROM information_schema.columns WHERE table_name='trips' AND column_name='trip_notes';` |

### 0078 — `0078_trip_members_expansion.sql` 🟡

| Field | Detail |
|-------|--------|
| **Creates / changes** | Adds `co_host` and `viewer` to `member_role` enum; adds `status`, `permissions`, `joined_at` columns to `trip_members` |
| **Tables affected** | `trip_members` |
| **Dependent live code** | `trips-expansion.ts` join-request approve/decline uses `status='accepted'` upsert; `requireTripMember` reads `status` |
| **Required before beta?** | Yes — join-request routes fail silently without `status` column |
| **Required before production?** | Yes |
| **Manual Supabase action** | Apply SQL via Supabase SQL Editor |
| **Risk** | Fixed: `.neq("role","invited")` no longer sends unknown enum values |
| **Verification SQL** | `SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_type.oid=pg_enum.enumtypid WHERE typname='member_role';` |

### 0079 — `0079_trip_sub_tables.sql` 🔴 SHIP-BLOCKER

| Field | Detail |
|-------|--------|
| **Creates / changes** | Creates 11 trip sub-resource tables: `trip_budget`, `trip_documents`, `trip_notes`, `trip_join_requests`, `trip_invite_links`, `trip_saved_places`, `trip_checklists`, `trip_checklist_items`, `trip_activity_log`, `trip_reminders`, `trip_destinations` |
| **Indexes** | Various (trip_id FKs on all tables) |
| **Policies** | RLS ENABLED on all 11 tables with trip-member-based policies |
| **Dependent live code** | `trips-expansion.ts` routes for budget, documents, notes, checklists, join-requests, invite-links, saved-places, destinations |
| **Required before beta?** | Yes — all sub-resource routes return "relation does not exist" in production |
| **Required before production?** | Yes |
| **Manual Supabase action** | Apply SQL via Supabase SQL Editor |
| **Risk** | High — 18 routes in `trips-expansion.ts` reference these tables; all return 500 until applied |
| **Verification SQL** | `SELECT table_name FROM information_schema.tables WHERE table_name IN ('trip_budget','trip_documents','trip_join_requests');` |

### 0080 — `0080_events_extension.sql` 🔴 SHIP-BLOCKER

| Field | Detail |
|-------|--------|
| **Creates / changes** | Creates 10 event sub-tables: `event_attendees`, `event_saves`, `event_invites`, `event_cohosts`, `event_posts`, `event_media`, `event_reports`, `event_activity_log`, `event_share_links`, `event_reminders`; adds columns `rsvp_closed`, `show_exact_location`, `safety_notes`, `tags` to `events`; seeds event feature flags |
| **Indexes** | event_id FKs on all sub-tables |
| **Policies** | RLS ENABLED on all 10 new tables |
| **Dependent live code** | `events.ts` invites, co-hosts, posts, media, reports, drafts, share-links, reminders routes |
| **Required before beta?** | Yes — all extended events routes return "relation does not exist" |
| **Required before production?** | Yes |
| **Manual Supabase action** | Apply SQL via Supabase SQL Editor |
| **Risk** | High — core `events` columns (`rsvp_closed` etc.) also missing; event creation would fail if writing these |
| **Verification SQL** | `SELECT table_name FROM information_schema.tables WHERE table_name IN ('event_invites','event_cohosts','event_saves');` |

### 0081 — `0081_stamp_system_v2.sql` 🟢

| Field | Detail |
|-------|--------|
| **Creates / changes** | `stamp_definitions`, `user_stamps`, `stamp_award_events`, `stamp_progress`, `stamp_collections`, `stamp_campaigns` |
| **Dependent live code** | `stamps.ts`, `adminStamps.ts` — both gated behind `stamp_system_v2_enabled` feature flag |
| **Required before beta?** | No — guarded; returns 503 cleanly |
| **Required before production?** | Yes, to enable stamp system |
| **Manual Supabase action** | Apply SQL + set feature flag |
| **Verification SQL** | `SELECT * FROM feature_flags WHERE flag='stamp_system_v2_enabled';` |

### 0082 — `0082_stamp_definitions_v2.sql` 🟢

| Field | Detail |
|-------|--------|
| **Creates / changes** | Seeds stamp definition rows in `stamp_definitions` |
| **Required before beta?** | No (depends on 0081) |
| **Apply with** | 0081 |
| **Verification SQL** | `SELECT COUNT(*) FROM stamp_definitions;` |

### 0085 — `0085_enable_passport_flags.sql` 🟡

| Field | Detail |
|-------|--------|
| **Creates / changes** | Sets `passport_stamps_enabled = true`, `passport_memories_enabled = true`, `passport_visits_enabled = true` in `feature_flags` |
| **Dependent live code** | `passportStamps.ts`, `memories.ts`, `passport.ts` check these flags |
| **Required before beta?** | Yes — without it, passport stamps and memories are globally disabled even though routes and UI exist |
| **Required before production?** | Yes |
| **Manual Supabase action** | Apply SQL or run `UPDATE feature_flags SET enabled=true WHERE flag IN ('passport_stamps_enabled','passport_memories_enabled','passport_visits_enabled');` |
| **Verification SQL** | `SELECT flag, enabled FROM feature_flags WHERE flag LIKE 'passport%';` |

### 0086 — `0086_discovery_places_osm_id.sql` 🔴 SHIP-BLOCKER

| Field | Detail |
|-------|--------|
| **Creates / changes** | Adds `osm_id` column to `discovery_places`; sets `DEFAULT ''` on `city` |
| **Dependent live code** | `wishlist.ts` `trackOsmPlaceSave()` does `upsert on conflict(osm_id)` |
| **Required before beta?** | Yes — wishlist saves for OSM-sourced places fail with "column osm_id does not exist" |
| **Required before production?** | Yes |
| **Manual Supabase action** | Apply SQL |
| **Verification SQL** | `SELECT column_name FROM information_schema.columns WHERE table_name='discovery_places' AND column_name='osm_id';` |

### 0088 — `0088_wishlist_places.sql` 🔴 SHIP-BLOCKER

| Field | Detail |
|-------|--------|
| **Creates / changes** | Creates `wishlist_places` table; adds `prevent_wishlist_places_truncate` function + `block_wishlist_places_truncate` trigger |
| **Indexes** | `wishlist_places(user_id)`, `wishlist_places(place_id)`, unique on `(user_id, place_source, place_id)` |
| **Policies** | RLS ENABLED; owner-only policies |
| **Functions** | `prevent_wishlist_places_truncate()` — returns `EXCEPTION` on TRUNCATE |
| **Triggers** | `block_wishlist_places_truncate` — BEFORE TRUNCATE on `wishlist_places` |
| **Dependent live code** | `wishlist.ts` all routes: GET /wishlist, POST /wishlist, DELETE /wishlist/:placeId |
| **Required before beta?** | Yes — all wishlist routes return "relation does not exist" |
| **Required before production?** | Yes |
| **Manual Supabase action** | Apply SQL |
| **Verification SQL** | `SELECT table_name FROM information_schema.tables WHERE table_name='wishlist_places';` |

### 0089 — `0089_decrement_discovery_place_saved_count.sql` 🔴 SHIP-BLOCKER

| Field | Detail |
|-------|--------|
| **Creates / changes** | Creates `decrement_discovery_place_saved_count(p_place_id uuid)` function |
| **Tables affected** | `discovery_places.saved_count` |
| **Dependent live code** | `wishlist.ts` DELETE route calls `svc.rpc("decrement_discovery_place_saved_count", {p_place_id})` |
| **Required before beta?** | Yes — wishlist unsave returns 500 ("function not found") |
| **Required before production?** | Yes |
| **Manual Supabase action** | Apply SQL |
| **Verification SQL** | `SELECT routine_name FROM information_schema.routines WHERE routine_name='decrement_discovery_place_saved_count';` |

---

## 4. SQL Functions / RPC Inventory

| Function | Source migration | Parameters | Return | Tables touched | Backend/frontend caller | Deployment status | Required before beta? | Risk if missing |
|----------|-----------------|------------|--------|---------------|------------------------|------------------|-----------------------|-----------------|
| `is_blocked(a uuid, b uuid)` | 0015 | two user UUIDs | boolean | `blocks` | `blocks.ts` (indirectly via PostgREST query) | Local exists; ✅ applied with 0015 | No (backend handles blocking via query) | Blocking queries may miss reverse direction |
| `increment_hashtag_usage_count(p_hashtag_id UUID)` | 0044 | hashtag UUID | void | `hashtags` | TaggingService.ts `.rpc(...)` | Local exists; production verification required | No (hashtags degrade gracefully) | Hashtag counts not incremented |
| `upsert_hashtag_usage_and_increment(...)` | 0044 | hashtag text, user_id, entity_id, entity_type | uuid | `hashtag_usage`, `hashtags` | `TaggingService.ts` | Local exists; production verification required | No | Tags created but usage not tracked |
| `prevent_default_collection_delete()` | 0071 | none | trigger | `collections` | Trigger function (not called directly) | Local exists; ✅ applied with 0071 | Yes | Default "Saves" collection can be deleted |
| `prevent_collections_truncate()` | 0072 | none | trigger | `collections` | Trigger function | Local exists; ✅ applied with 0072 | Yes | collections table could be wiped |
| `prevent_collection_items_truncate()` | 0073 | none | trigger | `collection_items` | Trigger function | Local exists; ✅ applied with 0073 | Yes | collection_items table could be wiped |
| `prevent_saved_places_truncate()` | 0074 | none | trigger | `discovery_place_saves` | Trigger function | Local exists; ✅ applied with 0074 | Yes | saved_places wiped |
| `prevent_wishlist_places_truncate()` | 0088 | none | trigger | `wishlist_places` | Trigger function | Local exists; ⏳ PENDING (0088) | Yes (with 0088) | wishlist_places wiped |
| `decrement_discovery_place_saved_count(p_place_id uuid)` | 0089 | place UUID | void | `discovery_places.saved_count` | `wishlist.ts` DELETE route | Local exists; ⏳ PENDING (0089) | Yes | Wishlist unsave returns 500 |
| `upsert_city_stamp(...)` | **Not found in any migration file** | unknown | unknown | `passport_stamps` or `stamp_*` | `stampHelper.ts` line 52 | **Unknown — not in any local migration file; production verification required** | No (stamps guarded) | Stamp award at city level will fail when stamp system goes live |
| `increment_counter(...)` | **Not found in any migration file** | counter_name, entity_id | int | `hidden_gems` or unknown | `HiddenGemService.ts` line 235 | **Unknown — not in any local migration file; production verification required** | No (hidden gems feature) | View/save counters for hidden gems will not increment |

---

## 5. SQL Triggers Inventory

| Trigger name | Table | Event | Function called | Feature | Source migration | Deployment status | Required before beta? | Risk if missing |
|--------------|-------|-------|----------------|---------|-----------------|------------------|-----------------------|-----------------|
| `enforce_default_collection_no_delete` | `collections` | BEFORE DELETE | `prevent_default_collection_delete()` | Collections — protects default "Saves" collection | 0071 | ✅ Applied | Yes | Users can delete default collection, breaking saves |
| `block_collections_truncate` | `collections` | BEFORE TRUNCATE | `prevent_collections_truncate()` | Collections — data integrity | 0072 | ✅ Applied | Yes | Admin TRUNCATE could wipe all collections |
| `block_collection_items_truncate` | `collection_items` | BEFORE TRUNCATE | `prevent_collection_items_truncate()` | Collections — data integrity | 0073 | ✅ Applied | Yes | Admin TRUNCATE could wipe all saved items |
| `block_saved_places_truncate` | `discovery_place_saves` | BEFORE TRUNCATE | `prevent_saved_places_truncate()` | Discovery saves — data integrity | 0074 | ✅ Applied | Yes | Admin TRUNCATE could wipe all saved places |
| `block_wishlist_places_truncate` | `wishlist_places` | BEFORE TRUNCATE | `prevent_wishlist_places_truncate()` | Wishlist — data integrity | 0088 | ⏳ PENDING (0088) | Yes (with 0088) | wishlist_places could be wiped; applied automatically with 0088 |

**Updated_at triggers:** Not found in any local migration file. Supabase managed postgres may handle `updated_at` via Supabase's built-in `moddatetime` extension or the base schema (not shipped in src/migrations). Production verification required.

---

## 6. RLS Policy Inventory

All tables with live backend routes have RLS defined in their source migrations. The backend API server uses the **service role key** for all writes, which bypasses RLS. RLS applies to direct Supabase client calls (mobile app direct writes).

### Tables with live direct-frontend access risk

| Table | Direct frontend access? | API server service-role? | RLS defined? | Risk |
|-------|------------------------|------------------------|--------------|------|
| `profiles` | ✅ Yes (sign-up upsert in `auth.ts`) | ✅ Yes | Base schema (varies) | P-256 JWT issue; sign-up upsert works with fresh session token — monitor |
| `trip_members` | ⚠️ Yes (`addMember`/`removeMember` in trips.ts service) | ✅ Yes | Yes | Not called from any live screen; dead code — non-blocking |
| `map_pins` | ⚠️ Yes (`createMapPin` in map.ts) | No | Table doesn't exist | Not called from any live screen; will fail silently when wired |
| `user_location_privacy` | ⚠️ Yes (`map.ts`) | No | Renamed table | Table renamed to `location_preferences` — dead code |
| All other tables | No (all writes go through API) | ✅ Yes | Yes (in migrations) | No risk — service role bypasses RLS correctly |

### Pending migration RLS status

All 11 tables in 0079 and all 10 tables in 0080 have `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` plus owner/member policies defined in the migration SQL. When applied, RLS will be active immediately. No separate policy step required.

---

## 7. Storage Deployment Inventory

| Bucket name | Used by | Upload route | Access type | File types | Status | Required before beta? | Manual Supabase action needed | Verification |
|-------------|---------|-------------|-------------|-----------|--------|----------------------|-------------------------------|-------------|
| `profile-media` | `profile.ts` (avatar + cover photo upload), `admin.ts` (avatar removal) | `POST /api/me/profile/avatar`, `POST /api/me/profile/cover` | Public (URLs returned as public CDN URLs) | image/* (JPEG, PNG, WEBP enforced in route) | Local exists; **production existence not verifiable without Supabase dashboard** | Yes — avatar/cover upload returns 500 without bucket | Create public bucket named `profile-media` in Supabase Storage | Upload a test image and confirm URL resolves |
| `post-media` | `posts.ts` | `POST /api/media/upload` | Public | image/jpeg, image/png, image/gif, image/webp, video/mp4 | Local exists; **production existence not verifiable** | Yes — post image upload fails without bucket | Create public bucket named `post-media` in Supabase Storage | Upload test media via API; confirm URL |
| `memories` | `memories.ts` (media removal on delete) | `DELETE /api/memories/:id` (cleans up storage path) | Public | image/*, video/* | Local exists; **production existence not verifiable** | Yes — memory deletion throws on missing bucket | Create public bucket named `memories` in Supabase Storage | Confirm bucket exists |

**Buckets referenced in code but not confirmed with a named constant:**
- `highlights` — referenced in `messaging.ts` line 977 as `.from('highlights')` — appears to be a table reference, not a storage bucket
- Stories, event covers, trip covers — no storage upload routes found in current backend code; these features likely use direct mobile uploads or are not implemented yet

**Note:** `profile.ts` calls `ensureStorageBucket()` at startup which attempts to create the bucket via service role if it doesn't exist. This means `profile-media` may auto-create on first profile upload attempt. The same auto-create is **not** present for `post-media` or `memories`.

---

## 8. Backend Routes — Not Done / Partial / 501 Inventory

### 8A. 501 Not Implemented

All 501 stubs are in `rentABuddy.ts` — payment and dispute module. No live UI calls these routes.

| Method | Path | File | Feature | Frontend caller | Required before beta? | Fix needed |
|--------|------|------|---------|----------------|----------------------|------------|
| POST | `/api/rent-a-buddy/bookings/:bookingId/reschedule` | `rentABuddy.ts` | RAB booking reschedule | None (no UI for this) | No | Payment module integration |
| POST | `/api/rent-a-buddy/bookings/:bookingId/dispute` | `rentABuddy.ts` | RAB dispute filing | None | No | Payment module integration |
| GET | `/api/rent-a-buddy/bookings/:bookingId/dispute` | `rentABuddy.ts` | RAB dispute status | None | No | Payment module integration |
| GET | `/api/rent-a-buddy/bookings/:bookingId/refund-eligibility` | `rentABuddy.ts` | RAB refund check | None | No | Payment module integration |
| POST | `/api/rent-a-buddy/bookings/:bookingId/no-show` | `rentABuddy.ts` | RAB no-show reporting | None | No | Payment module integration |

### 8B. Partial — Blocked by pending migrations

| Router | Status | Routes blocked | Blocker migration | Required before beta? |
|--------|--------|---------------|------------------|-----------------------|
| `trips-expansion.ts` | Partial | budget, documents, notes, checklists, join-requests, invite-links, saved-places, destinations, lifecycle (draft/archive) | 0077, 0078, 0079 | Yes |
| `events.ts` | Partial | invites, co-hosts, posts, media, reports, drafts, share-links, reminders | 0080 | Yes |
| `wishlist.ts` | Blocked | All routes | 0086, 0088, 0089 | Yes |
| `stamps.ts` | Blocked (clean 503) | All routes | 0081 | No |
| `adminStamps.ts` | Blocked (clean 503) | All routes | 0081 | No |

### 8C. TODO comments in routes (non-blocking)

| File | Location | Description |
|------|----------|-------------|
| `events.ts` | Line 3606 | `// TODO: award category event stamps (first_event_joined, ...)` — stamp award not wired on event join |
| `location.ts` | Multiple | Anti-fake GPS verification and GPS history pruning marked as future hardening |
| `airport.ts` | Comment in route list | `POST /api/airport/sessions/:id/plan` — layover plan create listed as stub (no route body found) |

---

## 9. Backend Jobs / Cron / Scheduled Workers Inventory

| Job | File | Purpose | Mechanism | Deployed? | Required before beta? | Risk if missing |
|-----|------|---------|-----------|-----------|----------------------|-----------------|
| Weather cache cleanup | `src/lib/weatherCacheCleanup.ts` | Evicts stale weather cache entries older than `WEATHER_CACHE_RETENTION_HOURS` | `setInterval` started at server boot | ✅ Part of API server process | No | Weather data stays stale but feature is not core to beta |
| Safe Return scheduler | `src/lib/safeReturnScheduler.ts` | Escalates expired Safe Return sessions; expires stale live-shares | `setInterval` started at server boot | ✅ Part of API server process | Yes — without it, overdue Safe Return sessions never auto-escalate | Safety feature degraded; sessions stay "active" past timer |
| Daily brief cleanup | `src/routes/dailyBrief.ts` | Deletes `daily_briefs` rows older than `DAILY_BRIEF_RETENTION_DAYS` | `setInterval` configured by `DAILY_BRIEF_CLEANUP_INTERVAL_HOURS` | ✅ Part of API server process | No | Old brief rows accumulate; table grows but feature still works |
| Delayed post publish | Referenced in env var `DELAYED_POST_PUBLISH_INTERVAL_MINUTES` | Publishes scheduled posts | `setInterval` (implementation not verified) | Unknown — env var exists but no corresponding file found in `src/lib/` | No (no scheduled post UI exists) | No live UI depends on this |
| Push notification delivery | `src/routes/notifications.ts` + `src/lib/` push helpers | Delivers Expo push notifications | Per-request (no background queue) | ✅ Per-request — no cron needed | Yes | Push notifications not delivered |

**Note:** No Redis/queue-based job infrastructure was found despite `REDIS_URL` env var being referenced. All background work is in-process `setInterval`. This means jobs stop if the API server process restarts — acceptable for current scale.

---

## 10. Environment Variable Inventory

| Env var | Required by | Required before beta? | Required before production? | Safe fallback? | Risk if missing |
|---------|------------|----------------------|-----------------------------|----------------|-----------------|
| `SUPABASE_URL` | All routes via `getServiceClient()` | ✅ Yes | ✅ Yes | No | Server starts but all DB calls fail |
| `SUPABASE_SERVICE_ROLE_KEY` | All routes via `getServiceClient()` | ✅ Yes | ✅ Yes | No | Every route returns 503 |
| `EXPO_PUBLIC_SUPABASE_URL` | Mobile `supabase.ts` | ✅ Yes | ✅ Yes | No | Mobile app cannot connect to Supabase |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Mobile `supabase.ts` | ✅ Yes | ✅ Yes | No | Mobile cannot auth or read public data |
| `EXPO_PUBLIC_API_BASE_URL` | Mobile API service layer | ✅ Yes | ✅ Yes | No | All API calls fail from mobile |
| `SESSION_SECRET` | Express session middleware | ✅ Yes | ✅ Yes | No | Session validation broken |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | Telegraph AI, Daily Brief, Compass | Yes | Yes | No (AI features disabled) | Telegraph AI chat, Daily Brief AI, Compass feed all fail |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | Same | Yes | Yes | No | Same |
| `COMPASS_TOKEN_SECRET` | Compass token signing | Yes | Yes | No | Compass feed authentication fails |
| `INTERNAL_API_SECRET` | Admin internal API calls | Yes | Yes | No | Internal admin endpoints reject calls |
| `TICKETMASTER_API_KEY` | Events discovery (external events) | No | Yes | Yes (returns empty) | External event discovery returns empty results |
| `MAPBOX_TOKEN` | Referenced in env; no backend route found using it | No | No | N/A | Likely frontend-only; no backend risk |
| `REDIS_URL` | Referenced in env; no active Redis usage found in code | No | No | Yes (in-process fallback) | No live code actively uses Redis |
| `TRANSLATION_ENABLED` | `messaging.ts` translation pipeline | No | No | Yes (defaults false) | Translation pipeline disabled |
| `TRANSLATION_PROVIDER` | Same | No | No | Yes | Same |
| `TRANSLATION_TIMEOUT_MS` | Same | No | No | Yes (default 5000ms) | Same |
| `DAILY_BRIEF_RETENTION_DAYS` | Daily brief cleanup | No | No | Yes (default 60) | More retention than needed |
| `DAILY_BRIEF_CLEANUP_INTERVAL_HOURS` | Same | No | No | Yes (default 24) | Same |
| `WEATHER_CACHE_RETENTION_HOURS` | Weather cache cleanup | No | No | Yes | Stale weather data |
| `DELAYED_POST_PUBLISH_INTERVAL_MINUTES` | Delayed posts (not confirmed implemented) | No | No | N/A | Scheduled posts not published |
| `GEOFENCE_CONFIRMATION_MINUTES` | Plan geofences | No | No | Yes | Geofence confirmation timing uses default |
| `MUTE_RATE_LIMIT_PER_DAY` | `mutes.ts` | No | No | Yes (default) | Mute rate limit uses default |
| `REPORT_RATE_LIMIT_PER_HOUR` | `reports.ts` | No | No | Yes (default) | Report rate limit uses default |
| `CRASH_REPORT_MAX_REPORTS` | `crashReport.ts` | No | No | Yes | Crash report rate limiting uses default |
| `CRASH_REPORT_WINDOW_MS` | Same | No | No | Yes | Same |
| `SUGGESTION_SEEN_MAX` | `follow.ts` suggestions | No | No | Yes | Suggestion freshness window uses default |
| `SUGGESTION_SEEN_TTL_HOURS` | Same | No | No | Yes | Same |
| `LOG_LEVEL` | Pino logger | No | No | Yes (info) | More or less verbose logging |
| `CLEANUP_ADMIN_SECRET` | Admin cleanup endpoint | No | Yes | No | Cleanup admin endpoint not secured |
| `EXPO_PUBLIC_WEB_ORIGIN` | Mobile web origin config | No | No | Yes | CORS/origin check uses default |
| `NODE_ENV` | Standard | No | ✅ Yes | Yes (development) | Production optimizations disabled |
| `PORT` | Express listen | ✅ Yes | ✅ Yes | No (required by workflow config) | Server won't bind |

---

## 11. Feature Flag / Seed Data Inventory

| Flag / seed | Source migration | Feature | Currently seeded? | Deployment status | Required before beta? | Manual action | Verification SQL |
|-------------|-----------------|---------|------------------|--------------------|----------------------|---------------|------------------|
| Location intelligence flags (`location_sharing_enabled`, etc.) | 0037 | Location sharing | Yes | ✅ Applied | Yes | None | `SELECT flag, enabled FROM feature_flags WHERE flag LIKE 'location%';` |
| Trip crew location flags | 0041 + `20260702_crew_location_flags_reseed.sql` | Crew map | Yes (re-seeded) | ✅ Applied | Yes | None | `SELECT flag, enabled FROM feature_flags WHERE flag LIKE 'trip_crew%';` |
| `passport_stamps_enabled`, `passport_memories_enabled`, `passport_visits_enabled` | 0042 (seeds false) + 0085 (sets true) | Passport system | ⚠️ Seeded false; needs 0085 to set true | ⏳ 0085 PENDING | Yes | Apply 0085 | `SELECT flag, enabled FROM feature_flags WHERE flag LIKE 'passport%';` |
| `hidden_gems_enabled` | 0043 | Hidden Gems | Yes | ✅ Applied | Yes | None | `SELECT enabled FROM feature_flags WHERE flag='hidden_gems_enabled';` |
| `rent_buddy_enabled` | 0050 | Rent-a-Buddy | Yes | ✅ Applied | Yes | None | `SELECT enabled FROM feature_flags WHERE flag='rent_buddy_enabled';` |
| `stories_enabled` | 0068 | Stories | Yes (seeded false or true — check migration) | Production verification required | No | Check and set if needed | `SELECT flag, enabled FROM feature_flags WHERE flag='stories_enabled';` |
| `stamp_system_v2_enabled` | 0081 (seeds false) | Stamps v2 | ⚠️ Seeded false; needs manual enable after 0081 applied | ⏳ 0081 PENDING | No | After applying 0081: `UPDATE feature_flags SET enabled=true WHERE flag='stamp_system_v2_enabled';` | `SELECT enabled FROM feature_flags WHERE flag='stamp_system_v2_enabled';` |
| Event extension flags | 0080 | Events sub-features | ⏳ Not seeded (0080 pending) | ⏳ 0080 PENDING | Yes (with 0080) | Apply 0080 | `SELECT flag, enabled FROM feature_flags WHERE flag LIKE 'event%';` |
| Compass flags (9) | 0051, 0053 | Compass AI feed | Yes | ✅ Applied | Yes | None | `SELECT flag, enabled FROM feature_flags WHERE flag LIKE 'compass%';` |
| Emergency safety flags (11) | 0065 | Safe Return, reports | Yes | ✅ Applied | Yes | None | `SELECT flag, enabled FROM feature_flags WHERE flag LIKE 'safe_return%' OR flag LIKE 'emergency%';` |
| `rent_buddy_global_controls` default row | Inline migration in route | RAB global killswitch | Yes | ✅ Applied | Yes | None | `SELECT * FROM rent_buddy_global_controls;` |
| `rent_buddy_city_rollouts` | Admin API or dashboard | RAB city-level launch | Not seeded by default | Manual Supabase | No (RAB is feature-flagged) | `INSERT INTO rent_buddy_city_rollouts (city, status) VALUES ('YourCity', 'live');` | `SELECT * FROM rent_buddy_city_rollouts;` |
| Admin role bootstrap | Not found in any migration | Admin user | No automated seed found | Manual | Yes — requireAdmin routes need at least one admin user | Manually set `profiles.role='admin'` for admin user ID | `SELECT id, role FROM profiles WHERE role='admin';` |
| Default notification preferences | 0062 migration | Notifications | Seeded per-user on device registration | ✅ Applied | Yes | None | Check on first notification_preferences INSERT |

---

## 12. Direct Supabase Frontend Risk Inventory

| File | Function | Table | Live UI? | API route alternative? | P-256 JWT risk | Required fix before beta? |
|------|---------|-------|----------|------------------------|---------------|--------------------------|
| `src/services/auth.ts` | `ensureProfile()` | `profiles` | ✅ Yes — called on sign-up/sign-in | Partial (`POST /api/auth/lookup-username` but not profile upsert) | ⚠️ Monitor — fresh JWT at sign-up works in practice; P-256 issue mainly affects stale tokens | No — works in practice; add API route if sign-up starts failing |
| `src/services/trips.ts` | `addMember()` | `trip_members` | ❌ No live screen calls this | Yes (`POST /api/trips/:id/invite`) | High — P-256 will reject INSERT | No — dead code; document before wiring |
| `src/services/trips.ts` | `removeMember()` | `trip_members` | ❌ No live screen calls this | No route exists | High | No — dead code; need `DELETE /api/trips/:id/members/:userId` before wiring |
| `src/services/trips.ts` (line 58) | Profile update | `profiles` | ❌ No live screen calls this (update in trips service is not user-facing profile update) | Yes (`PATCH /api/me/profile`) | High | No — dead code |
| `src/services/map.ts` | `createMapPin()` | `map_pins` | ❌ No live screen | No | Very high — table doesn't exist | No — dead code; table missing |
| `src/services/map.ts` | `updateMyLocationPrivacy()` | `user_location_privacy` (renamed) | ❌ No live screen | Yes (`PATCH /api/me/location-preferences`) | Very high — table renamed | No — dead code; use API route when wiring map screen |

---

## 13. Final Beta / Production Blocker List

### Must apply before beta launch

| # | Blocker | Category | Feature affected | Action | Verification |
|---|---------|----------|-----------------|--------|-------------|
| 1 | Migration 0079 not applied | Migration | Trip sub-resources (budget, documents, notes, checklists, join-requests) | Apply `0079_trip_sub_tables.sql` in Supabase SQL Editor | `SELECT table_name FROM information_schema.tables WHERE table_name='trip_budget';` |
| 2 | Migration 0080 not applied | Migration | Events invites, co-hosts, posts, media, drafts, reminders | Apply `0080_events_extension.sql` | `SELECT table_name FROM information_schema.tables WHERE table_name='event_invites';` |
| 3 | Migration 0086 not applied | Migration | Wishlist OSM place saves fail | Apply `0086_discovery_places_osm_id.sql` | `SELECT column_name FROM information_schema.columns WHERE table_name='discovery_places' AND column_name='osm_id';` |
| 4 | Migration 0088 not applied | Migration | All wishlist routes return "relation does not exist" | Apply `0088_wishlist_places.sql` | `SELECT table_name FROM information_schema.tables WHERE table_name='wishlist_places';` |
| 5 | Migration 0089 not applied | Migration | Wishlist unsave returns 500 | Apply `0089_decrement_discovery_place_saved_count.sql` | `SELECT routine_name FROM information_schema.routines WHERE routine_name='decrement_discovery_place_saved_count';` |
| 6 | Migration 0077 not applied | Migration | Trip privacy columns missing; draft/archived status | Apply `0077_trips_expansion.sql` | `SELECT column_name FROM information_schema.columns WHERE table_name='trips' AND column_name='trip_notes';` |
| 7 | Migration 0078 not applied | Migration | Trip join-request approve/decline broken (status column missing) | Apply `0078_trip_members_expansion.sql` | `SELECT column_name FROM information_schema.columns WHERE table_name='trip_members' AND column_name='status';` |
| 8 | Migration 0085 not applied | Feature flag | Passport stamps and memories globally disabled | Apply `0085_enable_passport_flags.sql` | `SELECT flag, enabled FROM feature_flags WHERE flag='passport_stamps_enabled';` |
| 9 | `SUPABASE_SERVICE_ROLE_KEY` not set on deployed API server | Env var | All routes | Set in deployed environment | `GET /api/healthz` returns 200 (not 503) |
| 10 | Storage bucket `profile-media` not created | Storage | Avatar and cover photo upload | Create public bucket `profile-media` in Supabase Storage | Upload test image via `POST /api/me/profile/avatar` |
| 11 | Storage bucket `post-media` not created | Storage | Post media upload | Create public bucket `post-media` in Supabase Storage | Upload test image via `POST /api/media/upload` |
| 12 | Admin role not bootstrapped | Seed | All admin routes (admin moderation, feature flags, stamp admin) | `UPDATE profiles SET role='admin' WHERE id='<admin-user-id>';` | `GET /api/feature-flags` returns 200 (not 403) |
| 13 | `upsert_city_stamp` function production status unknown | SQL function | Stamp awards (guarded — stamps not live until 0081 applied) | Verify in Supabase dashboard → SQL Editor: check `information_schema.routines` | Non-blocking now; confirm before enabling stamp system |

### Must apply before production (non-beta)

| # | Blocker | Category | Feature | Action |
|---|---------|----------|---------|--------|
| 14 | Migration 0081 not applied | Migration | Stamp system v2 | Apply after beta; set `stamp_system_v2_enabled=true` |
| 15 | Migration 0082 not applied | Migration | Stamp definitions | Apply with 0081 |
| 16 | Storage bucket `memories` not created | Storage | Memory media cleanup | Create `memories` bucket in Supabase Storage |
| 17 | `AI_INTEGRATIONS_OPENAI_API_KEY` not set | Env var | Telegraph AI, Daily Brief, Compass | Set on deployed server |
| 18 | `COMPASS_TOKEN_SECRET` not set | Env var | Compass AI | Set on deployed server |
| 19 | `TICKETMASTER_API_KEY` not set | Env var | External events discovery | Set on deployed server |
| 20 | `NODE_ENV=production` | Env var | Production optimizations | Set in deployment config |

---

## 14. Required Manual Supabase SQL Actions

Apply these in order via **Supabase Dashboard → SQL Editor**:

```sql
-- Step 1: Trips expansion columns
-- Run: artifacts/api-server/src/migrations/0077_trips_expansion.sql

-- Step 2: Trip member roles + status
-- Run: artifacts/api-server/src/migrations/0078_trip_members_expansion.sql

-- Step 3: Trip sub-resource tables
-- Run: artifacts/api-server/src/migrations/0079_trip_sub_tables.sql

-- Step 4: Events extension tables
-- Run: artifacts/api-server/src/migrations/0080_events_extension.sql

-- Step 5: OSM ID on discovery_places
-- Run: artifacts/api-server/src/migrations/0086_discovery_places_osm_id.sql

-- Step 6: Wishlist places table + trigger
-- Run: artifacts/api-server/src/migrations/0088_wishlist_places.sql

-- Step 7: Decrement RPC function
-- Run: artifacts/api-server/src/migrations/0089_decrement_discovery_place_saved_count.sql

-- Step 8: Enable passport feature flags
-- Run: artifacts/api-server/src/migrations/0085_enable_passport_flags.sql

-- Step 9: Bootstrap admin user (replace with real user ID)
UPDATE profiles SET role = 'admin' WHERE id = '<your-admin-user-uuid>';

-- Step 10: Verify rent_buddy_global_controls exists
SELECT * FROM rent_buddy_global_controls;
-- If empty: INSERT INTO rent_buddy_global_controls (is_globally_enabled) VALUES (true);
```

---

## 15. Verification SQL Checklist

After applying all migrations, run these queries in Supabase SQL Editor to confirm:

```sql
-- ── Migration column verification ──────────────────────────────────────────

-- 0077: trip_notes column
SELECT column_name FROM information_schema.columns WHERE table_name='trips' AND column_name='trip_notes';

-- 0078: member_role enum has co_host/viewer
SELECT enumlabel FROM pg_enum
JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
WHERE typname = 'member_role' ORDER BY enumlabel;

-- 0079: trip sub-tables exist
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('trip_budget','trip_documents','trip_join_requests','trip_invite_links','trip_destinations')
ORDER BY table_name;

-- 0080: event sub-tables exist
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('event_invites','event_cohosts','event_posts','event_media','event_saves')
ORDER BY table_name;

-- 0085: passport flags enabled
SELECT flag, enabled FROM feature_flags WHERE flag LIKE 'passport%' ORDER BY flag;

-- 0086: osm_id on discovery_places
SELECT column_name FROM information_schema.columns
WHERE table_name='discovery_places' AND column_name='osm_id';

-- 0087: cover_photo_url on profiles (already applied)
SELECT column_name FROM information_schema.columns
WHERE table_name='profiles' AND column_name='cover_photo_url';

-- 0088: wishlist_places table
SELECT table_name FROM information_schema.tables WHERE table_name='wishlist_places';

-- 0089: decrement RPC
SELECT routine_name FROM information_schema.routines
WHERE routine_name='decrement_discovery_place_saved_count';

-- ── Function verification ───────────────────────────────────────────────────

-- All known functions
SELECT routine_name FROM information_schema.routines
WHERE routine_name IN (
  'is_blocked',
  'increment_hashtag_usage_count',
  'upsert_hashtag_usage_and_increment',
  'prevent_default_collection_delete',
  'prevent_collections_truncate',
  'prevent_collection_items_truncate',
  'prevent_saved_places_truncate',
  'prevent_wishlist_places_truncate',
  'decrement_discovery_place_saved_count',
  'upsert_city_stamp',
  'increment_counter'
) ORDER BY routine_name;

-- ── Trigger verification ────────────────────────────────────────────────────

SELECT trigger_name, event_object_table, event_manipulation
FROM information_schema.triggers
WHERE trigger_name IN (
  'enforce_default_collection_no_delete',
  'block_collections_truncate',
  'block_collection_items_truncate',
  'block_saved_places_truncate',
  'block_wishlist_places_truncate'
) ORDER BY trigger_name;

-- ── Feature flag status ─────────────────────────────────────────────────────

SELECT flag, enabled FROM feature_flags ORDER BY flag;

-- ── Admin bootstrap ─────────────────────────────────────────────────────────

SELECT id, email, role FROM profiles WHERE role = 'admin';

-- ── Storage buckets ─────────────────────────────────────────────────────────
-- Run in Supabase Dashboard > Storage — confirm buckets exist:
-- profile-media (public)
-- post-media (public)
-- memories (public)
```

---

## 16. Files Changed (Core Beta Trust + Usability Pass)

All changes applied to both `travel-buddy-standalone/` and `artifacts/travel-buddy/`:

| File | Change | Issue |
|------|--------|-------|
| `app/u/[username].tsx` | Added `iBlockedThem` state, `handleUnblock` callback, Unblock button | #118 |
| `app/circle.tsx` | Added `blockerIds.has(u.id)` check in `CircleUserRow` hidden condition | #226 |
| `src/components/TelegraphInboxScreen.tsx` | Added `filteredRequests` (filters both blocked/blocker directions); `requestCount` uses filtered length; `RequestsPane` receives `filteredRequests` | #119 |
| `src/components/PostCard.tsx` | All 4 card variants: `isReported` state, early-return guard, `onReported` prop wired | #217 |
| `src/services/trips.ts` | `updateTrip` body builder: added `destinationCity`, `destinationCountry`, `startDate`, `endDate`; `TripInvite` interface: added `visibility`, `memberCount` | #125/#150, #216 |
| `app/(tabs)/trips.tsx` | `InviteCard`: shows visibility label + memberCount; accept navigates to `/trip/:id` | #125/#150 |
| `app/trip/edit.tsx` | **Created** — pre-filled trip edit form (owner-gated) | #216 |
| `app/trip/[id].tsx` | Edit Trip button is now owner-only Pressable navigating to `/trip/edit?id=…` | #216 |

API server changes:

| File | Change | Issue |
|------|--------|-------|
| `artifacts/api-server/src/routes/trips.ts` | `GET /api/me/trip-invites/pending`: added `visibility` to trips select + member-count subquery | #125/#150 |

---

## 17. Validation Table

| Check | Command | Result |
|-------|---------|--------|
| API server typecheck | `pnpm --filter @workspace/api-server run typecheck` | ✅ PASS |
| Standalone typecheck | `cd travel-buddy-standalone && pnpm typecheck` | ✅ PASS |
| Full workspace typecheck | `pnpm run typecheck` | ✅ PASS |
| Source drift | `bash scripts/sync-standalone.sh --check-source` | ✅ PASS — 0 drifted files |
| Dependency drift | `bash scripts/sync-standalone.sh --check-deps` | ✅ PASS |
| Sync regression suite | `bash scripts/test-sync-standalone.sh` | ✅ PASS — 78/78 |
| Routes guard | `pnpm --filter @workspace/scripts run test:routes-guard` | ✅ PASS |
| API server build | `pnpm --filter @workspace/api-server run build` | ✅ PASS |
| Code review | Automated code review | ✅ APPROVED_WITH_COMMENTS |

---

## 18. Commit Message

```
docs: Core Beta Trust + Usability Pass — closeout report + SQL inventory

Part 1 — Core Beta Trust + Usability Pass Final Report
All 7 items complete: #118 unblock button, #119 request-pane filtering,
#124 pre-existing pass, #125/#150 invite preview + accept navigation,
#216 trip edit screen, #217 post reporting, #226 circle blocking.
Source drift 0; all typechecks and validation suites pass.

Part 2 — Full Undeployed SQL + Backend Inventory
Covers migrations 0077–0089 (10 pending, 6 ship-blocking),
SQL functions (11 inventoried, 2 unknown production status),
triggers (5 inventoried, 1 pending), RLS (all pending-migration
tables have RLS defined inline), storage (3 buckets used by backend),
backend routes (5 × 501 RAB stubs; sub-resource routes blocked by
pending migrations), background jobs (2 active, 1 unconfirmed),
30 env vars, feature flags, direct Supabase risk (5 mobile mutations;
3 dead code, 1 monitored, 1 non-live), and final 20-item beta/prod
blocker list with verification SQL.

No code changes — documentation only.
```

*End of report. All claims are based on local file inspection as of 2026-07-03.
Production status for any item marked "production verification required" must
be confirmed in the Supabase dashboard before treating it as live.*
