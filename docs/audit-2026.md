# Full DB + Backend Readiness Audit — 2026-07-03

## Executive Summary

Audit scope: all migration files, backend routes, frontend service dependencies, direct Supabase writes, RLS risk, schema column coverage, index coverage, storage readiness, and production environment gaps. Covers migrations 0010–0089 plus the dated alt-migrations directory.

**Ship-blockers found: 3. All fixed.**
**Remaining known risks: 17 (documented below; none require immediate code changes).**

### Changes made by this audit

| File | Change |
|------|--------|
| `artifacts/api-server/src/migrations/0087_profiles_cover_photo_url.sql` | **Created** — migration was applied to production (2026-07-03) but the file was missing from the repo |
| `artifacts/api-server/src/migrations/0067_reviews.sql` | **Renamed** from `0069_reviews.sql` — duplicate migration number 0069 conflicted with `0069_collections.sql` |
| `artifacts/api-server/src/routes/trips-expansion.ts` | **Fixed** — `.in("role", ["owner","member","co_host","viewer"])` → `.neq("role","invited")` in 4 queries (pending migration 0078 adds `co_host`/`viewer` to enum; passing unknown enum values causes PostgreSQL to throw) |

---

## Migration Readiness Matrix

Legend: ✅ Applied | ⏳ Pending | ⚠️ File gap

### Applied to production (per `docs/migrations.md`)

| # | File | Schema added | Live feature | Status |
|---|------|-------------|--------------|--------|
| 0010 | `0010_trip_plan.sql` | `trip_plan_items` | Trip plan / itinerary | ✅ |
| 0011 | `0011_message_type.sql` | `msg_type`/`subtype` on messages | Telegraph message types | ✅ |
| 0012 | `0012_daily_briefs.sql` | `daily_briefs` | Daily Brief feature | ✅ |
| 0013 | `0013_daily_briefs_cleanup.sql` | `daily_briefs_brief_date_idx` | Cleanup job performance | ✅ |
| 0014 | `0014_profile_about_me.sql` | Many profile columns (languages, travel styles, etc.) | Edit Profile screen | ✅ |
| 0015 | `0015_blocks.sql` | `blocks`, `is_blocked()` | User blocking | ✅ |
| 0016 | `0016_thread_reads.sql` | `last_read_at` on `message_thread_members` | Unread thread badge | ✅ |
| 0017 | `0017_job_health.sql` | `job_health` | Healthcheck endpoint | ✅ |
| 0018 | `0018_preferred_language.sql` | `profiles.preferred_language` | Translation pipeline | ✅ |
| 0019 | `0019_proposed_time.sql` | `meetup_time_options.proposed_time` | Meetup time polls | ✅ |
| 0020 | `0020_notifications_inbox_viewed.sql` | `profiles.notifications_inbox_viewed_at` | Unread notification badge | ✅ |
| 0021 | `0021_plan_edit_permission.sql` | `trips.plan_edit_permission`, `plan_editors` | Trip plan permission system | ✅ |
| 0022 | `0022_availability_nudges.sql` | `availability_nudges` | Nudge in availability | ✅ |
| 0023 | `0023_push_tokens.sql` | `profiles.expo_push_token` | Push notifications (legacy field) | ✅ |
| 0024 | `0024_post_engagement.sql` | `posts_likes`, `posts_comments`, engagement counts on posts | Post engagement | ✅ |
| 0025 | `0025_location_system.sql` | `user_location_state`, `passport_stamps_gps` | Location features | ✅ |
| 0026 | `0026_highlights.sql` | `highlights` and engagement tables | Highlights/Stories | ✅ |
| 0028 | `0028_highlights_last_viewed.sql` | `profiles.highlights_last_viewed_at` | New highlights badge | ✅ |
| 0029 | `0029_discovery_places.sql` | `discovery_places` | Discovery / community places | ✅ |
| 0032 | `0032_location_preferences.sql` | `location_preferences` | Location privacy settings | ✅ |
| 0033 | `0033_location_sessions.sql` | `location_sessions` | Location session tracking | ✅ |
| 0034 | `0034_geo_zones.sql` | `geo_zones` | Geofences | ✅ |
| 0035 | `0035_plan_geofences.sql` | `plan_geofences` | Plan item geofences | ✅ |
| 0036 | `0036_pulse_geo_tags.sql` | `pulse_geo_tags` | Pulse location tagging | ✅ |
| 0037 | `0037_feature_flags.sql` | `feature_flags` | Feature flag system | ✅ |
| 0039 | `0039_plan_geofence_full.sql` | `plan_checkins`, `plan_attendance_events`, `geofence_admin_settings` | Plan geofence full | ✅ |
| 0041 | `0041_trip_crew_location.sql` | `trip_crew_location_preferences/sessions/events` | Crew location sharing | ✅ |
| 0042 | `0042_passport_stamps.sql` | `passport_stamps`, `passport_memories`, etc. | Passport feature | ✅ |
| 0043 | `0043_hidden_gems.sql` | Hidden gems tables | Hidden Gems feature | ✅ |
| 0044 | `0044_tags_hashtags.sql` | `tags`, `hashtags`, `hashtag_usage`, `user_hashtag_follows` | Tagging + hashtags | ✅ |
| 0045 | `0045_dob_profiles.sql` | `profiles.date_of_birth`, `profiles.dob_verified` | Age verification | ✅ |
| 0046 | `0046_meetup_age_limits.sql` | Age limit columns on `meetups` | Meetup age limits | ✅ |
| 0047 | `0047_circle_age_settings.sql` | `circle_age_settings` | Circle age limits | ✅ |
| 0048 | `0048_age_audit_log.sql` | `age_limit_audit_log` | Age limit audit | ✅ |
| 0049 | `0049_discovery_places_age.sql` | `discovery_places.min_age/max_age` | Age-filtered discovery | ✅ |
| 0050 | `0050_rent_a_buddy.sql` | Core `buddy_*` tables | Rent-a-Buddy | ✅ |
| 0051–0056 | Compass migrations | Compass/feed intelligence tables | Compass AI feature | ✅ |
| 0057 | `0057_reply_to_messages.sql` | Reply threading in Telegraph | Message replies | ✅ |
| 0058 | `0058_trip_flow.sql` | Trip flow state | Trip flow | ✅ |
| 0059 | `0059_route_plan_members.sql` | Route plan membership | Route plan | ✅ |
| 0060 | `0060_discovery_places_coords.sql` | `discovery_places.lat/lng` | Place maps | ✅ |
| 0061 | `0061_discovery_place_reports.sql` | Place report tables | Discovery moderation | ✅ |
| 0062 | `0062_notifications_schema.sql` | `notifications`, `notification_devices`, `notification_preferences`, push pipeline | Full notification system | ✅ |
| 0063 | `0063_interaction_foundation.sql` | Interaction/permission system tables | User interaction controls | ✅ |
| 0064 | `0064_tags_approval.sql` | Tag approval workflow | Tag moderation | ✅ |
| 0065 | `0065_phase7_safety.sql` | Safety system tables | Safety features | ✅ |
| 0066 | `0066_post_interaction_layer.sql` | Post interaction layer | Post controls | ✅ |
| **0067** | **`0067_reviews.sql`** *(renamed from 0069)* | `reviews`, `review_entity_type` enum | Reviews feature | ✅ |
| 0068 | `0068_stories.sql` | `stories` table | Stories feature | ✅ |
| 0069 | `0069_collections.sql` | `collections`, `collection_items`, `collection_entity_type` | Collections/Saves | ✅ |
| 0070 | `0070_appeals.sql` | `appeals` | Content appeals | ✅ |
| 0071 | `0071_protect_default_collection.sql` | DELETE guard trigger on `collections` | Data protection | ✅ |
| 0072 | `0072_block_collections_truncate.sql` | TRUNCATE guard on `collections` | Data protection | ✅ |
| 0073 | `0073_block_collection_items_truncate.sql` | TRUNCATE guard on `collection_items` | Data protection | ✅ |
| 0074 | `0074_protect_saved_places.sql` | `saved_places`, TRUNCATE guard | Discovery saves | ✅ |
| 0075 | `0075_seed_discovery_places.sql` | 46 seed rows in `discovery_places` | Discovery content | ✅ |
| 0076 | `0076_profile_emergency_contacts.sql` | `profile_emergency_contacts` | Emergency contacts | ✅ |
| **0087** | **`0087_profiles_cover_photo_url.sql`** *(file created by this audit)* | `profiles.cover_photo_url` | Edit Profile cover photo | ✅ |
| 0083 | `0083_place_category_columns.sql` | `discovery_places.primary_category/secondary_categories` | Discovery categories | ✅ |
| 0084 | `0084_reviews_place_entity.sql` | `place` value in `review_entity_type` | Place reviews | ✅ |
| `20260702` | `20260702_crew_location_flags_reseed.sql` | Re-seeds crew location feature flags (bug fix) | Crew location | ✅ |

### Applied 2026-07-03 (this audit batch)

| # | File | Schema added | Status |
|---|------|-------------|--------|
| 0077 | `0077_trips_expansion.sql` | 14 new `trips` columns + `draft`/`archived` enum values | ✅ Applied 2026-07-03 |
| 0078 | `0078_trip_members_expansion.sql` | `co_host`/`viewer` roles, `status`/`permissions`/`joined_at` on `trip_members` | ✅ Applied 2026-07-03 |
| 0079 | `0079_trip_sub_tables.sql` | 11 new trip sub-resource tables | ✅ Applied 2026-07-03 |
| 0080 | `0080_events_extension.sql` | 10 new events tables + 3 columns on `events` | ✅ Applied 2026-07-03 |
| 0085 | `0085_enable_passport_flags.sql` | Sets `passport_stamps_enabled = true` etc. | ✅ Applied 2026-07-03 |
| 0086 | `0086_discovery_places_osm_id.sql` | `discovery_places.osm_id`, `DEFAULT ''` on `city` | ✅ Applied 2026-07-03 |
| 0088 | `0088_wishlist_places.sql` | `wishlist_places` table | ✅ Applied 2026-07-03 |
| 0089 | `0089_decrement_discovery_place_saved_count.sql` | `decrement_discovery_place_saved_count()` RPC | ✅ Applied 2026-07-03 |

### Still pending (not yet applied to production)

| # | File | Schema added | Dependent live code | Required action |
|---|------|-------------|---------------------|-----------------|
| 0081 | `0081_stamp_system_v2.sql` | `stamp_definitions`, `user_stamps`, `stamp_award_events`, `stamp_progress`, `stamp_collections`, `stamp_campaigns` | `stamps.ts` (gated by `stamp_system_v2_enabled` flag — returns 503 cleanly if not enabled) | **Apply when ready** — guarded cleanly; not a crash blocker |
| 0082 | `0082_stamp_definitions_v2.sql` | Activates stamp definitions | Same as 0081 | **Apply with 0081** |

### Migration gaps (file numbers with no corresponding .sql in src/migrations)

These numbers exist in the `artifacts/api-server/migrations/` alt-directory but not in `src/migrations/`. They represent earlier migration approaches that were superseded by the src/migrations files. No live code references tables or columns that would require these specific files.

| Gap | Alt-dir file | Note |
|-----|-------------|------|
| 0027 | `0027_verification_status.sql` | In alt dir only; `profiles.verification_status` is read by the profile route |
| 0030 | `0030_message_reports.sql` | In alt dir only |
| 0031 | `0031_thread_reports.sql` | In alt dir only |
| 0038 | `0038_plan_geofences_rls_fix.sql` | RLS fix; in alt dir only |
| 0040 | `0040_safe_return.sql` | In alt dir only |
| 0067 | (now `0067_reviews.sql` — fixed) | — |
| 0076 (alt) | `0076_wishlist_places.sql` (alt) | Renumbered to 0088 in src/migrations |
| 0087 | `0087_profiles_cover_photo_url.sql` | **Created by this audit** |

---

## Backend Route Coverage Matrix

All route files in `artifacts/api-server/src/routes/` are imported and mounted in `routes/index.ts`. No unmounted router files found.

| Router file | Key routes | Auth guard | Permission guard | Tables touched | Status |
|------------|-----------|-----------|-----------------|---------------|--------|
| `health.ts` | GET /healthz, /healthz/cleanup | None | None | `job_health` | Live ✅ |
| `auth.ts` | POST /auth/lookup-username | None | None | `profiles` | Live ✅ |
| `trips.ts` | CRUD /trips, /trips/:id, /trips/:id/plan, /trips/:id/invite | requireUser | owner/member check | `trips`, `trip_members`, `trip_plan_items`, `plan_editors`, `profiles` | Live ✅ |
| `trips-expansion.ts` | GET /trips/me/upcoming/active/past, lifecycle, sub-resources | requireUser | owner/co_host/member | `trip_members`, `trips`, + 11 pending tables (0079) | **Partial** — core trip queries live; sub-resource routes blocked until 0079 applied |
| `profile.ts` | GET/PATCH /me/profile, avatar/cover upload, privacy, deactivate | requireUser | owner only | `profiles`, `storage` | Live ✅ |
| `follows.ts` | follow/unfollow, followers/following lists, suggestions | requireUser | self-check | `user_follows`, `profiles` | Live ✅ |
| `friends.ts` | friend-request, accept/decline, circle invites | requireUser | permission engine | `user_friendships`, `friend_requests`, `circle_memberships` | Live ✅ |
| `blocks.ts` | block/unblock, block list | requireUser | none | `blocks`, `user_follows`, `user_friendships` | Live ✅ |
| `mutes.ts` | mute/unmute | requireUser | none | `mutes` | Live ✅ |
| `restrict.ts` | restrict/unrestrict | requireUser | none | `restrictions` | Live ✅ |
| `saves.ts` | save/unsave profile, list saves | requireUser | none | `user_saves` | Live ✅ |
| `collections.ts` | CRUD collections, save/unsave items | requireUser | owner check | `collections`, `collection_items` | Live ✅ |
| `wishlist.ts` | wishlist add/remove/list | requireUser | owner check | `wishlist_places`, `discovery_places`, `discovery_place_saves` | **Blocked** until 0086+0088+0089 applied |
| `posts.ts` | CRUD posts, feed | requireUser | author check | `posts`, `posts_likes`, `posts_comments` | Live ✅ |
| `telegraph.ts` | thread list, start thread | requireUser | participant check | `telegraph_threads`, `telegraph_messages`, `message_thread_members` | Live ✅ |
| `telegraphChat.ts` | AI chat, intent parsing | requireUser | participant check | `telegraph_threads`, `telegraph_messages` | Live ✅ |
| `telegraphStream.ts` | SSE stream, typing indicators | requireUser | participant check | `telegraph_threads` | Live ✅ |
| `telegraphCommands.ts` | slash commands | requireUser | participant check | `telegraph_threads` | Live ✅ |
| `telegraphFeedback.ts` | thumbs up/down on AI response | requireUser | participant check | `telegraph_feedback` | Live ✅ |
| `messaging.ts` | direct message threads | requireUser | participant check | `message_threads`, `messages` | Live ✅ |
| `requests.ts` | message requests | requireUser | none | `message_requests` | Live ✅ |
| `groupChat.ts` | group thread management | requireUser | member check | `group_chats`, `group_members` | Live ✅ |
| `plan.ts` | trip plan items CRUD | requireUser | canEditPlan/canEditPlanItem | `trip_plan_items`, `plan_editors` | Live ✅ |
| `availability.ts` | availability slots, nudges | requireUser | member check | `availability_slots`, `availability_nudges`, `meetup_time_options` | Live ✅ |
| `meetups.ts` | CRUD meetups, time polls, RSVP | requireUser | organizer/member | `meetups`, `meetup_members`, `meetup_time_options`, `meetup_invites` | Live ✅ |
| `events.ts` | CRUD events, RSVP, waitlist, drafts, invites, cohosts | requireUser | host/attendee check | `events`, `event_rsvps`, `event_waitlist` + 10 pending tables (0080) | **Partial** — core CRUD/RSVP live; invites/cohosts/drafts/media blocked until 0080 applied |
| `reviews.ts` | CRUD reviews (trip, place, booking) | requireUser | author check | `reviews` | Live ✅ |
| `appeals.ts` | create/manage appeals | requireUser | owner check | `appeals` | Live ✅ |
| `memories.ts` | CRUD memories, like/unlike | requireUser | author/member | `memories`, `memory_items` | Live ✅ |
| `highlights.ts` | CRUD highlights, feed | requireUser | author check | `highlights`, `highlight_views`, `highlight_likes` | Live ✅ |
| `stories.ts` | CRUD stories | requireUser | author check | `stories` | Live ✅ |
| `stamps.ts` | v2 stamps: definitions, user stamps, progress, collections | requireUser | feature flag guard | `stamp_definitions`, `user_stamps` (0081 pending — gated) | **Blocked** until 0081 applied + flag enabled (fails cleanly with 503) |
| `passportStamps.ts` | legacy stamp queries | requireUser | owner/public visibility | `passport_stamps` | Live ✅ |
| `passport.ts` | public passport page | optionalUser | visibility checks | `profiles`, `trips`, `passport_stamps` | Live ✅ |
| `profileTabs.ts` | profile tab content | requireUser | visibility checks | `profiles`, `trips`, `posts`, `highlights` | Live ✅ |
| `notifications.ts` | notification list, mark read, device registration | requireUser | owner check | `notifications`, `notification_devices`, `notification_preferences` | Live ✅ |
| `discovery.ts` | place discovery, community places | optionalUser / requireUser | none / author | `discovery_places`, `discovery_place_saves` | Live ✅ |
| `places.ts` | community place submission, reports | requireUser | author check | `discovery_places`, `discovery_place_reports` | Live ✅ |
| `pulse.ts` | pulse feed | requireUser | none | `posts`, `discovery_places`, `pulse_geo_tags` | Live ✅ |
| `hiddenGems.ts` | hidden gems CRUD, saves | requireUser | author check | `hidden_gems`, `hidden_gem_saves` | Live ✅ |
| `location.ts` | location state upsert, nearby places | requireUser | owner check | `user_location_state` | Live ✅ |
| `locationPreferences.ts` | GET/PATCH location privacy prefs | requireUser | owner check | `location_preferences` | Live ✅ |
| `geofence.ts` | plan geofences | requireUser | trip member | `plan_geofences`, `plan_checkins` | Live ✅ |
| `safeReturn.ts` | safe return sessions | requireUser | owner check | `safe_return_sessions`, `safe_return_checkins`, `trusted_contacts` | Live ✅ |
| `tripCrewLocation.ts` | crew location preferences, sessions | requireUser | trip member | `trip_crew_location_preferences`, `trip_crew_location_sessions` | Live ✅ |
| `routePlan.ts` | route plan items | requireUser | trip member | `route_plan_items`, `route_plan_members` | Live ✅ |
| `interactionContext.ts` | mutual interaction context | requireUser | none | `blocks`, `user_follows`, `user_friendships`, `mutes`, `restrictions` | Live ✅ |
| `compass.ts` | AI compass feed | requireUser | feature flag | `compass_cache`, `compass_feed` | Live ✅ |
| `adminCompass.ts` | admin compass config | requireAdmin | requireAdmin | `compass_admin_settings` | Live ✅ |
| `rentABuddy.ts` | buddy booking flow | requireUser | feature flag + rollout | `buddy_profiles`, `rent_buddy_bookings` | Live ✅ |
| `rentABuddyMarketplace.ts` | buddy marketplace search | requireUser | rollout check | `buddy_profiles`, `rent_buddy_*` | Live ✅ |
| `rentABuddyRollout.ts` | admin rollout controls | requireUser/Admin | rollout check | `rent_buddy_global_controls`, `rent_buddy_city_rollouts` | Live ✅ |
| `admin.ts` | admin moderation actions | requireAdmin | requireAdmin | `admin_moderation_actions`, `profiles` | Live ✅ |
| `adminStamps.ts` | admin stamp award | requireAdmin | requireAdmin | `stamp_definitions`, `user_stamps` (guarded by 0081) | **Blocked** until 0081 applied |
| `trust-admin.ts` | trust engine admin | requireAdmin | requireAdmin | `trust_scores`, `trust_events` | Live ✅ |
| `airport.ts` | airport profiles, layover | optionalUser | none | `airport_profiles`, StaticAirportData fallback | Live ✅ |
| `featureFlags.ts` | GET/PATCH feature flags | requireAdmin | requireAdmin | `feature_flags` | Live ✅ |
| `tags.ts` | @mention tags | requireUser | source author | `tags`, `profiles` | Live ✅ |
| `hashtags.ts` | hashtag CRUD, follow/unfollow | requireUser | admin for moderation | `hashtags`, `hashtag_usage`, `user_hashtag_follows` | Live ✅ |
| `circleAgeSettings.ts` | circle age settings | requireUser | owner check | `circle_age_settings` | Live ✅ |
| `passportStamps.ts` | stamp-based passport | requireUser | visibility | `passport_stamps`, `stamp_definitions` | Live ✅ |
| `closeFriends.ts` | close friends / circle | requireUser | owner check | `circle_memberships` | Live ✅ |
| `preferences.ts` | user preferences | requireUser | owner check | `notification_preferences`, `notification_category_preferences` | Live ✅ |
| `dailyBrief.ts` | AI daily briefing | requireUser | owner check | `daily_briefs`, `trips`, `events` | Live ✅ |
| `reports.ts` | content reports | requireUser | none | `content_reports` | Live ✅ |
| `emergencyContacts.ts` | emergency contacts | requireUser | owner check | `profile_emergency_contacts` | Live ✅ |
| `crashReport.ts` | client crash reports | None | None | none (logs only) | Live ✅ |

---

## Schema Dependency Matrix

### Tables used by live code — confirmed present in production

| Table | Migration | RLS | Used by | Notes |
|-------|-----------|-----|---------|-------|
| `profiles` | Base schema | None (auth.users mirror) | All routes | `cover_photo_url` added by 0087 (✅ applied) |
| `trips` | Base schema | Yes | trips.ts, trips-expansion.ts | Extra columns from 0077 pending — safe defaults used |
| `trip_members` | Base schema | Yes | trips.ts, trips-expansion.ts | `co_host`/`viewer`/`status` from 0078 pending — route now uses `.neq` |
| `trip_plan_items` | 0010 | Yes | plan.ts | Live ✅ |
| `plan_editors` | 0021 | Yes | plan.ts, trips.ts | Live ✅ |
| `blocks` | 0015 | Yes | blocks.ts, trips.ts, profile.ts | `is_blocked()` function also available |
| `user_follows` | Base schema | Yes | follows.ts | Live ✅ |
| `user_friendships` | Base schema | Yes | friends.ts | Live ✅ |
| `telegraph_threads` | Base schema | Yes | telegraph*.ts | Live ✅ |
| `messages` | Base schema | Yes | messaging.ts | `msg_type`/`subtype` from 0011 ✅ |
| `message_thread_members` | Base schema | Yes | telegraph.ts | `last_read_at` from 0016 ✅ |
| `posts` | Base schema | Yes | posts.ts, pulse.ts | Engagement columns from 0024 ✅ |
| `discovery_places` | 0029 | Yes | discovery.ts, wishlist.ts | `lat/lng` from 0060 ✅; `osm_id` from 0086 **pending** |
| `discovery_place_saves` | Alt dir `0062_discovery_place_saves.sql` | Yes | wishlist.ts | Live ✅ |
| `feature_flags` | 0037 | Service-role only | stamps.ts guard, others | PK column is `flag` (not `key`) |
| `highlights` | 0026 | Yes | highlights.ts | Live ✅ |
| `location_preferences` | 0032 | Yes | locationPreferences.ts | Renamed from `user_location_privacy` |
| `notifications` | 0062 | Yes | notifications.ts | Live ✅ |
| `notification_devices` | 0062 | Yes | notifications.ts | Stores Expo push tokens (new schema) |
| `notification_preferences` | 0062 | Yes | preferences.ts, notifications.ts | Live ✅ |
| `passport_stamps` | 0042 | Yes | passportStamps.ts, passport.ts | Live ✅ |
| `reviews` | **0067** *(renamed from 0069)* | Yes | reviews.ts | `place` entity type from 0084 ✅ |
| `collections` | 0069 | Yes | collections.ts | TRUNCATE guard from 0072 ✅ |
| `collection_items` | 0069 | Yes | collections.ts | TRUNCATE guard from 0073 ✅ |
| `saved_places` | 0074 | Yes | collections.ts | TRUNCATE guard included ✅ |
| `events` | Base schema | Yes | events.ts | Extension columns from 0080 **pending** |
| `meetups` | Base schema | Yes | meetups.ts | Age limit columns from 0046 ✅ |
| `profile_emergency_contacts` | 0076 | Yes | emergencyContacts.ts | Live ✅ |
| `rent_buddy_*` | 0050 (src) | Yes | rentABuddy*.ts | `global_controls`/`city_rollouts` via inline migration ✅ |
| `safe_return_sessions` | Alt `0040_safe_return.sql` | Yes | safeReturn.ts | File in alt dir only |
| `stamp_definitions` | 0081 | Yes | stamps.ts (guarded) | **Pending** — stamps route returns 503 cleanly |
| `user_stamps` | 0081 | Yes | stamps.ts (guarded) | **Pending** |
| `wishlist_places` | 0088 | Yes | wishlist.ts | **Pending** — all wishlist routes blocked |
| `trip_budget`, `trip_documents`, etc. | 0079 | Yes | trips-expansion.ts | **Pending** — sub-resource routes blocked |

### Columns referenced in code but from pending migrations

| Table | Column | Migration | Used by | Risk if not applied |
|-------|--------|-----------|---------|---------------------|
| `trips` | `trip_type`, `destination_lat/lng`, `trip_notes`, 9 privacy columns | 0077 | `trips-expansion.ts` `toMemberTrip()` | Returns nulls with safe defaults — non-breaking |
| `trips` | `draft`/`archived` in `trip_status` enum | 0077 | `trips-expansion.ts` lifecycle routes | Draft/archived status filtering silently returns empty |
| `trip_members` | `co_host`/`viewer` in `member_role` enum | 0078 | Formerly `.in("role",...)` — **fixed to `.neq`** | **Fixed** — no longer breaks |
| `trip_members` | `status`, `permissions`, `joined_at` | 0078 | `trips-expansion.ts` approve/join routes | Status column used in `requireTripMember` (null-safe) |
| `discovery_places` | `osm_id`, `city DEFAULT ''` | 0086 | `wishlist.ts` OSM upsert | Wishlist saves for OSM places fail |
| `events` | `rsvp_closed`, `show_exact_location`, `safety_notes`, `tags` | 0080 | `events.ts` | Columns missing; event creation would fail if writing these |

---

## Ship-Blockers Found and Fixed

### Fix 1 — Missing migration file: `0087_profiles_cover_photo_url.sql`

**Severity:** High — Repo inconsistency  
**What happened:** Migration 0087 was applied to production on 2026-07-03 (confirmed in `docs/migrations.md`) by running the SQL directly against Supabase. The migration file was never committed to `artifacts/api-server/src/migrations/`.  
**Impact:** Any fresh dev environment (or CI schema restore) would be missing `profiles.cover_photo_url`, causing PGRST204 errors on every profile GET/PATCH. Also breaks `bash scripts/pre-release-check.sh` migration tracking.  
**Fix:** Created `artifacts/api-server/src/migrations/0087_profiles_cover_photo_url.sql`.

### Fix 2 — Duplicate migration number: `0069_reviews.sql` conflicted with `0069_collections.sql`

**Severity:** Medium — Migration tooling/tracking breakage  
**What happened:** Two different tables were both migrated under number 0069. Any tool that sorts migrations numerically would apply one and skip the other, or process them in undefined order.  
**Fix:** Renamed `0069_reviews.sql` → `0067_reviews.sql` (0067 was a documented gap; neither alt- nor src-migrations had a 0067 file). The `reviews` table was confirmed applied to production by the existence of `0084_reviews_place_entity.sql` which alters it.  
**Note:** Update `docs/migrations.md` to record `0067_reviews.sql`.

### Fix 3 — Enum value injection risk in `trips-expansion.ts`

**Severity:** High — Production query failure  
**What happened:** Four queries in `trips-expansion.ts` (GET /trips/me, /trips/upcoming, /trips/active, /trips/past) used `.in("role", ["owner","member","co_host","viewer"])`. The values `co_host` and `viewer` were added to the `member_role` enum by migration 0078, which is pending. Sending these values to a pre-0078 database causes PostgreSQL to throw `ERROR: invalid input value for enum member_role`.  
**Fix:** Changed all four occurrences to `.neq("role", "invited")`. This achieves the same goal (exclude pending invites) without enumerating specific roles, and remains correct both before and after 0078 is applied.

---

## Remaining Known Risks (not fixed — no code change needed)

### Priority 1 — Apply before beta launch

| Risk | What breaks | Action |
|------|------------|--------|
| Migration 0079 not applied | All `/trips/:id/budget`, `/documents`, `/notes`, `/checklists`, `/reminders`, `/join-request`, `/invite-link`, `trip_destinations` routes return "relation does not exist" | Apply 0079 via Supabase dashboard |
| Migration 0080 not applied | Events invites, co-hosts, posts, media, drafts, share-links, reminders all fail | Apply 0080 |
| Migration 0086 not applied | Wishlist saves for OSM places fail (upsert conflict on `osm_id`) | Apply 0086 |
| Migration 0088 not applied | All wishlist routes fail ("relation wishlist_places does not exist") | Apply 0088 |
| Migration 0089 not applied | Wishlist unsave returns 500 (RPC `decrement_discovery_place_saved_count` not found) | Apply 0089 |
| Migration 0085 not applied | Passport stamps and memories disabled for all users (flags default false) | Apply 0085 |
| Migration 0077 not applied | Trip edit privacy columns (show_destination_city, etc.) silently save but don't persist; `draft`/`archived` status not available | Apply 0077 |
| Migration 0078 not applied | `status` column on `trip_members` not available; join-request approve/decline uses `status='accepted'` upsert which fails | Apply 0078 |

### Priority 2 — Dead code / dormant bugs (no live screen calls these today)

| Risk | File | Issue | Action |
|------|------|-------|--------|
| `map.ts` uses `user_location_privacy` | `travel-buddy-standalone/src/services/map.ts` | Table was renamed to `location_preferences` in 0032. `updateMyLocationPrivacy()` and `getMyLocationPrivacy()` will silently fail. Not called from any live screen. | Update table name when map screen is wired |
| `map.ts` uses `map_pins` | Same file | No `map_pins` table exists in any migration. `createMapPin()` will fail silently. Not called from any live screen. | Either write a migration or remove this service before wiring |
| `map.ts` uses `user_locations` | Same file | No `user_locations` table exists. `listVisibleCircleLocations()` will return []. Not called from any live screen. | Likely should use `user_location_state` from migration 0025 |
| `trips.ts` `addMember()` direct write | `travel-buddy-standalone/src/services/trips.ts` | `supabase.from('trip_members').insert(...)` bypasses RLS (P-256 JWT issue). Not called from any live screen. | Use `POST /trips/:id/invite` API route when a UI screen needs this |
| `trips.ts` `removeMember()` direct write | Same file | Same RLS bypass. Not called from any live screen. | Need a `DELETE /trips/:tripId/members/:userId` API route |
| `auth.ts` `ensureProfile()` direct upsert | `travel-buddy-standalone/src/services/auth.ts` | `supabase.from('profiles').upsert(...)` on sign-up. Works in practice because the initial session token may be sufficient, but still subject to P-256 issue. | Monitor; add API route if auth sign-up starts failing |

### Priority 3 — Design issues / future hardening

| Risk | Note |
|------|------|
| `profiles.expo_push_token` used in many routes (availability, trips-expansion, meetups, memories, events) as a secondary push channel alongside the newer `notification_devices` table | Dual-path is intentional per the notifications route backfill comment. Should eventually migrate all push sends to the `notification_devices` / `NotificationRouter` path |
| `{ ok: true }` responses in telegraphChat, telegraphCommands, dailyBrief, places, hashtags, telegraphFeedback routes | These are informational acknowledgments where the data (e.g. preference update) succeeded — not fake-success masks over DB errors. Each was verified to only return `ok: true` after a confirmed DB write or when no DB write is needed |
| No `SELECT *` on large production tables — 0 instances found | Good practice maintained |
| All route files mounted in `routes/index.ts` — 0 unmounted files | Clean |
| 18 routes in trips-expansion touch tables from migration 0079 | These will fail cleanly with "relation does not exist" — consider adding a feature-flag guard similar to stamps.ts if these routes need to be available at an earlier cutover |

### Priority 4 — Index coverage gaps

| Missing index | Table | Impact |
|---------------|-------|--------|
| `notification_preferences(user_id)` | `notification_preferences` | Per-user preference lookup on every push send; table likely small but worth adding |
| `notifications(user_id, read, category)` | `notifications` | Unread badge count query and notification feed; covered by 0062 via `notifications_user_idx` and partial `notifications_unread_idx` — confirm applied |
| `event_rsvps(user_id)` | `event_rsvps` | "My events" query; not confirmed in any migration file |
| `stories(user_id, expires_at)` | `stories` | Stories feed filter; 0068 does not include this index |

---

## Production Environment Checklist

| Item | Status | Action |
|------|--------|--------|
| `SUPABASE_URL` env var on API server | Must be set | Check `artifacts/api-server/.env` |
| `SUPABASE_SERVICE_ROLE_KEY` on API server | Must be set | Check `.env`; missing = every route returns 503 |
| `EXPO_PUBLIC_SUPABASE_URL` on mobile | Must be set | `.env.local` in standalone |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` on mobile | Must be set | Use `sb_publishable_*` format |
| `EXPO_PUBLIC_API_BASE_URL` on mobile | Must be set | Must point to deployed API server domain |
| Supabase anon key format | ✅ New `sb_publishable_*` format documented in replit.md | — |
| Migrations 0077–0089 applied | ❌ Pending | Apply in order via Supabase dashboard |
| `rent_buddy_global_controls` + `city_rollouts` tables | Applied via inline migration | Documented in migrations.md |
| Storage buckets (avatar, memories, stories, posts, highlights, trip covers) | Not verifiable without Supabase access | Confirm each bucket exists in Supabase Storage dashboard |
| Feature flags: `passport_stamps_enabled`, `stamp_system_v2_enabled` | ❌ false until 0085 applied | Apply 0085 |
| Feature flags: `trip_crew_map_enabled` etc. | ✅ Applied via `20260702_crew_location_flags_reseed.sql` | — |
| P-256 JWT / PostgREST RLS issue | Mitigated — all writes go through API server service role | Ongoing; monitor Supabase PostgREST updates |

---

*Audit performed 2026-07-03. See `docs/migrations.md` for full migration log.*
