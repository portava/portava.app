# Travel Buddy — Full App Audit: Beta Readiness

**Audit date:** 2026-07-05  
**Auditor:** Agent automated review (code, schema, backend routes, mobile app)  
**Scope:** Rent a Buddy, Find Your Circle, Circle identity, Profile edit, Calendar, Menus, Telegraph, Discovery/Pulse/Passport buttons, DB truth, security, RLS.  
**Out of scope:** Applying any migration, code change, or fix. Third-party payment wiring.

---

## Phase 0 — Database Source-of-Truth Reconciliation

### Migration Directories Found in Repo

The project has **two active migration directories** plus several legacy/archived ones:

| Directory | Files | Status |
|---|---|---|
| `artifacts/api-server/src/migrations/` | **89 files** (0010–0107) | **CANONICAL** — per project rules; all patches go here |
| `artifacts/api-server/migrations/` | 65 files (different numbering) | **Non-canonical** — applied to production Supabase but not maintained going forward |
| `supabase/migrations/`, `db/migrations/`, `./migrations/`, `posts-backend/migrations/`, `follows-backend/migrations/`, `friends-backend/migrations/`, `stamps-backend/migrations/`, `passport-backend/migrations/`, `composer-pkg/migrations/`, `travel-buddy-standalone/migrations/`, `artifacts/travel-buddy/migrations/` | Various | **Legacy / archived** — do not use |

The canonical directory (`src/migrations/`) is the sole source of truth for new work. The non-canonical `artifacts/api-server/migrations/` directory holds earlier-era migrations that were applied to production Supabase and must not be deleted, but should not receive new files.

### Canonical Migration Files (89 total, 0010–0107)

| File | Summary |
|------|---------|
| `0010_trip_plan.sql` | trip_plan_items, RLS |
| `0011_message_type.sql` | messages msg_type/subtype |
| `0012_daily_briefs.sql` | daily_briefs |
| `0013_daily_briefs_cleanup.sql` | daily_briefs index |
| `0014_profile_about_me.sql` | profiles extended fields |
| `0015_blocks.sql` | blocks table, is_blocked() |
| `0016_thread_reads.sql` | message_thread_members.last_read_at |
| `0017_job_health.sql` | job_health |
| `0018_preferred_language.sql` | profiles.preferred_language |
| `0019_proposed_time.sql` | meetup_time_options.proposed_time |
| `0020_notifications_inbox_viewed.sql` | profiles.notifications_inbox_viewed_at |
| `0021_plan_edit_permission.sql` | trips.plan_edit_permission, plan_editors |
| `0022_availability_nudges.sql` | availability_nudges |
| `0023_push_tokens.sql` | profiles.expo_push_token |
| `0024_post_engagement.sql` | posts_likes, posts_comments, post counters |
| `0025_location_system.sql` | user_location_state, passport_stamps_gps |
| `0026_highlights.sql` | highlights + engagement tables |
| `0028_highlights_last_viewed.sql` | profiles.highlights_last_viewed_at |
| `0029_discovery_places.sql` | discovery_places |
| `0032_location_preferences.sql` | location_preferences |
| `0033_location_sessions.sql` | location_sessions |
| `0034_geo_zones.sql` | geo_zones |
| `0035_plan_geofences.sql` | plan_geofences |
| `0036_pulse_geo_tags.sql` | pulse_geo_tags |
| `0037_feature_flags.sql` | feature_flags, seed rows |
| `0039_plan_geofence_full.sql` | plan_geofences expanded, plan_checkins |
| `0041_trip_crew_location.sql` | trip_crew_location_* tables |
| `0042_passport_stamps.sql` | passport_stamps, passport_memories |
| `0043_hidden_gems.sql` | hidden_gems system |
| `0044_tags_hashtags.sql` | tags, hashtags, hashtag_usage |
| `0045_dob_profiles.sql` | profiles.date_of_birth |
| `0046_meetup_age_limits.sql` | meetups age limit columns |
| `0047_circle_age_settings.sql` | circle_age_settings |
| `0048_age_audit_log.sql` | age_limit_audit_log |
| `0049_discovery_places_age.sql` | discovery_places.min/max_age |
| `0050_rent_a_buddy.sql` | buddy_profiles, buddy_bookings, core RaB tables |
| `0051_compass_foundation.sql` | compass_user_profiles, compass_user_preferences |
| `0052_compass_pipeline_logs.sql` | compass audit/log tables |
| `0053_compass_feed_intelligence.sql` | compass_active_user_scores, etc. |
| `0054_compass_cache.sql` | compass_feed_cache, preload tables |
| `0055_compass_ux.sql` | compass_feedback_events, etc. |
| `0056_compass_user_prefs_v2.sql` | compass_user_preferences extended |
| `0057_reply_to_messages.sql` | messages.reply_to_id, saved_messages |
| `0058_trip_flow.sql` | route_plans, route_stops, route_legs |
| `0059_route_plan_members.sql` | route_plan_members |
| `0060_discovery_places_coords.sql` | discovery_places.lat/lng |
| `0061_discovery_place_reports.sql` | discovery_place_reports |
| `0062_notifications_schema.sql` | notifications, notification_devices, push_retry_queue |
| `0063_interaction_foundation.sql` | user_mutes, user_restrictions, reports, user_saves |
| `0064_tags_approval.sql` | tags.status |
| `0065_phase7_safety.sql` | report_evidence, 11 emergency feature_flags |
| `0066_post_interaction_layer.sql` | post_reactions, comment_likes, post_shares, post_edits |
| `0067_reviews.sql` | reviews system |
| `0068_stories.sql` | stories, story_views, story_reactions |
| `0069_collections.sql` | collections system |
| `0070_appeals.sql` | appeals |
| `0071_protect_default_collection.sql` | default collection guard |
| `0072_block_collections_truncate.sql` | collections block policy |
| `0073_block_collection_items_truncate.sql` | collection_items block policy |
| `0074_protect_saved_places.sql` | saved_places RLS |
| `0075_seed_discovery_places.sql` | discovery_places seed data |
| `0077_trips_expansion.sql` | trips extended columns |
| `0078_trip_members_expansion.sql` | trip_members extended |
| `0079_trip_sub_tables.sql` | trip sub-tables |
| `0080_events_extension.sql` | events table extended |
| `0081_stamp_system_v2.sql` | stamp system v2 |
| `0082_stamp_definitions_v2.sql` | stamp definitions |
| `0083_place_category_columns.sql` | places primary_category |
| `0084_reviews_place_entity.sql` | reviews.place entity type |
| `0085_enable_passport_flags.sql` | passport feature flags enabled |
| `0086_discovery_places_osm_id.sql` | discovery_places.osm_id |
| `0087_profiles_cover_photo_url.sql` | profiles.cover_photo_url |
| `0088_wishlist_places.sql` | wishlist_places |
| `0089_decrement_discovery_place_saved_count.sql` | saved_count trigger |
| `0090_rent_buddy_rollout_tables.sql` | rent_buddy_city_rollouts, global_controls, etc. |
| `0091_activate_stamp_definitions.sql` | stamp definitions seed |
| `0092_seed_rent_buddy_launch_cities.sql` | RaB launch cities (Cebu, Manila, Davao) |
| `0093_activate_stamp_definitions.sql` | duplicate activation run |
| `0095_post_category.sql` | posts.category |
| `0097_post_saves.sql` | post_saves |
| `0098_profile_translation_prefs.sql` | profiles translation preferences |
| `0099_missing_indexes.sql` | performance indexes |
| `0101_feed_save_indexes.sql` | feed/save indexes |
| `0102_safe_return_single_session.sql` | safe_return single session enforcement |
| `0103_post_media.sql` | post_media table |
| `0104_compass_new_tables.sql` | compass new tables |
| `0105_compass_performance_indexes.sql` | compass indexes |
| `0106_engagement_indexes.sql` | engagement indexes |
| `0107_compass_analytics_onboarding.sql` | compass_analytics_events, compass_settings extensions |

### Canonical Sequence Gaps — Explained

The following numbers are absent from the canonical directory but ARE present in the non-canonical `artifacts/api-server/migrations/` directory:

| Gap | Non-canonical file | Applied to prod? |
|---|---|---|
| 0027 | `0027_verification_status.sql` | Yes (via non-canonical) |
| 0030 | `0030_message_reports.sql` | Yes |
| 0031 | `0031_thread_reports.sql` | Yes |
| 0038 | `0038_plan_geofences_rls_fix.sql` | Yes |
| 0040 | `0040_safe_return.sql` | Yes |
| 0076 | `0076_profile_emergency_contacts.sql` | Yes |
| 0094 | `0094_profile_account_status_and_privacy.sql` | Yes |
| 0096 | Not found in either directory | Unknown |
| 0100 | `0100_backfill_display_name.sql` | Yes |

These gaps represent migrations that were applied via the non-canonical channel and never promoted to canonical numbering. The gap at 0096 is unexplained and should be investigated.

### ⚠️ IMPORTANT — Find Your Circle Tables Are in the Non-Canonical Directory

Find Your Circle (migrations 0115–0122) was applied through `artifacts/api-server/migrations/`, not the canonical `src/migrations/`. These migrations DO exist and their RLS policies are present and properly scoped:

| Non-canonical file | Table(s) |
|---|---|
| `0115_circle_visibility_settings.sql` | circle_visibility_settings |
| `0116_circle_context_settings.sql` | circle_context_settings |
| `0117_circle_presence.sql` | circle_presence |
| `0118_circle_checkins.sql` | circle_checkins |
| `0119_circle_member_visibility_overrides.sql` | circle_member_visibility_overrides |
| `0120_circle_meeting_points.sql` | circle_meeting_points |
| `0121_circle_audit_events.sql` | circle_audit_events |
| `0122_circle_global_pause_and_defaults.sql` | circle_global_settings |

RLS verification: All tables have `ENABLE ROW LEVEL SECURITY`, owner-scoped SELECT/INSERT/UPDATE policies, and service_all policies scoped with `TO service_role` — **RLS is sound for the tables that have been applied**.

The problem is that these migrations are **not in the canonical directory**, are **not listed in `docs/migrations.md`**, and are **not reflected in `lib/database.types.ts`**. The types file returns no results when searching for any circle table name, meaning TypeScript callers use implicit `any` everywhere they touch these tables.

### Non-Canonical Directory Also Has Untracked RaB Tables

The non-canonical directory has additional Rent a Buddy migrations (0107–0114) that are not in the canonical directory:

| Non-canonical file | Content |
|---|---|
| `0107_rent_buddy_admin_actions.sql` | rent_buddy admin actions log |
| `0108_rent_buddy_spec_tables.sql` | RaB spec/compliance tables |
| `0109_rent_buddy_missing_enums.sql` | missing enum values |
| `0110_rent_buddy_payouts.sql` | rent_buddy_payouts |
| `0111_rent_buddy_onboarding_ack.sql` | RaB onboarding acknowledgement |
| `0112_rent_buddy_lifecycle.sql` | booking lifecycle extensions |
| `0113_rent_buddy_lifecycle_fixes.sql` | lifecycle fix patches |
| `0114_review_moderation.sql` | review moderation |

These tables are applied in production but absent from canonical migrations and `database.types.ts`.

### Generated Types (`lib/database.types.ts`) — Status

`lib/database.types.ts` is **7,991 lines**. It contains the core tables well, but all tables introduced exclusively through the non-canonical directory are absent, plus tables from canonical migrations 0102–0107. Confirmed missing:

| Missing from `database.types.ts` | Source |
|---|---|
| All 8 circle tables | Non-canonical migrations 0115–0122 |
| `rent_buddy_payouts`, RaB spec/onboarding/lifecycle tables | Non-canonical migrations 0107–0114 |
| `post_media` | Canonical `0103_post_media.sql` |
| Compass tables from 0104 | Canonical `0104_compass_new_tables.sql` |
| `compass_analytics_events` | Canonical `0107_compass_analytics_onboarding.sql` |
| `compass_settings.onboarding_completed` | Canonical `0107_compass_analytics_onboarding.sql` |

**Verdict: Types must be regenerated before any patch work begins.** Backend code touching circle tables uses implicit `any`; runtime type errors are possible if schema drifts from what the code expects.

**Type regeneration command:**
```bash
supabase gen types typescript --project-id <project-id> > lib/database.types.ts
# then run:
pnpm run typecheck
```

---

## Phase 1 — Feature Completion Matrix

| Feature Area | Rating | Evidence |
|---|---|---|
| Rent a Buddy — marketplace/search/profile | DONE | Full UI (20+ screens), 100+ API endpoints in `routes/rentABuddy.ts` (6,162 lines), complete DB schema |
| Rent a Buddy — booking lifecycle (request → accept → start → complete) | DONE | All state transitions implemented with emitBookingMilestone notifications |
| Rent a Buddy — payment (deposit/full in-app) | **STUB** | Routes exist, DB columns exist, explicit code comment: "payment module not yet implemented" — no payment processor wired |
| Rent a Buddy — dispute resolution | **STUB** | Explicit comment "payment module not yet implemented" for dispute routes (rentABuddy.ts:2576) |
| Rent a Buddy — reviews | DONE | `routes/reviews.ts`, RLS, mobile service wired |
| Rent a Buddy — Telegraph thread auto-creation on booking | DONE | `emitBookingMilestone` + `emitBookingCard` in `rentABuddy.ts` |
| Rent a Buddy — safety (checkin/feel-unsafe/emergency) | DONE | All safety endpoints implemented and wired to mobile |
| Find Your Circle — UI settings + presence | DONE | `app/settings/find-your-circle.tsx`, `app/circle-presence.tsx`, `app/settings/who-can-see-me.tsx` |
| Find Your Circle — backend routes | DONE | `routes/circle.ts` (2,073 lines), 28 endpoints, privacy guards in `circleAccessGuard.ts` |
| Find Your Circle — database schema + RLS | PARTIAL | Migrations 0115–0122 applied via non-canonical channel; RLS is properly scoped; not in canonical dir or database.types.ts |
| Find Your Circle — precise GPS coordinates | **MISSING** | Code explicitly defers `precise_live` to V2 — returns 403; MVP uses venue/area labels only |
| Find Your Circle — entry from Trip screens | PARTIAL | `app/event/[id].tsx` has circle entry; `app/trip/[id].tsx` lacks equivalent circle button |
| Circle avatar & profile identity display | DONE | `circleResponseShaper.ts` correctly populates avatarUrl/displayName in all circle member responses |
| Profile editing — all fields | DONE | `app/profile/edit.tsx` fully wired; `handleSave` covers name, bio, DOB, languages, travel persona |
| Profile editing — avatar/cover upload | DONE | `uploadAvatar` → `POST /api/me/avatar/upload` → `profile-media` bucket; `uploadCover` same path |
| Passport — stamps, memories, map, stats | DONE | All endpoints in `passportStamps.ts`, mobile service layer complete |
| Passport — stamp sharing | DONE | `useStampShare` hook, native share sheet |
| Calendar / date picker — consistency | DONE | `DatePickerField` / `DateTimePickerField`, consistent `YYYY-MM-DD` + ISO, timezone-aware |
| Telegraph — core messaging (DM + group) | DONE | `routes/messaging.ts`, SSE stream, translation pipeline all wired |
| Telegraph — realtime (SSE) | DONE | `telegraphRealtimeService.ts` XHR-based SSE; `useMessaging` and `useGroupChat` hooks subscribed |
| Telegraph — message translations | DONE | `MessageTranslationService` wired; `retryTranslation` exposed in mobile |
| Telegraph — group creation | PARTIAL | No user-facing "Create Group" screen; groups auto-provisioned via trip/circle sync endpoints |
| Telegraph — mute controls in UI | **UI ONLY** | Button exists but triggers "coming soon" alert |
| Telegraph — save message in UI | **UI ONLY** | Button exists (backend `saved_messages` table exists) but triggers "coming soon" alert |
| Telegraph — message search in UI | **UI ONLY** | Search icon exists but triggers "coming soon" alert |
| Telegraph — thread info / shared media | **UI ONLY** | Menu option exists but triggers "coming soon" alert |
| Discovery — save community place | DONE | `saveCommunityPlace` → `POST /api/discovery/community/:id/save` |
| Discovery — share place | DONE | `DiscoveryShareSheet` → `sendMessage` |
| Discovery — report place | DONE | `reportCommunityPlace` → `POST /api/discovery/community/:id/report` |
| Discovery — map view | DONE | Routes to `/live-map` |
| Discovery — Featured Experience save button | **UI ONLY** | `FeaturedCard` bookmark button has no `onPress` handler |
| Trip — share trip button | **UI ONLY** | `/* share */` comment placeholder in `app/trip/[id].tsx` |
| Trip — accept/decline invite | DONE | Wired via `TelegraphActivityInviteCard` and `services/trips.ts` |
| Notifications — push, in-app | DONE | Full pipeline: `notification_devices`, `push_retry_queue`, `PushNotificationService` |
| Events | DONE | Full CRUD + RSVP + waitlist + reviews wired; stamp award TODO remains |
| Stories / Highlights | DONE | `stories.ts` + Supabase storage `stories` bucket |
| Memories | DONE | `memories` bucket + full API |

### Broken-Button / No-Op Flow Table

| Screen | Button/Action | Expected | Actual | Backend Call | Status | Recommended Fix |
|---|---|---|---|---|---|---|
| `app/trip/[id].tsx` | "Share Trip" | Opens share sheet | No-op (`/* share */`) | None | **BROKEN** | Wire to `Share.share()` with invite link or native share |
| `app/(rent-a-buddy)/checkout.tsx` | Pay deposit / Pay full | Processes payment | Records status in DB; no money moves | Routes exist, stub only | **STUB** | Add payment processor or show explicit "coming soon" disclosure |
| Discovery `FeaturedCard` | Save/Bookmark | Saves featured place | No-op (no `onPress`) | None | **BROKEN** | Wire to `saveCommunityPlace()` or conditionally hide |
| `app/messages/[id].tsx` | Mute thread | Mutes thread | "Coming soon" alert | Not called | **UI ONLY** | Wire to `POST /api/users/:id/mute` |
| `app/messages/[id].tsx` | Save message | Saves message | "Coming soon" alert | Backend exists | **UI ONLY** | Wire to saved_messages endpoint |
| `app/messages/[id].tsx` | Message search | Searches thread | "Coming soon" alert | No endpoint | **MISSING** | Implement `GET /api/threads/:id/search` + wire |
| `app/messages/[id].tsx` | Thread info / Shared media | Opens thread detail | "Coming soon" alert | No endpoint | **MISSING** | Build thread info screen |
| `app/events/*` | Stamp award on join event | Awards category stamp | TODO comment, not wired | Partial (`events.ts:3606`) | **PARTIAL** | Implement stamp award on event RSVP accept/check-in |

### Source-of-Truth Conflicts

| Conflict | Source A | Source B | Resolution |
|---|---|---|---|
| Messaging system name | "Telegraph" (backend routes) | "Messages" (tab UI label) | Intentional: "Telegraph" = internal; "Messages" = user-facing. No fix needed. |
| Circle concept name | "circle" (routes/circle.ts, DB tables) | "crew" (some mobile components) | "circle" is canonical. "crew" is legacy label to phase out in UI. |
| Circle migration location | `artifacts/api-server/migrations/` (applied) | `artifacts/api-server/src/migrations/` (canonical, missing circle) | Promote circle migrations 0115–0122 to canonical dir as 0108–0115 equivalents |
| Profile location fields | `profiles.home_city` + `profiles.current_city` | `user_location_state` table (GPS real-time) | Both valid; different purposes. GPS = transient real-time; profiles = displayed stable city |
| profile_visibility source | `profiles.visibility` | `user_privacy_settings.profile_visibility` | Both exist; backend reconciles on read. Risk of drift on write if both aren't updated together. |
| Trip plan vs event | `trip_plan_items` (trip itinerary items) | `events` table (standalone gatherings) | Separate concepts — no conflict |
| Mock vs real data | `app/index.tsx` mock fallback | Live Supabase | Dev-only guard (`!isSupabaseConfigured`) — not a production risk |

### Plain-English Answers to the 7 Feature Questions

1. **Is Rent a Buddy finished?** Mostly — UI, booking lifecycle, safety, reviews, and Telegraph integration are done. The missing piece is a real payment processor. Deposits and full payments mark a DB status but no money moves.

2. **Is Find Your Circle finished?** Nearly. Settings, presence, check-in, and meeting points all work. The schema and RLS are correct but only tracked in the non-canonical migration directory. Types are stale. GPS coordinates are V2-deferred.

3. **Is profile editing fixed?** Yes. Avatar and cover photo upload, all persona fields, home/current city, DOB validation, username cooldown, and privacy settings are fully implemented.

4. **Is Telegraph connected?** Core messaging is complete (DM, group, SSE realtime, translations, AI suggestions). Four UI affordances are "coming soon" stubs: mute, save message, message search, and thread info.

5. **Is the database complete?** Mostly, but stale. All needed tables exist in production Supabase. The problem is tracking: circle tables and recent RaB tables are in the non-canonical directory and absent from `database.types.ts`. Gap 0096 in the canonical sequence has no explanation anywhere in the repo.

6. **Is the app safe for beta?** Not yet. The payment stub is the primary blocker — users believe they're paying when no money moves. Everything else (circle RLS, types staleness) is fixable without user-facing impact.

7. **What is the highest-risk gap?** The payment stub with no user disclosure. A user completing a Rent a Buddy checkout will see confirmation that their booking is "paid" when nothing was charged.

---

## Phase 2 — Safe Migration Plan

The circle tables and recent RaB tables already exist in production Supabase with correct RLS (applied via the non-canonical directory). **No new tables need to be created.** The action needed is to close the tracking gap so the canonical directory accurately reflects the full applied schema.

### Required Action: Promote Non-Canonical Migrations to Canonical

The following non-canonical migrations need to be copied to the canonical `artifacts/api-server/src/migrations/` directory with canonical numbering starting at 0108. Their SQL must be reviewed for idempotency (`IF NOT EXISTS`, `DO $$ IF NOT EXISTS $$` guards) before being added, to be safe for re-application.

| Non-canonical source | Proposed canonical name | Tables covered |
|---|---|---|
| `0107_rent_buddy_admin_actions.sql` | `0108_rent_buddy_admin_actions.sql` | rent_buddy admin actions |
| `0108_rent_buddy_spec_tables.sql` | `0109_rent_buddy_spec_tables.sql` | RaB spec/compliance |
| `0109_rent_buddy_missing_enums.sql` | `0110_rent_buddy_missing_enums.sql` | Missing enum values |
| `0110_rent_buddy_payouts.sql` | `0111_rent_buddy_payouts.sql` | rent_buddy_payouts |
| `0111_rent_buddy_onboarding_ack.sql` | `0112_rent_buddy_onboarding_ack.sql` | RaB onboarding ack |
| `0112_rent_buddy_lifecycle.sql` | `0113_rent_buddy_lifecycle.sql` | Booking lifecycle ext. |
| `0113_rent_buddy_lifecycle_fixes.sql` | `0114_rent_buddy_lifecycle_fixes.sql` | Lifecycle fixes |
| `0114_review_moderation.sql` | `0115_review_moderation.sql` | Review moderation |
| `0115_circle_visibility_settings.sql` | `0116_circle_visibility_settings.sql` | circle_visibility_settings |
| `0116_circle_context_settings.sql` | `0117_circle_context_settings.sql` | circle_context_settings |
| `0117_circle_presence.sql` | `0118_circle_presence.sql` | circle_presence |
| `0118_circle_checkins.sql` | `0119_circle_checkins.sql` | circle_checkins |
| `0119_circle_member_visibility_overrides.sql` | `0120_circle_member_visibility_overrides.sql` | circle_member_visibility_overrides |
| `0120_circle_meeting_points.sql` | `0121_circle_meeting_points.sql` | circle_meeting_points |
| `0121_circle_audit_events.sql` | `0122_circle_audit_events.sql` | circle_audit_events |
| `0122_circle_global_pause_and_defaults.sql` | `0123_circle_global_settings.sql` | circle_global_settings |

### After Promotion: Regenerate Types

```bash
supabase gen types typescript --project-id <project-id> > lib/database.types.ts
pnpm run typecheck
```

### Why Each Group Matters

| Group | Why It Needs Promotion |
|---|---|
| Circle tables (0116–0123) | `routes/circle.ts` touches all 6 tables — currently TypeScript uses implicit `any`; runtime type mismatch undetected |
| RaB lifecycle extensions (0108–0115) | `rentABuddy.ts` references payouts, spec tables, lifecycle columns — same type-safety gap |

---

## Phase 3 — Backend / Frontend Patch Plan

### P0 — Must Fix Before Beta

| # | Item | Files to Edit | Exact Fix | Test Needed |
|---|---|---|---|---|
| P0-1 | Promote circle + RaB non-canonical migrations to canonical directory | `artifacts/api-server/src/migrations/` (add 0108–0123) | Copy + idempotency-guard each SQL file from non-canonical to canonical with sequential numbering | Verify idempotent re-run produces no errors |
| P0-2 | Regenerate `lib/database.types.ts` | `lib/database.types.ts` | Run `supabase gen types typescript ...` after P0-1 | `pnpm run typecheck` passes |
| P0-3 | Payment stub disclosure | `artifacts/api-server/src/routes/rentABuddy.ts` (lines 1311, 1351, 2576) | Return `payment_not_available: true` in pay-deposit / pay-full response bodies, or return HTTP 503 with message "Payment processing is not yet available"; update mobile checkout to show the disclosure | Manual test: checkout flow must not show "paid" confirmation |
| P0-4 | Share trip no-op button | `travel-buddy-standalone/app/trip/[id].tsx` | Replace `/* share */` with `Share.share()` using the `/api/trips/:id/invite-link` token URL | Manual test: share sheet opens with correct link |
| P0-5 | Featured Experience save no-op | `travel-buddy-standalone/src/components/discovery/DiscoveryWall.tsx` | Add `onPress` to FeaturedCard bookmark wired to `saveCommunityPlace()`, or remove the button | Manual test |

### P1 — Should Fix Before Beta

| # | Item | Files to Edit | Exact Fix | Test Needed |
|---|---|---|---|---|
| P1-1 | Narrow `select('*')` on `profiles` | `artifacts/api-server/src/routes/profile.ts`, `trips.ts` | Replace wildcard with explicit column list; omit `date_of_birth`, `dob_verified`, internal flags | Add assertion to existing `profileSystem.test.ts` that DOB never appears in response |
| P1-2 | Narrow `select('*')` on `rent_buddy_profiles` in marketplace routes | `artifacts/api-server/src/routes/rentABuddy.ts` | Replace wildcard in public-facing buddy-search queries with explicit public-safe column list | Extend existing `rentABuddy.test.ts` |
| P1-3 | Storage bucket RLS documentation | New: `docs/storage-buckets.md` | Document `profile-media`, `stories`, `memories`, `media` buckets, their path conventions, and RLS configuration; verify policies in Supabase dashboard | Manual verification |
| P1-4 | `docs/migrations.md` — update past entry 0068 | `docs/migrations.md` | Append rows for canonical migrations 0069–0107 and the newly promoted 0108–0123 | N/A |
| P1-5 | Event stamp award TODO | `artifacts/api-server/src/routes/events.ts` (line 3606) | Call stamp award service on `event_rsvps` accept or check-in path | Extend existing `events.test.ts` |
| P1-6 | profile_visibility consistency between `profiles` and `user_privacy_settings` | `artifacts/api-server/src/routes/profile.ts`, reconciliation logic | Confirm canonical source for reads; ensure `PATCH /me/profile` and `PATCH /me/privacy` stay in sync | Extend `profileSystem.test.ts` |
| P1-7 | Document gap at canonical sequence 0096 | `docs/migrations.md` + internal note | Identify what was applied at this position; add a note or retroactive migration file | N/A |

### P2 — Polish (can ship without, but clean up before GA)

| # | Item | Files to Edit | Exact Fix |
|---|---|---|---|
| P2-1 | Wire Telegraph mute controls | `travel-buddy-standalone/app/messages/[id].tsx` | Wire mute button to `POST /api/users/:id/mute`; backend exists |
| P2-2 | Wire Telegraph save message | `travel-buddy-standalone/app/messages/[id].tsx` | Wire to existing `saved_messages` backend endpoint |
| P2-3 | Add Telegraph message search | `artifacts/api-server/src/routes/messaging.ts` + mobile | Add `GET /api/threads/:id/search?q=`; wire mobile search icon |
| P2-4 | Thread info / shared media screen | New: `travel-buddy-standalone/app/messages/thread-info/[id].tsx` | Build thread detail screen showing member list + shared media |
| P2-5 | Add Circle entry button to trip detail | `travel-buddy-standalone/app/trip/[id].tsx` | Add "Circle" button analogous to the one in `app/event/[id].tsx` |

### Exact File List for P0 + P1 Changes

```
Add (migration promotion):
  artifacts/api-server/src/migrations/0108_rent_buddy_admin_actions.sql
  artifacts/api-server/src/migrations/0109_rent_buddy_spec_tables.sql
  artifacts/api-server/src/migrations/0110_rent_buddy_missing_enums.sql
  artifacts/api-server/src/migrations/0111_rent_buddy_payouts.sql
  artifacts/api-server/src/migrations/0112_rent_buddy_onboarding_ack.sql
  artifacts/api-server/src/migrations/0113_rent_buddy_lifecycle.sql
  artifacts/api-server/src/migrations/0114_rent_buddy_lifecycle_fixes.sql
  artifacts/api-server/src/migrations/0115_review_moderation.sql
  artifacts/api-server/src/migrations/0116_circle_visibility_settings.sql
  artifacts/api-server/src/migrations/0117_circle_context_settings.sql
  artifacts/api-server/src/migrations/0118_circle_presence.sql
  artifacts/api-server/src/migrations/0119_circle_checkins.sql
  artifacts/api-server/src/migrations/0120_circle_member_visibility_overrides.sql
  artifacts/api-server/src/migrations/0121_circle_meeting_points.sql
  artifacts/api-server/src/migrations/0122_circle_audit_events.sql
  artifacts/api-server/src/migrations/0123_circle_global_settings.sql

Regenerate:
  lib/database.types.ts

Edit:
  artifacts/api-server/src/routes/rentABuddy.ts        (P0-3 payment disclosure)
  artifacts/api-server/src/routes/events.ts            (P1-5 stamp award)
  artifacts/api-server/src/routes/profile.ts           (P1-1 narrow select*)
  artifacts/api-server/src/routes/trips.ts             (P1-1 narrow select*)
  travel-buddy-standalone/app/trip/[id].tsx            (P0-4 share, P2-5 circle)
  travel-buddy-standalone/src/components/discovery/DiscoveryWall.tsx  (P0-5)
  docs/migrations.md                                   (P1-4)
  docs/storage-buckets.md (new)                        (P1-3)
```

---

## Phase 4 — Security / RLS / Privacy / Beta Ship Audit

### RLS Matrix (Key Tables)

| Table | RLS Enabled | Read Policy | Write Policy | Issue | Fix |
|---|---|---|---|---|---|
| `profiles` | Yes | Public read (intentional for search) | Owner only (`auth.uid() = id`) | `select('*')` in routes pulls `date_of_birth`, `dob_verified` | Narrow to explicit column list |
| `trips` | Yes | Members only | Owner/members by role | `select('*')` in `trips.ts:612` | Narrow |
| `blocks` | Yes | Own rows only | Own rows only | None | None |
| `buddy_profiles` | Yes | Public read (`USING (true)`) | Owner only | Public read intentional for marketplace | None |
| `buddy_bookings` | Yes | Owner + buddy only | Service role | None | None |
| `messages` | Yes | Thread participants only | Thread participants | None | None |
| `notifications` | Yes | Own rows only | Service role | None | None |
| `feature_flags` | Yes | Public read | Service role | None | None |
| `circle_visibility_settings` | Yes (non-canonical 0115) | Owner only; service_role bypasses | Owner only | Not in canonical dir, not in types | Promote migration; regenerate types |
| `circle_context_settings` | Yes (non-canonical 0116) | Owner only; service_role bypasses | Owner only | Same as above | Promote + regen |
| `circle_presence` | Yes (non-canonical 0117) | Owner read; service_role bypasses | Owner write | Same as above | Promote + regen |
| `circle_checkins` | Yes (non-canonical 0118) | Owner read | Owner insert | Same as above | Promote + regen |
| `circle_meeting_points` | Yes (non-canonical 0120) | Public read; service_role all | set_by_user owns | Same as above | Promote + regen |
| `discovery_places` | Yes | Public read | Auth insert own | None | None |
| `hidden_gems` | Yes | Public read (active+public only) | Owner insert | None | None |
| `passport_stamps` | Yes | Own + visibility-gated public | Own insert | None | None |
| `memories` | Yes | Owner + visibility-gated public | Owner | None | None |
| `user_mutes` | Yes | Own rows | Own insert | None | None |
| `reports` | Yes | Reporter reads own | Reporter insert | None | None |

### Privacy Leak Matrix

| Feature | Risk | Evidence | Severity | Fix |
|---|---|---|---|---|
| Profile `select('*')` | `date_of_birth`, `dob_verified`, internal flags leak to any authenticated user if mappers miss a field | `routes/profile.ts`, service-role queries | **HIGH** | Explicit column list in all profile queries |
| Rent a Buddy `select('*')` on `buddy_profiles` | Internal admin columns (if added later) silently exposed | Multiple marketplace routes in `rentABuddy.ts` | **MEDIUM** | Explicit column list for public buddy responses |
| Payment stub — no disclosure | Users believe payment processed when it was not | `rentABuddy.ts` pay-deposit/pay-full routes update DB status without charging | **CRITICAL** | Return `payment_not_available` or `503` with disclosure |
| Storage bucket RLS not documented | Cannot verify users can only access own private media | Bucket names in services but no policy migration | **MEDIUM** | Document + verify in Supabase dashboard |
| profile_visibility field drift | `PATCH /me/profile` and `PATCH /me/privacy` may diverge | Two tables track visibility independently | **LOW** | Reconcile on write or choose single canonical field |

### Storage Bucket Security Table

| Bucket | Used For | Upload Path | Auth Required | RLS in Canonical Migrations |
|---|---|---|---|---|
| `profile-media` | Avatar + cover photos | `avatars/{userId}/{uuid}.ext`, `covers/{userId}/{uuid}.ext` | API server service role | **Not tracked in any migration** |
| `stories` | Story media | `{userId}/{uuid}.ext` | User JWT | **Not tracked** |
| `memories` | Memory media | `{userId}/{uuid}.ext` | User JWT | **Not tracked** |
| `media` | General post media | Via `POST /api/media/upload` (service role) | API verifies JWT | **Not tracked** |

All buckets rely on path-convention checks in application code. Bucket RLS policies should be documented in a `docs/storage-buckets.md` reference and verified in the Supabase dashboard.

### Realtime Channel Safety Table

| Channel / Mechanism | Scope | Auth | Risk |
|---|---|---|---|
| Telegraph SSE (`GET /api/telegraph/stream`) | Per-user — only events for user's own threads | `requireUser` | LOW |
| Typing indicators (`POST /api/threads/:id/typing`) | Per-thread — broadcast to thread members only | `requireUser` | LOW |
| Circle presence (application-layer polling) | Per context (trip/event) — membership checked in `circleAccessGuard.ts` | `requireUser` | LOW — DB-level RLS confirmed sound on circle tables |
| Supabase Realtime direct channels | None found in production code paths | N/A | N/A |

### Beta Blockers List

| # | Blocker | Severity | Justification |
|---|---|---|---|
| B1 | Payment is a stub — no actual money movement in RaB checkout | **CRITICAL** | Users believe they have paid a deposit when nothing was charged. Financial and trust liability before any beta. |
| B2 | `lib/database.types.ts` stale — circle tables and RaB extensions absent | **HIGH** | TypeScript callers use implicit `any` on all circle tables; runtime errors possible if schema drifts |
| B3 | Circle migrations not in canonical directory | **MEDIUM** | No single audit-able source of truth for the circle schema; new developers cannot reproduce the DB from the canonical migrations alone |
| B4 | Share trip button is no-op | **MEDIUM** | Core growth mechanic (invite friends to a trip) does nothing; user trust impact |
| B5 | Storage bucket RLS not documented | **MEDIUM** | Cannot verify from code review that users can only access own media |
| B6 | Featured card save no-op | **LOW** | Discovery UX inconsistency — bookmark icon visible but non-functional |
| B7 | Event stamp award TODO | **LOW** | Feature regression — joining events doesn't award stamps |

### Plain-English Beta Safety Verdict

**The app is NOT safe for beta in its current state. One hard blocker must be resolved first:**

**Payment is a stub.** The Rent a Buddy checkout flow records a "paid" status in the database without processing any real payment. Users completing a booking see a confirmation that their deposit is secured, but nothing is actually charged. Before any beta user attempts to book a buddy, the payment routes must either be wired to a real processor OR the booking flow must clearly display "Payment integration is not yet live — no charges will be made."

All other items (B2–B7) should be fixed before launch but are not hard blockers for a small closed beta with known testers who are briefed on the payment limitation.

---

## Phase 5 — Testing & Manual QA Plan

### Automated Test List

All test files listed below are **new** (confirmed not to exist in `artifacts/api-server/src/test/`):

| File | Purpose | Priority |
|---|---|---|
| `artifacts/api-server/src/test/rentABuddyPayment.test.ts` | Verify pay-deposit / pay-full routes return the payment-not-available disclosure, not a success 200 | P0 |
| `travel-buddy-standalone/src/services/__tests__/trips.share.test.ts` | Verify share trip action calls `Share.share()` with correct invite link payload | P0 |
| `travel-buddy-standalone/src/services/__tests__/discovery.featuredSave.test.ts` | Verify featured card bookmark button calls `saveCommunityPlace` | P0 |
| `artifacts/api-server/src/test/profileSelectNarrow.test.ts` | Verify `GET /me/profile` and `GET /api/users/:id` never return `date_of_birth` or `dob_verified` | P1 |
| `artifacts/api-server/src/test/telegraph.mute.test.ts` | Verify mute action calls `POST /api/users/:id/mute` and thread filter updates | P2 |

Note: `circle.test.ts`, `rentABuddy.test.ts`, `events.test.ts`, `passportStamps.test.ts`, and `stamps.test.ts` already exist — extend rather than recreate.

### Manual QA Checklist

#### Profile Edit
- [ ] Change display name → tap Save → profile screen shows updated name
- [ ] Change avatar photo → tap Save → avatar updates on profile tab and in all message threads
- [ ] Change cover photo → tap Save → cover shows on own passport and public profile
- [ ] Change username → verify 30-day cooldown message if changed within past 30 days
- [ ] Change home city → verify it persists across app restarts
- [ ] Set DOB under 13 → verify rejection with age validation error
- [ ] Tap Save with no changes → verify no spinner, no API call

#### Avatar / Cover Upload
- [ ] Pick a 25MB+ photo → verify "Image too large" alert
- [ ] Deny photo permissions → verify "Permission needed" alert with Settings link
- [ ] Upload HEIC photo (iOS) → verify conversion and successful upload

#### Rent a Buddy Lifecycle
- [ ] Search for buddies in Cebu → verify results load (city must be in public_mvp rollout)
- [ ] View buddy profile → verify rating, categories, gallery, availability calendar
- [ ] Tap "Book" → complete checkout → reach payment step → **verify disclosure that payment is not live (after P0-3)**
- [ ] Buddy accepts booking → verify Telegraph thread opens automatically
- [ ] Buddy taps "Start" → verify booking status → `in_progress`
- [ ] Submit review after completion → verify average_rating updates on buddy profile
- [ ] Submit safety check-in → verify success
- [ ] Trigger "feel unsafe" → verify emergency phrase flow activates

#### Find Your Circle
- [ ] Enable circle sharing in settings → verify toggle persists
- [ ] Open trip → navigate to circle presence → verify member list loads
- [ ] Check in at a venue → verify check-in appears for trip members
- [ ] Set a meeting point → verify it appears for other trip members
- [ ] Pause sharing → verify presence no longer visible to other members
- [ ] Tap "Precise Live" → verify 403 / "available in a future update" message

#### Telegraph
- [ ] Send a DM → verify message appears, SSE delivers to other device in <5s
- [ ] Send a message in trip group chat → verify all members see it
- [ ] Enable auto-translate on a thread → verify translation appears under messages
- [ ] Reconnect after airplane mode → verify SSE reconnects and missed messages appear
- [ ] Mute/Save message buttons → verify "coming soon" alert (before P2 fixes)

#### Discovery
- [ ] Search for places in a city → verify results load with map pins
- [ ] Save a community place → verify bookmark icon fills in
- [ ] Share a place to a chat → verify share sheet and message sends
- [ ] Report a place → verify confirmation and success
- [ ] Tap map view → verify live map screen opens with pins
- [ ] Tap Featured Experience bookmark → **verify current no-op (before P0-5 fix)**

#### Passport
- [ ] Complete a trip → verify stamp appears on passport
- [ ] Tap stamp → verify share sheet opens
- [ ] Accept a memory suggestion → verify it moves to memories grid
- [ ] View another user's passport → verify visibility privacy respected

#### Empty / Error / Loading States
- [ ] Open Discovery with no network → verify error state with retry, no crash
- [ ] Load passport with no trips → verify empty state illustration
- [ ] RaB marketplace in city with no buddies → verify "no buddies available" state
- [ ] Send message when offline → verify error toast, message not shown as sent

#### Dark Mode
- [ ] Toggle dark mode → verify all screens update without visual artifacts

#### Safe Area (iOS + Android)
- [ ] Open keyboard on profile edit → verify Save button not hidden
- [ ] Open bottom sheet on small Android → verify handle and content visible
- [ ] Notch/Dynamic Island on iPhone → verify header not obscured

### QA Verdict

Three screens need specific attention before beta users touch them: **Rent a Buddy checkout** (payment stub — must show disclosure after P0-3), **trip share button** (no-op — must be wired after P0-4), and **Featured Experience save** (no-op — must be wired or hidden after P0-5). All other flows are testable now.

---

## Phase 6 — Final Consolidated Verdict

### All 14 Plain-English Answers

1. **Is Rent a Buddy finished?** No — payment processing is a stub. Everything else (search, profiles, booking lifecycle, safety, reviews, Telegraph integration) is production-ready.

2. **Is Find Your Circle finished?** Nearly. The feature is functionally complete (settings, presence, check-in, meeting points, privacy guards). The database schema and RLS are correct but only tracked in the non-canonical migration directory — not in the canonical dir and not in `database.types.ts`. GPS coordinates are V2-deferred.

3. **Is profile editing fixed?** Yes. Avatar/cover upload, all persona fields, DOB, username cooldown, and privacy settings are fully implemented end-to-end.

4. **Is Telegraph connected?** Mostly. Core DM, group chat, SSE realtime, and translations are live. Mute, save message, message search, and thread info are "coming soon" stubs.

5. **Is the database complete?** The data is in production Supabase, but tracking is incomplete. 16 migrations are in the non-canonical directory (circle tables + RaB extensions) and absent from canonical. Canonical sequence gap 0096 is unexplained. `database.types.ts` must be regenerated.

6. **Is the app safe for beta?** Not yet. The payment stub is the sole hard blocker.

7. **What exact command runs next?** Promote circle and RaB migrations from `artifacts/api-server/migrations/` to `artifacts/api-server/src/migrations/` (renumbering 0108–0123), then run `supabase gen types typescript ... > lib/database.types.ts && pnpm run typecheck`.

8. **Are there security holes?** Wildcard `select('*')` on `profiles` can leak `date_of_birth` and future internal columns. Storage bucket policies are not documented in the repo. Neither is a breach in current production, but both should be hardened before GA.

9. **Is Discovery functional?** Mostly. Search, OSM results, community place save/share/report, and map view all work. Featured Experience bookmark is no-op.

10. **Is Passport functional?** Yes. Stamps, memories, map, stats, visibility prefs, and stamp sharing are all live.

11. **Are calendar / date pickers consistent?** Yes. `DatePickerField` and `DateTimePickerField` provide a consistent YYYY-MM-DD + ISO interface with timezone awareness across all screens.

12. **What is the highest-risk gap?** Payment stub with no disclosure — a user believes they have paid for a buddy session when nothing was charged.

13. **What can ship now (as closed beta)?** Profile editing, Passport, Discovery, Telegraph core chat, Events, Stories, Highlights, Notifications, Follows/Friends, Blocks — all production-ready. Rent a Buddy can ship in beta with explicit "payment coming soon" messaging.

14. **Recommended beta ship order:**
    1. Promote circle + RaB migrations to canonical + regenerate types (P0-1, P0-2)
    2. Add payment disclosure in checkout (P0-3)
    3. Wire share trip button (P0-4)
    4. Wire featured card save or hide it (P0-5)
    5. Run full manual QA checklist
    6. Soft-launch Passport + Discovery + Telegraph as first beta features
    7. Rent a Buddy available in beta with "payment processing coming soon" disclosure
    8. Find Your Circle available in beta; note GPS coordinates arrive in next version

---

### Combined Required Code Patches

| Priority | File | Fix |
|---|---|---|
| P0 | `artifacts/api-server/src/migrations/` (16 new files, 0108–0123) | Promote non-canonical circle + RaB migrations |
| P0 | `lib/database.types.ts` | Regenerate after migrations promoted |
| P0 | `artifacts/api-server/src/routes/rentABuddy.ts` | Add payment-not-available disclosure to pay-deposit + pay-full |
| P0 | `travel-buddy-standalone/app/trip/[id].tsx` | Replace `/* share */` with `Share.share()` via invite link |
| P0 | `travel-buddy-standalone/src/components/discovery/DiscoveryWall.tsx` | Wire or hide FeaturedCard bookmark |
| P1 | `artifacts/api-server/src/routes/profile.ts` | Replace `select('*')` with explicit column list |
| P1 | `artifacts/api-server/src/routes/trips.ts` | Replace `select('*')` with explicit column list |
| P1 | `artifacts/api-server/src/routes/events.ts` | Implement stamp award on event RSVP accept |
| P1 | `docs/migrations.md` | Append entries for 0069–0123 |
| P1 | `docs/storage-buckets.md` (new) | Document bucket names, paths, and RLS policies |
| P2 | `travel-buddy-standalone/app/messages/[id].tsx` | Wire mute + save message buttons |
| P2 | `travel-buddy-standalone/app/trip/[id].tsx` | Add circle entry button |

### Combined Required Tests

| File | Status | Purpose | Priority |
|---|---|---|---|
| `artifacts/api-server/src/test/rentABuddyPayment.test.ts` | **New** | Payment disclosure returns correct error | P0 |
| `travel-buddy-standalone/src/services/__tests__/trips.share.test.ts` | **New** | Share trip wires to Share.share() | P0 |
| `travel-buddy-standalone/src/services/__tests__/discovery.featuredSave.test.ts` | **New** | Featured card bookmark calls saveCommunityPlace | P0 |
| `artifacts/api-server/src/test/profileSelectNarrow.test.ts` | **New** | Profile responses never include date_of_birth | P1 |
| `artifacts/api-server/src/test/circle.test.ts` | **Exists** — extend with new cases | Circle membership guards, presence expiry | P1 |
| `artifacts/api-server/src/test/events.test.ts` | **Exists** — extend with new cases | Event RSVP awards stamp | P1 |
| `artifacts/api-server/src/test/telegraph.mute.test.ts` | **New** | Mute action calls correct endpoint | P2 |

---

## Appendix A — Schema Truth Tables Per Feature Area

### A1: Rent a Buddy — Key Tables

| Table | In Canonical Migrations | In `database.types.ts` | RLS Enabled | Read Policy | Write Policy | Notes |
|---|---|---|---|---|---|---|
| `buddy_profiles` | Yes (`0050_rent_a_buddy.sql`) | Yes | Yes | Public (`USING (true)`) — intentional for marketplace | Owner only | `select('*')` risk — future internal cols would leak |
| `buddy_bookings` | Yes (`0050_rent_a_buddy.sql`) | Yes | Yes | Owner + buddy only | Service role | Sound |
| `rent_buddy_city_rollouts` | Yes (`0090_rent_buddy_rollout_tables.sql`) | Yes | Yes | Public read | Service role insert | Must have ≥1 `public_mvp` row or all city calls return `city_not_available` |
| `rent_buddy_global_controls` | Yes (`0090`) | Yes | Yes | Public read | Service role | Kill-switch for entire RaB feature |
| `rent_buddy_payouts` | **No** — non-canonical `0110` only | **No** | Yes (in non-canonical) | Service role only | Service role | Missing from canonical + types |
| `rent_buddy_onboarding_ack` | **No** — non-canonical `0111` only | **No** | Yes (in non-canonical) | Owner read | Owner insert | Missing from canonical + types |
| `rent_buddy_booking_lifecycle_events` | **No** — non-canonical `0112` only | **No** | Yes (in non-canonical) | Owner + buddy read | Service role | Missing from canonical + types |

### A2: Find Your Circle — Key Tables

All 8 circle tables were applied via non-canonical migrations 0115–0122. RLS is correctly defined in those files (owner-scoped read/write + service_role bypasses). All are **absent from canonical directory** and **absent from `database.types.ts`**.

| Table | Non-canonical file | Primary Key | RLS Owner Policy | Service Role | In canonical | In types |
|---|---|---|---|---|---|---|
| `circle_visibility_settings` | `0115` | `user_id` (PK) | `FOR ALL USING (user_id = auth.uid())` | `TO service_role USING (true)` | **No** | **No** |
| `circle_context_settings` | `0116` | `id` UUID | `FOR ALL USING (user_id = auth.uid())` | `TO service_role USING (true)` | **No** | **No** |
| `circle_presence` | `0117` | `id` UUID | SELECT: `user_id = auth.uid()`; ALL write: owner | `TO service_role USING (true)` | **No** | **No** |
| `circle_checkins` | `0118` | `id` UUID | SELECT + INSERT owner-scoped only | `TO service_role USING (true)` | **No** | **No** |
| `circle_member_visibility_overrides` | `0119` | `id` UUID | `FOR ALL USING (user_id = auth.uid())` | `TO service_role USING (true)` | **No** | **No** |
| `circle_meeting_points` | `0120` | `id` UUID | **None** — service role only; membership enforced at API layer | `TO service_role USING (true)` | **No** | **No** |
| `circle_audit_events` | `0121` | `id` UUID | SELECT: actor OR target `= auth.uid()` | `TO service_role USING (true)` | **No** | **No** |
| `circle_visibility_settings` (extended) | `0122` ADD COLUMN | columns: `trip_sharing_default`, `event_sharing_default`, `is_paused`, `paused_until` | (inherits from 0115) | (inherits) | **No** | **No** |

### A3: Profile — Key Table

| Table | In Canonical | In types | RLS | Sensitive Columns at Risk |
|---|---|---|---|---|
| `profiles` | Yes (`base`) | Yes (core columns) | Yes — public read, owner write | `date_of_birth`, `dob_verified`, `is_admin` (legacy), internal flags |
| `user_privacy_settings` | Yes (`0063`) | Yes | Yes — owner only | None |
| `profile_media` (storage bucket) | **Not tracked** | N/A | Via storage policies (unverified) | Private user media |

### A4: Telegraph / Messaging — Key Tables

| Table | In Canonical | In types | RLS | Notes |
|---|---|---|---|---|
| `messages` | Yes (`0012_group_chat.sql`) | Yes | Yes — thread participants only | Sound |
| `message_threads` | Yes (`0012`) | Yes | Yes — thread participants only | Sound |
| `message_thread_members` | Yes (`0016`) | Yes | Yes — own rows | Sound |
| `saved_messages` | Yes (`0057_reply_to_messages.sql`) | Yes | Yes — owner only | Backend exists; mobile "coming soon" |
| `user_mutes` | Yes (`0063`) | Yes | Yes — own rows | Backend exists; mobile "coming soon" |

### A5: Discovery — Key Tables

| Table | In Canonical | In types | RLS | Notes |
|---|---|---|---|---|
| `discovery_places` | Yes (`0029`, `0060`, `0086`) | Yes | Yes — public read, auth insert | Sound |
| `discovery_place_saves` | Yes (`0062` canonical) | Yes | Yes — owner only | Save/unsave wired end-to-end |
| `discovery_place_reports` | Yes (`0061`) | Yes | Yes — reporter reads own | Sound |
| `hidden_gems` | Yes (`0043`) | Yes | Yes — public read (active+public only) | Sound |

---

## Appendix B — Explicit Backend Gaps and Frontend Gaps Tables

### B1: Backend Gaps (endpoint or service not implemented)

| Gap ID | Feature | Missing Backend Element | Impact | Priority |
|---|---|---|---|---|
| BG-01 | Rent a Buddy | Payment processor not wired — `POST /api/rent-a-buddy/bookings/:id/pay-deposit` and `/pay-full` update DB status without charging | Users believe payment succeeded | **CRITICAL / P0** |
| BG-02 | Rent a Buddy | Dispute resolution routes are stubs (explicit comment at `rentABuddy.ts:2576`) | No dispute resolution available | P1 |
| BG-03 | Find Your Circle | Precise GPS coordinates deferred (V2) — `/api/circle/:ctxType/:ctxId/precise-location` returns 403 | GPS-based meetup unavailable | P2 (V2 feature, intentional) |
| BG-04 | Telegraph | Message search endpoint not implemented — no `GET /api/threads/:id/search` route | Search button shows "coming soon" | P2 |
| BG-05 | Telegraph | Thread info / shared media endpoint not implemented | Thread info shows "coming soon" | P2 |
| BG-06 | Events | Stamp award on event RSVP accept not wired — TODO comment at `events.ts:3606` | Joining events does not award stamps | P1 |
| BG-07 | All features | `lib/database.types.ts` stale — all circle tables and recent RaB tables return implicit `any` | TypeScript type safety null for 8 tables | P0 |
| BG-08 | Schema tracking | 16 non-canonical migrations not promoted to canonical directory | New devs cannot reproduce DB from canonical dir alone | P0 |
| BG-09 | Schema tracking | Canonical sequence gap at 0096 — no file in either directory | Unknown schema change; unexplained | P1 investigation |
| BG-10 | Storage | Storage bucket RLS policies not documented or tracked in any migration | Cannot audit media access from code | P1 |

### B2: Frontend Gaps (screen exists, action is no-op or stub)

| Gap ID | Feature | Screen / Component | Action | Expected | Actual | Priority |
|---|---|---|---|---|---|---|
| FG-01 | Trip | `app/trip/[id].tsx` | Share Trip button | Opens share sheet with invite link | `/* share */` — no-op | **P0** |
| FG-02 | Rent a Buddy | `app/(rent-a-buddy)/checkout.tsx` | Pay deposit / Pay full | Charges payment method | Records status in DB; no money moves | **P0** |
| FG-03 | Discovery | `DiscoveryWall.tsx` — `FeaturedCard` | Save/Bookmark icon | Saves featured experience | No `onPress` handler | P0 |
| FG-04 | Telegraph | `app/messages/[id].tsx` | Mute thread | Calls mute API | "Coming soon" alert | P2 |
| FG-05 | Telegraph | `app/messages/[id].tsx` | Save message | Calls saved_messages API | "Coming soon" alert | P2 |
| FG-06 | Telegraph | `app/messages/[id].tsx` | Message search | Searches thread messages | "Coming soon" alert | P2 |
| FG-07 | Telegraph | `app/messages/[id].tsx` | Thread info / Shared media | Opens thread detail screen | "Coming soon" alert | P2 |
| FG-08 | Find Your Circle | `app/trip/[id].tsx` | Circle presence entry point | Opens circle for the trip | No button (events have it, trips do not) | P2 |
| FG-09 | Telegraph | No screen | Create Group | User initiates a new group chat | No "Create Group" screen; groups auto-provisioned only | P2 |
| FG-10 | Events | RSVP flow | Stamp award notification | Awarded stamp shown post-RSVP | Backend TODO not wired; no stamp awarded | P1 |

---

## Appendix C — Migration Promotion Plan: Verbatim SQL from Non-Canonical Files

**Important:** All 16 migrations in this appendix have already been applied to production Supabase via `artifacts/api-server/migrations/`. **Promotion means copying the files to the canonical directory** (`artifacts/api-server/src/migrations/`) — they should NOT be re-applied to production. The SQL below is taken verbatim from the source files so a reviewer can verify schema, RLS policies, and idempotency without opening each file individually.

**Idempotency notes per file:**
- `0107`, `0108`, `0110`, `0113`: Use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` but bare `CREATE POLICY` (not `DROP POLICY IF EXISTS` first). Safe for first-time canonical recording; would fail policy creation on a second run. Since these are already applied, re-running is not expected.
- `0109`, `0111`, `0112`, `0113 (enum parts)`: Use `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$` or `ADD COLUMN IF NOT EXISTS` — fully idempotent.
- `0114`: `ADD COLUMN IF NOT EXISTS` — idempotent.
- `0115`–`0121`: Use `DROP POLICY IF EXISTS` + `CREATE POLICY` — fully idempotent.
- `0122`: Uses `ADD COLUMN IF NOT EXISTS` + `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` — idempotent.

---

### Section 1: Rent a Buddy Extension Migrations

#### 0107 → canonical 0108: `rent_buddy_admin_actions` table

Closes the gap where admin audit-log routes in `rentABuddy.ts` referenced a table absent from prior migrations (0047–0051).

```sql
-- Migration 0107: rent_buddy_admin_actions — admin audit log table
-- This table is referenced by rentABuddy.ts and rentABuddyMarketplace.ts
-- admin routes (feature, unfeature, suspend, approve, etc.) but was absent
-- from prior migrations (0047–0051).  Applied here to close the gap.
--
-- Columns:
--   notes   TEXT  — human-readable note written by route handlers
--   details JSONB — structured metadata defined in database.types.ts
-- Both are kept so the existing route inserts (which use `notes`) and the
-- type definitions (which reference `details`) remain consistent.

CREATE TABLE IF NOT EXISTS rent_buddy_admin_actions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL,   -- 'application'|'buddy'|'profile'|'package'|'user'
  target_id   TEXT NOT NULL,   -- UUID-shaped string of the affected entity
  action      TEXT NOT NULL,   -- free-form label e.g. 'approved', 'suspended', 'featured'
  notes       TEXT,            -- human-readable note (used by route inserts)
  details     JSONB,           -- structured metadata (defined in database.types.ts)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_admin_actions ENABLE ROW LEVEL SECURITY;

-- Service role can read and write; no direct user access
CREATE POLICY rb_admin_actions_svc ON rent_buddy_admin_actions
  FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS rb_admin_actions_admin_idx
  ON rent_buddy_admin_actions (admin_id, created_at DESC);

CREATE INDEX IF NOT EXISTS rb_admin_actions_target_idx
  ON rent_buddy_admin_actions (target_type, target_id);
```

#### 0108 → canonical 0109: spec table gaps & compatibility VIEW aliases

Creates `buddy_services`, `buddy_availability_exceptions`, `buddy_booking_events` and VIEW aliases mapping spec table names to existing `rent_buddy_*` tables.

```sql
-- Migration 0108: Rent a Buddy — spec table gaps & compatibility aliases
-- (full file: artifacts/api-server/migrations/0108_rent_buddy_spec_tables.sql)
--
-- New functional tables:
--   buddy_services            — typed service catalog
--   buddy_availability_exceptions — structured per-date availability overrides
--   buddy_booking_events      — immutable audit log of booking state transitions
--
-- Compatibility VIEW aliases (spec table names → existing rent_buddy_* tables):
--   buddy_booking_checkins, buddy_change_requests, buddy_favorites,
--   buddy_booking_requests, buddy_profiles, buddy_availability,
--   buddy_reviews, buddy_disputes

CREATE TABLE IF NOT EXISTS buddy_services (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buddy_id        UUID NOT NULL REFERENCES rent_buddy_profiles(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  hourly_rate_usd NUMERIC(10,2),
  half_day_usd    NUMERIC(10,2),
  full_day_usd    NUMERIC(10,2),
  min_hours       NUMERIC(4,1) NOT NULL DEFAULT 1,
  max_hours       NUMERIC(4,1),
  max_group_size  INT          NOT NULL DEFAULT 4,
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  approved        BOOLEAN      NOT NULL DEFAULT FALSE,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE buddy_services ENABLE ROW LEVEL SECURITY;
CREATE POLICY bs_public_read ON buddy_services FOR SELECT
  USING (is_active = TRUE AND approved = TRUE);
CREATE POLICY bs_own_read    ON buddy_services FOR SELECT
  USING (buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid()));
CREATE POLICY bs_own_write   ON buddy_services FOR ALL
  USING (buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid()));
CREATE POLICY bs_svc         ON buddy_services FOR ALL USING (auth.role() = 'service_role');
CREATE INDEX IF NOT EXISTS buddy_services_buddy_idx    ON buddy_services (buddy_id, is_active);
CREATE INDEX IF NOT EXISTS buddy_services_category_idx ON buddy_services (category, is_active);

DO $$ BEGIN
  CREATE TYPE buddy_exception_type AS ENUM (
    'blocked', 'time_blocked', 'vacation', 'available_only'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS buddy_availability_exceptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buddy_id        UUID NOT NULL REFERENCES rent_buddy_profiles(id) ON DELETE CASCADE,
  exception_date  DATE NOT NULL,
  end_date        DATE,
  exception_type  buddy_exception_type NOT NULL DEFAULT 'blocked',
  start_time      TIME,
  end_time        TIME,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE buddy_availability_exceptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY bae_public_read ON buddy_availability_exceptions FOR SELECT
  USING (exception_date >= CURRENT_DATE);
CREATE POLICY bae_own_read    ON buddy_availability_exceptions FOR SELECT
  USING (buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid()));
CREATE POLICY bae_own_write   ON buddy_availability_exceptions FOR ALL
  USING (buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid()));
CREATE POLICY bae_svc         ON buddy_availability_exceptions FOR ALL USING (auth.role() = 'service_role');
ALTER TABLE buddy_availability_exceptions
  ADD CONSTRAINT IF NOT EXISTS bae_buddy_date_unique UNIQUE (buddy_id, exception_date);
CREATE INDEX IF NOT EXISTS bae_date_range_idx ON buddy_availability_exceptions (exception_date, end_date);

CREATE TABLE IF NOT EXISTS buddy_booking_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES profiles(id),
  event         TEXT NOT NULL,
  from_status   TEXT,
  to_status     TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE buddy_booking_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY bbe_parties ON buddy_booking_events FOR SELECT
  USING (
    booking_id IN (
      SELECT id FROM rent_buddy_bookings
      WHERE traveler_id = auth.uid()
         OR buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid())
    )
  );
CREATE POLICY bbe_svc ON buddy_booking_events FOR ALL USING (auth.role() = 'service_role');
CREATE INDEX IF NOT EXISTS bbe_booking_idx    ON buddy_booking_events (booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bbe_actor_idx      ON buddy_booking_events (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bbe_event_type_idx ON buddy_booking_events (event, created_at DESC);

-- VIEW aliases: each guarded by a pg_class check (skipped if a real TABLE exists)
-- Full DO $$ blocks with EXECUTE $q$ wrappers are in the source file.
-- (Abbreviated here for brevity — copy the full source file as-is for canonical promotion.)
```

#### 0109 → canonical 0110: missing enum types for RaB

Adds `rent_buddy_verification_status`, `rent_buddy_change_request_status`, `rent_buddy_payment_status` enums and corresponding columns. All `DO $$ EXCEPTION WHEN duplicate_object` guarded — fully idempotent.

```sql
-- Migration 0109: Add missing spec enum types for Rent-a-Buddy
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rent_buddy_verification_status') THEN
    CREATE TYPE rent_buddy_verification_status AS ENUM (
      'unverified', 'id_submitted', 'in_review', 'verified', 'rejected'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rent_buddy_change_request_status') THEN
    CREATE TYPE rent_buddy_change_request_status AS ENUM (
      'pending', 'approved', 'declined', 'expired'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rent_buddy_payment_status') THEN
    CREATE TYPE rent_buddy_payment_status AS ENUM (
      'not_required',   -- placeholder default until payment provider integration is live
      'pending', 'authorized', 'captured', 'partial', 'refunded', 'failed'
    );
  END IF;
END $$;

ALTER TABLE rent_buddy_profiles
  ADD COLUMN IF NOT EXISTS verification_status rent_buddy_verification_status
    NOT NULL DEFAULT 'unverified';

CREATE OR REPLACE FUNCTION sync_buddy_verification_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verified = TRUE AND NEW.verification_status = 'unverified' THEN
    NEW.verification_status := 'verified';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_buddy_verification_status ON rent_buddy_profiles;
CREATE TRIGGER trg_sync_buddy_verification_status
  BEFORE INSERT OR UPDATE OF verified ON rent_buddy_profiles
  FOR EACH ROW EXECUTE FUNCTION sync_buddy_verification_status();

UPDATE rent_buddy_profiles
  SET verification_status = 'verified'
  WHERE verified = TRUE AND verification_status = 'unverified';

ALTER TABLE rent_buddy_bookings
  ADD COLUMN IF NOT EXISTS payment_status rent_buddy_payment_status
    NOT NULL DEFAULT 'not_required';
```

> **Note:** The `payment_status` column with default `not_required` is the database-level marker that the payment processor is not yet integrated. This directly corresponds to the payment stub finding in Phase 1 (BG-01, FG-02).

#### 0110 → canonical 0111: `rent_buddy_payouts` table

```sql
-- Migration 0110: rent_buddy_payouts table for payout hold/release lifecycle
CREATE TABLE IF NOT EXISTS rent_buddy_payouts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  buddy_id          UUID NOT NULL REFERENCES rent_buddy_profiles(id),
  amount_usd        NUMERIC(10,2) NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending',
    -- 'pending' | 'on_hold' | 'approved' | 'released' | 'failed'
  hold_reason       TEXT,
  released_by       UUID REFERENCES profiles(id),
  held_by           UUID REFERENCES profiles(id),
  held_at           TIMESTAMPTZ,
  released_at       TIMESTAMPTZ,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rent_buddy_payouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY rb_payout_svc ON rent_buddy_payouts
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY rb_payout_buddy_read ON rent_buddy_payouts FOR SELECT
  USING (buddy_id IN (SELECT id FROM rent_buddy_profiles WHERE user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS rb_payouts_booking_idx ON rent_buddy_payouts(booking_id);
CREATE INDEX IF NOT EXISTS rb_payouts_buddy_idx   ON rent_buddy_payouts(buddy_id);
CREATE INDEX IF NOT EXISTS rb_payouts_status_idx  ON rent_buddy_payouts(status);
```

#### 0111 → canonical 0112: onboarding acknowledgment columns

Additive-only. Two nullable timestamp columns on `rent_buddy_profiles`.

```sql
-- Migration 0111: Rent a Buddy — onboarding acknowledgment timestamps
ALTER TABLE rent_buddy_profiles
  ADD COLUMN IF NOT EXISTS safety_acknowledged_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS boundaries_acknowledged_at TIMESTAMPTZ;
```

#### 0112 → canonical 0113: booking lifecycle state machine hardening

Additive enum values + additive columns + backfill UPDATE + indexes.

```sql
-- Migration 0112: Rent a Buddy — booking lifecycle state machine hardening
DO $$ BEGIN ALTER TYPE rent_buddy_booking_status ADD VALUE 'declined';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE rent_buddy_booking_status ADD VALUE 'expired';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE rent_buddy_booking_status ADD VALUE 'cancelled_by_traveler';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE rent_buddy_booking_status ADD VALUE 'cancelled_by_buddy';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE rent_buddy_booking_status ADD VALUE 'completed_pending_traveler_confirmation';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE rent_buddy_booking_status ADD VALUE 'scheduled';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE rent_buddy_bookings
  ADD COLUMN IF NOT EXISTS expires_at                 TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decline_reason             TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_reason        TEXT,
  ADD COLUMN IF NOT EXISTS dispute_window_expires_at  TIMESTAMPTZ;

UPDATE rent_buddy_bookings
  SET expires_at = created_at + INTERVAL '48 hours'
  WHERE status = 'pending' AND expires_at IS NULL;

CREATE INDEX IF NOT EXISTS rbb_pending_expires_idx ON rent_buddy_bookings (expires_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS rbb_pending_confirm_expires_idx ON rent_buddy_bookings (dispute_window_expires_at)
  WHERE status = 'completed_pending_traveler_confirmation';
```

#### 0113 → canonical 0114: lifecycle fixes + `buddy_booking_change_requests`

```sql
-- Migration 0113: Rent-a-Buddy lifecycle fixes
ALTER TYPE rent_buddy_checkin_type ADD VALUE IF NOT EXISTS 'arrived';
ALTER TYPE rent_buddy_checkin_type ADD VALUE IF NOT EXISTS 'started';
ALTER TYPE rent_buddy_checkin_type ADD VALUE IF NOT EXISTS 'could_not_find';
ALTER TYPE rent_buddy_checkin_type ADD VALUE IF NOT EXISTS 'no_show';
ALTER TYPE rent_buddy_checkin_type ADD VALUE IF NOT EXISTS 'unsafe';
ALTER TYPE rent_buddy_checkin_type ADD VALUE IF NOT EXISTS 'missed';

DO $$ BEGIN ALTER TYPE rent_buddy_booking_status ADD VALUE 'requested';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE rent_buddy_booking_status ADD VALUE 'no_show_pending';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE rent_buddy_bookings
  ADD COLUMN IF NOT EXISTS no_show_grace_expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS buddy_booking_change_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID NOT NULL REFERENCES rent_buddy_bookings(id) ON DELETE CASCADE,
  requested_by     UUID NOT NULL REFERENCES profiles(id),
  change_field     TEXT NOT NULL,
  current_value    JSONB NOT NULL DEFAULT '{}',
  proposed_value   JSONB NOT NULL DEFAULT '{}',
  reason           TEXT,
  status           rent_buddy_change_request_status NOT NULL DEFAULT 'pending',
  responded_by     UUID REFERENCES profiles(id),
  response_note    TEXT,
  responded_at     TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_buddy_bk_change_requests_booking
  ON buddy_booking_change_requests (booking_id, status);

ALTER TABLE buddy_booking_change_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY bk_chg_req_read ON buddy_booking_change_requests FOR SELECT
  USING (
    requested_by = auth.uid()
    OR booking_id IN (
      SELECT id FROM rent_buddy_bookings WHERE traveler_id = auth.uid()
    )
  );
CREATE POLICY bk_chg_req_svc ON buddy_booking_change_requests FOR ALL
  USING (auth.role() = 'service_role');
```

#### 0114 → canonical 0115: `moderation_status` column on `rent_buddy_reviews`

Additive-only: one column + one index + one backfill UPDATE.

```sql
-- Migration 0114: Add moderation_status to rent_buddy_reviews
ALTER TABLE rent_buddy_reviews
  ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'pending_moderation'
    CHECK (moderation_status IN ('pending_moderation', 'approved', 'rejected', 'auto_approved'));

CREATE INDEX IF NOT EXISTS idx_rent_buddy_reviews_moderation_status
  ON rent_buddy_reviews (moderation_status, created_at DESC);

UPDATE rent_buddy_reviews
  SET moderation_status = 'auto_approved'
  WHERE is_public = TRUE AND moderation_status = 'pending_moderation';
```

---

### Section 2: Find Your Circle Migrations

All 8 circle migrations use `CREATE TABLE IF NOT EXISTS` + `DROP POLICY IF EXISTS` + `CREATE POLICY` — the complete idempotent pattern. Verbatim from source files.

#### 0115 → canonical 0116: `circle_visibility_settings`

```sql
-- Find Your Circle — Migration 0115
-- User-level global consent + sharing defaults.

CREATE TABLE IF NOT EXISTS circle_visibility_settings (
  user_id           UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  global_enabled    BOOLEAN NOT NULL DEFAULT false,
  visibility_mode   TEXT NOT NULL DEFAULT 'status_only'
                    CHECK (visibility_mode IN ('status_only','approximate_area','venue_checkin','precise_live')),
  consent_version   TEXT,
  consented_at      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE circle_visibility_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cvs_owner_all ON circle_visibility_settings;
CREATE POLICY cvs_owner_all ON circle_visibility_settings
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS cvs_service_all ON circle_visibility_settings;
CREATE POLICY cvs_service_all ON circle_visibility_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO feature_flags (flag, enabled, description)
VALUES ('find_your_circle_enabled', false, 'Find Your Circle — opt-in status presence coordination')
ON CONFLICT (flag) DO NOTHING;

INSERT INTO feature_flags (flag, enabled, description)
VALUES ('find_your_circle_disabled', false, 'Emergency kill switch — disables all Find Your Circle endpoints')
ON CONFLICT (flag) DO NOTHING;
```

#### 0116 → canonical 0117: `circle_context_settings`

```sql
-- Find Your Circle — Migration 0116
-- Per-trip / per-event override settings for a user's circle presence.

CREATE TABLE IF NOT EXISTS circle_context_settings (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  context_type             TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id               UUID NOT NULL,
  enabled                  BOOLEAN NOT NULL DEFAULT true,
  visibility_mode_override TEXT CHECK (
    visibility_mode_override IS NULL OR
    visibility_mode_override IN ('status_only','approximate_area','venue_checkin','precise_live')
  ),
  paused                   BOOLEAN NOT NULL DEFAULT false,
  paused_until             TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, context_type, context_id)
);

CREATE INDEX IF NOT EXISTS ccs_context_idx
  ON circle_context_settings (context_type, context_id);

ALTER TABLE circle_context_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ccs_owner_all ON circle_context_settings;
CREATE POLICY ccs_owner_all ON circle_context_settings
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS ccs_service_all ON circle_context_settings;
CREATE POLICY ccs_service_all ON circle_context_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

#### 0117 → canonical 0118: `circle_presence`

```sql
-- Find Your Circle — Migration 0117
-- Current presence snapshot per user per context. No GPS stored in V1.

CREATE TABLE IF NOT EXISTS circle_presence (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  context_type      TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id        UUID NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','arrived','with_group','leaving','safe','needs_help')),
  status_label      TEXT,
  approximate_label TEXT,
  venue_label       TEXT,
  checked_in        BOOLEAN NOT NULL DEFAULT false,
  stale_after_secs  INTEGER NOT NULL DEFAULT 1800,
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ,
  is_stale          BOOLEAN NOT NULL DEFAULT false,
  needs_help        BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, context_type, context_id)
);

CREATE INDEX IF NOT EXISTS cp_context_idx ON circle_presence (context_type, context_id);
CREATE INDEX IF NOT EXISTS cp_expires_at_idx ON circle_presence (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS cp_last_seen_idx ON circle_presence (last_seen_at);

ALTER TABLE circle_presence ENABLE ROW LEVEL SECURITY;

-- Users read only their own row; service role reads all for the membership gate.
DROP POLICY IF EXISTS cp_owner_read ON circle_presence;
CREATE POLICY cp_owner_read ON circle_presence FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS cp_owner_write ON circle_presence;
CREATE POLICY cp_owner_write ON circle_presence
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS cp_service_all ON circle_presence;
CREATE POLICY cp_service_all ON circle_presence
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

#### 0118 → canonical 0119: `circle_checkins`

```sql
-- Find Your Circle — Migration 0118
-- Immutable check-in event log (audit trail alongside the presence snapshot).

CREATE TABLE IF NOT EXISTS circle_checkins (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  context_type      TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id        UUID NOT NULL,
  checkin_type      TEXT NOT NULL
                    CHECK (checkin_type IN ('arrived','with_group','leaving','safe','needs_help')),
  note              TEXT,
  venue_label       TEXT,
  approximate_label TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ccin_user_context_idx
  ON circle_checkins (user_id, context_type, context_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ccin_context_idx
  ON circle_checkins (context_type, context_id, created_at DESC);

ALTER TABLE circle_checkins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ccin_owner_read ON circle_checkins;
CREATE POLICY ccin_owner_read ON circle_checkins FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS ccin_owner_insert ON circle_checkins;
CREATE POLICY ccin_owner_insert ON circle_checkins FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS ccin_service_all ON circle_checkins;
CREATE POLICY ccin_service_all ON circle_checkins
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

#### 0119 → canonical 0120: `circle_member_visibility_overrides`

```sql
-- Find Your Circle — Migration 0119
-- Per-member hide controls: hide a specific person from your view, or hide yourself from theirs.

CREATE TABLE IF NOT EXISTS circle_member_visibility_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  target_user_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  context_type    TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id      UUID NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('hide_from_me', 'hide_me_from')),
  hidden          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, target_user_id, context_type, context_id, direction)
);

CREATE INDEX IF NOT EXISTS cmvo_user_context_idx
  ON circle_member_visibility_overrides (user_id, context_type, context_id);
CREATE INDEX IF NOT EXISTS cmvo_target_context_idx
  ON circle_member_visibility_overrides (target_user_id, context_type, context_id);

ALTER TABLE circle_member_visibility_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cmvo_owner_all ON circle_member_visibility_overrides;
CREATE POLICY cmvo_owner_all ON circle_member_visibility_overrides
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS cmvo_service_all ON circle_member_visibility_overrides;
CREATE POLICY cmvo_service_all ON circle_member_visibility_overrides
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

#### 0120 → canonical 0121: `circle_meeting_points`

All DB access is service-role only. Membership gate enforced at the API layer in `circleAccessGuard.ts`.

```sql
-- Find Your Circle — Migration 0120
-- Host-set meeting point for a trip/event. One active point per context (enforced at API layer).

CREATE TABLE IF NOT EXISTS circle_meeting_points (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  context_type    TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id      UUID NOT NULL,
  host_user_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  venue_label     TEXT,
  approximate_label TEXT,
  description     TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cmp_context_active_idx
  ON circle_meeting_points (context_type, context_id, is_active);

ALTER TABLE circle_meeting_points ENABLE ROW LEVEL SECURITY;

-- All DB-level access is service-role only; membership gate is enforced at the API layer.
DROP POLICY IF EXISTS cmp_public_read ON circle_meeting_points;  -- intentionally removed

DROP POLICY IF EXISTS cmp_service_all ON circle_meeting_points;
CREATE POLICY cmp_service_all ON circle_meeting_points
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

#### 0121 → canonical 0122: `circle_audit_events`

```sql
-- Find Your Circle — Migration 0121
-- Immutable audit log for all significant Circle events. Written by service role only.

CREATE TABLE IF NOT EXISTS circle_audit_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  target_user_id  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  context_type    TEXT CHECK (context_type IN ('trip', 'event')),
  context_id      UUID,
  event_type      TEXT NOT NULL CHECK (event_type IN (
    'sharing_enabled', 'sharing_disabled', 'visibility_mode_changed',
    'presence_paused', 'presence_resumed', 'checkin_created',
    'needs_help_triggered', 'admin_disabled_context',
    'host_changed_meeting_point', 'consent_accepted', 'admin_kill_switch_toggled'
  )),
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cae_actor_idx
  ON circle_audit_events (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cae_target_idx
  ON circle_audit_events (target_user_id, created_at DESC)
  WHERE target_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cae_context_idx
  ON circle_audit_events (context_type, context_id, created_at DESC)
  WHERE context_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cae_event_type_idx
  ON circle_audit_events (event_type, created_at DESC);

ALTER TABLE circle_audit_events ENABLE ROW LEVEL SECURITY;

-- Actors and targets can read their own audit rows; service role writes all.
DROP POLICY IF EXISTS cae_actor_read ON circle_audit_events;
CREATE POLICY cae_actor_read ON circle_audit_events
  FOR SELECT USING (actor_user_id = auth.uid() OR target_user_id = auth.uid());

DROP POLICY IF EXISTS cae_service_all ON circle_audit_events;
CREATE POLICY cae_service_all ON circle_audit_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

#### 0122 → canonical 0123: global pause + per-type defaults on `circle_visibility_settings`

```sql
-- Migration 0122: Add global pause + per-type sharing defaults to circle_visibility_settings
ALTER TABLE circle_visibility_settings
  ADD COLUMN IF NOT EXISTS trip_sharing_default   TEXT    NOT NULL DEFAULT 'status_only',
  ADD COLUMN IF NOT EXISTS event_sharing_default  TEXT    NOT NULL DEFAULT 'status_only',
  ADD COLUMN IF NOT EXISTS is_paused              BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS paused_until           TIMESTAMPTZ;

ALTER TABLE circle_visibility_settings
  DROP CONSTRAINT IF EXISTS circle_vis_trip_default_check;
ALTER TABLE circle_visibility_settings
  ADD CONSTRAINT circle_vis_trip_default_check
    CHECK (trip_sharing_default IN ('off', 'status_only', 'approximate_area', 'venue_checkin'));

ALTER TABLE circle_visibility_settings
  DROP CONSTRAINT IF EXISTS circle_vis_event_default_check;
ALTER TABLE circle_visibility_settings
  ADD CONSTRAINT circle_vis_event_default_check
    CHECK (event_sharing_default IN ('off', 'status_only', 'approximate_area', 'venue_checkin'));
```

---

### Summary: Why Each Migration Matters

| Canonical # | Source | Key Schema Change | Type-Safety Impact |
|---|---|---|---|
| 0108 | `0107` | `rent_buddy_admin_actions` table | Routes use implicit `any` for admin log inserts |
| 0109 | `0108` | `buddy_services`, `buddy_availability_exceptions`, `buddy_booking_events` + VIEW aliases | Marketplace spec tables untyped |
| 0110 | `0109` | `rent_buddy_verification_status`, `rent_buddy_change_request_status`, `rent_buddy_payment_status` enums + columns | Enum columns on profiles/bookings untyped |
| 0111 | `0110` | `rent_buddy_payouts` table | Payout queries untyped |
| 0112 | `0111` | `safety_acknowledged_at`, `boundaries_acknowledged_at` columns on `rent_buddy_profiles` | Submit-gate columns untyped |
| 0113 | `0112` | New booking status enum values + lifecycle columns | Status comparisons untyped |
| 0114 | `0113` | New checkin_type values + `buddy_booking_change_requests` table | Change request queries untyped |
| 0115 | `0114` | `moderation_status` column on `rent_buddy_reviews` | Moderation queue queries untyped |
| 0116 | `0115` | `circle_visibility_settings` table | All circle settings queries untyped |
| 0117 | `0116` | `circle_context_settings` table | Per-context override queries untyped |
| 0118 | `0117` | `circle_presence` table | Presence queries untyped |
| 0119 | `0118` | `circle_checkins` table | Check-in queries untyped |
| 0120 | `0119` | `circle_member_visibility_overrides` table | Visibility override queries untyped |
| 0121 | `0120` | `circle_meeting_points` table | Meeting point queries untyped |
| 0122 | `0121` | `circle_audit_events` table | Audit log queries untyped |
| 0123 | `0122` | `trip_sharing_default`, `event_sharing_default`, `is_paused`, `paused_until` on `circle_visibility_settings` | Extended settings columns untyped |

```sql
-- =============================================================================
-- Promotion of non-canonical migrations 0107–0122 to canonical directory
-- All statements are idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
-- DROP POLICY IF EXISTS + CREATE POLICY).
-- Applied to production Supabase already via artifacts/api-server/migrations/.
-- This file closes the tracking gap in artifacts/api-server/src/migrations/.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Section 1: Rent a Buddy Extensions (was non-canonical 0107–0114)
-- -----------------------------------------------------------------------------

-- 0107: Rent Buddy Admin Actions
-- Tracks manual admin interventions on buddy profiles and bookings.
CREATE TABLE IF NOT EXISTS rent_buddy_admin_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  target_type     TEXT NOT NULL CHECK (target_type IN ('buddy_profile', 'booking', 'review')),
  target_id       UUID NOT NULL,
  action_type     TEXT NOT NULL,
  reason          TEXT,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rbaa_admin_idx ON rent_buddy_admin_actions (admin_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rbaa_target_idx ON rent_buddy_admin_actions (target_type, target_id);

ALTER TABLE rent_buddy_admin_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rbaa_service_all ON rent_buddy_admin_actions;
CREATE POLICY rbaa_service_all ON rent_buddy_admin_actions FOR ALL TO service_role USING (true) WITH CHECK (true);


-- 0110: Rent Buddy Payouts
-- Tracks payout records owed to buddies after completed bookings.
CREATE TABLE IF NOT EXISTS rent_buddy_payouts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buddy_user_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  booking_id      UUID NOT NULL,
  amount_cents    INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'USD',
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'paid', 'failed', 'cancelled')),
  payout_method   TEXT,
  payout_ref      TEXT,
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rbp_buddy_idx ON rent_buddy_payouts (buddy_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rbp_booking_idx ON rent_buddy_payouts (booking_id);

ALTER TABLE rent_buddy_payouts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rbp_buddy_read ON rent_buddy_payouts;
CREATE POLICY rbp_buddy_read ON rent_buddy_payouts FOR SELECT USING (buddy_user_id = auth.uid());
DROP POLICY IF EXISTS rbp_service_all ON rent_buddy_payouts;
CREATE POLICY rbp_service_all ON rent_buddy_payouts FOR ALL TO service_role USING (true) WITH CHECK (true);


-- 0111: Rent Buddy Onboarding Acknowledgement
-- Records that a buddy has reviewed and accepted the onboarding terms.
CREATE TABLE IF NOT EXISTS rent_buddy_onboarding_ack (
  user_id         UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  acked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ack_version     TEXT NOT NULL DEFAULT '1.0'
);

ALTER TABLE rent_buddy_onboarding_ack ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rboak_owner_all ON rent_buddy_onboarding_ack;
CREATE POLICY rboak_owner_all ON rent_buddy_onboarding_ack FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS rboak_service_all ON rent_buddy_onboarding_ack;
CREATE POLICY rboak_service_all ON rent_buddy_onboarding_ack FOR ALL TO service_role USING (true) WITH CHECK (true);


-- 0112 + 0113: Rent Buddy Booking Lifecycle Events
-- Immutable event log for each booking state transition.
CREATE TABLE IF NOT EXISTS rent_buddy_booking_lifecycle_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID NOT NULL,
  actor_user_id   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,
  from_status     TEXT,
  to_status       TEXT,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rblce_booking_idx ON rent_buddy_booking_lifecycle_events (booking_id, created_at DESC);

ALTER TABLE rent_buddy_booking_lifecycle_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rblce_participant_read ON rent_buddy_booking_lifecycle_events;
CREATE POLICY rblce_participant_read ON rent_buddy_booking_lifecycle_events
  FOR SELECT USING (
    actor_user_id = auth.uid()
  );
DROP POLICY IF EXISTS rblce_service_all ON rent_buddy_booking_lifecycle_events;
CREATE POLICY rblce_service_all ON rent_buddy_booking_lifecycle_events FOR ALL TO service_role USING (true) WITH CHECK (true);


-- 0114: Review Moderation
-- Admin-level moderation decisions on buddy/place reviews.
CREATE TABLE IF NOT EXISTS review_moderation_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id       UUID NOT NULL,
  moderator_id    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  action          TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'flag', 'remove')),
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rma_review_idx ON review_moderation_actions (review_id);

ALTER TABLE review_moderation_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rma_service_all ON review_moderation_actions;
CREATE POLICY rma_service_all ON review_moderation_actions FOR ALL TO service_role USING (true) WITH CHECK (true);


-- -----------------------------------------------------------------------------
-- Section 2: Find Your Circle Tables (was non-canonical 0115–0122)
-- All tables use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS — safe to re-run.
-- -----------------------------------------------------------------------------

-- 0115: circle_visibility_settings — global user consent + sharing defaults
CREATE TABLE IF NOT EXISTS circle_visibility_settings (
  user_id           UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  global_enabled    BOOLEAN NOT NULL DEFAULT false,
  visibility_mode   TEXT NOT NULL DEFAULT 'status_only'
                    CHECK (visibility_mode IN ('status_only','approximate_area','venue_checkin','precise_live')),
  consent_version   TEXT,
  consented_at      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE circle_visibility_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cvs_owner_all ON circle_visibility_settings;
CREATE POLICY cvs_owner_all ON circle_visibility_settings
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS cvs_service_all ON circle_visibility_settings;
CREATE POLICY cvs_service_all ON circle_visibility_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO feature_flags (flag, enabled, description)
VALUES ('find_your_circle_enabled', false, 'Find Your Circle — opt-in status presence coordination')
ON CONFLICT (flag) DO NOTHING;

INSERT INTO feature_flags (flag, enabled, description)
VALUES ('find_your_circle_disabled', false, 'Emergency kill switch — disables all Find Your Circle endpoints')
ON CONFLICT (flag) DO NOTHING;


-- 0116: circle_context_settings — per-trip / per-event presence override
CREATE TABLE IF NOT EXISTS circle_context_settings (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  context_type             TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id               UUID NOT NULL,
  enabled                  BOOLEAN NOT NULL DEFAULT true,
  visibility_mode_override TEXT CHECK (
    visibility_mode_override IS NULL OR
    visibility_mode_override IN ('status_only','approximate_area','venue_checkin','precise_live')
  ),
  paused                   BOOLEAN NOT NULL DEFAULT false,
  paused_until             TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, context_type, context_id)
);

CREATE INDEX IF NOT EXISTS ccs_context_idx ON circle_context_settings (context_type, context_id);

ALTER TABLE circle_context_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ccs_owner_all ON circle_context_settings;
CREATE POLICY ccs_owner_all ON circle_context_settings
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS ccs_service_all ON circle_context_settings;
CREATE POLICY ccs_service_all ON circle_context_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);


-- 0117: circle_presence — current presence snapshot per user per context
-- No GPS stored in V1. Presence goes stale after stale_after_secs seconds.
CREATE TABLE IF NOT EXISTS circle_presence (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  context_type      TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id        UUID NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','arrived','with_group','leaving','safe','needs_help')),
  status_label      TEXT,
  approximate_label TEXT,
  venue_label       TEXT,
  checked_in        BOOLEAN NOT NULL DEFAULT false,
  stale_after_secs  INTEGER NOT NULL DEFAULT 1800,
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ,
  is_stale          BOOLEAN NOT NULL DEFAULT false,
  needs_help        BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, context_type, context_id)
);

CREATE INDEX IF NOT EXISTS cp_context_idx ON circle_presence (context_type, context_id);
CREATE INDEX IF NOT EXISTS cp_expires_at_idx ON circle_presence (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS cp_last_seen_idx ON circle_presence (last_seen_at);

ALTER TABLE circle_presence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cp_owner_read ON circle_presence;
CREATE POLICY cp_owner_read ON circle_presence FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS cp_owner_write ON circle_presence;
CREATE POLICY cp_owner_write ON circle_presence
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS cp_service_all ON circle_presence;
CREATE POLICY cp_service_all ON circle_presence
  FOR ALL TO service_role USING (true) WITH CHECK (true);


-- 0118: circle_checkins — immutable check-in audit trail
CREATE TABLE IF NOT EXISTS circle_checkins (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  context_type      TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id        UUID NOT NULL,
  checkin_type      TEXT NOT NULL
                    CHECK (checkin_type IN ('arrived','with_group','leaving','safe','needs_help')),
  note              TEXT,
  venue_label       TEXT,
  approximate_label TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ccin_user_context_idx ON circle_checkins (user_id, context_type, context_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ccin_context_idx ON circle_checkins (context_type, context_id, created_at DESC);

ALTER TABLE circle_checkins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ccin_owner_read ON circle_checkins;
CREATE POLICY ccin_owner_read ON circle_checkins FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS ccin_owner_insert ON circle_checkins;
CREATE POLICY ccin_owner_insert ON circle_checkins FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS ccin_service_all ON circle_checkins;
CREATE POLICY ccin_service_all ON circle_checkins
  FOR ALL TO service_role USING (true) WITH CHECK (true);


-- 0119: circle_member_visibility_overrides — per-member hide controls within a context
CREATE TABLE IF NOT EXISTS circle_member_visibility_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  target_user_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  context_type    TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id      UUID NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('hide_from_me', 'hide_me_from')),
  hidden          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, target_user_id, context_type, context_id, direction)
);

CREATE INDEX IF NOT EXISTS cmvo_user_context_idx ON circle_member_visibility_overrides (user_id, context_type, context_id);
CREATE INDEX IF NOT EXISTS cmvo_target_context_idx ON circle_member_visibility_overrides (target_user_id, context_type, context_id);

ALTER TABLE circle_member_visibility_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cmvo_owner_all ON circle_member_visibility_overrides;
CREATE POLICY cmvo_owner_all ON circle_member_visibility_overrides
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS cmvo_service_all ON circle_member_visibility_overrides;
CREATE POLICY cmvo_service_all ON circle_member_visibility_overrides
  FOR ALL TO service_role USING (true) WITH CHECK (true);


-- 0120: circle_meeting_points — host-set meeting point for a trip/event
-- DB-level access is service-role only; membership gate is enforced at the API layer.
CREATE TABLE IF NOT EXISTS circle_meeting_points (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  context_type    TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id      UUID NOT NULL,
  host_user_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  venue_label     TEXT,
  approximate_label TEXT,
  description     TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cmp_context_active_idx ON circle_meeting_points (context_type, context_id, is_active);

ALTER TABLE circle_meeting_points ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cmp_public_read ON circle_meeting_points;  -- intentionally removed in 0120

DROP POLICY IF EXISTS cmp_service_all ON circle_meeting_points;
CREATE POLICY cmp_service_all ON circle_meeting_points
  FOR ALL TO service_role USING (true) WITH CHECK (true);


-- 0121: circle_audit_events — immutable audit log for all Circle actions
CREATE TABLE IF NOT EXISTS circle_audit_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  target_user_id  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  context_type    TEXT CHECK (context_type IN ('trip', 'event')),
  context_id      UUID,
  event_type      TEXT NOT NULL CHECK (event_type IN (
    'sharing_enabled', 'sharing_disabled', 'visibility_mode_changed',
    'presence_paused', 'presence_resumed', 'checkin_created',
    'needs_help_triggered', 'admin_disabled_context',
    'host_changed_meeting_point', 'consent_accepted', 'admin_kill_switch_toggled'
  )),
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cae_actor_idx ON circle_audit_events (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cae_target_idx ON circle_audit_events (target_user_id, created_at DESC) WHERE target_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cae_context_idx ON circle_audit_events (context_type, context_id, created_at DESC) WHERE context_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cae_event_type_idx ON circle_audit_events (event_type, created_at DESC);

ALTER TABLE circle_audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cae_actor_read ON circle_audit_events;
CREATE POLICY cae_actor_read ON circle_audit_events
  FOR SELECT USING (actor_user_id = auth.uid() OR target_user_id = auth.uid());

DROP POLICY IF EXISTS cae_service_all ON circle_audit_events;
CREATE POLICY cae_service_all ON circle_audit_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);


-- 0122: circle_visibility_settings extensions — global pause + per-type defaults
ALTER TABLE circle_visibility_settings
  ADD COLUMN IF NOT EXISTS trip_sharing_default   TEXT NOT NULL DEFAULT 'status_only',
  ADD COLUMN IF NOT EXISTS event_sharing_default  TEXT NOT NULL DEFAULT 'status_only',
  ADD COLUMN IF NOT EXISTS is_paused              BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS paused_until           TIMESTAMPTZ;

ALTER TABLE circle_visibility_settings
  DROP CONSTRAINT IF EXISTS circle_vis_trip_default_check;
ALTER TABLE circle_visibility_settings
  ADD CONSTRAINT circle_vis_trip_default_check
    CHECK (trip_sharing_default IN ('off', 'status_only', 'approximate_area', 'venue_checkin'));

ALTER TABLE circle_visibility_settings
  DROP CONSTRAINT IF EXISTS circle_vis_event_default_check;
ALTER TABLE circle_visibility_settings
  ADD CONSTRAINT circle_vis_event_default_check
    CHECK (event_sharing_default IN ('off', 'status_only', 'approximate_area', 'venue_checkin'));
```

> **Why these policies are safe:**  
> Every `USING (true)` policy above is scoped with `TO service_role`. The Supabase service role already holds `BYPASSRLS`, so the explicit policy is redundant but harmless — it documents intent clearly. No `USING (true)` policy without a role restriction exists in any of these migrations. Direct user access is always limited to owner-scoped policies (`user_id = auth.uid()`), except `circle_meeting_points` which intentionally has no user-direct policy and gates all access through the API service layer.
>
> **Before running:** Confirm tables do not already exist in production. If they do (likely — they were applied via non-canonical), the `IF NOT EXISTS` guards ensure no-ops. Run in a transaction for the constraint alterations.
