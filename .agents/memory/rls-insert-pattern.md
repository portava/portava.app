---
name: Supabase RLS insert pattern
description: All DB inserts in route handlers must use the service role client, not the user JWT client
---

## Rule

Every INSERT (and UPDATE/DELETE that the user owns) in the API server must use `getServiceClient()`, not `auth.client` from `requireUser`.

**Why:** The Supabase project rotated its JWT signing key to ECC P-256. PostgREST hasn't fully picked up the new key, so `auth.uid()` returns NULL when the user JWT client is used for PostgREST queries. RLS policies that check `auth.uid() = user_id` then fail (no match), causing inserts to silently return no rows or an RLS violation.

The service role client bypasses RLS entirely and uses the service key — this is safe because the route handler already verified the user via `requireUser` (which calls Auth directly, not PostgREST).

**How to apply:**
- At the top of every write route handler: `const sc = getServiceClient(); if (!sc) { sendError(res, "server_not_configured"); return; }`
- Pass `sc` (not `client`) to all service functions that do inserts/updates.
- Pass `user.id` explicitly so the service function can set the `user_id` column.
- Known affected tables: trips, passport_memories, passport_stamps — any new table with RLS based on `auth.uid()` will have the same issue.

**Frontend mobile code must also use the API server for mutations:**
- `supabase.from('trips').update(...)` and `.delete(...)` from the mobile client use the user JWT, which hits the same P-256/auth.uid() NULL issue — updates and deletes silently succeed (HTTP 200) but affect 0 rows.
- Fix: route all trip mutations through the API server (PATCH/DELETE `/api/trips/:tripId`) using `freshToken()` + `fetch`.
- `getTrip` (SELECT) is fine as Supabase direct if the RLS SELECT policy doesn't rely on `auth.uid()` or is permissive for reads.

**Pattern (from trips route, confirmed working):**
```typescript
const auth = await requireUser(req, res);
if (!auth) return;
const { user } = auth;

const sc = getServiceClient();
if (!sc) { sendError(res, "server_not_configured"); return; }

const result = await insertSomething(sc, { userId: user.id, ...data });
```
