---
name: Spec alias URL rewrite
description: How /api/buddy-bookings/* and other alias URL families are routed, and the dead-route trap
---

The API server rewrites alias URL families (e.g. `/api/buddy-bookings/*` → `/api/rent-a-buddy/bookings/*`) in a `specAliasRewrite` middleware (`src/lib/specAliasRewrite.ts`) BEFORE routing.

**Rule:** register routes only at the canonical `/api/rent-a-buddy/...` paths. A route registered at an alias path (e.g. `/api/buddy-bookings/:id/foo`) is unreachable in production — the rewrite converts the URL away before any router sees it — yet it still passes tests that mount the router directly.

**Why:** two parallel change-request/rebook implementations diverged this way; blocked-date checks had to be duplicated and the dead-path copies silently masked which code actually served production.

**How to apply:** when adding/testing rent-a-buddy routes, mount `specAliasRewrite` in the test app and hit the alias URLs the mobile client actually calls; keep one canonical handler per endpoint.
