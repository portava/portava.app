---
name: Phase 8 fake-client pitfalls
description: Gotchas found during Phase 8 full verification — fake client data shape requirements and flag seeding gaps
---

## Geofence — trip_members must return `role` field

`getMemberRole` was refactored to read `(member as any).role` from the row instead of relying on a `.eq("role","member")` filter. Fake clients that return `{ user_id }` without a `role` field cause `getMemberRole` to fall back to "invited", blocking accepted members. Always return `{ user_id, role: "member" }` for accepted member rows.

**Why:** The refactor removed the DB-level role filter so the route can distinguish member vs invited without two separate queries.

**How to apply:** Any fake client for geofence / trip_members `maybeSingle()` must include `role`.

## safeReturn — admin.ts uses `.eq("flag",...)` but safeReturn.ts uses `.eq("key",...)`

`isFlagEnabled` in safeReturn.ts queries `.eq("key", flag)` (legacy column). `isSafeReturnAdminEnabled` in admin.ts queries `.eq("flag", "safe_return_admin_logs_enabled")`. Fake client feature_flags rows must expose BOTH columns: `{ key, flag: key, enabled }`.

**Why:** The two routers were written independently and use different column aliases.

**How to apply:** In safeReturn.test.ts `getRows("feature_flags")`, map entries as `{ key, flag: key, enabled }`.

## rentABuddy — nightlife flag must be seeded or age/category checks are unreachable

`checkRentBuddyAccess` checks the global `RENT_BUDDY_NIGHTLIFE_ENABLED` feature flag before age or category-approval checks. If the flag is absent (fail-closed → false), all nightlife bookings return `nightlife_disabled` regardless of the test's intent.

**Why:** Flag is fail-closed by design; DB returns null when the row doesn't exist → `Boolean(null?.enabled)` = false.

**How to apply:**
- `setupState()` now merges featureFlags via destructured `extraFlags` so `RENT_BUDDY_NIGHTLIFE_ENABLED` is always in the default set.
- `setupBookingEnforcement()` (assigns `state` directly, bypasses `setupState`) must also include `RENT_BUDDY_NIGHTLIFE_ENABLED` in its featureFlags literal.

## Fire-and-forget `.then(undefined, handler)` crashes fake-client insert

Routes that write to a table fire-and-forget use `.then(undefined, onRejected)`. Fake client `insert` returning `{ then: (res: Function) => res(result) }` calls `undefined(result)` — throwing a TypeError that Express catches and returns 500.

**Why:** Two-arg `.then(onFulfilled, onRejected)` — when onFulfilled is `undefined`, calling it throws.

**How to apply:** Fake client `insert` result's `then` must guard:
```ts
then: (onFulfilled?: Function | null, _onRejected?: Function | null) => {
  if (typeof onFulfilled === 'function') onFulfilled(result);
}
```

## Geofence — late check-in (window_closed) should succeed with ok=true

The check-in route had an early return for `window_closed` that made the `isLate` / `late_check_in` event logic at line 537 dead code. The test expects late check-ins to be admitted (ok=true) but logged as late. Fix: remove the early return; the `isLate` flag handles the trust event correctly.
