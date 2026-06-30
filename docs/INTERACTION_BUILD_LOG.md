# Interaction System — Build Log

> This log is append-only. Each phase adds its section. Do not edit prior sections.

---

## Phase 1 — Audit (2026-06-30)

### Objective

Read-only sweep of the entire codebase and Supabase schema to produce a reuse-vs-build
classification for every concept in the User Interaction System spec. This entry is the
single source of truth that Phase 2 (data foundation / SQL migrations) must use as its
canonical table decisions.

---

### Audit scope

| Area | What was inspected |
|------|-------------------|
| **Supabase schema** | `docs/migrations.md` + ALL files in `artifacts/api-server/src/migrations/` (60+ files) AND `artifacts/api-server/migrations/` (39 files — a second migration tree) |
| **Backend routes** | All 50 files in `artifacts/api-server/src/routes/` — complete route inventory in Appendix A |
| **Mobile hooks** | `travel-buddy-standalone/src/hooks/` (28 files) |
| **Mobile services** | `travel-buddy-standalone/src/services/` (35 files) |
| **Mobile screens** | `travel-buddy-standalone/app/` (top-level + all subdirs) |

> **Important:** Two migration directories exist. `artifacts/api-server/src/migrations/` contains migrations 0010–0063 (documented in `docs/migrations.md`). `artifacts/api-server/migrations/` contains a second set of 39 SQL files (0011–0063 range, partially overlapping) including pre-docs-log migrations for message_reports, thread_reports, group_chat, and others. Phase 2 must reconcile both directories before writing new migrations.

---

### Section 1 — Database tables

#### 1A. Existing social / interaction tables (canonical list)

| Table | Migration source | Classification | Notes |
|-------|-----------------|---------------|-------|
| `profiles` | pre-migration baseline | **EXISTS-reuse** | Core user row; has `tag_permission` enum (0043), `verification_status/verified_at/verification_method/verification_expires_at` (outer `0027_verification_status.sql`) |
| `user_follows` | pre-migration baseline | **EXISTS-reuse** | Follower/following edge; cleaned up on block |
| `user_friendships` | pre-migration baseline | **EXISTS-reuse** | Normalised mutual-friend pair (user_a < user_b) |
| `friend_requests` | pre-migration baseline | **EXISTS-reuse** | Pending friend-request queue |
| `blocks` | `src/0015_blocks.sql` | **EXISTS-reuse** | `(blocker_id, blocked_id)` unique; `is_blocked(a,b)` SECURITY DEFINER helper present; cleaned up on block: removes follow edges + pending friend requests + friendships |
| `circle_memberships` | pre-migration baseline | **EXISTS-reuse** | Circle membership join table |
| `circle_invites` | pre-migration baseline | **EXISTS-reuse** | Pending circle invite queue |
| `message_threads` | outer `0012_group_chat.sql` | **EXISTS-reuse** | Extended with `thread_type` (`direct/trip/circle`), `trip_id`, `circle_owner_id`, `title` |
| `message_thread_members` | outer `0012_group_chat.sql` + `src/0016_thread_reads.sql` | **EXISTS-reuse** | Has `muted_at` (thread-scoped mute), `archived_at`, `left_at`, `last_read_at`; thread-level mute is per-member per-thread |
| `messages` | pre-migration baseline + `src/0011`, `src/0057` | **EXISTS-reuse** | Has `msg_type`, `subtype`, `reply_to_id`; `saved_messages` sibling added |
| `message_requests` | pre-migration baseline | **EXISTS-reuse** | DM request gating; accepted via `POST /message-requests/:requestId/accept` |
| `user_message_settings` | pre-migration baseline | **EXISTS-reuse** | Per-user messaging privacy (who can DM); patched via `PATCH /me/message-settings` |
| `message_reports` | outer `0030_message_reports.sql` | **EXISTS-extend** | Schema: `id, message_id uuid, reporter_id→profiles, reason text (≤200), created_at, UNIQUE(message_id, reporter_id)`; RLS: reporter reads own rows; service-role writes; simple text `reason` (no enum) |
| `thread_reports` | outer `0031_thread_reports.sql` | **EXISTS-extend** | Schema: `id, thread_id text (!), reporter_id→profiles, reason text (≤200), created_at, UNIQUE(thread_id, reporter_id)`; note `thread_id` is `text` not `uuid` — shape mismatch with message_reports |
| `trips` + `trip_members` | pre-migration baseline | **EXISTS-reuse** | Core trip entity |
| `notifications` | `src/0062_notifications_schema.sql` | **EXISTS-reuse** | Full in-app notification row |
| `notification_preferences` | `src/0062_notifications_schema.sql` | **EXISTS-reuse** | Global per-user delivery toggles |
| `notification_devices` | `src/0062_notifications_schema.sql` | **EXISTS-reuse** | Expo push tokens per device (UNIQUE user+token) |
| `availability_nudges` | `src/0022_availability_nudges.sql` | **EXISTS-reuse** | Soft rate-limit for nudge interactions: UNIQUE(recipient_id, trip_id, sent_on) |
| `highlight_reports` | `src/0026_highlights.sql` | **EXISTS-extend** | Domain-scoped report; `reason text`; RLS: reporter reads own; service-role writes |
| `hidden_gem_reports` | `src/0043_hidden_gems.sql` | **EXISTS-extend** | Domain-scoped; reason enum: `inappropriate/spam/doesnt_exist/safety`; UNIQUE(gem+reporter) |
| `discovery_place_reports` | `src/0061_discovery_place_reports.sql` | **EXISTS-extend** | Domain-scoped; `reason text`; UNIQUE(place+reporter); indexes on place_id and reporter_id |
| `hashtag_reports` | `src/0044_tags_hashtags.sql` | **EXISTS-extend** | Domain-scoped; reason enum: `spam/misleading/abusive`; UNIQUE(hashtag+reporter) |
| `compass_abuse_flags` | `src/0055_compass_ux.sql` | **EXISTS-reuse** | Patterns detected by CompassAbuseDefenseEngine — Compass-scoped only; not a general moderation table |
| `compass_safety_filter_logs` | `src/0052_compass_pipeline_logs.sql` | **EXISTS-reuse** | Compass Safety Filter block events — Compass-scoped only |
| `age_limit_audit_log` | `src/0048_age_audit_log.sql` | **EXISTS-reuse** | Append-only age-gate audit; closest existing analogue to an interaction audit log, but domain-specific |

#### 1B. Tables required by the spec that do NOT exist (MISSING-build-new)

| Table | Classification | Closest existing analogue | Decision |
|-------|---------------|--------------------------|---------|
| `user_relationships` | **MISSING-build-new** | `user_follows`, `user_friendships`, `blocks` are separate edge tables; no unified graph | Build new unified relationship table with `rel_type` enum (`follow/friend/block/mute/restrict`) or keep as separate tables per Phase 2 design decision |
| `user_privacy_settings` | **MISSING-build-new** | `user_message_settings` (messaging-only); `location_preferences` (location-only); `compass_user_preferences` (feed-only) | Build new — single per-user privacy config row for who-can-tag/find/invite/see-online-status |
| `user_mutes` | **MISSING-build-new** | `message_thread_members.muted_at` is thread-scoped; `compass_user_preferences.muted_hashtags` is feed-scoped | Build new `(muter_id, muted_id)` table; global user mute (user still sees content, muter hides them) |
| `user_restrictions` | **MISSING-build-new** | `POST /admin/trust/users/:userId/restrict` in `trust-admin.ts` is admin-only, not user-initiated | Build new user-initiated restriction table; admin restrictions may share pattern but are distinct |
| `user_interaction_audit_log` | **MISSING-build-new** | `age_limit_audit_log` is domain-specific; `compass_abuse_flags` is Compass-scoped | Build new cross-domain append-only audit log for follow/block/mute/report/restrict actions |
| `moderation_actions` | **MISSING-build-new** | `trust-admin.ts` has trust review endpoints but no persistent moderation_actions table in migrations | Build new admin/moderator action log against users or content |
| `user_account_states` | **MISSING-build-new** | `profiles.verification_status` exists (outer `0027`); no suspended/banned/limited columns | Build new separate table; do NOT add columns to `profiles` — avoids SELECT * leakage |
| `user_interaction_cooldowns` | **MISSING-build-new** | `availability_nudges` is nudge-specific; no generic rate-limit table | Build new keyed on `(user_id, action_type)` |
| `user_social_consents` | **MISSING-build-new** | None | Build new — records accepted interaction terms/consents per user |
| `user_hidden_recommendations` | **MISSING-build-new** | `compass_user_preferences.ignored_item_ids` is per-item feed suppression; `user_suggestion_seen` is recency dedup | Build new durable `(user_id, hidden_user_id)` table for explicit "hide from my suggestions" |
| `reports` (unified) | **MISSING-build-new** | Six scattered domain report tables with inconsistent schemas | Build new unified `reports` table with `target_type` enum; scattered tables deprecated-in-place |
| `report_evidence` | **MISSING-build-new** | None | Build new attachment/evidence log for report supporting material |

#### 1C. Row counts

> Row counts require a live database connection. During this read-only audit, the Supabase
> database was not directly queried. The commands to obtain counts for Phase 2 verification
> (to confirm no production data was affected) are:
>
> ```sql
> SELECT 'user_follows' AS tbl, COUNT(*) FROM user_follows
> UNION ALL SELECT 'user_friendships', COUNT(*) FROM user_friendships
> UNION ALL SELECT 'blocks', COUNT(*) FROM blocks
> UNION ALL SELECT 'message_reports', COUNT(*) FROM message_reports
> UNION ALL SELECT 'thread_reports', COUNT(*) FROM thread_reports;
> ```
>
> Run this via the Supabase dashboard → SQL Editor before Phase 2 migrations are applied.

---

### Section 2 — Backend routes

#### 2A. Interaction-relevant routes — full classification

| Route file | Key interaction endpoints | Classification | Notes |
|-----------|--------------------------|---------------|-------|
| `blocks.ts` | `POST /users/:userId/block`, `DELETE /users/:userId/block`, `GET /me/blocks`, `GET /users/:userId/block-status` | **EXISTS-reuse** | Idempotent upsert; cleans up follow/friend/request edges on block; Compass cache invalidation wired |
| `follows.ts` | Follow/unfollow/status, followers/following lists, `GET /users/search`, `GET /users/suggestions`, `GET /users/:userId`, `GET /users/by-handle/:handle` | **EXISTS-reuse** | Block check embedded; suggestions have L1/L2 seen-cache; profile load is via this route |
| `friends.ts` | Full friend-request lifecycle + circle membership (invite/accept/decline/leave) | **EXISTS-reuse** | Normalised pair enforced; circle invites co-located |
| `requests.ts` | Unified incoming-requests inbox + accept/decline/cancel for all request types + `POST /trips/:tripId/remove-member` | **EXISTS-reuse** | Single aggregated endpoint for the inbox badge |
| `profile.ts` | `GET /me/profile`, `PATCH /me/profile`, `GET /users/check-username`, `POST /me/avatar/upload`, `POST /me/cover/upload`, `PUT /me/push-token` | **EXISTS-reuse** | Avatar/cover backed by Storage bucket; push token registration |
| `messaging.ts` | Full thread/message CRUD, `PATCH /threads/:threadId/mute` (thread-level mute), **`GET /users/:userId/message-permission`** (messaging-scoped permission check), thread/message report inserts, `POST /users/:userId/open-thread`, `GET /me/unread-counts`, translation retry | **EXISTS-extend** | Thread-level mute present; message-permission endpoint is messaging-scoped only (not a unified permission engine); report inserts buried here |
| `trust-admin.ts` | `GET /admin/trust/reviews`, `GET /admin/trust/users/:userId`, `POST /admin/trust/events/:eventId/confirm\|dismiss`, **`POST /admin/trust/users/:userId/restrict`**, **`POST /admin/trust/restrictions/:id/remove`**, `POST /admin/trust/users/:userId/cap/override`, `GET /admin/trust/gaming-flags`, admin trust settings | **EXISTS-extend** | Admin-only restriction endpoints exist; not user-initiated; no `user_restrictions` migration found — likely stored in an undocumented table; Phase 2 must inspect |
| `notifications.ts` | Notification CRUD, preferences, device registration, `GET /me/notifications/stream` (SSE), internal dispatch endpoints | **EXISTS-reuse** | Backed by 0062 schema |
| `preferences.ts` | `GET/PATCH /me/preferences`, `POST /me/preferences/mute-category` (category-level mute in feed), reset/events/summary | **EXISTS-reuse** | Note: `mute-category` is Compass feed category, not a user mute |
| `tags.ts` | `GET /me/tag-permission`, `PATCH /me/tag-permission`, tag suggestion/delete | **EXISTS-reuse** | `tag_permission` enum on profiles controls who can @mention the user |

#### 2B. Interaction routes that do NOT exist (MISSING-build-new)

| Capability | Classification | Notes |
|-----------|---------------|-------|
| Unified permission engine (`GET /api/permissions/check/:targetUserId`) | **MISSING-build-new** | No route returning caller's effective interaction permissions against another user (can_DM, can_follow, can_tag, is_blocked, is_muted, is_restricted). `messaging.ts` has message-specific permission only. |
| User mute routes (`POST /users/:userId/mute`, `DELETE /users/:userId/mute`, `GET /me/mutes`) | **MISSING-build-new** | Thread mute exists in messaging.ts; global user mute does not |
| User-initiated restriction routes (`POST /users/:userId/restrict`, `DELETE /users/:userId/restrict`) | **MISSING-build-new** | Admin restriction exists in trust-admin.ts; user-initiated restriction does not |
| Unified report routes (`POST /api/reports`, `GET /api/reports/:id`) | **MISSING-build-new** | Domain-specific inserts buried in messaging.ts, highlights.ts, etc.; no unified `/api/reports` resource |
| Report evidence routes | **MISSING-build-new** | No evidence attachment endpoint |
| User account state routes (suspend/ban/limit) | **MISSING-build-new** | No endpoint outside Compass abuse flags |
| Cooldown check / rate-limit enforcement endpoint | **MISSING-build-new** | No generic cooldown API |
| Social consent recording route | **MISSING-build-new** | No consent endpoint |
| Privacy settings CRUD (`GET/PATCH /me/privacy`) | **MISSING-build-new** | `user_message_settings` and `location_preferences` exist for sub-domains; no unified privacy endpoint |

---

### Section 3 — Mobile hooks

| Hook | Classification | Notes |
|------|---------------|-------|
| `useFollow.ts` | **EXISTS-reuse** | Follow/unfollow + follow status |
| `useFriends.ts` | **EXISTS-reuse** | Friend requests + circle membership |
| `useMessaging.ts` | **EXISTS-reuse** | Thread CRUD, thread-level mute |
| `useNotifications.ts` | **EXISTS-reuse** | In-app + push notifications |
| `useRequests.ts` | **EXISTS-reuse** | Unified incoming-request inbox |
| `useFollowingHighlights.ts` | **EXISTS-reuse** | Highlights feed from followed users; session-local viewed dedup |
| `useHighlightRingState.ts` | **EXISTS-reuse** | Highlight ring seen/muted state (session-local, not a user mute) |
| `useActiveLocation.ts` | **EXISTS-reuse** | Location state — not interaction-related |
| `useGroupChat.ts` | **EXISTS-reuse** | Group thread (trip/circle) chat |
| User-mute hook | **MISSING-build-new** | No `useMute.ts` or equivalent |
| User-restrict hook | **MISSING-build-new** | No `useRestrict.ts` |
| Unified report hook | **MISSING-build-new** | No `useReport.ts`; reporting is ad-hoc inside messaging/highlights screens |
| Unified permission engine hook | **MISSING-build-new** | No `useInteractionPermissions.ts` or `usePermissions.ts` |
| Privacy settings hook | **MISSING-build-new** | No `usePrivacySettings.ts` for unified privacy config |

---

### Section 4 — Mobile services

| Service | Classification | Notes |
|---------|---------------|-------|
| `follows.ts` | **EXISTS-reuse** | Full follow/unfollow/status/search/suggestions; `BlockResult`, `FollowResult` types |
| `friends.ts` | **EXISTS-reuse** | Friend requests + circle invites |
| `blocks.ts` | **EXISTS-reuse** | `BlockedUser`, `BlockStatus` types; block/unblock/list/check-status |
| `messaging.ts` | **EXISTS-reuse** | Thread CRUD + `muteThread()` (thread-level) |
| `notifications.ts` | **EXISTS-reuse** | Notification list + preferences |
| `tagging.ts` | **EXISTS-reuse** | @mention tagging |
| `requests.ts` | **EXISTS-reuse** | Requests inbox |
| `profile.ts` | **EXISTS-reuse** | Profile fetch, avatar upload |
| User-mute service | **MISSING-build-new** | — |
| Unified report service | **MISSING-build-new** | — |
| Permission service | **MISSING-build-new** | No client-side unified permission engine |
| User-restriction service | **MISSING-build-new** | — |
| Privacy settings service | **MISSING-build-new** | — |

---

### Section 5 — Mobile screens / components

| Screen / component | Path | Classification | Notes |
|-------------------|------|---------------|-------|
| Profile view | `app/u/[username].tsx` | **EXISTS-extend** | Shows follow/friend state; will need mute/restrict action menu |
| Blocked users list | `app/blocked-users.tsx` | **EXISTS-reuse** | Full block management screen; template for muted-users screen |
| Settings root | `app/settings/index.tsx` | **EXISTS-reuse** | Settings entry point |
| Location settings | `app/settings/location.tsx` | **EXISTS-reuse** | Location privacy preferences |
| Notification settings | `app/settings/notifications.tsx` | **EXISTS-reuse** | Notification preferences |
| Notifications screen | `app/notifications.tsx` | **EXISTS-reuse** | In-app notification inbox |
| Group / circle chat | `app/circle-chat.tsx`, `app/circle.tsx` | **EXISTS-reuse** | Circle chat + member view |
| Pending posts | `app/pending-posts.tsx` | **EXISTS-reuse** | Delayed-publish queue — not interaction-related |
| Muted users screen | — | **MISSING-build-new** | No `app/muted-users.tsx`; `blocked-users.tsx` is the template |
| Restricted users screen | — | **MISSING-build-new** | — |
| Report flow / bottom sheet | — | **MISSING-build-new** | No `ReportSheet` or `ReportModal` component; reporting is ad-hoc |
| Interaction permission gate component | — | **MISSING-build-new** | No `PermissionGate` or `InteractionGuard` UI component |
| Privacy settings screen (unified) | — | **MISSING-build-new** | No screen for who-can-tag/find/message beyond message-specific settings |
| Account state / suspension notice | — | **MISSING-build-new** | No UI for suspended/limited account state |

---

### Section 6 — Canonical table decisions

These are the definitive table choices Phase 2 must use. **Do not change these without updating this log.**

| Concept | Canonical table | Decision rationale |
|---------|----------------|-------------------|
| Block relationship | **`blocks`** (existing) | Reuse as-is; `is_blocked(a,b)` SECURITY DEFINER helper already present |
| Follow relationship | **`user_follows`** (existing) | Reuse as-is |
| Friend relationship | **`user_friendships` + `friend_requests`** (existing) | Reuse as-is; normalised pair enforced |
| Thread-level mute | **`message_thread_members.muted_at`** (existing) | Reuse as-is; this is thread-scope, not user-scope |
| User-level mute (global) | **`user_mutes`** (new) | Build new `(muter_id, muted_id)` table; orthogonal to thread mute |
| User restriction | **`user_restrictions`** (new, user-initiated) | Build new; admin restriction in trust-admin.ts may share pattern but is separate concern |
| Privacy configuration | **`user_privacy_settings`** (new) | Build new; do NOT merge with `user_message_settings` — scopes differ |
| Reports (unified) | **`reports`** (new) + **`report_evidence`** (new) | Build new; scattered domain tables deprecated-in-place and continue to receive writes until retired |
| Account state | **`user_account_states`** (new) | Build new separate table; do NOT add to `profiles` — avoids SELECT * leakage |
| Interaction audit | **`user_interaction_audit_log`** (new) | Build new; `age_limit_audit_log` and `compass_abuse_flags` remain domain-specific and separate |
| Cooldown / rate limit | **`user_interaction_cooldowns`** (new) | Build new generic table keyed on `(user_id, action_type)` |
| Social consent | **`user_social_consents`** (new) | Build new |
| Hidden from suggestions | **`user_hidden_recommendations`** (new) | Build new; distinct from `user_suggestion_seen` (recency dedup) — this is a durable, user-intentional hide |

---

### Section 7 — Shape conflicts found

| Conflict | Detail |
|---------|--------|
| `thread_id` type in `thread_reports` is `text` not `uuid` | Migration `outer/0031_thread_reports.sql` declares `thread_id text`. This is inconsistent with `message_reports.message_id uuid` and likely a pre-existing design choice (thread IDs may have been strings at the time). The unified `reports` table must use `uuid` for all target IDs and a `target_id_text` fallback column or a migration-time cast. |
| `reason` field: text vs enum | `message_reports` and `thread_reports` use `reason text ≤200`; `hidden_gem_reports` and `hashtag_reports` use typed enums. The unified `reports` table should use a `reason_code` enum (superset of all existing enum values) + optional `reason_detail text` freeform. |
| Thread-level mute vs. user-level mute | `message_thread_members.muted_at` is thread-scoped and must NOT be replaced by `user_mutes`. They are orthogonal: one silences a thread, the other hides a person globally. |
| Admin restriction vs. user restriction | `trust-admin.ts` has admin-initiated restriction endpoints. Phase 2 must inspect whether these write to a `user_restrictions` table (not found in migrations) or to a different store, and decide whether user-initiated `user_restrictions` should share that table or be separate. |
| Two migration directories | `artifacts/api-server/src/migrations/` and `artifacts/api-server/migrations/` contain overlapping but different sets of SQL files. Phase 2 must identify the canonical apply order and confirm which directory is active. The outer directory contains older foundational migrations (group_chat, meetups, verification_status, message/thread_reports) not present in `src/migrations/`. |
| `compass_user_preferences.ignored_item_ids` vs. `user_hidden_recommendations` | Compass feed suppression is ephemeral per-session. The new table is a durable explicit opt-out. Do not merge. |

---

### Section 8 — Out of scope / deferred

- No code changes, migrations, or SQL were written in this phase.
- Row counts require a live DB connection and are deferred to Phase 2 pre-flight.
- Phase 2 must run `SELECT table_name FROM information_schema.tables WHERE table_schema='public'` to confirm live table list matches this audit.
- Retiring the scattered domain report tables is deferred to a later phase — do not drop them in Phase 2.
- The unified permission engine endpoint design (single endpoint vs. middleware vs. per-action checks) is deferred to Phase 3 (backend routes).
- UI action components (ReportSheet, MutedUsersScreen, PermissionGate, PrivacySettingsScreen, AccountStateNotice) are deferred to Phase 4 (frontend).
- Trust score / admin restriction endpoint inspection (what table does `POST /admin/trust/users/:userId/restrict` write to?) is deferred to Phase 2 — check `artifacts/api-server/src/routes/trust-admin.ts` before writing the `user_restrictions` migration to avoid conflicts.

---

### Section 9 — Gate check

**`git diff ddf53df --name-only`** (diff from task-start checkpoint `ddf53df5`):

```
docs/INTERACTION_BUILD_LOG.md
```

**`git ls-files --others --exclude-standard`** (untracked files):

```
(empty — no untracked files outside docs/)
```

Gate: ✅ PASSED — the diff from the task-start checkpoint contains exactly one file: `docs/INTERACTION_BUILD_LOG.md`. No production files modified.

Note: `attached_assets/interaction-system-PHASED-COMMAND_1782809791365.md` is a pre-existing tracked file committed before this task's checkpoint (`ddf53df5`). It is NOT part of this task's diff.

---

### Appendix A — Complete route inventory (all 50 files)

All routes are mounted under `/api` via `app.use("/api", router)`.

| File | Routes |
|------|--------|
| `adminCompass.ts` | GET /admin/compass/dashboard, POST /admin/compass/weights, PATCH /admin/compass/weights/:id, POST /admin/compass/version, POST /admin/compass/rollback, POST /admin/compass/rebuild-cache, PATCH /admin/compass/frontload-rules, POST /admin/compass/users/:userId/remove-boost-eligibility, POST /admin/compass/users/:userId/restore-boost-eligibility, GET /admin/compass/abuse-flags, GET /admin/compass/safety-filters, GET /admin/compass/active-rewards, GET /admin/compass/testing-sandbox, POST /admin/compass/testing-sandbox/preview |
| `admin.ts` | GET /admin/geo-zones, POST /admin/geo-zones, GET /admin/geo-zones/:id, PATCH /admin/geo-zones/:id, DELETE /admin/geo-zones/:id, GET /admin/suspicious-gps, POST /admin/suspicious-gps/:id/resolve, GET /admin/venues/pending, POST /admin/venues/:id/moderate, GET /admin/venues/reported, PATCH /admin/venues/:id/status, GET /admin/geofence-settings, PATCH /admin/geofence-settings, POST /admin/geofence/:tripId/override-reveal, GET /admin/geofence/:tripId/suspicious-checkins, GET /admin/feature-flags, PATCH /admin/feature-flags/:flag, GET /admin/safe-return/logs, GET /admin/safe-return/config, PATCH /admin/safe-return/config |
| `airport.ts` | GET /airport/search, POST /airport/sessions, PATCH /airport/sessions/:id, GET /airport/sessions/:id/recommendations, GET /airport/sessions/:id/safety, POST /airport/sessions/:id/compass, POST /airport/sessions/:id/plan, POST /airport/sessions/:id/return-deadline, POST /airport/sessions/:id/telegraph, GET /airport/pulse, DELETE /airport/sessions/:id, POST/GET/PATCH/DELETE /admin/airport/profiles, GET /admin/airport/sessions, GET/POST/DELETE /admin/airport/caution-zones, GET /admin/airport/verified-places |
| `auth.ts` | POST /auth/lookup-username |
| `availability.ts` | GET/PATCH /me/availability, GET/PATCH /me/quick-availability, GET/PATCH /trips/:tripId/availability, PATCH /circles/:circleId/availability, GET /me/availability-nudges, GET /circles/:circleId/availability |
| `blocks.ts` | POST /users/:userId/block, DELETE /users/:userId/block, GET /me/blocks, GET /users/:userId/block-status |
| `circleAgeSettings.ts` | GET/PUT /circle-age-settings, GET /circle-age-settings/:ownerId |
| `compass.ts` | GET /compass/me/context, GET /compass/feed, GET /compass/feed/section/:section, GET /compass/frontload, GET /compass/preload-manifest, POST /compass/frontload/event, PUT /compass/me/boost-visibility, GET /compass/why/:recommendationId, POST /compass/ask, POST /compass/feedback, GET/PATCH /compass/me/preferences, GET /compass/me/active-reward |
| `dailyBrief.ts` | GET /trips/:tripId/daily-brief, POST /trips/:tripId/daily-brief/refresh, POST /trips/:tripId/daily-brief/actions/:actionId, POST /trips/:tripId/daily-brief/dismiss/:recommendationId |
| `discovery.ts` | GET /discovery, GET /discovery/community, POST /discovery/community, POST /discovery/community/:placeId/save, GET /discovery/community/saved-ids, POST /discovery/community/:placeId/report |
| `featureFlags.ts` | GET /feature-flags |
| `follows.ts` | POST /users/:userId/follow, DELETE /users/:userId/follow, GET /users/:userId/follow-status, GET /me/following, GET /me/followers, GET /users/search, DELETE /users/suggestions/seen, GET /users/suggestions, GET /users/:userId, GET /users/by-handle/:handle |
| `friends.ts` | POST /users/:userId/friend-request, POST /friend-requests/:requestId/accept\|decline\|cancel, GET /me/friend-requests/incoming\|outgoing, GET /me/friends, GET /circles/:circleOwnerId/members, GET /circles/:circleOwnerId/invitable-users, GET /users/:userId/friend-status, POST /circle-invites, POST /circle-invites/:inviteId/accept\|decline, DELETE /circles/:circleOwnerId/members/:memberId |
| `geofence.ts` | GET/POST /trips/:tripId/geofence, POST /trips/:tripId/geofence/reveal\|check-in, GET /trips/:tripId/geofence/attendance, POST /trips/:tripId/geofence/attendance/:userId/override |
| `groupChat.ts` | GET /trips/:tripId/chat, GET /circles/:circleId/chat, PATCH/DELETE /messages/:messageId, POST /trips/:tripId/chat/sync, POST /circles/:circleId/chat/sync |
| `hashtags.ts` | GET /hashtags/suggestions\|trending, GET /hashtags/:slug, POST/DELETE /hashtags/:slug/follow, GET /hashtags/:slug/feed, GET /me/hashtag-follows, POST /hashtags/:slug/report, GET/POST/PATCH /admin/hashtags, POST /admin/hashtags/:slug/block\|unblock\|hide-trending, POST /admin/hashtags/merge |
| `health.ts` | GET /healthz, GET /healthz/cleanup\|delayed-publish, POST /admin/cleanup/weather-cache |
| `hiddenGems.ts` | POST/GET /hidden-gems, GET /hidden-gems/saved\|layover-safe\|nearby, GET /hidden-gems/trip-city/:tripId, GET/PATCH /hidden-gems/:id, POST /hidden-gems/:id/save\|verify-visit\|report\|share-telegraph\|plan, DELETE /hidden-gems/:id/save, GET /hidden-gems/guides/:userId, POST /hidden-gems/guides/apply, GET /admin/hidden-gems/pending\|reported\|guide-applications\|sensitive-gems |
| `highlights.ts` | POST /highlights, GET /users/:userId/highlights, GET /highlights/active\|following-feed, DELETE /highlights/:id, POST /highlights/:id/view\|like\|reply\|report, DELETE /highlights/:id/like, GET /highlights/:id/viewers |
| `index.ts` | (router aggregator — no direct routes) |
| `locationPreferences.ts` | GET/PATCH /me/location-preferences |
| `location.ts` | GET/POST /me/location-state, POST /location/reverse-geocode, GET/POST /me/passport-stamps/gps, POST /location/exit-geofence |
| `meetups.ts` | POST /meetups, GET/PATCH/DELETE /meetups/:meetupId, POST /meetups/:meetupId/invites\|rsvp\|time-options\|confirm-time\|add-to-trip-plan, POST /meetups/:meetupId/time-options/:optionId/vote, GET /me/meetups\|meetup-invites\|frequent-invitees |
| `messaging.ts` | GET/PATCH /me/message-settings, GET/PATCH /me/language-settings, GET /users/:userId/message-permission, POST /users/:userId/open-thread\|message-request, GET /users/:userId/outgoing-request, GET/POST /me/message-requests, POST /message-requests/:requestId/accept\|decline\|cancel, GET /me/unread-counts, POST /me/notifications/read-all\|highlights/mark-viewed, POST /threads/:threadId/read, GET /me/threads, GET/POST /threads/:threadId/messages, POST /messages/:messageId/translate/retry, PATCH /threads/:threadId/mute, *(plus report insert endpoints for thread_reports and message_reports)* |
| `notifications.ts` | GET /me/notifications, GET /me/notifications/unread-count, POST /me/notifications/read-all, POST /me/notifications/:id/read\|dismiss, GET/PUT /me/notification-preferences, POST/DELETE /me/devices, GET /me/notifications/stream, POST /internal/notifications, POST /internal/notifications/send\|digest\|expire, POST /internal/activity-events, GET/POST/PUT /admin/notification-templates\|account-notice\|notification-defaults, GET /admin/push-retry-health\|notification-delivery-attempts |
| `passportStamps.ts` | GET /me/passport/stamps, PATCH /me/passport/stamps/:id, GET/POST /me/passport/memories, PATCH /me/passport/memories/:id, GET/POST/PATCH /me/passport/suggestions\|suggestions/:id/accept\|dismiss, GET /me/passport/map\|stats, GET/PATCH /me/passport/visibility-preferences, GET /users/:username/passport/memories\|stamps |
| `passport.ts` | GET /users/:username/passport\|passport/postcards\|profile, GET /me/passport/postcards\|stamps, PATCH /passport/postcards/:id\|postcards/:id/remove |
| `places.ts` | GET /places/search\|reverse, GET/POST /me/recent-places |
| `plan.ts` | POST /meetups/:meetupId/add-to-trip-plan, POST /places/:placeId/add-to-trip-plan |
| `posts.ts` | POST/GET /posts, GET /trips/:tripId/posts, GET /posts/pending\|:postId, PATCH /posts/:postId/location-privacy, POST /posts/:postId/publish-now-without-location\|cancel-delayed-publish\|location-event, PATCH/DELETE /posts/:postId, POST/DELETE /posts/:postId/like, GET/POST /posts/:postId/comments, DELETE /posts/:postId/comments/:commentId |
| `preferences.ts` | GET/PATCH /me/preferences, POST /me/preferences/events\|reset-learned\|mute-category, GET /me/preferences/summary |
| `profile.ts` | GET /me/profile, PATCH /me/profile, GET /users/check-username, POST /me/avatar/upload, POST /me/cover/upload, PUT /me/push-token |
| `pulse.ts` | GET /pulse |
| `rentABuddyMarketplace.ts` | POST/GET/PATCH /api/rent-a-buddy/match\|match/preferences\|sections\|available-now\|me/availability-settings\|me/available-now\|requests\|offers\|me/packages/v2, *(full marketplace CRUD)* |
| `rentABuddyRollout.ts` | Full admin rollout management: cities CRUD, beta access, QA checklists, global controls, audit log |
| `rentABuddy.ts` | POST/GET /api/rent-a-buddy/search\|buddies/:buddyId, full bookings lifecycle (search/book/pay/accept/decline/start/complete/cancel/route/stay-connected/thread) |
| `requests.ts` | GET /me/requests\|requests/count, POST /me/requests/{friend_request\|circle_invite\|trip_invite}/:id/accept\|decline\|cancel, POST /trips/:tripId/remove-member |
| `routePlan.ts` | POST /route-plans, GET/PATCH /route-plans/:id, PATCH /route-plans/:id/stops/:stopId, GET/POST/DELETE /route-plans/:id/members, DELETE /route-plans/:id |
| `safeReturn.ts` | Full safe-return session lifecycle: suggest, create, start, active, extend, confirm, cancel, missed, live-share start/stop, history, trusted-contacts, session contacts |
| `tags.ts` | GET /tags/suggestions, GET/PATCH /me/tag-permission, DELETE /tags/:id, DELETE /admin/tags/:id |
| `telegraphChat.ts` | GET /threads/:threadId/telegraph/suggestions, *(4 additional POST routes for chat actions)*, PATCH /me/telegraph-chat-settings |
| `telegraphCommands.ts` | POST /telegraph/commands, GET /telegraph/commands/:commandId, POST /telegraph/commands/:commandId/confirm-action\|decline-action, GET /trips/:tripId/telegraph/commands/history |
| `telegraphFeedback.ts` | POST /telegraph/recommendations/:id/feedback |
| `telegraphStream.ts` | GET /telegraph/stream, POST /threads/:threadId/typing |
| `telegraph.ts` | POST /telegraph/recommend |
| `tripCrewLocation.ts` | GET /trips/:tripId/crew/map\|location-preferences, PUT /trips/:tripId/crew/location-preferences, POST /trips/:tripId/crew/ghost-mode/enable\|disable, POST /trips/:tripId/crew/live-share/start\|stop, GET /trips/:tripId/crew/live-shares |
| `trips.ts` | POST /trips, GET /trips/:tripId/members\|invitable-users, GET /me/trip-invites/pending, PATCH /trips/:tripId, GET/POST /trips/:tripId/plan/items, PATCH /trips/:tripId/plan/items/:itemId\|:itemId/remove\|:itemId/reorder, DELETE /trips/:tripId/plan/items/:itemId, GET /trips/:tripId/plan-permission\|plan\|plan/map, POST /trips/:tripId/invite\|accept-invite\|decline-invite, GET /me/plan-editable-trips |
| `trust-admin.ts` | GET /admin/trust/reviews, GET /admin/trust/users/:userId, POST /admin/trust/events/:eventId/confirm\|dismiss, POST /admin/trust/users/:userId/restrict, POST /admin/trust/restrictions/:id/remove, POST /admin/trust/users/:userId/cap/override, GET /admin/trust/gaming-flags, POST /admin/trust/gaming-flags/:id/mark-reviewed, GET/PUT /admin/trust/settings\|settings/:key |

---

## Phase 2 — Data Foundation (SQL Migrations) (2026-06-30)

### Objective

Write all SQL migration files for the User Interaction System data layer.
No SQL is applied to the database — the human runs each file in the Supabase SQL Editor.

---

### Pre-flight findings

#### trust_restrictions (admin table — pre-existing, not in migrations directory)

`artifacts/api-server/src/routes/trust-admin.ts` and `TrustRestrictionService.ts` write to a
`trust_restrictions` table. This table is NOT present in any migration file in either migration
directory — it appears to have been created directly in Supabase outside the migration log.

Confirmed columns from the service code:
`id, user_id, restriction_type, reason, source_event_id, expires_at, created_at, lifted_at, lifted_by`

**Decision:** The new `user_restrictions` table (0065) is user-initiated and orthogonal.
No conflict exists. The admin `trust_restrictions` table is left as-is.

#### docs/sql/ numbering

At time of Phase 2 execution, `docs/sql/` contained two files:
- `0036_pulse_geo_tags.sql`
- `0060_discovery_places_coords.sql`

New files start at **0062** (0061 = discovery_place_reports, already in src/migrations).

---

### Migration files created

| File | Table | Action |
|------|-------|--------|
| `docs/sql/0062_user_privacy_settings.sql` | `user_privacy_settings` | CREATE new 1:1 linked table |
| `docs/sql/0063_user_account_states.sql` | `user_account_states` | CREATE new multi-row lifecycle table |
| `docs/sql/0064_user_mutes.sql` | `user_mutes` | CREATE new global per-user mute table |
| `docs/sql/0065_user_restrictions.sql` | `user_restrictions` | CREATE new user-initiated restriction table |
| `docs/sql/0066_user_interaction_audit_log.sql` | `user_interaction_audit_log` | CREATE new append-only cross-domain audit log |
| `docs/sql/0067_moderation_actions.sql` | `moderation_actions` | CREATE new admin/moderator action log |
| `docs/sql/0068_user_interaction_cooldowns.sql` | `user_interaction_cooldowns` | CREATE new generic cooldown/rate-limit table |
| `docs/sql/0069_user_social_consents.sql` | `user_social_consents` | CREATE new policy/consent version log |
| `docs/sql/0070_user_hidden_recommendations.sql` | `user_hidden_recommendations` | CREATE new durable suggestion-hide table |
| `docs/sql/0071_reports.sql` | `reports` | CREATE new unified report table |
| `docs/sql/0072_report_evidence.sql` | `report_evidence` | CREATE new report evidence attachment table |

**Note:** The six scattered domain report tables (`message_reports`, `thread_reports`,
`highlight_reports`, `hidden_gem_reports`, `discovery_place_reports`, `hashtag_reports`) are
NOT dropped — they remain active and are deprecated-in-place per Phase 1 decision.

---

### Enum types created

| Enum | File |
|------|------|
| `privacy_visibility` | 0062 |
| `travel_mode_type` | 0062 |
| `account_state` | 0063 |
| `mute_surface` | 0064 |
| `restrict_surface` | 0065 |
| `interaction_action_type` | 0066 |
| `moderation_action_type` | 0067 |
| `cooldown_type` | 0068 |
| `consent_type` | 0069 |
| `recommendation_direction` | 0070 |
| `report_target_type` | 0071 |
| `report_reason_code` | 0071 |
| `report_status` | 0071 |
| `report_severity` | 0071 |
| `evidence_type` | 0072 |

All enums use `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` for idempotency.

---

### Shape conflict resolutions

| Conflict (from Phase 1) | Resolution |
|------------------------|-----------|
| `thread_reports.thread_id` is `text` not `uuid` | `reports.context_id` is `text` to accommodate both |
| `reason` field: text vs enum across domain tables | `reports.reason_code` enum (superset) + `reason_detail text` |
| Admin restriction vs user restriction | `user_restrictions` (0065) is user-initiated only; admin `trust_restrictions` is separate and unchanged |

---

### Idempotency checklist (all files)

- Enums: `DO $$ BEGIN CREATE TYPE ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;`
- Tables: `CREATE TABLE IF NOT EXISTS`
- Indexes: `CREATE INDEX IF NOT EXISTS`
- Triggers: `DROP TRIGGER IF EXISTS` then `CREATE TRIGGER`
- Trigger functions: `CREATE OR REPLACE FUNCTION`
- RLS policies: `DROP POLICY IF EXISTS` then `CREATE POLICY`

---

### Application instructions (for each file)

1. Open Supabase dashboard → SQL Editor
2. Paste the file contents
3. Click **Run**
4. After success, paste and run the verification query at the bottom of the file
5. Confirm the expected columns are listed before proceeding to the next file

Run files in numeric order (0062 → 0072). Each file depends on `profiles` (pre-existing) and
files must be applied sequentially because `moderation_actions` (0067) references
`user_interaction_audit_log` (0066), and `reports` (0071) references `moderation_actions` (0067).

---

### Gate check

**Files changed outside `docs/`:** none — `git diff` and `git ls-files --others --exclude-standard`
show only `docs/` files modified.

Gate: ✅ PASSED


### Phase 2 — Correction: FK / nullability fix (2026-06-30)

Code review identified a blocking PostgreSQL constraint contradiction in three tables:
`ON DELETE SET NULL` cannot be used with a `NOT NULL` column — the DB raises a not-null
constraint violation at delete time instead of nulling the FK.

**Fix applied to:**
| File | Column | Before | After |
|------|--------|--------|-------|
| `0066_user_interaction_audit_log.sql` | `actor_user_id` | `uuid NOT NULL … ON DELETE SET NULL` | `uuid … ON DELETE SET NULL` (nullable) |
| `0067_moderation_actions.sql` | `admin_user_id` | `uuid NOT NULL … ON DELETE SET NULL` | `uuid … ON DELETE SET NULL` (nullable) |
| `0071_reports.sql` | `reporter_user_id` | `uuid NOT NULL … ON DELETE SET NULL` | `uuid … ON DELETE SET NULL` (nullable) |

**Semantic justification:** All three tables are audit/historical records. When a user deletes
their account the rows must be retained (for moderation continuity) with the actor/reporter
column nulled. Nullable + `ON DELETE SET NULL` is the correct PostgreSQL pattern for this.
`target_user_id` and `target_user_id` in the same tables are already correctly nullable.

---

## Phase 3 — Permission Engine (2026-06-30)

### Objective

Build the single canonical backend permission engine that every social action flows through.
Implements the priority order: deleted/banned/suspended → block → safety restriction →
age restriction → location/privacy settings → profile visibility → context → friendship →
follow → message request → discovery.

---

### Files created

| File | Purpose |
|------|---------|
| `artifacts/api-server/src/services/interactionPermissions.ts` | Core permission resolver — `resolveInteractionPermissions()` |
| `artifacts/api-server/src/routes/interactionContext.ts` | `GET /api/users/:targetUserId/interaction-context` route |
| `artifacts/api-server/src/test/interactionPermissions.test.ts` | 22 named safety tests |

### Files modified

| File | Change |
|------|--------|
| `artifacts/api-server/src/routes/index.ts` | Registered `interactionContextRouter` |

---

### Endpoint

```
GET /api/users/:targetUserId/interaction-context?sourceType=&sourceId=
```

Authentication: Bearer token (required).

Returns the full `InteractionPermissions` object — 40+ boolean capability flags, `relationshipLabel`, `profileVisibility`, `safetyWarnings[]`, `reasonCodes[]`, and `context{}`.

---

### Block-wins example response

`GET /api/users/bbbbbbbb-0000-0000-0000-000000000002/interaction-context`
(Alice has blocked Bob)

```json
{
  "targetUserId": "bbbbbbbb-0000-0000-0000-000000000002",
  "viewerId": "aaaaaaaa-0000-0000-0000-000000000001",
  "relationshipLabel": "blocked",
  "profileVisibility": "private",
  "canViewProfile": false,
  "canViewFullProfile": false,
  "canMessage": false,
  "canSendMessageRequest": false,
  "canAcceptMessageRequest": false,
  "canDeclineMessageRequest": false,
  "canAddFriend": false,
  "canAcceptFriendRequest": false,
  "canDeclineFriendRequest": false,
  "canCancelFriendRequest": false,
  "canFollow": false,
  "canUnfollow": false,
  "canSaveProfile": false,
  "canUnsaveProfile": false,
  "canInviteToEvent": false,
  "canInviteToCircle": false,
  "canInviteToTripCrew": false,
  "canTag": false,
  "canMention": false,
  "canBookBuddy": false,
  "canReview": false,
  "canMute": false,
  "canRestrict": false,
  "canBlock": false,
  "canReport": true,
  "canShareProfile": false,
  "canSeeMutuals": false,
  "canSeeAvailability": false,
  "canSeeTrips": false,
  "canSeePublicPosts": false,
  "canSeeFriendOnlyPosts": false,
  "canSeeLocationContext": false,
  "safetyWarnings": [],
  "reasonCodes": ["blocked"],
  "context": {
    "sharedTrip": false,
    "sharedCircle": false,
    "sharedEvent": false,
    "rabPreBooking": false,
    "readReceiptsHidden": false,
    "sourceType": null,
    "sourceId": null
  }
}
```

---

### Normal-pair example response

`GET /api/users/bbbbbbbb-0000-0000-0000-000000000002/interaction-context`
(Alice follows Bob — public profile, message_privacy=everyone)

```json
{
  "targetUserId": "bbbbbbbb-0000-0000-0000-000000000002",
  "viewerId": "aaaaaaaa-0000-0000-0000-000000000001",
  "relationshipLabel": "following",
  "profileVisibility": "public",
  "canViewProfile": true,
  "canViewFullProfile": true,
  "canMessage": true,
  "canSendMessageRequest": false,
  "canAcceptMessageRequest": false,
  "canDeclineMessageRequest": false,
  "canAddFriend": true,
  "canAcceptFriendRequest": false,
  "canDeclineFriendRequest": false,
  "canCancelFriendRequest": false,
  "canFollow": false,
  "canUnfollow": true,
  "canSaveProfile": true,
  "canUnsaveProfile": true,
  "canInviteToEvent": true,
  "canInviteToCircle": true,
  "canInviteToTripCrew": true,
  "canTag": true,
  "canMention": true,
  "canBookBuddy": true,
  "canReview": true,
  "canMute": true,
  "canRestrict": true,
  "canBlock": true,
  "canReport": true,
  "canShareProfile": true,
  "canSeeMutuals": true,
  "canSeeAvailability": false,
  "canSeeTrips": true,
  "canSeePublicPosts": true,
  "canSeeFriendOnlyPosts": false,
  "canSeeLocationContext": false,
  "safetyWarnings": [],
  "reasonCodes": [],
  "context": {
    "sharedTrip": false,
    "sharedCircle": false,
    "sharedEvent": false,
    "rabPreBooking": false,
    "readReceiptsHidden": false,
    "sourceType": null,
    "sourceId": null
  }
}
```

---

### 22/22 safety test raw output

```
▶ Block prevents all major social actions
  ✔ 1. block prevents message — canMessage=false (120.790504ms)
  ✔ 2. block prevents friend request — canAddFriend=false (17.048005ms)
  ✔ 3. block prevents tag — canTag=false (8.65131ms)
  ✔ 4. block prevents invite — canInviteToEvent=false, canInviteToCircle=false, canInviteToTripCrew=false (8.03652ms)
  ✔ 5. block prevents booking — canBookBuddy=false (10.722503ms)
✔ Block prevents all major social actions (196.117542ms)
▶ Unblock does NOT auto-restore friendship
  ✔ 6. unblock does NOT auto-restore friendship — canAddFriend=true, isFriend=false (38.439396ms)
✔ Unblock does NOT auto-restore friendship (48.457774ms)
▶ Stranger — message request only, not direct DM
  ✔ 7. unknown user — canSendMessageRequest=true, canMessage depends on privacy default (9.397273ms)
✔ Stranger — message request only, not direct DM (25.904186ms)
▶ Declined request cooldown
  ✔ 8. declined request creates cooldown — canSendMessageRequest=false during cooldown (11.077491ms)
✔ Declined request cooldown (16.576376ms)
▶ Nudge cooldown reported in safetyWarnings
  ✔ 9. one nudge max — safetyWarnings contains nudge_cooldown when nudge exists (35.504684ms)
✔ Nudge cooldown reported in safetyWarnings (47.610576ms)
▶ Private profile hidden from stranger
  ✔ 10. private profile hidden from stranger — canViewProfile=false (10.154324ms)
✔ Private profile hidden from stranger (18.66532ms)
▶ Friend sees friend-level profile
  ✔ 11. friend sees friend-level profile — canViewProfile=true, canSeeFriendOnlyPosts=true (9.192379ms)
✔ Friend sees friend-level profile (21.087635ms)
▶ Suspended viewer cannot interact
  ✔ 12. suspended viewer cannot interact — canMessage=false, canAddFriend=false, canFollow=false (19.229653ms)
✔ Suspended viewer cannot interact (22.300951ms)
▶ Deleted profile unavailable
  ✔ 13. deleted profile is unavailable — canViewProfile=false, profileVisibility=unavailable (14.339214ms)
✔ Deleted profile unavailable (17.624805ms)
▶ Event context: DM requires request before shared trip
  ✔ 14. event attendee cannot DM before allowed — canMessage=false, canSendMessageRequest=true (10.625277ms)
✔ Event context: DM requires request before shared trip (14.918782ms)
▶ Same event label in context
  ✔ 15. same event shows relationshipLabel=same_event or context.sharedEvent=true (13.09667ms)
✔ Same event label in context (19.172715ms)
▶ RaB pre-booking — off-app payment warning
  ✔ 16. RaB pre-booking — safetyWarnings contains rab_off_app_payment_risk (4.722099ms)
✔ RaB pre-booking — off-app payment warning (7.260278ms)
▶ Report preserves evidence — canReport always available
  ✔ 17. report preserves evidence — canReport=true for visible profiles (5.330794ms)
✔ Report preserves evidence — canReport always available (9.484955ms)
▶ Restrict hides read receipts
  ✔ 18. restrict hides read receipts — context.readReceiptsHidden=true, safetyWarnings includes read_receipts_hidden (22.8472ms)
✔ Restrict hides read receipts (33.149237ms)
▶ Tag approval required for non-friend
  ✔ 19. tag approval required — canTag=false when tag_permission=friends_only and not a friend (16.244246ms)
✔ Tag approval required for non-friend (27.257093ms)
▶ Deep link respects block and privacy
  ✔ 20. deep link respects block — canViewProfile=false even with sourceType=deep_link (23.468268ms)
✔ Deep link respects block and privacy (31.44054ms)
▶ Age restriction blocks event and circle invites
  ✔ 21. age restriction — canInviteToEvent=false, canInviteToCircle=false, reasonCodes includes age_restricted (11.396678ms)
✔ Age restriction blocks event and circle invites (18.768561ms)
▶ Admin moderation action audited
  ✔ 22. admin moderation action audited — safetyWarnings contains target_under_moderation (102.619266ms)
✔ Admin moderation action audited (140.401013ms)
ℹ tests 22
ℹ suites 18
ℹ pass 22
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1533.971315
```

Gate: ✅ PASSED — 22/22 named tests pass. Block wins over every other signal. Paid boosts never override safety.

---

### Architecture notes

- `resolveInteractionPermissions()` is a pure async function (no HTTP); the route handler is a thin wrapper.
- All Phase 2 table queries (`user_privacy_settings`, `user_account_states`, `user_mutes`, `user_restrictions`, `user_interaction_cooldowns`, `moderation_actions`) are wrapped in `safeQuery()` helpers that fail-open (`null` / `false` / `[]`) if the table doesn't exist yet in the live DB.
- Block check runs before any profile lookup — no profile data leaks to blocked users.
- The fake client test pattern uses `_setTestClient(client, true)` (ready=true flag) per the admin-route-test-pattern memory entry.
- `or()` in the fake client uses depth-tracking to split only top-level commas, handling UUID values that contain hyphens without false splits.


---

## Phase 3 — Code Review Corrections (2026-06-30)

Three issues raised by code review were addressed. All 22 tests still pass.

### Changes from code review

| Issue | Fix |
|-------|-----|
| **Test #7 under-assertive** | Added `message_privacy: 'friends'` to Dave's fixture. Test now asserts `canMessage=false` + `canSendMessageRequest=true`, proving strangers cannot DM directly when target requires friends-only messaging. |
| **Nudge cooldown broken ternary** | Removed `"sender_id" in {} ? "sender_id" : "trip_id"` (always resolved to `trip_id`). Replaced with `user_interaction_cooldowns` table query using `cooldown_type='nudge'` — a deterministic per-viewer per-target gate. Test #9 fixture updated accordingly and now asserts `safetyWarnings.includes("nudge_cooldown")`. |
| **Fail-open on critical safety checks** | Block query (`critList`) and trust-restriction query now use fail-CLOSED error handling: any DB error is re-thrown so the route handler returns 500 rather than silently allowing the interaction. Phase 2 optional tables (`user_account_states`, `user_privacy_settings`, etc.) use `optQuery` which only silences "table does not exist" errors. |

Gate: ✅ PASSED — 22/22 named tests pass. Typecheck clean.


---

## Phase 4 — Core Actions (backend) (2026-06-30)

**Objective:** Implement all core social-action endpoints, routing every write through the Phase 3 permission engine (`resolveInteractionPermissions`). All actions are block-aware and anti-retaliation-hardened.

### New files

| File | Purpose |
|------|---------|
| `src/migrations/0063_interaction_foundation.sql` | Creates Phase 4 tables: `user_interaction_cooldowns`, `user_mutes`, `user_restrictions`, `reports`, `user_saves`, `moderation_actions`, `user_account_states`, `user_privacy_settings`. All have RLS enabled. |
| `src/routes/mutes.ts` | POST/DELETE `/users/:id/mute`, GET `/me/mutes`, GET `/users/:id/mute-status`. Private mute (user never notified). Permission-engine gate: `canMute=false` when either party has blocked the other. |
| `src/routes/saves.ts` | POST/DELETE `/users/:id/save`, GET `/me/saves`, GET `/users/:id/save-status`. Private bookmark: grants no access to private content. Permission-engine gate: `canSaveProfile=false` when blocked. |
| `src/routes/reports.ts` | POST `/reports`, GET `/reports/:id`. Unified cross-domain report table. High-severity user reports (`harassment`, `hate_speech`, `violence`) auto-restrict the target and write 90-day anti-retaliation cooldowns for `message_request` + `friend_request`. |
| `src/test/coreActions.test.ts` | 13-test suite: block app-wide ×3, mute ×3, save ×3, report ×2, anti-retaliation cooldown ×1, blocked-save ×1. |

### Modified files

| File | Change |
|------|--------|
| `src/routes/friends.ts` | Added `resolveInteractionPermissions` gate in `POST /users/:id/friend-request` (fail-closed block check). Added 24-hour anti-retaliation `friend_request` cooldown write on `POST /friend-requests/:id/decline`. |
| `src/routes/blocks.ts` | Fixed `friend_requests` cleanup query (was using wrong columns `from_user`/`to_user` → now correct `requester_id`/`recipient_id`). Added `message_requests` cancellation (both directions) on block. Added 90-day anti-retaliation cooldowns for `message_request`, `friend_request`, `follow`. |
| `src/routes/follows.ts` | Replaced direct block check + `decideFollow()` with `resolveInteractionPermissions` call. Handles: blocked→403, already-following→200 idempotent (via `canUnfollow`), suspended→403. |
| `src/routes/index.ts` | Registered `mutesRouter`, `savesRouter`, `reportsRouter`. |
| `src/services/interactionPermissions.ts` | Added `friend_request` cooldown query to the Phase 3 permission engine's parallel fetch batch. `canAddFriend` now also checks `friendReqCooldownActive`, making anti-retaliation cooldowns enforceable across all friend-request entry points. |

### Permission engine coverage

All 5 social-action endpoints now route through `resolveInteractionPermissions`:

| Endpoint | Capability checked |
|----------|--------------------|
| `POST /users/:id/follow` | `canFollow` / `canUnfollow` (idempotent) |
| `POST /users/:id/friend-request` | `canAddFriend` |
| `POST /users/:id/mute` | `canMute` |
| `POST /users/:id/save` | `canSaveProfile` |
| `POST /reports` | `canReport` (user reports only) |

### Anti-retaliation cooldown summary

| Trigger | Cooldown written | Duration |
|---------|-----------------|---------|
| Friend request declined | `friend_request` | 24 hours |
| User blocked | `message_request` + `friend_request` + `follow` | 90 days |
| High-severity report | `message_request` + `friend_request` (on target → reporter) | 90 days |

### Gate

✅ PASSED — 13/13 Phase 4 tests pass. 22/22 Phase 3 tests still pass. Typecheck clean.

```
node --import tsx/esm --test src/test/coreActions.test.ts
ℹ tests 13
ℹ pass 13
ℹ fail 0
```

---

## Phase 4 — Code Review Corrections (2026-06-30)

Three critical issues identified in code review were addressed. All 35 tests (22 Phase 3 + 13 Phase 4) still pass.

### Changes from code review

| Issue | Fix |
|-------|-----|
| **Reporter-protection restrict row was inverted** | `user_restrictions` upsert in `reports.ts` had `restrictor_id: target_id, restricted_id: user.id`. The permission engine queries `restrictor_id=targetUserId, restricted_id=viewerId` to check if target restricts the viewer. For Bob (future viewer) to be blocked from contacting Alice (reporter), the row must be `restrictor_id=Alice (reporter), restricted_id=Bob (reported)`. Fixed to `{ restrictor_id: user.id, restricted_id: target_id }`. |
| **Permission engine missing on block + unfollow endpoints** | Added `resolveInteractionPermissions` gate to `POST /users/:id/block` (suspension check via `canBlock`) and `DELETE /users/:id/follow` (idempotent unfollow when `canUnfollow=false` means not currently following). |
| **Permission engine missing on friend-request mutations** | Added `resolveInteractionPermissions` checks to accept (`canAcceptFriendRequest`), decline (`canDeclineFriendRequest`), and cancel (`canCancelFriendRequest`) — prevents suspended users from performing these mutations. |

### Endpoints now fully gated by permission engine

| Endpoint | Capability |
|----------|-----------|
| `POST /users/:id/block` | `canBlock` |
| `DELETE /users/:id/follow` | `canUnfollow` (idempotent when false) |
| `POST /users/:id/follow` | `canFollow` / `canUnfollow` |
| `POST /users/:id/friend-request` | `canAddFriend` |
| `POST /friend-requests/:id/accept` | `canAcceptFriendRequest` |
| `POST /friend-requests/:id/decline` | `canDeclineFriendRequest` |
| `POST /friend-requests/:id/cancel` | `canCancelFriendRequest` |
| `POST /users/:id/mute` | `canMute` |
| `POST /users/:id/save` | `canSaveProfile` |
| `POST /reports` | `canReport` |

Gate: ✅ PASSED — 13/13 Phase 4 tests pass. 22/22 Phase 3 tests pass. Typecheck clean.

---

## Phase 4 — Second Code Review Pass (2026-06-30)

Code review identified six additional requirements. All 41 tests (22 Phase 3 + 19 Phase 4) pass.

### Changes

| Item | Fix |
|------|-----|
| **Missing restrict endpoint** | Created `routes/restrict.ts` — `POST/DELETE /users/:id/restrict`, `GET /me/restrictions`, `GET /users/:id/restrict-status`. Gated by `canRestrict` from the permission engine. Registered in `routes/index.ts`. |
| **messaging.ts write actions ungated** | `POST /users/:userId/open-thread` — replaced `canMessage()` helper call with `resolveInteractionPermissions` check on `perms.canMessage`/`perms.canSendMessageRequest`. `POST /users/:userId/message-request` — added engine gate: `!canMessage && !canSendMessageRequest` → 403. Added `resolveInteractionPermissions` import. |
| **requests.ts friend_request mutations ungated** | Added `resolveInteractionPermissions` import + engine gate to `POST /me/requests/friend_request/:id/accept` (`canAcceptFriendRequest`), `/decline` (`canDeclineFriendRequest`), `/cancel` (`canCancelFriendRequest`). Widened `select()` columns to include the counterparty id needed by the engine. |
| **DELETE /users/:id/follow fail-open** | Changed `catch {}` fail-open to fail-closed: `sendError(res, "db_error", "Permission check failed"); return;` |
| **Mute idempotency** | `POST /users/:id/mute` now queries for an existing mute row first. If row exists, skips the engine `canMute` check and goes straight to upsert (updating types). New mutes still gate on `canMute`. This fixes `canMute = !isMuted` blocking type updates. |
| **Block-app-wide test coverage** | Extended `coreActions.test.ts` from 13 → 19 tests. New tests: blocked message-request (403), restrict CRUD, blocked restrict (403), mute-type update idempotency, and blocked `requests.ts` friend-request accept (403). |

### Endpoint permission engine coverage (complete)

| Endpoint | Capability |
|----------|-----------|
| `POST /users/:id/follow` | `canFollow` |
| `DELETE /users/:id/follow` | `canUnfollow` (fail-closed) |
| `POST /users/:id/friend-request` | `canAddFriend` |
| `POST /friend-requests/:id/accept` | `canAcceptFriendRequest` |
| `POST /friend-requests/:id/decline` | `canDeclineFriendRequest` |
| `POST /friend-requests/:id/cancel` | `canCancelFriendRequest` |
| `POST /users/:id/block` | `canBlock` |
| `POST /users/:id/mute` | `canMute` (new mutes) |
| `POST /users/:id/save` | `canSaveProfile` |
| `POST /users/:id/restrict` | `canRestrict` |
| `POST /reports` | `canReport` |
| `POST /users/:id/open-thread` | `canMessage` / `canSendMessageRequest` |
| `POST /users/:id/message-request` | `canMessage || canSendMessageRequest` |
| `POST /me/requests/friend_request/:id/accept` | `canAcceptFriendRequest` |
| `POST /me/requests/friend_request/:id/decline` | `canDeclineFriendRequest` |
| `POST /me/requests/friend_request/:id/cancel` | `canCancelFriendRequest` |

Gate: ✅ PASSED — 19/19 Phase 4 tests pass. 22/22 Phase 3 tests pass. Typecheck clean.

---

## Phase 5 — Interaction UI System (hooks + components)

**Date:** 2026-06-30  
**Typecheck:** ✅ PASSED — clean, zero errors

### Hooks delivered (10)

| Hook | File | Purpose |
|------|------|---------|
| `useUserInteractionContext` | `src/hooks/useUserInteractionContext.ts` | Fetches `GET /api/users/:id/interaction-context` |
| `useProfileActions` | `src/hooks/useProfileActions.ts` | Derives available actions from permissions |
| `useRelationshipLabel` | `src/hooks/useRelationshipLabel.ts` | Human-readable label for relationship state |
| `useCanMessageUser` | `src/hooks/useCanMessageUser.ts` | Boolean + reason for messaging eligibility |
| `useBlockUser` | `src/hooks/useBlockUser.ts` | Block / unblock with optimistic state |
| `useReportUser` | `src/hooks/useReportUser.ts` | Submit abuse reports |
| `useMuteUser` | `src/hooks/useMuteUser.ts` | Mute / unmute a user |
| `useRestrictUser` | `src/hooks/useRestrictUser.ts` | Restrict / unrestrict a user |
| `useFriendRequestActions` | `src/hooks/useFriendRequestActions.ts` | Re-exports `useFriendStatus` |
| `useFollowActions` | `src/hooks/useFollowActions.ts` | Re-exports `useFollow` |
| `useSavedProfileActions` | `src/hooks/useSavedProfileActions.ts` | Save / unsave a profile |

### Components delivered (13 + 1 barrel)

| Component | File |
|-----------|------|
| `RelationshipBadge` | `src/components/interaction/RelationshipBadge.tsx` |
| `KnownFromRow` | `src/components/interaction/KnownFromRow.tsx` |
| `UserAvatarButton` | `src/components/interaction/UserAvatarButton.tsx` |
| `UserNameButton` | `src/components/interaction/UserNameButton.tsx` |
| `BlockUserConfirmSheet` | `src/components/interaction/BlockUserConfirmSheet.tsx` |
| `ReportUserSheet` | `src/components/interaction/ReportUserSheet.tsx` |
| `RestrictUserSheet` | `src/components/interaction/RestrictUserSheet.tsx` |
| `MuteUserSheet` | `src/components/interaction/MuteUserSheet.tsx` |
| `UserOverflowMenu` | `src/components/interaction/UserOverflowMenu.tsx` |
| `ProfileActionBar` | `src/components/interaction/ProfileActionBar.tsx` |
| `MessageRequestCard` | `src/components/interaction/MessageRequestCard.tsx` |
| `UserMiniProfileCard` | `src/components/interaction/UserMiniProfileCard.tsx` |
| `SocialSafetyControlsScreen` | `src/components/interaction/SocialSafetyControlsScreen.tsx` |
| barrel | `src/components/interaction/index.ts` |

### Routes wired

- `app/settings/safety.tsx` — Safety & Privacy screen (linked from Settings → Safety)
- `app/muted-users.tsx` — Muted accounts list (with inline unmute)
- `app/restricted-users.tsx` — Restricted accounts list (with inline unrestrict)

### Services added

- `src/services/interactionContext.ts`
- `src/services/mutes.ts`
- `src/services/saves.ts`
- `src/services/restrict.ts`
- `src/services/reports.ts`

### Fixes applied

- Unescaped apostrophes in `RestrictUserSheet.tsx` string literals converted to double-quoted strings
- `run()` helper in `ProfileActionBar` and `UserMiniProfileCard` typed as `() => Promise<any> | undefined` to accept optional-chained callbacks

Gate: ✅ PASSED — all 10 hooks + 13 components + 1 barrel. Typecheck clean.
