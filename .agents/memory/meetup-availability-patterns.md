---
name: Meetup & Availability API patterns
description: Key gotchas for availability/meetup routes — error codes, test file placement, response shapes
---

## Error code → HTTP status
- `invalid_payload` → **400** (not 422). All zod validation failures use `sendError(res, "invalid_payload", ...)`.
- `forbidden` → 403, `not_found` → 404, `db_error` → 500.

**Why:** `sendError` in `src/lib/http.ts` maps `ApiErrorCode` literals to status via a hardcoded `STATUS` record. `invalid_payload` is 400.

**How to apply:** Write test assertions as `assert.equal(r.status, 400)` for body validation failures, not 422.

## Test file placement
- Tests go in `src/test/` (not `src/routes/`). The `pnpm test` script runs `node --import tsx/esm --test src/test/*.test.ts`.
- Import the specific **router** (`import fooRouter from "../routes/foo.js"`), then mount it on a minimal express app. Do NOT import `../index.js` — it has no default export (it calls `app.listen`).
- Use `_setTestClient(makeFakeClient(state), true)` before creating the express app so `requireUser()` uses the fake client.

**Why:** `index.ts` is an entrypoint, not a module export. The app itself is `app.ts` → `export default app`.

## Availability response shapes
- `GET /api/trips/:tripId/availability` → `{ members: [...], tripId }`
- `GET /api/circles/:circleId/availability` → `{ members: [...], circleId }` (key is `circleId`, not `circleOwnerId`)
- Quick status null/clear: **not supported** — schema only accepts `z.enum(["free_now","busy","open_to_plans","free_tonight"])`. No null clearing endpoint.

## Meetup add-to-trip-plan idempotency
- If the meetup is already in the trip plan: `200 { message: "already_added", planItemId, idempotent: true }`
- If it's new: `201 { planItemId, tripId, meetupId }`

## Meetup card in chat
- Messages with JSON body `{type:"meetup_card", meetupId, title}` render as tappable cards in `messages/[id].tsx`.
- `parseMeetupCard(body)` detects by checking `body.startsWith('{')` then parsing.
