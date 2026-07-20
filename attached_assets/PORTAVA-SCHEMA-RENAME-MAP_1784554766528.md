# Portava — Schema Rename Map (code → actual production columns)

**Source:** full code-vs-DB audit + live column dump, July 20, 2026.
**For Portava Manager. Rules: these are CODE fixes — do NOT create new tables/columns unless an item says ADD. After each file, run its tests. The schema is right; the code guessed wrong names.**

## A. Wrong table names (repoint, never create)

| Code references | Actual table | Where |
|---|---|---|
| `follows` | `user_follows` (follower_id, following_id) | src/routes/discovery.ts |
| `places` | `discovery_places` | src/routes/plan.ts |
| `stamps` | `passport_stamps` | src/routes/passport.ts |
| `circle_members` | `circle_memberships` (verify its real columns first — table empty; probe or check dashboard) | src/routes/events.ts |
| `compass_analytics` | now EXISTS (created in repair-2) — no change needed | src/routes/admin.ts |
| `friend_connections`, `friend_requests`, `user_friendships` refs | **Spec says follow-only, no friends system.** Delete `friends.ts` routes + these references, or explicitly decide to keep and migrate. | src/routes/friends.ts, passportStamps.ts |

## B. Messaging naming drift — user-facing breakage (fix first)

These four bugs are live in prod: event chat creation, event context card, gem-share-to-chat, and review-prompt notifications all fail silently.

**`src/routes/events.ts` — thread creation:** `message_threads` has NO `type`/`name`/`created_by`/`metadata`. Actual: `thread_type`, `title`, `trip_id`, `circle_owner_id`, `status`. Fix: insert `{ id, thread_type: <valid value — copy from messaging.ts's canonical creation>, title }`; the event linkage lives on `events.chat_thread_id`, not on the thread. Drop `created_by`/`metadata`.

**`src/routes/events.ts` — context-card message:** `messages` has no `metadata`/`pinned`/`content`. Actual: `body`, `msg_type`, `subtype`. Put the card payload as JSON in `body` (the discovery-card pattern already does exactly this). Drop `pinned` or add the feature properly later.

**`src/routes/hiddenGems.ts` — gem share:** `messages.content` → **`messages.body`**; `metadata: card` → embed card JSON in `body` (again, copy `sendDiscoveryCard`). And its `posts.body` write → **`posts.content`** (yes — messages use *body*, posts use *content*; the file has them swapped).

**Notifications (events.ts, appeals.ts):** `notification_type` → **`event_type`** (set `category` too — see existing notification inserts for the convention); `content: {...}` → **`metadata`**.

**`src/routes/messaging.ts`:** `messages.status` filter — no such column; probably belongs on `message_requests`. Verify intent. `message_thread_members.id` read — verify that table's real key columns.

## C. Column renames — mechanical (high confidence)

| File | Wrong → Right |
|---|---|
| routes/hashtags.ts (events) | `name`→`title`, `location`→`location_name`, `start_at`→`starts_at`, `end_at`→`ends_at`, `organizer_id`→`host_id` |
| routes/discoverySearch.ts | events: `cover_image_url`→`cover_url`, `status`→`state`; trips: `cover_image_url`→`cover_url`; profiles: `is_buddy`→ join `rent_buddy_profiles` or use `buddy_verified_at` |
| routes/hashtags.ts (trips) | `name`→`title` |
| routes/collections.ts | trips: `destination`→`destination_city`; posts: `title`/`caption`→`content` |
| routes/admin.ts | trips: `user_id`→`owner_id`; profiles: `email`→ not on profiles (use auth admin API); events: `featured`→ no column (ADD `events.featured boolean default false` if the admin toggle should work, else remove control) |
| routes/pulse.ts | trips: `member_count`→ count `trip_members` (no column); rent_buddy_profiles: `trust_score`→ decide (`profiles.trust_score` or `trust_score_override`), `moderation_status`→`admin_status`/`risk_review_status` |
| routes/posts.ts | profiles: `is_verified`→`verified` |
| compass/CompassAbuseDefenseEngine.ts | posts: `user_id`→`author_id`; reviews: `reviewee_id`→ **`rent_buddy_reviews.reviewee_id`** (wrong table); profiles: `referred_by`→ no column (stub out or ADD); rent_buddy_bookings: `rating`→ lives on `rent_buddy_reviews` |
| compass/CompassFallbackFeedBuilder.ts | posts: `post_type`→`category`, `is_verified`→`location_verified`/`geotag_verified` (decide), `event_starts_at`→ posts aren't events — restructure; passport_stamps: `unlocked_at`→**`awarded_at`** |
| compass/CompassActiveUserRewardEngine.ts | profiles: `safety_flags`→`safety_flags_count` |
| compass/CompassItemHydrator.ts | rent_buddy_profiles: `is_verified`→`verified` |
| routes/adminCompass.ts | rent_buddy_profiles: `is_active`→`status = 'active'`; user_location_state: `resolved_city`→`city`, `resolved_country`→`country`; compass_active_user_scores: `updated_at`/`badge_eligibility`→ verify (may be `last_computed_at`) |
| services/passport/PassportMapService.ts | passport_stamps: `earned_at`→**`awarded_at`** |
| lib/safeReturnScheduler.ts | feature_flags: `key`→**`flag`** |
| routes/trips.ts (push) | `notification_devices.expo_push_token`→ **`profiles.expo_push_token`** (devices table is empty/unused) |
| routes/highlights.ts, collections.ts, engagement.ts | highlights: `user_id`→`owner_id`, `media_duration_seconds`→`video_duration_seconds`; `media_thumbnail_url`/`filter_id`/`filter_intensity`→ no columns (ADD if the filters feature is real, else strip) |
| routes/routePlan.ts | trip_plan_items: `item_type`→`category`, `planned_start_date`→`day_date`, `structured_location`→ use `location_name`/`lat`/`lng` |
| routes/dailyBrief.ts | meetups: `proposed_time`/`attendee_count`→ verify real columns (table empty — check dashboard) |
| routes/stamps.ts | stamp_progress: `name`/`icon_url`→ likely joined from `universal_stamp_catalog` now — verify |
| routes/engagement.ts | memories: `user_id`→ verify (passport_memories vs memories); trip_members: `id`→ verify key |
| routes/passport.ts | rent_buddy_availability: `available_now`→ lives on **`rent_buddy_profiles.available_now`** |
| lib/chatSync.ts | circle_memberships: `member_id`/`owner_id` vs `user_id`/`other_id` — table empty; verify real shape, then unify ALL circle-membership code on one column set |

## D. Verify-class items ([write]-derived, possible JSON-key false positives)

buddy_booking_events (13 cols from messaging.ts/rentABuddy.ts inserts — if top-level, ADD columns to this audit table; if nested under `metadata`, no-op) · compass_feedback.details · compass_feedback_events.category · delayed_post_location_events.worker · geo_zones.note/source · location_trust_events.note · layover_events.token · report_evidence.context_id/auto_attached · reports.notes · rent_buddy_applications.admin_status · rent_buddy_safety_events.response · rent_buddy_bookings.service_id · user_deletion_requests.id/executed_by · user_restrictions.report_id · friend_requests/message_requests updated_at/responded_at · trust_events/trip_members updated_at · event_attendee_states.id · passport_postcards.pinned_at/note · discovery_places.country/cover_url · compass_user_preferences.interests · hidden_gems image_url/location_city/location_country/lat/lng (table empty — verify real names, client expects lat/lng).

## E. One code-pattern bug

`HiddenGemService.ts` wraps `db.rpc(...)` in try/catch expecting a throw — supabase-js returns `{ error }` instead, so the fallback never runs. Check `error` explicitly. Audit the codebase for this pattern generally.

## F. Already fixed — do not redo

Tables created via repair SQL: rank_events, search_history, profile_views, post_impressions, user_recent_places, user_trust_scores, compass_analytics, circle_invites. Columns: messages media (0152), trips/events/passport_memories media_type (0150s), rent_buddy_bookings stay_connected_*, 0160 family. Functions: increment_counter created; upsert_city_stamp being authored separately.
