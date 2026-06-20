# Apply migration 0008 — GPS stamp earning

## One-time setup

Open your Supabase project → SQL Editor → New query. Paste and run
`stamps-backend/migrations/0008_stamps.sql`.

## What this creates

| Object | Purpose |
|--------|---------|
| `stamps` table | One row per (user, kind, city); check-ins increment `check_in_count` |
| `upsert_city_stamp()` RPC | Atomic insert-or-increment callable only by `service_role` |

## Security model

- **RLS blocks all direct writes** — `stamps_insert` policy uses `with check (false)`,
  so no client (anon or authenticated) can INSERT directly via PostgREST.
- **`upsert_city_stamp` RPC is locked down** — execution is revoked from `PUBLIC`,
  `anon`, and `authenticated`. PostgREST cannot expose it; clients calling
  `supabase.rpc('upsert_city_stamp', ...)` get a permission-denied error.
- **Defense-in-depth inside the function** — a `current_user` check raises an
  exception if the caller is not `service_role`/`postgres`/`supabase_admin`.
  This is a secondary guard that fires even if the REVOKE grants are ever altered.
- **Only the API server (service role) can write stamps** — the post-creation flow
  in `POST /api/posts` calls `upsertCityStamp()` only when `verifyLocation()`
  returns `stampEligible: true` and the server has confirmed GPS proximity.
  No client-supplied flag can bypass this check.

## Stamp earning conditions (enforced server-side)

A city stamp is created or incremented **only** when all of the following hold:
1. `locationSource === 'gps'` in the post payload
2. Both tagged coordinates (`locationLat`/`locationLng`) AND user GPS (`userGpsLat`/`userGpsLng`) are present
3. Haversine distance ≤ 1609 m (~1 mile)
4. A `passport_postcard` was successfully created from the post

Manual-tag posts (no GPS) never earn stamps.

## Verify the migration ran

```sql
select table_name from information_schema.tables
where table_schema = 'public' and table_name = 'stamps';
-- Should return 1 row

select proname from pg_proc where proname = 'upsert_city_stamp';
-- Should return 1 row

-- Confirm REVOKE took effect (should return 0 rows for anon/authenticated):
select grantee, privilege_type
from information_schema.routine_privileges
where routine_name = 'upsert_city_stamp'
  and grantee in ('anon', 'authenticated', 'public');
-- Expected: 0 rows
```

## Depends on Passport migration

`stamps.postcard_id` references `passport_postcards.id`. The Passport migration
(which creates `passport_postcards`) must be applied first.
