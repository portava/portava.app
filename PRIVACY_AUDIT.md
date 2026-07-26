# Privacy Audit Report — Portava

**Date:** 2026-07-26  
**Scope:** Phase 0 — audit only; no code changes. All subsequent implementation tasks may cite findings by ID (e.g. `[C1]`).  
**Coverage:** API routes, RLS policies, storage buckets, realtime/SSE, search & discovery, notification payloads, deep links/OG metadata, client cache & local storage, analytics/logging, admin tools.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 3     |
| High     | 5     |
| Medium   | 8     |
| Low      | 6     |

---

## Critical

### [C1] profile-media storage bucket is created PUBLIC — private-account photos accessible to unauthenticated callers

- **File:** `artifacts/api-server/src/routes/profile.ts`, line 44
- **Code:** `await sc.storage.createBucket(bucket, { public: true });`
- **Entity:** Profile / Media
- **Leak type:** Public storage bucket; no auth required to fetch avatar or cover photo by URL
- **Detail:** The `profile-media` bucket (which holds every user's avatar and cover photo) is explicitly created as `public: true`. Any caller who knows — or can construct — a Supabase Storage URL for this bucket can fetch any user's avatar or cover photo, including users who have set `is_private = true` or `passport_visibility = "private"`. The `media_private_buckets_enabled` feature flag (in `mediaFile.ts`) is designed to gate this, but it defaults OFF, meaning the bucket remains publicly readable in all current deployments. Private-account media is therefore effectively public.
- **Tables / columns affected:** `profiles.avatar_url`, `profiles.cover_photo_url`; Supabase bucket `profile-media`
- **Migrations affected:** None — bucket privacy is set at runtime via `createBucket`
- **Requires:** Flip bucket to private + turn on `media_private_buckets_enabled` flag, or enforce signed-URL authorization for profile-media before any private-account protection is meaningful.

---

### [C2] Passport postcards endpoint only gates `passport_visibility='private'` — `followers_only` accounts' postcards are served to unauthenticated callers

- **File:** `artifacts/api-server/src/routes/passport.ts`, lines 339–416 (specifically lines 354–361)
- **Code:**
  ```typescript
  if (profile.passport_visibility === "private") {
    res.status(200).json({ private: true, postcards: [] });
    return;
  }
  // Falls through: postcards returned for followers_only AND public
  ```
- **Entity:** Profile / Passport / Media
- **Leak type:** Missing visibility tier check; unauthenticated read
- **Detail:** `GET /users/:username/passport/postcards` uses the service-role client so share-link recipients can view postcards without logging in. The route correctly blocks callers when `passport_visibility = 'private'`, but does **not** block them when `passport_visibility = 'followers_only'`. A user who sets their passport to "followers only" still has their full postcard wall (including location names, captions, and cover photos) served to any anonymous internet user who knows their username. The route also does not call `resolveProfileVisibility` or `getOptionalViewerId`, so block relationships and account-status checks are skipped for this endpoint entirely.
- **Tables / columns affected:** `passport_postcards.*`, `profiles.passport_visibility`
- **Requires:** Re-check visibility against `resolveProfileVisibility`; gate `followers_only` profiles behind authentication + follower/friend check; apply block and account-status checks.

---

### [C3] Base `profiles` and `trips` tables lack documented RLS SELECT policies — all privacy enforcement depends entirely on API server middleware

- **Files:** Migration files in `artifacts/api-server/src/migrations/`, `docs/migrations/` — no migration found defining SELECT policies on `profiles` or `trips`
- **Entity:** Profile / Trip
- **Leak type:** No RLS; PostgREST direct access bypasses all privacy middleware
- **Detail:** Unlike sub-tables (`event_attendees`, `event_invites`, `profile_privacy_settings`, etc.), the base `profiles` and `trips` tables have RLS enabled (Supabase default) but no SELECT policy has been found in any migration that enforces privacy for non-owners. Without a SELECT policy, the `anon` and `authenticated` roles can read all rows directly via the PostgREST API (`/rest/v1/profiles`, `/rest/v1/trips`), bypassing every privacy check implemented in the API server: `is_private`, `passport_visibility`, `visibility`, `show_destination_city`, `show_exact_dates`, `date_of_birth`, etc. The API server uses the service-role key to bypass RLS deliberately, but the Supabase REST endpoint is also exposed and must have its own RLS protection.
- **Tables / columns affected:** `profiles.*`, `trips.*`
- **Requires:** Add `ENABLE ROW LEVEL SECURITY` + appropriate SELECT policies to `profiles` (e.g. `is_private = false OR id = auth.uid()`) and `trips` (e.g. `visibility = 'public' OR owner_id = auth.uid() OR EXISTS trip_members where user_id = auth.uid()`).

---

## High

### [H1] SSE stream accepts auth token as a `?token=` URL query parameter — token appears in server access logs

- **File:** `artifacts/api-server/src/routes/telegraphStream.ts`, lines 40–42
- **Code:**
  ```typescript
  } else if (typeof req.query.token === "string" && req.query.token) {
    token = req.query.token;
  }
  ```
- **Entity:** Auth / Realtime
- **Leak type:** Auth token in URL; logged by proxy/server access logs
- **Detail:** The `GET /api/telegraph/stream` SSE endpoint accepts the bearer token via `?token=<JWT>` because the browser `EventSource` API cannot set custom headers. The full JWT therefore appears in the server access log, proxy logs, browser history, and any referrer headers when the user navigates from the stream URL. A token leak of this kind gives an attacker a valid session. The token's expiry partially mitigates this, but long-lived Supabase tokens extend the risk window significantly.
- **Requires:** Use a short-lived one-time ticket (exchange JWT for a temporary opaque token via a separate auth endpoint, then pass the ticket in the URL). Alternatively, accept the limitation and ensure access logs exclude query strings for the `/telegraph/stream` path, and that tokens have short expiry.

---

### [H2] Discovery search results expose raw internal UUIDs (`hostId`, `ownerId`) to all authenticated callers

- **File:** `artifacts/api-server/src/routes/discoverySearch.ts`, lines 414, 477
- **Code (events):** `metadata: { hostId: e.host_id, status: e.state }`
- **Code (trips):** `metadata: { ownerId: t.owner_id, status: t.status }`
- **Entity:** Search / Event / Trip
- **Leak type:** Internal UUID exposed in public-facing search result
- **Detail:** The `SearchResult.metadata` field for events and trips includes the raw `host_id`/`owner_id` UUID. While UUIDs are not directly PII, exposing them in search results lets any authenticated user enumerate event hosts and trip owners by ID without going through the passport route, bypassing block checks and profile visibility checks on the identity. For example, a blocked user could learn the UUID of the user who blocked them via search and use it in other API calls.
- **Tables / columns affected:** `events.host_id`, `trips.owner_id`
- **Requires:** Remove `hostId`/`ownerId` from the `metadata` field in `SearchResult`, or run them through the block-check and name-visibility filters before inclusion.

---

### [H3] `POST /trips` returns raw snake_case DB row including `destination_lat` / `destination_lng` — bypasses privacy serializer

- **File:** `artifacts/api-server/src/routes/trips.ts`, lines 21–27 (TRIP_COLUMNS), line 278
- **Code:**
  ```typescript
  const { data, error } = await client.from("trips").insert({...}).select(TRIP_COLUMNS).single();
  // ...
  res.status(201).json(data);
  ```
- **Entity:** Trip
- **Leak type:** Serializer bypass; raw DB row returned
- **Detail:** `TRIP_COLUMNS` explicitly includes `destination_lat` and `destination_lng`, and the raw `data` object is returned directly to the client without passing through `toMemberTrip()` or `toPublicTrip()`. While the trip creator is always the owner and should see coordinates, this pattern: (a) returns snake_case keys (inconsistent with all other trip responses which return camelCase via `toMemberTrip`), and (b) returns all TRIP_COLUMNS including privacy flags (`show_exact_dates`, `show_destination_city`, `precise_location_visible`, `allow_join_requests`, etc.) as raw DB values. Any internal-only column accidentally added to TRIP_COLUMNS would reach the client immediately. The serializer gap also means the response contract is untested against the privacy schema.
- **Tables / columns affected:** `trips.*` (all columns in TRIP_COLUMNS)
- **Requires:** Pass the newly created trip through `toMemberTrip()` before responding.

---

### [H4] `GET /trips/me`, `/trips/upcoming`, `/trips/active`, `/trips/past` use `select("*")` — all future internal columns will be fetched

- **File:** `artifacts/api-server/src/routes/trips-expansion.ts`, lines 180, 214, 248, 281
- **Code:** `.select("*").in("id", tripIds)`
- **Entity:** Trip
- **Leak type:** Broad DB projection; internal columns fetched even if not returned
- **Detail:** These four member-only trip-list endpoints use `select("*")` to fetch all columns from the `trips` table, then filter through `toMemberTrip()`. Today `toMemberTrip()` only returns an explicit set of fields, so current internal columns don't reach clients. However, if `toMemberTrip()` is ever changed to use spread (`{ ...t }`) or if a developer adds a column to the function's returned object, every internal field becomes exposed. Best practice is to enumerate only required columns in the DB projection (as done by `TRIP_COLUMNS` in `trips.ts`).
- **Tables / columns affected:** `trips.*`
- **Requires:** Replace `select("*")` with a named column list matching the fields used by `toMemberTrip()`.

---

### [H5] Notification `metadata` JSONB is stored at creation time under privacy-guard filters, but returned verbatim to the client from the `GET /me/notifications` endpoint — no re-filtering on read

- **File:** `artifacts/api-server/src/routes/notifications.ts` (notification list endpoint); `artifacts/api-server/src/services/notifications/NotificationService.ts`; `artifacts/api-server/src/services/notifications/NotificationPrivacyGuard.ts`
- **Entity:** Notification
- **Leak type:** Stale privacy-filtered data; metadata may contain PII that was valid at creation but is now restricted
- **Detail:** `NotificationPrivacyGuard` strips GPS coordinates and reporter identity at notification creation time (the privacy guard runs once when the row is inserted). The stored `metadata` JSONB is then returned verbatim to the client when listing notifications. If privacy settings change after the notification is created (e.g. a user blocks the requester, or updates their name opt-in after a mention notification was created), the stored metadata is not re-evaluated. Depending on what fields the notification engine stores in `metadata`, this can expose: (a) a real name that is no longer opted in; (b) a venue or city from a post the user later deleted; (c) context about a user relationship that has since changed.
- **Tables / columns affected:** `notifications.metadata`
- **Requires:** Re-run metadata through a lightweight privacy filter on read (or, for sensitive fields, store references rather than copied values), and re-evaluate whether stored display names should respect current opt-in state.

---

## Medium

### [M1] Client-side `discoveryLocalCache.ts` persists full discovery payloads in AsyncStorage — stale private data survives privacy-setting changes

- **File:** `artifacts/travel-buddy/src/components/discovery/discoveryLocalCache.ts` (approx. line 66)
- **Entity:** Profile / Event / Trip / Cache
- **Leak type:** Client-side cache persistence; stale private data
- **Detail:** The discovery surface caches API responses in `AsyncStorage` for L2 cache performance. The cached payloads include profile handles, home cities, home countries, and event details. If a user changes their privacy settings (e.g. sets `is_private = true`, removes home city, or blocks a specific viewer), the cached payload on the viewer's device continues to show the old data until the AsyncStorage entry expires or is invalidated. There is no push-invalidation mechanism for cached discovery data when the subject's privacy settings change.
- **Requires:** Document the cache TTL and add a cache-version mechanism (bump cache key on profile-privacy-settings change). Consider encrypting AsyncStorage entries that contain profile data.

---

### [M2] Pulse feed block filter is best-effort / non-fatal — blocked authors' posts appear if the `blocks` query fails

- **File:** `artifacts/api-server/src/routes/pulse.ts`, lines 197–209
- **Code:**
  ```typescript
  try {
    // ... build blockedSet
    if (blockedSet.size > 0) {
      rows = rows.filter(...)
    }
  } catch { /* non-fatal */ }
  ```
- **Entity:** Profile / Feed
- **Leak type:** Fail-open block filter
- **Detail:** The `GET /api/pulse` route builds a `blockedSet` to filter out blocked authors, but wraps the entire block-query-and-filter block in a `try/catch` with a `/* non-fatal */` comment. If the `blocks` table query fails (network partition, DB overload, table missing), `blockedSet` stays empty and no posts are filtered. A user who blocks someone to stop seeing their content will see their posts again whenever there is a transient DB error. The `discoverySearch.ts` block filter uses a stricter fail-closed approach (returns `null` → returns empty results).
- **Requires:** Change to fail-closed: if block query fails, return empty results for the feed rather than unfiltered results. Match the pattern used by `fetchBlockedSet` in `discoverySearch.ts`.

---

### [M3] Event search snippets return the full raw `description` field — could expose private venue addresses, entry codes, or contact info

- **File:** `artifacts/api-server/src/routes/discoverySearch.ts`, line 358
- **Code:**
  ```typescript
  .select("id, title, description, host_id, cover_url, city, country, starts_at, visibility, state, created_at")
  ```
- **Entity:** Event / Search
- **Leak type:** Unredacted description field in search results
- **Detail:** Event descriptions are fetched and (depending on how the `SearchResult` is constructed) may be included in the response. Event hosts commonly put venue addresses, exact meeting spots, passwords for private venues, phone numbers, or organiser contact details in the `description` field. While event-level visibility is gated to `visibility='public'`, the description content is not separately reviewed or stripped before being returned in search results. Non-participants who search for a keyword matching the description will receive the full text.
- **Requires:** Either omit `description` from the search-result projection, or truncate it to a sanitized snippet (max ~120 chars, strip structured data patterns like phone/email).

---

### [M4] Trip invite response exposes `destination_city`, `start_date`, `end_date` regardless of `show_exact_dates` / `show_destination_city` trip privacy flags

- **File:** `artifacts/api-server/src/routes/trips-expansion.ts`, lines 331–350
- **Code:**
  ```typescript
  return {
    tripId: trip.id,
    tripTitle: trip.title,
    destinationCity: trip.destination_city,
    startDate: trip.start_date ?? null,
    endDate: trip.end_date ?? null,
    // ...
  }
  ```
- **Entity:** Trip
- **Leak type:** Privacy-flag bypass in invite payload
- **Detail:** When a user is invited to a trip, `GET /trips/invites` (and the alias `GET /me/trip-invites/pending`) returns `destination_city`, `start_date`, and `end_date` directly from the DB row without checking the trip owner's `show_destination_city` or `show_exact_dates` flags. An owner who set their trip to hide exact dates or hide the destination city from the public will still have those values revealed to invited (pending) members, even before they accept. While invited members arguably need this info to decide whether to accept, the current code exposes it without checking whether the flags allow it, which is inconsistent with the `toPublicTrip()` serializer that respects these flags.
- **Requires:** Either document that invited members are always shown full destination/date info (and add this to privacy settings UI), or respect the flags in the invite response as well.

---

### [M5] `profile_views` table stores viewer–target pairs without a documented RLS SELECT policy — viewer identities are accessible via PostgREST

- **File:** `artifacts/api-server/src/routes/profile.ts`, lines 231–258 (analytics and view tracking); no RLS policy found in any migration for `profile_views`
- **Entity:** Profile / Analytics
- **Leak type:** No RLS; viewer identity exposed
- **Detail:** `POST /users/:username/passport` inserts `{ target_id, viewer_id, viewed_at }` into `profile_views` as a fire-and-forget write. The `GET /me/profile/analytics` endpoint returns only aggregated counts (no viewer IDs). However, if no RLS policy restricts SELECT on `profile_views`, the table is accessible via the PostgREST endpoint (`/rest/v1/profile_views`) by any authenticated user, exposing which users viewed any target profile. This would violate the explicit comment in the route: "Never exposes viewer identity."
- **Tables / columns affected:** `profile_views.viewer_id`, `profile_views.target_id`, `profile_views.viewed_at`
- **Requires:** Add an RLS SELECT policy: `SELECT USING (target_id = auth.uid())` so only the target can see their own view log (but still not individual viewer IDs).

---

### [M6] Map search response echoes the caller's exact `lat`/`lng` back in the `viewport` field

- **File:** `artifacts/api-server/src/routes/mapSearch.ts`, line 132
- **Code:**
  ```typescript
  res.json({ enabled: true, results: page, viewport: { lat, lng, radiusKm }, ... });
  ```
- **Entity:** Map / Location
- **Leak type:** Precise caller location echoed in response
- **Detail:** The response body of `GET /api/map/search` includes the exact `lat` and `lng` submitted by the caller. While the caller already knows their own coordinates, the response is also likely logged (request body via pino or similar), potentially stored in analytics pipelines, and cached by the client. If the response is ever replayed, shared, or logged incorrectly as part of a different user's context, the precise location would leak. The viewport is returned in the same JSON object as potentially private search results.
- **Requires:** Low risk if logs are properly scoped. Consider omitting exact coordinates from the response body and relying only on the client's own state for viewport restoration.

---

### [M7] `POST /events` and event-update routes log raw `error.message` from Supabase — DB schema details may leak in error responses

- **File:** `artifacts/api-server/src/routes/profile.ts` line 190, `trips.ts` line 274, `events.ts` (multiple error returns)
- **Code:** `sendError(res, "db_error", error.message)`
- **Entity:** All
- **Leak type:** Internal error details in API response
- **Detail:** Multiple routes return raw Supabase/PostgREST error messages directly to the client via `sendError(res, "db_error", error.message)`. Supabase error messages can reveal table names, column names, constraint names, and in some cases partial query structure. While this is primarily a security concern (information disclosure to attackers) rather than a privacy concern, it is worth addressing as part of a hardening pass.
- **Requires:** Sanitize DB error messages before returning to clients; map known error codes (42703, 23505, etc.) to generic user-facing messages.

---

### [M8] `GET /users/:username/passport` returns `targetId` in the blocked-relationship response — exposes the target's UUID to blocked callers

- **File:** `artifacts/api-server/src/routes/passport.ts`, line 213
- **Code:** `res.status(200).json({ blocked: true, targetId });`
- **Entity:** Profile
- **Leak type:** UUID exposure via blocked sentinel
- **Detail:** When a block relationship exists, the passport endpoint returns `{ blocked: true, targetId }` so the client can offer "Unblock" functionality. This exposes the target's UUID to the caller even when they are blocked. The UUID is stable and can be used to probe other API endpoints. The comment "Include targetId so the client can call unblockUser(targetId) without a separate lookup" is valid, but the unblock operation could alternatively be performed by username (which is already known since it was used to look up the profile).
- **Requires:** Evaluate whether `targetId` is strictly necessary in the blocked response, or whether username alone is sufficient for the unblock flow.

---

## Low

### [L1] No `Cache-Control: private` or `Vary: Authorization` headers on authenticated profile/event API responses

- **File:** `artifacts/api-server/src/routes/profile.ts`, `passport.ts`, `events.ts` — no Cache-Control headers set on JSON responses
- **Entity:** Profile / Event / Trip
- **Leak type:** Potential shared-cache poisoning at CDN/proxy layer
- **Detail:** Authenticated profile, passport, and event detail responses do not set `Cache-Control: private` or `Vary: Authorization`. If any reverse proxy, CDN, or shared cache is ever placed in front of the API server without careful configuration, it could serve a cached response for User A to User B. The risk is low in current deployment (Replit proxy), but increases if the project is ever fronted by a CDN.
- **Requires:** Add `res.setHeader("Cache-Control", "private, no-store")` to all routes that return user-specific or visibility-gated data.

---

### [L2] `expo_push_token` stored in `profiles` table — service-role fetches include it in many internal queries

- **File:** `artifacts/api-server/src/routes/events.ts`, line 329 (`profiles.expo_push_token`); `trips.ts` line 101
- **Entity:** Profile / Notification
- **Leak type:** Push token exposure in internal queries
- **Detail:** `expo_push_token` is stored in the `profiles` table and fetched in several internal queries (waitlist promotion, trip member notifications). The `mapProfile()` serializer correctly excludes it from client responses. The risk is that a new route or an accidental `select("*")` could include it. Push tokens can be used to send push notifications to users outside of the app's control.
- **Requires:** Migrate `expo_push_token` out of `profiles` and into the separate `notification_devices` table (which already exists); ensure `profiles` column is removed after migration.

---

### [L3] Trip activity log (`trip_activity_log`) stores `actor_id` + action metadata — no RLS policy documented

- **File:** `artifacts/api-server/src/routes/trips-expansion.ts`, lines 143–154 (`logActivity` helper)
- **Entity:** Trip
- **Leak type:** No RLS; activity log accessible via PostgREST
- **Detail:** The `logActivity` helper inserts rows with `actor_id`, `event_type`, and `metadata` into `trip_activity_log`. No RLS SELECT policy for this table was found in the reviewed migrations. If PostgREST exposes this table, any authenticated user could enumerate all trip activity (who joined, who left, who updated, who invited whom) for all trips.
- **Requires:** Add RLS SELECT policy restricting reads to trip members (`EXISTS SELECT 1 FROM trip_members WHERE trip_id = trip_activity_log.trip_id AND user_id = auth.uid()`).

---

### [L4] Admin routes return full internal row data without field-level redaction

- **File:** `artifacts/api-server/src/routes/admin.ts` (approximately lines 1–200)
- **Entity:** Admin / Profile
- **Leak type:** Full object returned to admin users; no audit log
- **Detail:** Admin routes require `requireAdmin` auth enforcement, which is correct. However, admin list pages return full raw DB rows (e.g. `GET /admin/geo-zones/:id` uses `select()` which returns all columns). Admin users therefore see internal-only fields, moderation metadata, and verification timestamps for all users. There is no documented admin access audit log in the reviewed code. If admin credentials are compromised, all user PII and internal moderation state is accessible.
- **Requires:** (a) Add an audit log for admin reads of user-specific data; (b) define explicit column lists for admin routes to avoid returning unintended future internal columns; (c) verify `requireAdmin` checks the admin role claim in the JWT correctly and cannot be bypassed.

---

### [L5] `profile_privacy_settings` and `user_privacy_settings` fetched with `select("*")` — all columns including future internal flags returned to API server

- **File:** `artifacts/api-server/src/lib/profileVisibility.ts`, line 68; `artifacts/api-server/src/routes/discoverySearch.ts`, line 192
- **Entity:** Profile / Privacy Settings
- **Leak type:** Broad projection; future internal columns auto-included
- **Detail:** The privacy-settings tables are queried with `select("*")` and the full result is attached to responses as `privacySettings` (in the passport response). Any internal-only column added to `profile_privacy_settings` in the future (e.g. `flagged_for_review`, `trust_override`) would immediately be returned to all callers of `GET /users/:username/passport`. The `privacySettings` object in the passport response is passed through to the client with all keys intact.
- **Requires:** Define an explicit column list for `profile_privacy_settings` selects; strip the returned `privacySettings` object to only the fields the client actually needs before including it in the response, or remove it from public responses entirely.

---

### [L6] `mapPublicProfile()` in passport.ts passes `displayName: null` unless `show_real_name` is true — but `name` field is also selected and present in the raw DB row, which could be logged

- **File:** `artifacts/api-server/src/routes/passport.ts`, lines 25–50 (`mapPublicProfile`)
- **Entity:** Profile
- **Leak type:** Real name in server-side data even when not returned to client
- **Detail:** `mapPublicProfile()` correctly returns `displayName: null` when `show_real_name` is not opted in. However, the raw DB row (which contains the `name` column) is passed to the function and exists in the request handler's scope. If pino or another logger ever logs the full `data` object (e.g. on error), the user's real name would appear in server logs even for opt-out users. This is a low-risk internal concern but should be noted for log-hygiene purposes.
- **Requires:** Consider masking the `name` field in the raw profile row before passing it to any logger, or ensure error-path logging uses a sanitized shape.

---

## Entities Not Separately Audited (out of scope for Phase 0 / already gated correctly)

| Entity | Status |
|---|---|
| Deep link / OG metadata / link preview | No server-side HTML rendering or OG endpoint found in `api-server/src/routes/`. Deep links handled client-side. No `noindex` enforcement needed server-side in current architecture. |
| Telegraph/SSE event content | Messages are delivered only to their thread-member subscribers via the in-memory `subscribe(userId, send)` fan-out. Non-members cannot subscribe. Token is verified via `sc.auth.getUser()` before the SSE stream is opened. |
| Event attendee list | Correctly participant-scoped in `formatEvent()` — outsiders receive `goingAttendees: []`. |
| Profile DOB | Fetched server-side for `ageGateRequired` computation only; `mapProfile()` never returns it. Correct. |
| Block filter — discovery search | Fail-closed: returns `null` → returns `[]`. Correct. |
| Profile-tab visibility | `applyVisibilityGuard` enforces `resolveProfileVisibility` and respects all privacy flags (`show_posts`, `show_stamps`, `show_past_trips`, etc.). Correct. |
| Event exact coordinates | Gated to host or confirmed participant in `formatEvent()`. Correct. |
| Trip crew location | All responses use blurred area labels; exact GPS never returned. Gated to trip members. Correct. |
| Postcard `userId` field | `mapPostcard(r, false)` omits `userId`; only included when `includePrivate=true` for owner's own view. Correct. |

---

## Files and Migrations Requiring Change (reference for implementation tasks)

| Finding | Primary File | Migration / Table |
|---|---|---|
| C1 | `artifacts/api-server/src/routes/profile.ts:44` | `profile-media` bucket config |
| C1 | `artifacts/api-server/src/routes/mediaFile.ts` | `media_private_buckets_enabled` flag |
| C2 | `artifacts/api-server/src/routes/passport.ts:358` | `passport_postcards`, `profiles.passport_visibility` |
| C3 | (new migration needed) | `profiles`, `trips` RLS SELECT policies |
| H1 | `artifacts/api-server/src/routes/telegraphStream.ts:40` | — |
| H2 | `artifacts/api-server/src/routes/discoverySearch.ts:414,477` | — |
| H3 | `artifacts/api-server/src/routes/trips.ts:278` | `trips.*` |
| H4 | `artifacts/api-server/src/routes/trips-expansion.ts:180,214,248,281` | `trips.*` |
| H5 | `artifacts/api-server/src/services/notifications/NotificationService.ts` | `notifications.metadata` |
| M1 | `artifacts/travel-buddy/src/components/discovery/discoveryLocalCache.ts` | — |
| M2 | `artifacts/api-server/src/routes/pulse.ts:197` | `blocks` |
| M3 | `artifacts/api-server/src/routes/discoverySearch.ts:358` | `events.description` |
| M4 | `artifacts/api-server/src/routes/trips-expansion.ts:331` | `trips.show_exact_dates`, `trips.show_destination_city` |
| M5 | (new migration needed) | `profile_views` RLS SELECT policy |
| M6 | `artifacts/api-server/src/routes/mapSearch.ts:132` | — |
| M7 | Multiple routes | — |
| M8 | `artifacts/api-server/src/routes/passport.ts:213` | — |
| L1 | Multiple route files | — |
| L2 | `artifacts/api-server/src/routes/events.ts:329` | `profiles.expo_push_token` → `notification_devices` |
| L3 | (new migration needed) | `trip_activity_log` RLS SELECT policy |
| L4 | `artifacts/api-server/src/routes/admin.ts` | — |
| L5 | `artifacts/api-server/src/lib/profileVisibility.ts:68` | `profile_privacy_settings` |
| L6 | `artifacts/api-server/src/routes/passport.ts:25` | — |
