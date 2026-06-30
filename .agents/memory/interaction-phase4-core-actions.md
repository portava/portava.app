---
name: Interaction Phase 4 — Core Actions
description: Gotchas encountered while building Phase 4 social-action endpoints (mute, save, report, blocks fix, follows update).
---

# Interaction Phase 4 — Core Actions

## sendError response shape
`sendError(res, code, message)` sends `{ error: code, message: ... }` — the machine-readable key is `error`, NOT `code`. Test assertions must check `body.error`, not `body.code`.

**Why:** Confusion led to test assertion checking wrong field, causing false failure.

## isUuid() rejects non-hex characters
`isUuid()` (from `lib/followDecisions.ts`) validates UUID format strictly. Characters like `r`, `g`, `z` are not hex digits and will fail the check, returning 400. Always use valid hex-only UUIDs in tests (0-9, a-f).

**Why:** Test 12 used `r0r0r0r0-…` which caused a 400 instead of the expected 200.

## Supabase builder has no .catch()
Supabase query builders are thenables (they have `.then()`) but are NOT Promises and do NOT have `.catch()`. TypeScript error: `Property 'catch' does not exist on type 'PostgrestFilterBuilder…'`.

**Fix:** Use `.then(undefined, () => {})` for fire-and-forget error suppression instead of `.catch(() => {})`.

**Why:** `.catch()` is Promise-specific; Supabase builders implement a thenable subset only.

## friend_request cooldown in permission engine
The Phase 3 permission engine (`interactionPermissions.ts`) only checked `message_request` and `nudge` cooldowns initially. `canAddFriend` did not check `friend_request` cooldowns.

**Fix:** Added a third parallel `user_interaction_cooldowns` query for `cooldown_type='friend_request'`; `canAddFriend` formula now includes `&& !friendReqCooldownActive`.

**Why:** Anti-retaliation cooldowns written on block/decline had no enforcement point until this was added.

## blocks.ts: sc declared after cooldown write
In `blocks.ts`, the `sc = getServiceClient()` assignment happens after the Compass eviction block, but anti-retaliation cooldowns were initially written using `(sc ?? client)`, referencing `sc` before its `const` declaration → TS2454.

**Fix:** Use `client` directly for the cooldown writes — `client` is already the service-role client (from `requireUser`) and is available immediately.

## blocks.ts: wrong column names for friend_requests cleanup
The original block route used `from_user`/`to_user` in the `friend_requests` delete clause, but the actual column names are `requester_id`/`recipient_id`. This silently failed to clean up friend requests on block.

**Fix:** Updated to `.or("and(requester_id.eq.${…},recipient_id.eq.${…}),and(…)")`.
