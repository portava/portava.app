---
name: Circle notification + Telegraph card pattern
description: Patterns for wiring Circle events to push notifications and Telegraph status cards; fake-client pitfalls for neq filters and new routes.
---

## Notification helpers (circle.ts)

`sendCircleNotifications(sc, recipientIds, eventType, params)` — fire-and-forget; caps at 50 recipients; swallows all errors. Never block the HTTP response.

`postCircleStatusCard(sc, contextType, contextId, actorId, cardSubtype, safeCardData)` — inserts a `circle_status_card` message into the trip/event Telegraph thread. Thread lookup: trips via `message_threads.trip_id`, events via `events.chat_thread_id`. Deliberately excludes GPS, `needs_help`, and any emergency detail from the card body.

`resolveContextTitle(sc, contextType, contextId)` — returns trip title/destination_city or event title for notification params; non-fatal.

## Privacy invariants

- Check-in response: only `id`, `checkinType`, `createdAt` — no `needs_help`, `lat`, `lng`, `gps`.
- Need-help response: only `acknowledged`, `message` — same exclusions.
- Meeting-point card: no lat/lng even if V2 adds coordinates; rendering is client-side.
- Need-help notification: **host only** — not broadcast. Host resolved from `trips.user_id` or `events.organizer_id`/`creator_id`.

## Compass suggestions

`GET /circle/compass-suggestions` is a standalone route in circle.ts — NOT added to CompassFeedBuilder. Adding it there would touch 10+ compass files. Mobile Compass screen calls this endpoint independently. Returns up to 10 mutual followers not already in any active Circle context.

## Pause-on-session-end

`POST /circle/pause-on-session-end` bulk-updates circle_presence using `.neq("status", "paused")` to be idempotent. Returns `{ paused: N }`.

**Why:** mobile app calls this on AppState background transition to clear stale "active" badges.

## Fake-client pitfalls

- `neq(col, val)` must be added to the builder and handled in both `applyFilters` (select path) and the update-path `rowMatchesFilters`. Destructuring filters as `([, col, val])` silently treats neq as eq — fix with `([op, col, val])` and a conditional.
- New tables `follows`, `circle_members`, `messages`, `message_threads` must be seeded in FakeState + handled in `_resolve()` or compass-suggestions returns empty.
- The regression test for presence privacy should call `GET /circle/contexts/:type/:id/members` (which includes shaped presence), not `GET .../presence` which does not exist as a route.
