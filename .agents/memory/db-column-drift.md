---
name: DB column-name drift trap
description: Verify Supabase column names against generated types, not migration files or notes; type query rows with Pick<> for compile-time protection.
---

# DB column-name drift trap

**Rule:** Before writing any new query against an existing table, confirm column names in `artifacts/api-server/src/lib/database.types.ts` (generated from the live schema) — never from migration files, exploration notes, or analogous tables. Then type the selected rows with `Pick<Database["public"]["Tables"]["<table>"]["Row"], ...>` so property access is compile-checked.

**Why:** A new map endpoint queried `user_location_state.latitude/longitude` (names recalled from earlier exploration); the real columns are `lat`/`lng`. Because the code was fail-closed, the bug produced no error — just silently zero results — and only a review round caught it. Coordinate column names are inconsistent across this schema (some tables use `lat`/`lng`, notes/other layers say latitude/longitude), so recall is unreliable.

**How to apply:** grep `database.types.ts` for the table name first; add a `Pick<>`-typed row alias next to the query (cast the supabase result to it) so a future schema regen breaks the build instead of silently emptying responses. Also: for `user_location_state`, position freshness = `last_known_at` (written atomically with lat/lng on each fix), NOT `updated_at` (bumped by manual/permission-only updates).
