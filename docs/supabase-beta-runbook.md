# portava-beta — building the beta Supabase environment

*Replaces the 2026-07-03 "Supabase Production SQL Runbook — Beta Launch" (a
hand-applied 0077–0089 checklist against production). That procedure is
history; nothing in this document touches production.*

The beta database is built by one reviewed, repeatable, fail-closed workflow:
[`.github/workflows/beta-db.yml`](../.github/workflows/beta-db.yml). It runs on
GitHub Actions, talks to Supabase only through the Management API, and builds
the project from the repository's schema truth — never from
`src/lib/database.types.ts`, and never by hand in the SQL editor.

## The three projects

| Project | Ref | Role here |
| --- | --- | --- |
| production | `ajrurzioarfkagpuxfnb` | **Never touched, never read.** Every script and workflow involved refuses it by ref (`KNOWN_PROD_PROJECT_REF`). |
| portava-ci | `hwokxgbmezheskbzskfr` | The CI reference database (repo variable `CI_SUPABASE_PROJECT_REF`). Beta's reference rows are **read** from it, with SELECTs inside read-only transactions. |
| portava-beta | `emfpckykpzfturllshly` | The target. `https://emfpckykpzfturllshly.supabase.co`, created 2026-10-06 on the owner's authorization, Postgres 17, us-east-1. |

Projects are compared by ref only. Display names are not identities (the CI
credential once listed two different projects with the same name).

## What the workflow builds

Schema truth is two inputs, the same two the local replay
(`artifacts/api-server/scripts/local-db/up.sh`) uses:

1. **The baseline** — `artifacts/api-server/baseline/20260819_baseline_structure.sql`,
   a pg_dump 17 structure-only dump of production as of 2026-08-19.
2. **The canonical chain** — `artifacts/api-server/src/migrations/*.sql`, from
   `2093_` on. Every file sorting before `2093_` (280 of them) is already in the
   baseline; `2093_` is the first whose objects it lacks.

Because the baseline has no rows, the rows that pre-`2093_` migrations seeded
come from a **reference snapshot** of portava-ci.

The workflow has four jobs:

| Job | Touches | What it does |
| --- | --- | --- |
| `preflight` | nothing | `assert-ci-scripts.mjs`; the `confirm`/`reset` inputs must be exact. |
| `reference-snapshot` | portava-ci, **read-only** | `db:beta-reference-snapshot` → `beta-reference-snapshot.json`, uploaded as an artifact. |
| `beta-bootstrap` | portava-beta | `db:beta-bootstrap`, then `db:apply-migrations:dry-run`, the apply loop (`db:apply-migrations`, with `db:beta-bootstrap --apply-refused` where it stops on a refused-by-shape file), `certify:migrations`, `audit:schema`. |
| `verdict` | nothing | `live-db-verdict.sh`: anything skipped or cancelled is not a pass. |

### `db:beta-bootstrap` step by step (`scripts/src/beta-bootstrap.ts`)

- **a. Guards.** The repo's strict front door (`ciSupabaseGuard.mjs`) **and** a
  hard-coded `BETA_PROJECT_REF`. Any other ref exits 2 — portava-ci included,
  even if the allowlist were pointed at it — because this step restores a
  baseline over whatever it finds.
- **b. Emptiness.** `auth.users` must be empty, always. `public` may hold no
  base table except a leftover `schema_migration_ledger` (and that ledger may
  record no chain file). Otherwise exit 2, unless the reset was requested.
- **c. Extensions.** `postgis` and `pg_trgm` are created in `public` (three
  generated columns call `public.st_setsrid(public.st_makepoint(…))::public.geography`);
  the census is then compared with portava-ci's: `pgcrypto` (a column default
  calls `extensions.gen_random_bytes`) and `uuid-ossp` in `extensions`, and
  `plpgsql`, are required; `pg_stat_statements` and `supabase_vault` are
  expected and only warned about.
  `unaccent` is deliberately not installed: its one baseline use is inside the
  plpgsql body of `public.upsert_city_stamp()`, which is not resolved at create
  time and already tolerates the extension's absence; portava-ci lacks it too.
- **d. Baseline plan.** 5,200 top-level statements (split with the applier's
  `maskNonCode`); 5,066 executed; 134 skipped by four named rules, each printed
  with its first 100 characters:

  | Rule | Count | Why |
  | --- | --- | --- |
  | `dump-session-preamble` | 13 | pg_dump's own `SET …` and `set_config('search_path', '', false)`; a fixed prelude runs instead |
  | `platform-schema` | 2 | `CREATE SCHEMA public` / `storage` exist on every project |
  | `storage-platform-object` | 107 | the Storage service owns schema `storage` (types, functions, tables, indexes, triggers, constraints, RLS switches, grants, default privileges) |
  | `supabase-admin-default-privileges` | 12 | `postgres` cannot alter `supabase_admin`'s default privileges; Supabase sets them |

  The four app policies on `storage.objects` (`post_media_storage_owner_delete`,
  `post_media_storage_owner_insert`, `stamp_artwork_public_read`,
  `stamp_artwork_service_write`) are **kept**. These counts are pinned in
  `BASELINE_SHAPE` and in `scripts/src/beta-bootstrap.test.ts`; a refreshed
  baseline that moves any of them makes the script refuse until the rules are
  re-read.
- **e. Execution.** 26 batches of ≤ 200 statements. Each batch is one
  Management API call: a `SET LOCAL` prelude and one
  `SELECT … FROM beta_bootstrap.run(ARRAY[$bb$…$bb$, …])`. `run()` (a scratch
  function, dropped at the end) executes each statement in its own
  sub-transaction and tolerates only already-exists errors (42P06, 42P07, 42710,
  42723) — on a first run that count must be 0. Any other error re-raises, the
  batch rolls back whole, and the log prints the failing statement in full.
- **f. Census.** Public tables (387), views (10), policies (737), functions
  (59), enum types (69) and the four `storage.objects` policies must equal the
  baseline's; any delta is listed and exits 1.
- **g. Reference rows.** The snapshot is validated against the current
  baseline, then imported table by table with
  `INSERT … ON CONFLICT (primary key) DO NOTHING`; `storage.buckets` rows
  (`id, name, public, file_size_limit, allowed_mime_types`) likewise.
- **h. Ledger.** `2254_schema_migration_ledger.sql`'s DDL (its 382-row INSERT
  and its postcondition cut) plus one row per pre-`2093_` file with
  `checksum='backfill'`, `applied_by='backfill'` — 2254's own vocabulary — in
  one transaction. Every chain file has no row, so the **unchanged** applier
  treats all of them as pending, and 2254 later runs as an ordinary pending
  migration.
- **i. Refused-by-shape preview.** The chain files the applier will refuse are
  computed against the ledger just written and printed (2182 and 2190 today);
  they are applied later, where the applier stops on each — see below.

### The two files the applier refuses by shape — applied by the bootstrap

The unchanged applier wraps every migration in ONE transaction together with
its ledger row, so it refuses a file whose own transaction control it cannot
wrap, and its header names the remedy: *apply it by hand, verify it, then
INSERT its ledger row with `applied_by='manual'`*. On portava-ci such files
sit under 2254's backfill rows and are never classified. On beta every chain
file is pending, so the applier meets them. Measured by running
`classifyMigration` over every chain file at or after `2093_` with no ledger
row, the set is exactly:

| File | Why the applier refuses it |
| --- | --- |
| `2182_close_authz_rpc_oracle.sql` | a `BEGIN … COMMIT` body followed by a top-level `BEGIN … ROLLBACK` verification probe (line 167) |
| `2190_memory_lifecycle_fixes.sql` | two `BEGIN … COMMIT` blocks (lines 61–362 and 376–407) |

`scripts/src/beta-bootstrap.test.ts` pins that set, so a newly refused file
turns the test red instead of being absorbed.

The bootstrap is the hand: `db:beta-bootstrap --apply-refused <file>`. It
refuses unless the file is in the computed set, has no ledger row, and every
chain file sorting before it already has one — i.e. the applier stopped
exactly there. It then sends the file's bytes **verbatim** as one Management
API call (not through `beta_bootstrap.run()`: PL/pgSQL cannot execute
`BEGIN`/`COMMIT`/`ROLLBACK`; verbatim is what the SQL editor does — the file's
own `BEGIN … COMMIT` commits its body and its `BEGIN … ROLLBACK` probe rolls
itself back), and in a **second** call inserts the ledger row:
`applied_by='manual'`, `checksum` = the applier's `checksumOf(bytes)`, `notes`
= `beta-bootstrap 2026-10-06: applied verbatim by the bootstrap because the
applier refuses its shape (<first sentence of the refusal>)`,
`ON CONFLICT (filename) DO NOTHING`.

**This is not atomic.** The apply and the row are two calls, so a failure
between them leaves the file applied and unrecorded; the script says so and
names the row to insert by hand before the applier runs again. If the
verbatim call itself fails, no row is written and the file's own
preconditions and transaction blocks decide what persisted. The mode is
idempotent: a file that already has a ledger row is skipped.

Because 2182 and 2190 depend on the files before them, and the files after
them depend on them, the hand apply can only happen where the applier stops.
The workflow's apply step is therefore a bounded loop:

1. `db:apply-migrations` — applies everything before 2182, stops at 2182 (`refused`).
2. `db:beta-bootstrap --apply-refused 2182_close_authz_rpc_oracle.sql`
3. `db:apply-migrations` — continues, stops at 2190 (`refused`).
4. `db:beta-bootstrap --apply-refused 2190_memory_lifecycle_fixes.sql`
5. `db:apply-migrations` — to the end.

The loop continues only when the applier exits 1 reporting a `refused` stop
for a file the same run's dry run listed (and the bootstrap re-checks the
set); any other applier failure ends it red. It runs the applier at most
(refused files + 1) times. The dry run before it exits 1 whenever a pending
file is refused; that is accepted only when `db:beta-bootstrap --check-refused`
confirms every file it named is in the refused set.

### The reference snapshot (`scripts/src/beta-reference-snapshot.ts`)

Allowlist (nothing else is read): `feature_flags`, `stamp_definitions`,
`stamp_collections`, `country_essentials`, `compass_intent_modes`,
`compass_frontload_rules`, `price_baselines`, `destination_identities`,
`geofence_admin_settings`, `rent_buddy_global_controls`,
`rent_buddy_city_rollouts`, and `storage.buckets`.

- Only the columns the baseline's `CREATE TABLE` declares, each read as text.
- NULLed: every column the baseline declares as a foreign key to
  `public.profiles` or `auth.users` (`rent_buddy_global_controls.updated_by_admin_id`,
  `rent_buddy_city_rollouts.status_changed_by`), plus the user-id column that
  has no FK (`price_baselines.verified_by`).
- `feature_flags.enabled` is `false` on **every** row.
- A table over 20,000 rows is refused.
- `place_coverage_buckets` is **not** on the list: no migration seeds it (it is
  a runtime post counter), and its primary key is a NOT NULL foreign key to
  `public.places`, which is not copied, so any row would fail the import.

## How to dispatch it

`workflow_dispatch` workflows can only be started once the file is on the
default branch.

```bash
gh workflow run beta-db.yml -f confirm=BOOTSTRAP-BETA
```

Then follow it with `gh run watch`. The `confirm` input must be exactly
`BOOTSTRAP-BETA`, or nothing runs.

### Reset

```bash
gh workflow run beta-db.yml -f confirm=BOOTSTRAP-BETA -f reset=RESET-BETA
```

The reset runs as one transaction before the build: drop the scratch schema and
the four app policies on `storage.objects`, drop every extension living in
`public` (PostGIS objects are platform-owned, so dropping the schema alone would
fail on them), `DROP SCHEMA public CASCADE`, `CREATE SCHEMA public`, and restore
Supabase's default grants (`USAGE` to `anon, authenticated, service_role`,
`ALL` to `postgres`, and `postgres`'s default privileges on tables, sequences
and functions). It is refused when `auth.users` has any row — users are the
one thing a reset destroys that the build cannot recreate. A `reset` value other
than empty or `RESET-BETA` fails the preflight instead of running without it.

Use the reset after any failed run: batches commit one by one, so a failure
partway leaves tables behind and the next plain run is refused as not empty.

## What it refuses, and why

| Refusal | Exit | Why |
| --- | --- | --- |
| target ref is not `emfpckykpzfturllshly` | 2 | restoring a baseline over portava-ci or anything else is never intended |
| production ref, anywhere | 2 | twice over: the allowlist's secondary assertion and the script's own check |
| no Management API token | 2 | a build that did not run is not a skip |
| `auth.users` not empty (even with reset) | 2 | a project people have signed in to is not a bootstrap target |
| `public` not empty, no reset | 2 | the baseline is restored over whatever is there |
| baseline shape changed | 2 | the skip rules must be re-read against a new dump |
| snapshot missing, from another baseline, carrying an unlisted table, a non-NULL user-id column, or an enabled flag | 2 | the import accepts only what the plan allows |
| `--apply-refused` for a file the applier does not refuse by shape, or before every earlier chain file is recorded | 2 | only the applier's refused files are hand-applied, and only where it stopped |
| `--apply-refused` for a file that already has a ledger row | 0 (skips) | idempotent |
| a statement, the census, an import, the ledger check, a verbatim apply or its ledger row failed | 1 | the log names the statement and the error |

## What it does NOT configure

These are separate steps, deliberately outside this workflow:

- **Auth**: providers, redirect URLs, SMTP, email templates, hooks, MFA, rate
  limits. `auth.users` stays empty.
- **Storage** beyond the bucket rows: CORS, image transformation, and any
  per-bucket setting not in `id, name, public, file_size_limit,
  allowed_mime_types`. No objects are copied.
- **API keys** and the **runtime environment**: the beta API server's
  `SUPABASE_URL`, service-role and anon keys, and the mobile app's
  `EXPO_PUBLIC_*` values are set where those services are configured.
- **Feature-flag policy**: every flag arrives OFF. Which flags beta turns on is
  an explicit owner decision, made after the build.
- Realtime publication membership, Edge Functions, database webhooks, Vault
  secrets, scheduled jobs.

## What could stop the first run

In the order the workflow would meet them:

- **Token scope.** The job uses the `ci-nonprod-supabase` environment's
  `SUPABASE_PROJECT_TOKEN`, an account-level Management API token. If it is
  project-scoped it gets 401/403 on beta's first query. That is an external
  prerequisite (an account-level token, or a beta-scoped token in its own
  environment), not something to work around in code.
- **Management API limits.** Baseline batches are 5–108 KB of SQL (32 KB on
  average); each call has a 10-minute client timeout. A request that does not
  complete leaves its batch's outcome unknown — re-dispatch with the reset
  rather than retrying over it.
- **Chain order — merge #632 first.** The beta apply needs the declared
  apply-order overrides added to the applier by PR #632 (its entries are
  documented there). Without it, the chain apply stops at the first
  chain-order defect.
- **The refused-by-shape files.** Handled by the loop above. A verbatim apply
  that fails stops the loop with the file's own error.
- **Other replay gaps.** `artifacts/api-server/scripts/local-db/KNOWN_UNREPLAYABLE.json`
  records the files that fail when the chain is replayed onto this baseline on
  plain PostgreSQL. `2490` (the `MAINTAIN` privilege) is PostgreSQL-16-only and
  does not apply to beta's 17; `2970` needs the stamp slugs the reference
  snapshot now supplies; the intel files (`2276`–`2292`, `3002`, `3003`,
  `3310`) and `2140` are the most likely next stops if #632's overrides do not
  cover them.
