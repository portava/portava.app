---
name: _setTestClient also needs service client
description: _setTestClient only overrides requireUser's client; routes calling getServiceClient() directly hit the real DB unless you also override the service client slot.
---

## The rule

Whenever a route calls `getServiceClient()` directly (not via `requireUser`), the fake client injected by `_setTestClient` does NOT cover that call. The route hits the real Supabase DB, finds no matching row, and returns wrong data.

**Why:** `_testClient` in `http.ts` is only used inside `requireUser`. `getServiceClient()` in `supabase.ts` has its own separate `_testServiceClient` slot. The two were not wired together.

**How to apply:** The fix is already in place — `_setTestClient` now calls `_setTestServiceClient(client)` so both slots point to the same fake. No extra call needed from test files.

If you add a new route that calls `getServiceClient()` directly and write a test for it, the fix is transparent — `_setTestClient(fake, true)` covers both slots automatically.

## Symptom to watch for

Route test gets `403 { error: "age_not_eligible", reason: "dob_missing" }` (or similar "not found" / empty result) even though the fake client fixture has the data — this means a `getServiceClient()` call bypassed the fake and hit the real DB.
