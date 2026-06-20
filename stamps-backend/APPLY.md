# Apply migration 0008 — GPS stamp earning

## One-time setup

Open your Supabase project → SQL Editor → New query. Paste and run
`stamps-backend/migrations/0008_stamps.sql`.

## What this creates

| Object | Purpose |
|--------|---------|
| `stamps` table | One row per (user, kind, city); check-ins increment `check_in_count` |
| `upsert_city_stamp()` RPC | Atomic insert-or-increment so concurrent check-ins don't create duplicates |

## Security model

- `stamps` RLS blocks all direct client writes (`with check (false)`)
- Only the API server (service role) writes stamps, via the `upsert_city_stamp` RPC  
- The server decides `stamp_eligible` in `verifyLocation()` — never the client
- `stamps` only stores labels and counts — no GPS coordinates are persisted here

## Verify the migration ran

```sql
select table_name from information_schema.tables
where table_schema = 'public' and table_name = 'stamps';
-- Should return 1 row

select proname from pg_proc where proname = 'upsert_city_stamp';
-- Should return 1 row
```

## Depends on migration 0007

`stamps.postcard_id` references `passport_postcards.id`.
Apply `friends-backend/migrations/0007_friends.sql` first if you haven't already — 
though `stamps` has no FK to the friends tables, it does reference `passport_postcards`
which must exist (created by the Passport migration).
