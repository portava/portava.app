---
name: Supabase migration access
description: How to apply SQL migrations to the Supabase database from this workspace
---

# Supabase migration access

**Working path:** the Supabase Management API applies SQL directly and `SUPABASE_ACCESS_TOKEN` is valid:

```
POST https://api.supabase.com/v1/projects/{ref}/database/query
Authorization: Bearer $SUPABASE_ACCESS_TOKEN
{"query": "<sql>"}
```

`{ref}` = subdomain of `$SUPABASE_URL`. Returns `[]` on DDL success. Also works for read-only verification queries.

**Why:** direct psql to `db.{ref}.supabase.co` and all pooler hosts fail to connect from this workspace (tested exhaustively) — don't burn time on psql. An earlier session recorded the token as invalid; that is no longer true.

**How to apply:**
- POST the migration SQL to the Management API, verify with a follow-up query, then set the migration's row in `docs/migrations.md` to `applied <date>`.
- Watch for unapplied migrations: server code often degrades silently (column probes, best-effort selects), so a "pending" row in `docs/migrations.md` is the only reliable signal.
