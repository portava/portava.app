# ⚠️ Frozen — Do Not Add Files Here

This directory is the **legacy migrations folder** and has been fully reconciled
against the live Supabase schema as of **2026-07-17** (see `docs/migrations.md`).

**The canonical migration chain is `artifacts/api-server/src/migrations/`.**

All new database changes must go there. Adding a `.sql` file to _this_ directory
will cause the schema audit (`pnpm run audit:schema`) to fail immediately with a
clear error message.

## Why this directory exists

These files represent the original, ad-hoc migration history that predates the
canonical chain.  They are kept as a historical record only.  Many files here
were never applied to the live database, or were applied in a modified form — the
audit allowlist in `src/scripts/auditMigrationsVsLive.ts` documents the known
drift.

## What to do instead

Add your migration as the next numbered file in:

```
artifacts/api-server/src/migrations/
```

Follow the naming convention used there (e.g. `0150_my_change.sql`) and document
it in `docs/migrations.md`.
