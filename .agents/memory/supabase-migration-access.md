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

## Rebuild-chain gotchas (learned 2026-07-16)
- Apply each migration file as its own Management API request: `ALTER TYPE ... ADD VALUE` on a pre-existing enum cannot be *used* in the same transaction — split the file at first usage of the new value (error 55P04).
- Bare `CREATE POLICY` collides when two migrations create the same policy name (0047 vs 0107 both made `rb_admin_actions_svc`); prepend `DROP POLICY IF EXISTS`.
- docs/migrations.md "applied" rows lie; always verify against information_schema before trusting them.

## Full-schema audit lessons (2026-07-17)
- A mechanical diff of every migration file vs live schema found ~40 files with missing objects; whole feature table-groups (compass, hidden gems, safe_return, post_hides) were absent. Don't assume older migrations are safe.
- Migration files themselves can be wrong vs live: `feature_flags` column is `flag` (several files say `key`); `highlights` uses `owner_id` not `user_id`; `highlight_replies` uses `replier_id`; `events` has `state` not `status`; `tags` has no `tagged_at`. Adapt statements to the live schema when applying old files.
- `CREATE TYPE IF NOT EXISTS` is invalid Postgres — wrap in a DO block catching `duplicate_object`.
- `information_schema.triggers` does NOT list TRUNCATE triggers — check `pg_trigger` before declaring one missing.
- Legacy `buddy_*` relations live as `rent_buddy_*` tables + `buddy_*` compat views (0134 rebuild); `buddy_bookings` view was only added by src/migrations/0147.
- There is a second legacy dir `artifacts/api-server/migrations/` (no `src/`) with its own chain (e.g. 0040_safe_return.sql creates `safe_return_sessions`).
