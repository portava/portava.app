# `supabase/` is archival. Do not use it with the Supabase CLI.

This directory is **not** the authoritative migration set and is **not** a live
Supabase CLI project. It exists because other files cite these SQL files as
evidence. If you landed here by grep, read this before running anything.

## What this is

`migrations/` holds 14 `.sql` files (0015–0108) that were applied to production
long ago, under an early numbering scheme. They are kept as a **record**, not as
something to replay. Several are cited by name as the evidence for documented
conclusions — for example
`artifacts/api-server/src/migrations/2079_is_official_privileged_both_directions.sql`
cites `migrations/0106_profiles_is_official.sql` as the file that creates the
`is_official` machinery, in a comment that is itself a post-mortem about
searching only one of this repo's five migration roots. Deleting these files
would destroy that evidence, which is why they are still here.

## The authoritative set

`artifacts/api-server/src/migrations/` is the live series. Migrations are applied
to the database via the **Supabase Management API**
(`POST /v1/projects/{ref}/database/query`), recorded in
`artifacts/api-server/docs/migrations.md` and `docs/migrations.md`. That is the
only sanctioned path. See also `docs/production-migration-runbook.md` §1.2.

## Why the CLI must not be pointed here

Do not run `supabase init`, `supabase link`, or `supabase db push` in this
workspace.

- These 14 files are a **stale partial set**, not a replayable history. They are
  not idempotent (`0101_search_history.sql` and `0102_universal_stamp_catalog.sql`
  both contain unguarded DDL).
- Production has never had its CLI migration history table
  (`supabase_migrations.schema_migrations`) written by this repo, because
  migrations here go through the Management API. A `db push` would therefore see
  an empty history and attempt **all 14** against whatever project it resolved.
- The CLI resolves its target from `supabase/.temp/linked-project.json`, which is
  **not** governed by any guard in this repo. `ciSupabaseGuard`,
  `supabaseTargetPolicy`, and `ciProdReadOnlyAuditGuard` all sit in front of
  `@supabase/supabase-js` client construction in Node; `assert-nonprod-supabase.sh`
  compares environment variables before a job runs. None of them can see a CLI
  invocation. That file was committed to this repo pinning the **production**
  ref until 2026-08-11, when it was removed for exactly this reason — a
  `supabase init` would have made it authoritative again with no prompt and no
  gate.

Two Supabase projects share the display name `travel-buddy`
(`ajrurzioarfkagpuxfnb`, production, and `zheztcvfhkwbouspesew`, paused). A name
never identifies a project here. Whatever tool you use, put the **ref** or a
connection string on the command line rather than relying on stored state.
