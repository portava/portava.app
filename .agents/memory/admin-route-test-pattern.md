---
name: Admin route test pattern
description: Three gotchas when writing node:test contract tests for admin Express routes in this project
---

## Rule

When testing admin routes with the fake-client injection system:

1. **`_setTestClient(client, true)`** — the second argument is `ready: boolean`. Omitting it leaves `_testReady = null`, so `requireUser` falls back to `isServiceClientReady` which is `false` in CI/test (no env vars), and every request returns 503 before the route body runs.

2. **`requireAdmin` must return `sc`** — the guard function was refactored to return `{ userId, client, sc }` where `sc = getServiceClient() ?? client`. Route handlers must destructure `const { sc } = admin` rather than calling `getServiceClient()` themselves. Calling `getServiceClient()` directly in a route body returns `null` in test (no `SUPABASE_SERVICE_ROLE_KEY`) and produces a 503.

3. **Fake client ignores `.select()` column lists** — the in-memory fake builder returns all stored fields regardless of the SELECT string. If a route should never expose certain columns (e.g. `lat`/`lng` on suspicious GPS events for privacy), strip them explicitly before `res.json()`:
   ```ts
   const events = (data ?? []).map(({ lat: _lat, lng: _lng, ...rest }: Record<string, unknown>) => rest);
   ```

**Why:** The fake client is a lightweight in-memory builder — it doesn't parse SELECT column lists. Privacy-sensitive fields must be stripped at the application layer even though the real Supabase query would naturally omit them.

**How to apply:** Any new admin route test file must call `_setTestClient(client, true)` (not `_setTestClient(client)`), and any new admin route handler must use `const { sc } = await requireAdmin(req, res)` not `getServiceClient()`.
