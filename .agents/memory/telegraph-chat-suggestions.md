---
name: Telegraph Chat Suggestions backend pattern
description: Architecture decisions for Task #15 — suggestion generation, privacy, rate-limiting
---

## Pattern: inline intent detection on GET

`GET /api/threads/:threadId/telegraph/suggestions?message=<text>` doubles as
both a "fetch existing" and "run detection + persist new" endpoint. The
`?message=` query param triggers `detectIntent` → `resolvePrivacyVerdict` →
`buildSuggestions` → DB insert in a single request so the tray just calls one
endpoint after each send.

**Why:** Avoids a separate POST-then-GET round trip from the mobile client.

**How to apply:** When adding new suggestion sources (e.g. future trip-event
detection), add them to `telegraphIntent.ts` PATTERNS array and extend
`buildSuggestions` in `telegraphChatSuggestions.ts`.

## Privacy hard rules

- `TelegraphChatPrivacyVerdict` never exposes lat/lng or any live-location field.
- Trip context: `canUseTripContext` only true when user is `owner` or `member`
  in `trip_members`.
- Circle context: `canUseCircleContext` only true when user is in
  `circle_memberships` or is the owner.
- Non-members get `canShowRecommendation: false` → empty suggestions array.

## Rate limiting

- Max 3 suggestions per (user, thread) per hour (`checkRateLimit`).
- 30-minute cooldown per (user, thread, intentType) (`checkCooldown`).
- Both checks run server-side before any DB insert.

## Testing pattern

Uses `node --import tsx/esm --test` with an inline `makeFakeClient` that
simulates full `SupabaseClient` chaining. No `vi.doMock` or module-level mocks.
Fake client handles: `.select().eq().in().gte().maybeSingle()`, insert with
`{ count, head }` options for rate-limit check.
