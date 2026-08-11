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

## The CLI is one of two paths the guards do not face

There are four ways this repo can reach a Supabase database. Two are covered by
the Node guards: `@supabase/supabase-js` behind `ciSupabaseGuard`, and the
read-only audit path behind `ciProdReadOnlyAuditGuard`. The other two are not:

- **The Supabase CLI** (above) — a separate binary that reads stored link state.
- **Direct libpq**, via `TRIGGER_PSQL_URL` / `ENGAGEMENT_PSQL_URL` under
  `TRIGGER_QUERY_MODE=psql` / `ENGAGEMENT_QUERY_MODE=psql`
  (`scripts/check-db-triggers.sh:194-196`,
  `scripts/check-engagement-indexes.sh:91-94`).

The second is not merely unguarded — it is **structurally outside the
architecture**. Every assertion in `assert-nonprod-supabase.sh` resolves a
project ref and compares it. A libpq connection string carries no ref, so there
is nothing for the allowlist to bind to and no way to extend it to cover this.
It has to be a different check on a different key, and it is: both mechanisms
are now refused in CI outright, rather than inspected.

Neither refusal protects a developer laptop.

Two Supabase projects share the display name `travel-buddy`
(`ajrurzioarfkagpuxfnb`, production, and `zheztcvfhkwbouspesew`, paused). A name
never identifies a project here. Whatever tool you use, put the **ref** or a
connection string on the command line rather than relying on stored state.
