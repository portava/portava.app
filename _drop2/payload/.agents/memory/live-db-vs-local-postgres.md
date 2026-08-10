---
name: Never check production through DATABASE_URL
description: DATABASE_URL is read only by lib/db (pg/drizzle) and no api-server path reaches production through it; WHICH database it points at is an unverified runtime observation, not an in-tree fact. Check production via the Supabase Management API query endpoint.
---

Two different databases are reachable from this workspace, and only one of the two
access paths is production.

| | reached via | what it is |
|---|---|---|
| **Production** | `SUPABASE_URL` + service-role key (`@supabase/supabase-js`), or the Management API | the live Supabase project |
| **Not production** | `DATABASE_URL` (`pg` / drizzle) | read only by `lib/db`; no api-server route reaches production through it. **What it actually points at is not asserted anywhere in-tree** — see below |

**In-tree evidence — what it does and does not cover.**

Supported by the repo:

- `DATABASE_URL` is read in exactly four files, all under `lib/db/`
  (`lib/db/src/index.ts:7-13`, `lib/db/drizzle.config.ts:4-12` and their `.js` twins).
  **No api-server code path reaches production through it.**
- A local Postgres exists in this environment at
  `postgresql://postgres@helium:5432/heliumdb` — hardcoded as `LOCAL_PSQL_URL` in
  `scripts/src/check-db-triggers.test.ts:56`, `scripts/src/check-engagement-indexes.test.ts:52`
  and `scripts/src/saved-places-truncate-guard.test.ts:45`, and given as the example
  for `TRIGGER_PSQL_URL` in `scripts/check-db-triggers.sh:35,190`.
  `check-db-triggers.test.ts:55` calls it "Replit helium instance", and
  `saved-places-truncate-guard.test.ts:22-23` records that Supabase-managed objects
  (`auth.users`, `auth.uid()`, `discovery_places`) are *absent* from it.

**Not** supported by the repo: that `DATABASE_URL` is actually *set to* that helium
URL. Nothing in-tree asserts the variable's value — `lib/db` only reads it. Treat
"DATABASE_URL == the helium instance" as a runtime observation of this workspace,
not as a fact you can re-derive from the tree; re-check `echo $DATABASE_URL` before
relying on it.

Either way the rule is the same, and it is what matters: a query against
`DATABASE_URL` succeeds, returns rows, and tells you nothing about production —
the worst possible failure shape.

**How to apply:** to check production schema or data, POST to the Supabase
Management API query endpoint — the path `scripts/check-db-triggers.sh` uses:

```
POST https://api.supabase.com/v1/projects/{ref}/database/query
Authorization: Bearer $SUPABASE_ACCESS_TOKEN   (or $SUPABASE_PROJECT_TOKEN)
{"query": "<sql>"}
```

`{ref}` is the subdomain of `SUPABASE_URL` (read from `artifacts/api-server/.env`).
`psql` against production is unreachable from this workspace — see
[supabase-migration-access.md](supabase-migration-access.md). `TRIGGER_QUERY_MODE=psql`
in that script exists **only** for the local DB; never read its output as a
production result.
