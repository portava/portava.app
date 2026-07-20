---
name: Fake-client builder drift
description: Hand-written Supabase fakes silently break when routes gain new query-builder calls
---
Routes gaining new builder calls (`maybeSingle`, `gte/lte`, `order`, `contains`) turn out-of-list test fakes into 500s or silent fallbacks — e.g. `requireUser` now probes `profiles.account_status` via `.maybeSingle()`, so every fake lacking it 500s before route validation; pulse Compass ranking threw on missing `.gte` and silently fell back to unranked order.

**Why:** fakes are per-file and hand-written; a route change compiles clean but only fails when the fake is executed — and only curated files run in CI.

**How to apply:** when adding a builder method to a shared auth/route path, grep `src/test/` fakes for the affected table; when a validation test 500s, check the fake's chain methods before suspecting the route. Triage record: `artifacts/api-server/docs/test-triage-2026-07.md`.
