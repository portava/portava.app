---
name: rentABuddy fake-client and notification test gotchas
description: Pitfalls when writing new tests in artifacts/api-server/src/test/rentABuddy.test.ts against the hand-rolled Supabase fake client and fire-and-forget notifications.
---

- Seeded `state.bookings["some-key"]` objects MUST include an explicit `id` field matching the object's own key. The fake client's generic select handler returns `Object.values(state.bookings)` filtered by column predicates — it never injects the map key as `id`. Route code that does `rows.map(r => r.id)` (e.g. building an `.in("id", ids)` batch update) silently gets `undefined` ids if you omit it, and the batch update then matches nothing — the booking status appears to just not change, with no error surfaced anywhere.

- `notifyBookingParty` (in `rentABuddy.ts`) is a fire-and-forget `void (async () => {...})()` — the route handler's response can return before the notification insert lands in `state.notifications`. Tests asserting on `state.notifications` after `await reqSweep()`/`await req(...)` must first `await new Promise((r) => setImmediate(r));` to flush the pending microtask, or the array will appear empty even when the code is correct.

- The row shape actually inserted into the fake `notifications` table by `NotificationService.create()` uses snake_case DB columns: `user_id` and `event_type` — not `userId`/`type`. Assert on those field names.

**Why:** hit all three while adding a regression test for the "buddy-profile lookup DB error must not silence the traveler's own auto-completion notification" behavior; wasted several failed runs chasing a phantom app bug that was actually a test-setup gap.
