# migrations/ — Archived / Historical

> **This directory is archived. Do not add new files here.**

## Status

This directory was the original migration scratch-pad used during the first weeks of the project (pre-August 2026). Its files represent early schema snapshots and were applied to the very first production database.

**It is not the canonical source of truth for any table.** Several files here diverge from the current live schema:

- `0043_tags_hashtags.sql` creates `tags.created_at` — the column that actually exists live.
- The _canonical_ `artifacts/api-server/src/migrations/` tree has its own `0043_tags_hashtags.sql` which created `tags.tagged_at` — a column that was **never applied** and does not exist live.
- Similar divergences exist in other files (location column names, rent-buddy table shapes, etc.).

When the two trees disagree, **the live schema is authoritative**. See [docs/migrations.md](../docs/migrations.md) for the full reconciliation notes.

## Where to add new migrations

All new database changes must go into:

```
artifacts/api-server/src/migrations/
```

and be documented in `docs/migrations.md`.

## CI guard

A frozen-dir guard (`pnpm run check:frozen-dir` from `artifacts/api-server`) enforces that no new `.sql` files appear here. Adding a new file will fail CI.
