---
name: Find Your Circle — access guard and backend patterns
description: Guard logic, schema conventions, and test patterns for the Find Your Circle presence-coordination API.
---

## Key design decisions

**Membership check (guard step 2 & 3):**
- Trip: `trip_members` row with `role IN ('owner','co_host','member','viewer')` AND `status IS NULL OR status = 'accepted'`. Role `'invited'` fails.
- Event: `event_rsvps` row with `status = 'going'`. `'maybe'`, `'interested'`, `'cant_go'` all fail.
- Telegraph-only (message_thread_members) does NOT grant Circle membership — natural fallthrough.
- Follow relationship alone does NOT grant membership.

**Why:** "Find Your Circle" is opt-in status coordination for co-travelers, not social networking. Strict membership prevents information leakage to strangers who only share a chat thread or follow someone.

**How to apply:** Any route that reads another user's presence must call `canViewCirclePresence()` from `src/lib/circleAccessGuard.ts`. Never check membership inline.

## Guard order (fail-fast)
1. Kill switch: `isFlagEnabled(sc, 'find_your_circle_disabled')` — fail-OPEN on DB error (do not block users when DB is down)
2. Viewer accepted member
3. Target accepted member
4. Target `global_enabled=true` + `consented_at IS NOT NULL`
5. Context settings: `enabled=true`, not paused (or `paused_until < now()`)
6. Mutual block check (`blocks` table)
7. Target not banned/suspended (`user_account_states`)
8. Presence row: hard expiry → blocked; stale (`last_seen_at + stale_after_secs < now()`) → allowed but `isStale=true`

## Visibility mode contract (circleResponseShaper.ts)
- `status_only`: status + profile only. `approximateLabel = null`, `venueLabel = null`.
- `approximate_area`: status + `approximate_label`. `venueLabel = null`.
- `venue_checkin`: status + `venue_label` ONLY when `checked_in = true`.
- `precise_live`: rejected at route level with 403. Deferred to V2.

**Why:** shapePresence enforces this contract. Routes must never return raw DB rows.

## Response never exposes
`email`, `phone`, GPS coordinates, `needs_help` boolean, `admin notes`, emergency context.

## Migrations (0115–0121, pending production apply)
- 0115: `circle_visibility_settings` (global opt-in + consent)
- 0116: `circle_context_settings` (per-trip/event overrides + pause)
- 0117: `circle_presence` (snapshot, upserted on publish, UNIQUE per user+context)
- 0118: `circle_checkins` (immutable log: arrived/with_group/leaving/safe/needs_help)
- 0119: `circle_member_visibility_overrides` (hide-from-me / hide-me-from per context)
- 0120: `circle_meeting_points` (host-managed, one active per context)
- 0121: `circle_audit_events` (11 event types, actor/target nullable)

## Admin controls
- `POST /api/admin/circle/kill-switch { enabled: bool }` — toggles `find_your_circle_disabled` flag
- `POST /api/admin/circle/disable-context { contextType, contextId }` — upserts `enabled=false` for all members
- `GET /api/admin/circle/reports` — audit events filtered to safety/admin event types

## Internal cleanup cron
`POST /circle/internal/cleanup-presence` with `x-internal-secret` header. Marks rows stale, deletes hard-expired rows, sweeps ended trips (24h TTL) and events (2h TTL).

**Why `precise_live` returns 403 not 400:** Zod schema includes `precise_live` as a valid enum value; route handler explicitly rejects it with 403. This communicates "not supported" rather than "invalid input". Do not remove `precise_live` from the Zod schema or Zod will return 400 first.

## Test pattern (circle.test.ts)
- Mount: `app.use(circleRouter)` (no `/api` prefix); base = `http://127.0.0.1:PORT` (no suffix)
- `new URL("/circle/settings", "http://host/api")` resolves to `/circle/settings` (absolute path strips base path), so test mount must match
- Fake client: `_setTestClient(client, true)` + `_setTestServiceClient(client)` for routes that call both `requireUser` and `getServiceClient()`
- `featureFlags` state must include both `find_your_circle_enabled` (true) and `find_your_circle_disabled` (false) for full guard tests
