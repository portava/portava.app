---
name: DB column-name drift trap
description: Verify Supabase column names against the LIVE schema (generated types can themselves be stale); PGRST204 insert-rejection class; Pick<> typing for reads.
---

# DB column-name drift trap

**Rule:** Before writing any new query against an existing table, confirm column names against the **live schema** (Supabase Management API `information_schema.columns` query — see supabase-migration-access.md). `artifacts/api-server/src/lib/database.types.ts` is a useful first check but is itself stale in this repo (it predates the canonical-locations work): it can both **contain columns the live DB doesn't have** (code compiles, then every insert fails) and **lack columns the live DB does have** (valid writes need a localized `as typeof row` cast past `RejectExcessProperties` until the types are regenerated). Then type selected rows with `Pick<Database["public"]["Tables"]["<table>"]["Row"], ...>` so property access is compile-checked.

**PGRST204 insert class:** PostgREST rejects an INSERT/UPDATE that names *any* unknown column — even if the value is null — failing the whole statement ("Could not find the 'X' column … in the schema cache"). A generic `db_error` on every attempt at one endpoint while a sibling endpoint works usually means exactly one bad column name in the payload. Traps hit so far: `posts` has `location_place_id` (not `place_id`) and **no `event_id`** (event membership lives in the separate `event_posts` join table); other tables (memories, stories) legitimately have their own `event_id`/`place_id` columns, so don't pattern-match across tables.

**Why:** A new map endpoint queried `user_location_state.latitude/longitude` (names recalled from earlier exploration); the real columns are `lat`/`lng`. Because the code was fail-closed, the bug produced no error — just silently zero results — and only a review round caught it. Coordinate column names are inconsistent across this schema (some tables use `lat`/`lng`, notes/other layers say latitude/longitude), so recall is unreliable.

**Legacy-table trap:** `CREATE TABLE IF NOT EXISTS` silently no-ops when an older table with the *same name but a different shape* pre-exists — code compiles, every query silently fails. The rent_buddy_* family is affected (availability was realigned; profiles/bookings still drifted). Also treat docs/migrations.md "applied" rows as claims, not facts — verify against information_schema (at least one migration was marked applied but never ran).

**How to apply:** grep `database.types.ts` for the table name first; add a `Pick<>`-typed row alias next to the query (cast the supabase result to it) so a future schema regen breaks the build instead of silently emptying responses. Also: for `user_location_state`, position freshness = `last_known_at` (written atomically with lat/lng on each fix), NOT `updated_at` (bumped by manual/permission-only updates).

## CHECK-constraint drift (2026-07-15)
Column existence isn't the only drift axis: DB CHECK constraints can lag the API's zod enums (e.g. a mode column CHECK allowing only legacy values while the route validates a newer five-value vocabulary → every PATCH 500s). When a PATCH 500s with a db_error but columns exist, compare `pg_get_constraintdef` against the route's enum. Also: `upsert(..., { onConflict })` must name the table's actual unique constraint columns — `user_account_states` is unique on (user_id, state), not user_id.
