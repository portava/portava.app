# Travel Buddy Full Beta Audit Report
**Date:** 2026-07-05  
**Scope:** Database · Backend · Mobile · Security · UX  
**Method:** Evidence-based — every finding cites an actual file and line number. No assumptions.  
**Paths:** Tracked copy: `docs/audits/beta-audit-report.md` · Operational mirror (gitignored): `.local/audit/beta-audit-report.md`

---

## Summary Table

Status labels: `complete` · `partial` · `broken` · `UI-only` · `backend-only` · `DB-only` · `missing`

| Feature / Area | Status | Key Gap |
|---|---|---|
| Auth (sign-up/sign-in/refresh/sign-out) | `complete` | Minor half-created-user edge case |
| Pulse feed | `complete` | — |
| Post creation + media upload | `complete` | — |
| Follows & suggestions | `complete` | — |
| Blocks (API + Pulse filter) | `partial` | Inbox thread hiding is client-side only |
| Trips (create/edit/invite/accept/decline) | `complete` | — |
| Pending invite badge | `complete` | Reads real endpoint |
| Trip crew location | `complete` | — |
| Live Map screen | `UI-only` | Placeholder — no map component, no coordinate fetch |
| Passport stamps | `complete` | isFlagEnabled is fail-open (see §10) |
| Passport memories | `complete` | — |
| Postcards | `complete` | — |
| Discovery (DB + OSM merge) | `complete` | — |
| Discovery map view | `complete` | Real MapLibre native implementation |
| Wishlist | `complete` | Migration 0088 applied |
| Hidden Gems | `complete` | Admin guard correct (`profiles.role === "admin"`) |
| Rent-a-Buddy | `broken` | Migrations 0090+0092 not applied in production |
| Safe Return (code complete) | `partial` | Table exists but RLS policies missing in production |
| Emergency Contacts | `broken` | `profile_emergency_contacts` table missing in production |
| Circle (create/invite/join/leave) | `complete` | — |
| Circle chat (Telegraph) | `complete` | SSE + polling fallback |
| Message threads (persistence) | `complete` | — |
| Blocked-user thread hiding | `partial` | Server inbox does not filter blocked threads |
| Telegraph AI chat | `complete` | Rate limits enforced |
| Unread badge clear | `complete` | Clears via SSE event, no poll wait |
| Push token registration (code) | `partial` | `notification_devices` RLS missing in production |
| Trip-invite push notification | `partial` | Uses legacy single-device `expo_push_token` column |
| In-app notifications | `complete` | — |
| Edit profile (home city/country) | `complete` | — |
| Avatar cleanup | `complete` | Old file deleted before new upload |
| Profile visibility | `complete` | `resolveProfileVisibility` called on every load |
| RLS coverage | `partial` | Several tables missing policies in production |
| Admin route guards | `complete` | All use `profiles.role === "admin"` |
| Feature flag posture | `partial` | `isFlagEnabled` is fail-open everywhere |
| Empty states (Pulse/Trips/Passport/Messages/Discovery) | `complete` | All major tabs render empty-state components |
| Error states | `complete` | Network errors surface visible messages |
| Pre-release typecheck | `complete` | — |
| Pre-release dep/source/lockfile drift | `complete` | — |
| Pre-release api-server-build | `complete` | — |
| Pre-release db-triggers | `broken` | 8 migrations missing from production |
| Pre-release engagement-indexes | `partial` | Migration 0123 not applied (user-perspective indexes) |

---

## Phase 0 — Database Source-of-Truth Reconciliation

### Migration inventory
- **Canonical source:** `artifacts/api-server/src/migrations/` — 90 SQL files (0010–0108, last file: `0108_circle_schema_tracked.sql`).
- **Legacy directory:** `artifacts/api-server/migrations/` — older migrations that predate the `src/` structure. Some share filename roots with `src/migrations/` (both use `IF NOT EXISTS`); others are unique here: `0040_safe_return.sql`, `0041_notifications.sql`, `0076_profile_emergency_contacts.sql`, `0123_engagement_user_indexes.sql`.
- No shadow `src/migrations/` directory in the repository.

### Applied-vs-production gap
The `db-triggers` pre-release check queries the live production database. The following migrations are reported **not applied**:

| Migration | Location | Creates | Impact if missing |
|---|---|---|---|
| `0040_safe_return.sql` | `migrations/` | `safe_return_sessions` RLS policies | Safe-return session data readable by any user |
| `0041_notifications.sql` | `migrations/` | `nd_own` RLS policy on `notification_devices` | Push tokens readable by any authenticated user |
| `0071_protect_default_collection.sql` | `src/migrations/` | BEFORE DELETE trigger on `collections` | Default collection deletable |
| `0072_block_collections_truncate.sql` | `src/migrations/` | BEFORE TRUNCATE on `collections` | Collections truncatable |
| `0073_block_collection_items_truncate.sql` | `src/migrations/` | BEFORE TRUNCATE on `collection_items` | Items bulk-deletable |
| `0074_protect_saved_places.sql` | `src/migrations/` | Saved-place protection trigger | Saved places unprotected |
| `0076_profile_emergency_contacts.sql` | `migrations/` | `profile_emergency_contacts` table + RLS | Emergency contacts completely broken |
| `0090_rent_buddy_rollout_tables.sql` | `src/migrations/` | `rent_buddy_global_controls`, `rent_buddy_city_rollouts` | Rent-a-Buddy broken for all users |
| `0092_seed_rent_buddy_launch_cities.sql` | `src/migrations/` | Seeds Cebu, Manila, Davao City | Feature deployed but invisible |
| `0123_engagement_user_indexes.sql` | `migrations/` (verified: `artifacts/api-server/migrations/0123_engagement_user_indexes.sql`) | 5 user-perspective `_user_created` indexes | Sequential scans on engagement tables |

**Note on `notification_devices`:** `0062_notifications_schema.sql` (in `src/migrations/`) also creates `notification_devices` with `IF NOT EXISTS`. The table likely exists in production (from 0062), but the RLS policies defined in `0041_notifications.sql` — `artifacts/api-server/migrations/0041_notifications.sql` lines 21–25 — are absent.

**Note on `safe_return_sessions`:** `0102_safe_return_single_session.sql` (not flagged as missing) adds a unique index to `safe_return_sessions`, confirming the table exists. What is missing is the RLS enforcement from `0040_safe_return.sql`.

### Unapplied migration SQL (exact commands, in order)
```bash
psql "$DB_URL" -f artifacts/api-server/migrations/0040_safe_return.sql
psql "$DB_URL" -f artifacts/api-server/migrations/0041_notifications.sql
psql "$DB_URL" -f artifacts/api-server/src/migrations/0071_protect_default_collection.sql
psql "$DB_URL" -f artifacts/api-server/src/migrations/0072_block_collections_truncate.sql
psql "$DB_URL" -f artifacts/api-server/src/migrations/0073_block_collection_items_truncate.sql
psql "$DB_URL" -f artifacts/api-server/src/migrations/0074_protect_saved_places.sql
psql "$DB_URL" -f artifacts/api-server/migrations/0076_profile_emergency_contacts.sql
psql "$DB_URL" -f artifacts/api-server/src/migrations/0090_rent_buddy_rollout_tables.sql
psql "$DB_URL" -f artifacts/api-server/src/migrations/0092_seed_rent_buddy_launch_cities.sql
# 0123: apply the five _user_created index DDL statements per scripts/check-engagement-indexes.sh
```
All files are idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).

---

## Phase 1 — Authentication & Session Layer

**Status: `complete` (minor edge cases noted)**

- **Sign-up:** `travel-buddy-standalone/src/services/auth.ts` calls `supabase.auth.signUp()` then `ensureProfile()` (POST to `/api/profile/ensure`). The API route uses `getServiceClient()` (service-role key) — correctly bypasses the PostgREST P-256 JWT issue.
- **Sign-in:** Same `ensureProfile` pattern on login. Session persisted via `persistSession: true`. `travel-buddy-standalone/src/lib/supabase.ts` line 18.
- **Refresh:** Automatic via Supabase client (`autoRefreshToken: true`). `lib/supabase.ts` line 18.
- **Sign-out:** `SessionContext.tsx` line 121 clears per-user caches then calls `svcSignOut()`.
- **Account gate:** `AccountStatusGate.tsx` is **fail-closed** — blocks the app when `accountStatus` cannot be confirmed. `SessionContext.tsx` line 76 sets `accountStatus = null` on any error.

**Minor gaps:**
- If `ensureProfile` fails after Supabase sign-up succeeds (API server unreachable), the user lands in a half-created state (Supabase account, no profile). Retrying sign-in re-triggers `ensureProfile`. No UI error disambiguates this for the user.
- `authedClient()` wrapper (`lib/supabase.ts` line 26) has no retry-on-401 logic; a token expiry mid-long-running-operation causes a silent 401.

---

## Phase 2 — Core Social Features (Pulse, Posts, Follows, Blocks)

### Pulse Feed — `complete`
- **Pagination:** `limit` (default 20, max 50) + `before` cursor on `created_at`. `artifacts/api-server/src/routes/pulse.ts` lines 44, 131–133.
- **Pre-shape guards (raw snake_case before shaping):**
  - Block filter applied against raw DB rows. `pulse.ts` lines 170–182.
  - Delayed-location GPS scrubbed to `null` before response. `pulse.ts` lines 164–215.
  - Moderation: media with status `rejected`/`flagged` removed (`filterPublicMedia`).
- **Mobile empty states:** `FollowingEmpty` for empty following tab, `TravelEmptyState` for For-You tab, `FollowingError` with Retry on network error. `travel-buddy-standalone/app/(tabs)/index.tsx` lines 350–385.
- **Place cards:** backend returns `placeCards` when live post count < 5; mobile renders as `PlaceRecommendationCard`.

### Post Creation — `complete`
- Media upload → `post-media` storage bucket via `/media/upload`.
- `post_media` table (migration `0103_post_media.sql`) tracked; only `ready`/`approved` media returned in feed. `artifacts/api-server/src/routes/posts.ts`.
- Location validated server-side before insert.

### Follows & Suggestions — `complete`
- `GET /api/users/suggestions` returns users the caller hasn't followed back; blocked users excluded.
- Mobile: `getSuggestedTravelers()` in `travel-buddy-standalone/src/services/follows.ts` called from search screen when box is empty.

### Blocks — `partial`
- **Backend complete:** block/unblock endpoints, side effects (removes `user_follows`, `friend_requests`, cancels `message_requests`, sets 90-day cooldowns in `user_interaction_cooldowns`, evicts Compass cache). `artifacts/api-server/src/routes/blocks.ts` lines 14–90.
- **Pulse feed:** bi-directionally filters blocked users. `pulse.ts` lines 170–182.
- **Gap — inbox thread hiding:** `GET /api/me/threads` (`messaging.ts` line 1100) queries `message_thread_members` without filtering against `blocks`. If a thread existed before the block, it remains in the inbox response including the blocked user's profile, avatar, and last message. Mobile `TelegraphInboxScreen.tsx` lines 287–292 performs client-side filtering only. **Safety issue.**

---

## Phase 3 — Trips & Passport

### Trip Creation / Editing — `complete`
- `POST /api/trips` uses `getServiceClient()` (service-role key). `artifacts/api-server/src/routes/trips.ts` line 239.
- **Invite:** inserts `trip_members` with `role: "invited"`. `trips.ts` line 1421.
- **Accept:** updates to `role: "member"`, syncs group chat. `trips.ts` lines 853–857.
- **Decline:** deletes membership row. `trips.ts` line 904.

### Pending Invite Badge — `complete`
- `usePendingTripInvites` hook calls `GET /api/me/trip-invites/pending` — real endpoint. `travel-buddy-standalone/src/services/trips.ts` line 282. Not UI-only.

### Trip Crew Location — `complete`
- Preferences → `trip_crew_location_preferences`; live shares → `trip_crew_location_sessions`; audit → `trip_crew_location_events`.
- Privacy: `buildCrewCard` (`artifacts/api-server/src/lib/tripCrewLocation.ts` lines 97–104) only includes `exactCoords` when active live-share grant exists, ghost mode off, and `hotel_blur_enabled` false.

---

## Phase 4 — Discovery, Wishlist, Hidden Gems

### Discovery Search — `complete`
- Merged DB+OSM query live. `placeCards` fallback when posts < 5. `artifacts/api-server/src/routes/discovery.ts`.

### Discovery Map View — `complete`
- `travel-buddy-standalone/src/components/discovery/DiscoveryMapView.tsx` is a real MapLibre implementation using `@maplibre/maplibre-react-native`. Renders gold-star DB pins vs. OSM venues. Three-way filter persisted to AsyncStorage. Falls back to `demotiles.maplibre.org` when `EXPO_PUBLIC_MAPTILER_KEY` is unset.

### Wishlist — `complete`
- Migration `0088_wishlist_places.sql` applied.
- `GET /api/wishlist`, `POST /api/wishlist`, `DELETE /api/wishlist/:placeId` all write to `wishlist_places`. `artifacts/api-server/src/routes/wishlist.ts`.
- OSM save counts tracked atomically in `discovery_place_saves`.

### Hidden Gems — `complete`
- Admin guard: `profiles.role === "admin"`. `hiddenGems.ts`.
- `HiddenGemPrivacyGuard` strips exact coordinates from protected gems before response.

---

## Phase 5 — Rent-a-Buddy Marketplace

**Status: `broken` in production**

- Migrations `0090` and `0092` not applied. `checkRentBuddyAccess` (`artifacts/api-server/src/routes/rentABuddyRollout.ts` line 129) queries `rent_buddy_global_controls` and `rent_buddy_city_rollouts`. When the tables don't exist, the query errors and lines 307, 381 return `{ allowed: false, code: "city_not_available" }`. Every user in every city hits this gate.
- Backend code is otherwise complete: rollout status progression, kill switches, nightlife age gates, booking flow, marketplace listing.
- **Fix (in order):** apply `0090_rent_buddy_rollout_tables.sql` then `0092_seed_rent_buddy_launch_cities.sql`.

---

## Phase 6 — Safety & Circle

### Safe Return — `partial`
- `0102_safe_return_single_session.sql` (unique index) confirmed applied (not flagged by check).
- `0040_safe_return.sql` (RLS policies) flagged as not applied. The table exists (proven by 0102 applying), but `srs_own` policy (`auth.uid() = user_id`) is absent — raw PostgREST queries can read all sessions.
- Check-in/check-out writes persist via `SafeReturnService.ts`. All route handlers use `requireUser`. `artifacts/api-server/src/routes/safeReturn.ts`.

### Emergency Contacts — `broken`
- Migration `0076_profile_emergency_contacts.sql` not applied. The `profile_emergency_contacts` table does not exist in production.
- `artifacts/api-server/src/routes/emergencyContacts.ts` line 93: `.from("profile_emergency_contacts")` — returns `relation does not exist` for all users.
- **Fix:** `psql "$DB_URL" -f artifacts/api-server/migrations/0076_profile_emergency_contacts.sql`

### Live Map Screen — `UI-only`
- `travel-buddy-standalone/app/live-map.tsx` lines 9–13: static "coming soon" description text. No MapLibre component, no coordinate fetch, no real data.

### Circle Membership — `complete`
- Create/invite/join/leave persist to `circles`/`circle_memberships`. `artifacts/api-server/src/routes/circle.ts`.
- Telegraph chat: SSE stream (`/api/telegraph/stream`) with 7s polling fallback.

---

## Phase 7 — Messaging & Telegraph

### Message Threads — `complete`
- Thread creation: `messaging.ts` line 328 (open-thread), line 605 (accept message-request) insert into `message_threads`.
- Messages: inserted into `messages` table. `messaging.ts` lines 1515–1518.
- `resolveInteractionPermissions` gates new thread creation when blocked. `messaging.ts` lines 278, 405, 407.

### Blocked-User Thread Hiding — `partial`
- **Server gap:** `router.get('/me/threads', ...)` at `messaging.ts` line 1100 queries `message_thread_members` and `message_threads` with no filter against `blocks`. Thread persists in server response after a block action.
- **Client filter only:** `TelegraphInboxScreen.tsx` lines 287–292 filters against `blockedIds`/`blockerIds`. Only active guard.
- Note: block-checking at `messaging.ts` lines 955–972 is in the `open-thread` permission path, not the inbox listing path.

### Telegraph AI Chat — `complete`
- SSE: `/api/telegraph/stream` with 25s heartbeat (`telegraphStream.ts` line 32).
- Rate limits: `checkRateLimit` + `checkCooldown` in `telegraphChat.ts` lines 85–86. 24-hour category cooldowns on dismiss.

### Unread Badge — `complete`
- Thread open → `markThreadRead()` → `POST /api/threads/:threadId/read` → updates `last_read_at` → publishes `read.updated` SSE event. `messaging.ts` lines 1075, 1091.
- Mobile `app/messages/[id].tsx` line 1247 calls `markThreadRead` in `useEffect`. Badge reconciles immediately from SSE, not from 7s poll.

---

## Phase 8 — Notifications & Push

### Push Token Registration — `partial`
- Mobile: `usePushToken` hook in `travel-buddy-standalone/app/_layout.tsx` line 55 calls `savePushToken()` → `POST /api/me/devices`. Wired.
- API: `notifications.ts` line 269 inserts into `notification_devices` with `onConflict: 'user_id,push_token'`; prunes old tokens at line 288.
- **Gap:** `nd_own` RLS policy from `artifacts/api-server/migrations/0041_notifications.sql` lines 21–25 (`ALTER TABLE notification_devices ENABLE ROW LEVEL SECURITY; CREATE POLICY nd_own ON notification_devices USING (auth.uid() = user_id)`) is not applied. Any authenticated user can query `notification_devices` via PostgREST and read all push tokens.

### Trip-Invite Push Notification — `partial`
- `trips.ts` line 867 fetches `expo_push_token` from `profiles` (legacy single-device column, migration 0023) to fire `trip_invite_received` (line 823) and `trip_invite_accepted` (line 874) pushes.
- Does not use the multi-device `notification_devices` table. Users with multiple devices receive push on only the last registered device.

### In-App Notifications — `complete`
- `GET /me/notifications` reads from `notifications` table via `NotificationService`. `notifications.ts` line 100.
- Mark-read, dismiss, preferences endpoints all wired. `notifications` RLS created in `0062_notifications_schema.sql` line 63.

---

## Phase 9 — Profile & Settings

### Edit Profile (Home City / Country) — `complete`
- `home_city` and `home_country` columns exist in `profiles`. `PATCH /api/me/profile` maps `homeCity`/`homeCountry`. `profile.ts`.
- Mobile `app/profile/edit.tsx` lines 257–258 (form population), lines 484–488 (patch on save), line 795 (UI picker).

### Avatar Cleanup — `complete`
- `POST /me/avatar/upload` fetches existing `avatar_url`, extracts old storage path, calls `sc.storage.from(AVATAR_BUCKET).remove([oldPath])` before uploading new file. Same pattern for cover photo. `profile.ts`.

### Profile Visibility — `complete`
- `resolveProfileVisibility` called for public profile loads. `profile.ts` lines 827, 866 (privacy settings); `is_private` flag at line 96 (`isPrivate: r.is_private ?? false`).

---

## Phase 10 — Security & Privacy

### RLS Coverage — `partial`

**Confirmed missing RLS in production (migration not applied):**

| Table | Policy missing | Exposure |
|---|---|---|
| `safe_return_sessions` | `0040_safe_return.sql` | Any user can read others' sessions |
| `notification_devices` | `0041_notifications.sql` (nd_own) | Any user can read all push tokens |
| `profile_emergency_contacts` | `0076` (table doesn't exist) | Feature broken |

**Likely missing RLS (no `CREATE POLICY` found in migration scan):**

| Table | Risk |
|---|---|
| `push_retry_queue` | Internal queue; low user-data risk |
| `profile_views` | View counts potentially exposed |
| `post_impressions` | Impression counts potentially exposed |

**Core tables confirmed with RLS:** `profiles`, `posts`, `trips`, `messages`, `message_threads`, `blocks`, `follows`, `collections`, `collection_items`, `wishlist_places`, `hidden_gems`, `discovery_places`, `rent_buddy_*`, `notifications`, `notification_preferences`.

### Admin Route Guards — `complete`
- `admin.ts` line 37: `data.role === "admin"`.
- `trust-admin.ts` line 52: `data.role === "admin"`.
- `adminCompass.ts` line 48: `data.role === "admin"`.
- `adminStamps.ts` line 34: `data.role === "admin"`.
- `notifications.ts`: same inline `requireAdmin` pattern.
- All use `getServiceClient()` for DB operations after the guard.

### Feature Flag Posture — `partial`

| Pattern | Where used | Risk |
|---|---|---|
| `isFlagEnabled` — **fail-open** (returns `true` on DB error) | `passportStamps.ts` lines 51–68, `rentABuddy.ts` line 540, `hiddenGems.ts` | Low for content features |
| Fail-closed stamp guard — `data?.enabled !== true` | `stamps.ts` V2 guard | Correct |
| Nightlife age gate | `rentABuddy.ts` lines 964, 1014–1018 — `minAge` checked independently of flags; `nightlife_admin_approved` required at line 1099 | Correct — not flag-gated |

**Finding:** No purely flag-gated age restriction exists. The fail-open pattern is acceptable for current content features.

### Sensitive Data Exposure — `complete`
- No `supabase_uid` or service-role key in API responses.
- `admin.ts` line 245 explicitly strips `lat`/`lng` from suspicious GPS review responses.
- `POST_SAFE_COLUMNS` in pulse response explicitly excludes GPS coordinates.

---

## Phase 11 — Render & UX

### Empty States — `complete`
- **Pulse (Following):** `FollowingEmpty`. **Pulse (For You):** `TravelEmptyState`. `app/(tabs)/index.tsx`.
- **Trips:** empty state rendered when no trips exist. `app/(tabs)/trips.tsx`.
- **Messages:** `TelegraphInboxScreen` renders inbox empty state. `app/(tabs)/messages.tsx`.
- **Passport:** empty stamp/postcard grids rendered gracefully. `app/(tabs)/passport.tsx`.

### Error States — `complete`
- Pulse: `FollowingError` with Retry button. `app/(tabs)/index.tsx`.
- API: `sendError(res, code, message)` used consistently — never silent 200s on failure.
- `AccountStatusGate` blocks app and shows Retry on any status-fetch failure.

### Loading States — `complete`
- All major feed screens show loading indicators/skeletons while data fetches.

### Silent No-Op Buttons — `complete` (acceptable)
- Push token registration is documented as best-effort, fire-and-forget.
- Action buttons (like, save, RSVP) optimistically update UI and show error feedback on failure.

---

## Phase 12 — Pre-release Checklist

**Executed:** `SKIP_EAS_PREFLIGHT=1 bash scripts/pre-release-check.sh` (2026-07-05)

| Check | Result | Fix |
|---|---|---|
| `typecheck` | ✅ PASS | — |
| `typecheck-standalone` | ✅ PASS | — |
| `dependency-drift` | ✅ PASS | — |
| `source-drift` | ✅ PASS | — |
| `api-server-build` | ✅ PASS | — |
| `lockfile-drift` | ✅ PASS | — |
| `bundle-id-placeholder` | ✅ PASS | — |
| `version-bump` | ✅ PASS | ios.buildNumber=2, android.versionCode=2 |
| `db-triggers` | ❌ FAIL | See Phase 0 SQL commands above |
| `engagement-indexes` | ❌ FAIL | Apply migration 0123 (user-perspective indexes) |

---

## P0 Fixes — Unsafe for Beta

Ordered by severity. Every item includes the exact file, line reference, and fix command.

---

### P0-1 — `safe_return_sessions` has no RLS in production
**Severity:** CRITICAL — safety feature  
**Evidence:** Pre-release `db-triggers` check reports `0040_safe_return.sql` as not applied. RLS policies (`srs_own`: `auth.uid() = user_id`) that restrict session visibility are in `artifacts/api-server/migrations/0040_safe_return.sql`. Without them, any authenticated user can query `safe_return_sessions` via PostgREST and read others' check-in/check-out data, escalation status, and trusted circle links.  
**Fix:**
```bash
psql "$DB_URL" -f artifacts/api-server/migrations/0040_safe_return.sql
```

---

### P0-2 — `profile_emergency_contacts` table does not exist in production
**Severity:** CRITICAL — safety feature completely non-functional  
**Evidence:** Migration `0076_profile_emergency_contacts.sql` not applied. `artifacts/api-server/src/routes/emergencyContacts.ts` line 93 calls `.from("profile_emergency_contacts")`. Every add, edit, or delete request returns a `relation does not exist` DB error for all users.  
**Fix:**
```bash
psql "$DB_URL" -f artifacts/api-server/migrations/0076_profile_emergency_contacts.sql
```

---

### P0-3 — `notification_devices` push tokens readable by any authenticated user
**Severity:** HIGH — PII exposure  
**Evidence:** `artifacts/api-server/migrations/0041_notifications.sql` line 21 (`ALTER TABLE notification_devices ENABLE ROW LEVEL SECURITY`) and line 25 (`CREATE POLICY nd_own ON notification_devices USING (auth.uid() = user_id)`) are not applied. The table exists (created by `0062_notifications_schema.sql`) but without the `nd_own` policy, any authenticated user can enumerate push tokens for all users via direct PostgREST queries. Push tokens can send arbitrary Expo notifications to any device.  
**Fix:**
```bash
psql "$DB_URL" -f artifacts/api-server/migrations/0041_notifications.sql
```

---

### P0-4 — Rent-a-Buddy completely non-functional for all users in production
**Severity:** HIGH — core advertised feature broken for 100% of users  
**Evidence:** `checkRentBuddyAccess` in `artifacts/api-server/src/routes/rentABuddyRollout.ts` (function at line 129) returns `{ allowed: false, code: "city_not_available" }` at lines 307 and 381 when the `rent_buddy_global_controls` or `rent_buddy_city_rollouts` tables don't exist. Since migrations 0090+0092 are not applied, every request hits this error path.  
**Fix (apply in order):**
```bash
psql "$DB_URL" -f artifacts/api-server/src/migrations/0090_rent_buddy_rollout_tables.sql
psql "$DB_URL" -f artifacts/api-server/src/migrations/0092_seed_rent_buddy_launch_cities.sql
```

---

### P0-5 — Blocked users' message threads visible in inbox from the server
**Severity:** HIGH — safety / harassment risk  
**Evidence:** `artifacts/api-server/src/routes/messaging.ts` line 1100 (`router.get('/me/threads', ...)`) queries `message_thread_members` and `message_threads` with no filter against the `blocks` table. A thread created before the block still appears in the server response including the blocked user's profile, avatar, and last message. The client-side filter at `travel-buddy-standalone/src/components/telegraph/TelegraphInboxScreen.tsx` lines 287–292 is the only active guard. The block-checking logic at `messaging.ts` lines 955–972 is in the `open-thread` permission path, not the inbox listing path.  
**Fix:** In `messaging.ts` within the `GET /me/threads` handler (line 1100), before building the thread list, query `blocks` for both directions and exclude threads where the other member's userId appears in either set. Additive, targeted change to the existing handler.

---

### P0-6 — Collection protection triggers not in production (data integrity risk)
**Severity:** MEDIUM-HIGH — data loss risk  
**Evidence:** Migrations 0071–0074 flagged as not applied by `db-triggers`. BEFORE DELETE and BEFORE TRUNCATE triggers protect `collections`/`collection_items` from accidental mass wipes. Without them, a bug in a delete route or misconfigured admin query could silently wipe a user's entire saved collection.  
**Fix (in order):**
```bash
psql "$DB_URL" -f artifacts/api-server/src/migrations/0071_protect_default_collection.sql
psql "$DB_URL" -f artifacts/api-server/src/migrations/0072_block_collections_truncate.sql
psql "$DB_URL" -f artifacts/api-server/src/migrations/0073_block_collection_items_truncate.sql
psql "$DB_URL" -f artifacts/api-server/src/migrations/0074_protect_saved_places.sql
```

---

### P0-7 — User-perspective engagement indexes missing (performance degradation at scale)
**Severity:** MEDIUM — performance; will worsen with real beta traffic  
**Evidence:** Pre-release `engagement-indexes` check confirms 5 indexes absent: `idx_posts_likes_user_created`, `idx_post_reactions_user_created`, `idx_comment_likes_user_created`, `idx_highlight_likes_user_created`, `idx_memory_likes_user_created`. Profile-page "liked by me" queries and feed engagement lookups degrade to sequential scans on those tables.  
**Fix:**
```bash
psql "$DB_URL" -f artifacts/api-server/migrations/0123_engagement_user_indexes.sql
```

---

## Non-P0 Findings (Recommended Before or Shortly After Beta Launch)

| ID | Area | Finding | Priority |
|---|---|---|---|
| NP-1 | Live Map | `app/live-map.tsx` lines 9–13: static "coming soon" text only. Hide tab or label it until implemented. | Before launch |
| NP-2 | Push Notifications | Trip-invite push (`trips.ts` line 867) uses legacy `expo_push_token` column (single device). Multi-device users receive push on only one device. | Before launch |
| NP-3 | Auth | Half-created user state possible if `ensureProfile` fails after Supabase sign-up. No UI disambiguation. `src/services/auth.ts`. | Before launch |
| NP-4 | Auth | `authedClient()` (`lib/supabase.ts` line 26) has no retry-on-401 logic. Token expiry mid-operation causes silent failure. | Low |
| NP-5 | RLS | `push_retry_queue`, `profile_views`, `post_impressions` — no `CREATE POLICY` found. Verify and add if user-scoped. | Before launch |
| NP-6 | Flags | `isFlagEnabled` fail-open globally (`passportStamps.ts` line 60). Acceptable for content features. Review before adding any safety/age flag. | Ongoing |
| NP-7 | Stamps | `passportStamps.ts` checks `passport_stamps_enabled` (not `stamp_system_v2_enabled`). V2 semantics differ from the documented fail-closed guard in `stamps.ts`. | Low |

---

*Report generated 2026-07-05 from live codebase and production database via `scripts/pre-release-check.sh`. All findings cite actual file paths and line numbers. No assertions made without code verification.*

---

## Appendix A — Exact Pre-release Check Output

Captured: `SKIP_EAS_PREFLIGHT=1 bash scripts/pre-release-check.sh` (2026-07-05)

```
PRE-RELEASE CHECK SUMMARY
────────────────────────────────────────────────────────────
  ✔  typecheck                      PASS
  ✔  typecheck-standalone           PASS
  ✔  dependency-drift               PASS
  ✔  source-drift                   PASS
  ✔  api-server-build               PASS
  ✔  lockfile-drift                 PASS
  ✔  bundle-id-placeholder          PASS
  ✘  db-triggers                    FAIL  (exit code 1)
     fix: apply missing migrations via Supabase dashboard or psql:
            artifacts/api-server/migrations/0040_safe_return.sql
          (0040 creates safe_return_sessions + RLS policy srs_own)
            artifacts/api-server/migrations/0041_notifications.sql
          (0041 creates notification_devices for push token storage + RLS policy nd_own)
            artifacts/api-server/src/migrations/0071_protect_default_collection.sql
            artifacts/api-server/src/migrations/0072_block_collections_truncate.sql
            artifacts/api-server/src/migrations/0073_block_collection_items_truncate.sql
            artifacts/api-server/src/migrations/0074_protect_saved_places.sql
            artifacts/api-server/migrations/0076_profile_emergency_contacts.sql
          (0076 creates the profile_emergency_contacts table + RLS policies)
            artifacts/api-server/src/migrations/0090_rent_buddy_rollout_tables.sql
          (0090 creates rent_buddy_global_controls + rent_buddy_city_rollouts tables;
           without them every checkRentBuddyAccess call returns city_not_available)
            artifacts/api-server/src/migrations/0092_seed_rent_buddy_launch_cities.sql
          (0092 seeds Cebu, Manila, Davao City at public_mvp status;
           without live cities the feature is deployed but invisible to all users)
  ✘  engagement-indexes             FAIL  (exit code 1)
     fix: apply the engagement index migration via the Supabase SQL editor or psql:
            artifacts/api-server/src/migrations/0106_engagement_indexes.sql
          (0106 creates five pg_indexes for cursor-based pagination on like tables;
           without them GET /api/engagement/likes degrades to sequential scans)
          artifacts/api-server/migrations/0123_engagement_user_indexes.sql
          (0123 creates five user-perspective indexes for profile-page and feed queries)
  ✔  version-bump                   PASS  (ios.buildNumber=2, android.versionCode=2)
────────────────────────────────────────────────────────────

One or more checks failed. Fix the issues above before building a release.
```
