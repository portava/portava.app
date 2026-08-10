# Bootstrapping the CI Supabase project

**Audience:** a human operator with dashboard access to both Supabase projects and
admin access to this GitHub repo. Not a script. Several steps here require judgement
and none of them should be automated behind a green checkmark.

| | project ref |
| --- | --- |
| **Production** — never a target of CI | `ajrurzioarfkagpuxfnb` |
| **CI (non-production), currently EMPTY** | `hwokxgbmezheskbzskfr` |

The production ref is pinned at `.github/workflows/live-db.yml:150` as
`KNOWN_PROD_PROJECT_REF` and matches `.replit:145,148`. The CI ref is what you will
set as `CI_SUPABASE_PROJECT_REF`.

**You will need both refs in two places:** the repo/workflow configuration (§3 step
7) *and* your own shell (§5.2). The workflow's `env:` block does not reach your
terminal, and every check in this document refuses to run without both.

`.github/workflows/live-db.yml` cannot produce a meaningful result against an empty
database. This document takes the CI project from empty to a state where the
workflow's verdict means something — and, just as importantly, tells you what its
verdict still does **not** mean.

---

## 0. The one thing to understand before doing anything

**A green live-db run on a database with the right shape and no rows is the failure
mode this whole CI tier exists to eliminate.** Three of its checks pass loudly on
such a database, having verified nothing. They are enumerated in §4 with the exact
lines that do it. If you bootstrap wrongly and the workflow goes green, you have not
succeeded — you have reproduced the original problem with more infrastructure.

**Be precise about *which* empty, because it changes which checks are dangerous.**
The CI project today has **no tables at all**; the state you are bootstrapping it
into is **schema restored, no rows**. Those are not the same failure surface:

| | no tables (today) | schema restored, unseeded (after §3) |
|---|---|---|
| `check:missing-live-columns` | **vacuous pass** (`:412`) | meaningful |
| `check:media-objects` | **errors** — `post_media` does not exist, the Management API returns non-2xx and `checkMediaObjects.ts:94` throws | **vacuous pass** (`:134`) |
| RLS anon "returns empty" trio | **fails** — `assert.ifError(error)` runs *before* `deepEqual(data, [])` and PostgREST errors on an unknown relation | **vacuous pass** |

So the danger is not the project you have now — a table-less database is loud in two
of the three. The danger is the project you are about to create. All three are
vacuous on a correctly-restored, unseeded schema, which is exactly where §3 leaves
you. Read §4 with that state in mind, not this one.

Everything below is arranged so that you never have to trust a green run to know
whether the bootstrap worked.

---

## 1. The load method: schema-only restore from production

**Do this:** take a schema-only dump of the production database, restore it into the
CI project, then run the repo's own seeders to create the minimum fixture rows.

**Do not do this:** replay `artifacts/api-server/src/migrations/*.sql` (255 files) into
the CI project.

### Why migration replay is rejected — read this before "simplifying" it back

This is not a stylistic preference. Migration replay makes the repo's two
drift-detection checks **vacuous by construction**: they would compare the migration
files to themselves and always pass.

`artifacts/api-server/src/scripts/auditMigrationsVsLive.ts` works like this:

- **Left side (`auditMigrationsVsLive.ts:61`):** `MIGRATION_DIRS = [resolve(__dir,
  "../migrations")]`. Every file in `src/migrations/` is read and regex-parsed into
  *Claims* — `CREATE TABLE` and its column list, `CREATE VIEW`, `ALTER TABLE ADD
  COLUMN`, `CREATE FUNCTION`, `CREATE INDEX`, `CREATE POLICY`, `CREATE TYPE AS ENUM`,
  `ALTER TYPE ADD VALUE`, `CREATE TRIGGER`.
- **Right side (`:231`–`:253`):** the live catalogs, over the Management API —
  `pg_class`, `information_schema.columns`, `pg_proc`, `pg_indexes`, `pg_policies`,
  `pg_type`/`pg_enum`, `pg_trigger`.
- **The comparison (`isMissing()`, `:535`):** literally `return
  !live.relations.has(key)` / `!live.columns.has(key)`. It asks one question, in one
  direction: *does every object named by the files exist live?*

Now replay those same 255 files into the CI project. Every object the parser can see
was, by construction, just executed by the same files the parser read. The audit
prints `✔ Live schema contains every object claimed by the migrations` and exits 0,
having compared the file tree to itself. The two caveats do not rescue it:

- The regex parser can only **under**-claim relative to what a replay actually
  creates. That makes the pass *more* certain, not less.
- It would go red only if a file were unreplayable at all — at which point you have
  paid for a 255-file, live-Postgres SQL linter and called it a drift audit.

`live-db.yml:327` says *"EXPECT THIS JOB TO BE RED ON ITS FIRST RUN. The drift is
real."* That sentence is only true against a database **that did not come from these
files.** Replay quietly converts a documented, expected red into a permanent,
meaningless green, and nothing in the workflow will ever tell you it happened.

`checkMissingLiveColumns.ts` takes the same migration files as its left-hand input
(`:58`) and inherits the same vacuity.

If you are reading this because replay looks simpler: it is simpler, and it is
simpler *because it does less*. The cost is not a slower bootstrap; the cost is that
`schema-drift` becomes a job that cannot fail.

### What schema-only restore buys, honestly

It gives the audits an **independent right-hand side** — a schema whose provenance is
production, not this repo — so "migrations claim X, live does not have X" becomes a
real question again. That is the entire argument. It is a necessary condition, not a
sufficient one; see §7 for what it still cannot catch.

---

## 2. What a schema-only dump does **not** carry

Each item below is named explicitly, with whether CI needs it and how it gets there.
Read the whole table before running anything — several items must be handled *during*
the restore, not after.

### 2.1 RLS policies — **verify, do not assume**

Documented `pg_dump` behaviour is that `--schema-only` **does** emit `ALTER TABLE …
ENABLE ROW LEVEL SECURITY` and `CREATE POLICY …` for tables inside the dumped
schemas. Policies are schema objects, not data.

**This was not empirically verified for this repo.** No Postgres client is installed
on the machine where this document was written and no database was reachable, so the
claim rests on documented behaviour rather than on an observed dump. Because the three
`live-db-security-suites` jobs test *nothing but policies*, verify it yourself, on your
actual dump file, before restoring:

```
grep -c 'ENABLE ROW LEVEL SECURITY' schema.sql
grep -c 'CREATE POLICY'             schema.sql
```

Both counts must be non-zero and in the right ballpark for the number of public tables.
If either is zero, your dump tool or its flags dropped them and **the RLS suites will
test an unprotected database and may still go green** — see §4.3.

**CI needs these: absolutely.** They are the object under test.

### 2.2 The `auth` schema and its users

**Not carried** by a `public`-scoped dump, and you should not try to carry the users.
`auth.users` in production contains real people; copying it into a CI project that
runs `auth.admin.createUser` and mutates `profiles.role` is a privacy incident waiting
for a schedule trigger to fire.

The `auth` schema itself already exists in any Supabase project — it is provisioned by
the platform, not by this repo. What is missing is **rows**.

**CI needs rows in `auth.users`: yes, and it is load-bearing.**
`checkRankEventsSurfaces.ts` sources its probe user with `SELECT id FROM auth.users
LIMIT 1` inside the probe transaction (`:509`). With `auth.users` empty it exits **3 —
BLOCKED**, reason `"auth.users is empty — no FK-valid user_id to probe with"`
(`:721`), and `run_gate()` scores that as a failure. This is correct fail-closed
behaviour, and it means the `api-server-check-all` job cannot pass until at least one
auth user exists.

**How it gets there:** §3 step 5 — `seed-portava-account.ts` calls
`auth.admin.createUser`, and each of the three RLS suites creates and deletes its own
users. Do not hand-insert rows into `auth.users`.

### 2.3 Storage: buckets and objects

**Not carried.** `storage.buckets` and `storage.objects` are rows in a
Supabase-managed schema; a `public`-scoped schema dump contains neither, and no
migration in this repo creates a bucket (verified: zero migrations reference
`storage.buckets`).

**CI needs buckets: yes, two of them.** `check-media-bucket-privacy.ts` names
`post-media` and `profile-media`, and the storage policies in
`0103_post_media.sql` are written against `bucket_id = 'post-media'`.

**How they get there:** create them by hand in the CI project's dashboard
(Storage → New bucket), named exactly `post-media` and `profile-media`. Match
production's public/private setting, read from **production's dashboard**: Storage →
Buckets, where the list shows Public/Private per bucket. Reproduce those two values
in CI.

**Do not run `check-media-bucket-privacy.ts` against production to learn this.** It
requires `SUPABASE_SERVICE_ROLE_KEY` (`:11`) — the most powerful credential the
project has — exported into your shell, to obtain a fact the dashboard displays with
no credential at all. And it is **not guarded**: it imports neither guard front door
(confirmed against the importer lists in §3 step 1), so nothing
in the execution path would stop a mistyped URL. The trade is a production
service-role key in your environment for zero additional information.

The script also prints the `media_private_buckets_enabled` feature flag. If you want
that too, read it in production's Table Editor: table `feature_flags`, column `flag`
— note the live column is `flag`, not `key`; the migrations declare `key` and the
audit allowlists the difference (`auditMigrationsVsLive.ts:139`).

**CI needs objects: see §4.2.** The short answer is that an empty bucket makes
`check:media-objects` pass trivially, and the available seeder makes it fail
spuriously. Neither is a good outcome.

### 2.4 Storage RLS policies — the one that will bite you

`0103_post_media.sql:117`–`:143` creates three policies **on `storage.objects`**, not
on a public table:

- `post_media_storage_owner_insert`
- `post_media_storage_owner_delete`
- `post_media_storage_public_read`

And `auditMigrationsVsLive.ts:247` reads policies with `where schemaname in
('public','storage')` — so the audit **does** claim and check them.

A dump scoped to `--schema=public` will not carry them, and `audit:schema` will
report all three as missing drift. That red is an artefact of your bootstrap, not a
finding.

**How they get there:** after restoring the public schema, apply
`0103_post_media.sql`'s storage-policy block by hand in the CI project's SQL editor.
It is idempotent — each `CREATE POLICY` is preceded by `DROP POLICY IF EXISTS`. Apply
only that block; the rest of the file touches public tables the dump already created.

### 2.5 Extensions

`pg_dump --schema-only` normally emits `CREATE EXTENSION IF NOT EXISTS …` for
extensions in dumped schemas, but Supabase's own dump tooling filters some of them,
and extensions frequently live in a dedicated `extensions` schema that a
`public`-scoped dump never visits.

**CI needs at least PostGIS, in the same schema production has it in.** This is the
item most likely to be got wrong, because getting it wrong still passes the obvious
verification.

`2030_postgis_spatial.sql:21` is a **bare `CREATE EXTENSION IF NOT EXISTS postgis;`
with no `SCHEMA` clause.** It therefore lands wherever the executing session's
`search_path` puts it, and that is not a property of this repo — it is a property of
whoever ran it in production. Two consequences, both silent:

1. A `--schema=public` dump emits every spatial column with its type **qualified by
   production's extension schema** — `extensions.geography(Point,4326)`, or
   `public.geography(...)`, or whatever it actually is there. That qualification is
   baked into the dump text.
2. `CREATE EXTENSION IF NOT EXISTS postgis` — the dump's own, if it carries one — is
   an **`IF NOT EXISTS` no-op** once postgis exists *anywhere* in the database. It
   will not relocate an extension you already installed into the wrong schema.

So if you enable postgis into a different schema than production's, the restore
fails on every spatial column with `type "extensions.geography" does not exist`,
while `select postgis_version();` returns a version string quite happily. **That
verify passes either way** — it is why this defect survives a careful bootstrap.

**How it gets there — read production first, then install to match.**

Step A, in **production's** SQL editor (read-only):

```
select e.extname, n.nspname as extension_schema, e.extversion
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
 where e.extname = 'postgis';
```

Note `extension_schema` character for character.

Step B, in the **CI** project's SQL editor — not the Extensions toggle, which does
not let you state this unambiguously:

```
create schema if not exists <extension_schema>;
create extension if not exists postgis with schema <extension_schema>;
```

Step C, verify by comparison, not by existence — run the **same query from step A**
in CI and require `extension_schema` to be the identical string:

```
select e.extname, n.nspname as extension_schema, e.extversion
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
 where e.extname = 'postgis';
```

Then `grep -i 'CREATE EXTENSION' schema.sql` and repeat A–C for **every** extension
the dump names. "Enable it" is not the requirement; "enable it in the same
namespace" is.

### 2.6 Roles and grants

**Roles: not carried, and not needed.** Roles are cluster-level objects; `pg_dump`
does not create them (that is `pg_dumpall --roles-only`). Every role this schema
grants to — `anon`, `authenticated`, `service_role`, `postgres`, `supabase_admin` —
already exists in the CI project, because Supabase provisions them.

**Grants: carried, conditionally.** `pg_dump --schema-only` emits `GRANT`/`REVOKE` for
the objects it dumps. Since the grantee roles already exist, they should apply
cleanly. Watch the restore log for `role "…" does not exist` — that is the one failure
mode here, and it is loud.

**CI needs grants: yes.** The RLS suites exercise the `anon` and `authenticated`
paths; a missing table-level `GRANT SELECT … TO anon` produces a *permission* denial
that looks exactly like a *policy* denial in the test output, so the suite would pass
for the wrong reason.

### 2.7 Sequences

**Definitions: carried.** `CREATE SEQUENCE` and identity/serial column defaults are
schema.

**Current values: not carried.** `setval()` calls are emitted as *data*, so a
schema-only restore leaves every sequence at its start value.

**CI needs correct values: no.** The CI database starts empty; sequences starting at 1
are exactly right. Nothing in the live-db workflow asserts anything about sequence
positions. No action.

### 2.8 Supabase-managed schemas

`auth`, `storage`, `realtime`, `graphql`, `graphql_public`, `vault`,
`supabase_functions`, `extensions`, `pgsodium`. These are **provisioned by the
platform** and already present in the empty CI project.

**Do not dump or restore them.** Restoring a production `auth` or `storage` schema
over the platform's own is how you get a project that half-works in ways nobody can
diagnose. The only thing this repo adds to a managed schema is the three
`storage.objects` policies in §2.4.

**CI needs them: yes, and it already has them.** No action beyond §2.4.

---

## 3. Order of operations

Do these in order. Each step names what to verify before moving on. Do not batch them.

### Step 1 — Confirm the CI project is the one you think it is

In the CI project's dashboard, Settings → API. Confirm the project ref in the URL is
`hwokxgbmezheskbzskfr` and **not** `ajrurzioarfkagpuxfnb`.

You are about to use a service-role key. Note that `seed-portava-account.ts` imports
**no guard at all**. Verified by grepping the tree for the imports — there are
**two** guard front doors and **nine** importers between them:

**`src/lib/ciSupabaseGuard.mjs` — strict: the sanctioned CI project, or exit 2.**

| | |
|---|---|
| `src/test/rlsHardening.test.ts` | creates/deletes auth users |
| `src/test/isOfficialPrivileged.test.ts` | mutates `profiles.is_official` |
| `src/test/profileRoleNotSelfWritable.test.ts` | mutates `profiles.role` |
| `src/scripts/checkRankEventsSurfaces.ts` | real `INSERT` probe, rolled back |
| `src/scripts/checkDiscoveryCacheKeys.ts` | SELECT-only, but not one of the four sanctioned audits and not CI-wired; strict by default |

**`src/lib/ciProdReadOnlyAuditGuard.mjs` — the same, plus a read-only audit of the
declared production project, outside CI only, on a deliberate named request.**

| | |
|---|---|
| `src/scripts/auditMigrationsVsLive.ts` | pg catalog SELECTs |
| `src/scripts/checkMissingLiveColumns.ts` | `information_schema` SELECTs |
| `src/scripts/checkMediaObjects.ts` | `post_media` + `storage.objects` SELECTs |
| `src/scripts/checkWritePathColumns.ts` | TypeScript AST + one SELECT on `profiles` |

Line numbers are deliberately not quoted here: they churn, and the grep is the
answer. `scripts/check-guard-coverage.mjs` enforces both lists on every run —
including that nothing outside the second table imports the read-only door — so a
disagreement between this table and the tree fails `check:all` rather than sitting
here misleading you. Trust the check, not the prose, including this document's.

**None of this helps you in steps 5 and 6.** The read-only door's production mode
is for auditing production; bootstrapping is the opposite errand, and every command
in this document points at the CI project. Do not export
`PORTAVA_PROD_READ_ONLY_AUDIT` while doing any of it — the four scripts that honour
it would then be pointed at production while you believe you are looking at CI.

Everything else — `seed-portava-account.ts`, `seed-test-media.ts`,
`check-media-bucket-privacy.ts`, every other seeder and fix script — is **outside**
that chokepoint. **Nothing will stop you from pointing them at production.** You are
the guard for steps 5 and 6.

**Verify:** the ref in your address bar, read character by character.

### Step 2 — Install extensions in the CI project, in production's schema

Follow §2.5 A→B→C. Read production's `pg_extension` / `pg_namespace` row for
`postgis` **first**, then `create extension … with schema <that schema>` in CI. Do
not use the Extensions toggle: it does not let you state the schema unambiguously,
and a bare `CREATE EXTENSION` inherits `search_path` instead.

**Verify:** run §2.5's step-A query in **both** projects and require the
`extension_schema` values to be the identical string.

**Do not verify with `select postgis_version();`** — it returns a version string
whether or not the extension landed where the dump expects it, so it cannot tell a
correct install from the one that breaks every spatial column in step 4.

### Step 3 — Take the schema-only dump from production

Use a **read-only** dump. Scope it to `public`. Do not dump `auth` or `storage`.
Run it from your own machine with the production connection string in your
environment — never write the credential into a file in this repo.

Whatever tool you use (`supabase db dump --schema public`, or `pg_dump --schema-only
--schema=public --no-owner --no-privileges` — drop `--no-privileges` if you want the
grants from §2.6), the output is a `.sql` file you must inspect before restoring.

**Verify, on the file, before it touches anything:**

```
grep -c 'CREATE TABLE'                  schema.sql   # dozens
grep -c 'CREATE POLICY'                 schema.sql   # non-zero  (§2.1)
grep -c 'ENABLE ROW LEVEL SECURITY'     schema.sql   # non-zero  (§2.1)
grep -ci 'INSERT INTO'                  schema.sql   # MUST be 0 — this is schema-only
grep -i  'CREATE EXTENSION'             schema.sql   # enable each one in step 2
```

A non-zero `INSERT INTO` count means you took a data dump. Stop and re-dump: you were
about to copy production rows, possibly personal data, into a CI project that
schedules a nightly job.

### Step 4 — Restore into the CI project

Run the file against the CI project. Read the output; do not just check the exit code.

**Verify:** in the CI project's SQL editor —

```
select count(*) from information_schema.tables where table_schema = 'public';
select count(*) from pg_policies where schemaname = 'public';
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public';
select count(*) from pg_trigger tr
  join pg_class c on c.oid = tr.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where not tr.tgisinternal and n.nspname = 'public';
```

The `nspname = 'public'` filter on the trigger count is deliberate and is **not**
what `audit:schema` does — see §7. Without it you would be counting the CI project's
platform-provisioned triggers in `auth`, `storage` and `realtime` alongside your
restored ones, and a restore that dropped every public trigger could still return a
comfortable-looking number.

Compare each number against the same four queries run against **production**. They do
not have to match exactly — you will learn something either way — but a category
sitting at zero means that category did not restore.

Also confirm the spatial columns survived, since §2.5 is the one step whose failure
mode looks like success:

```
select count(*) from information_schema.columns
 where table_schema = 'public' and udt_name in ('geography','geometry');
```

Non-zero, and in the same ballpark as production. Zero here with a clean-looking
restore log means the extension landed in the wrong schema and every
`ALTER TABLE … ADD COLUMN … geography` in the dump failed.

### Step 5 — Apply the storage policies

Create buckets `post-media` and `profile-media` (§2.3), then paste the storage-policy
block from `artifacts/api-server/src/migrations/0103_post_media.sql:117`–`:143` into
the CI project's SQL editor.

**Verify:**

```
select policyname from pg_policies where schemaname = 'storage';
```

Three rows: `post_media_storage_owner_insert`, `post_media_storage_owner_delete`,
`post_media_storage_public_read`.

### Step 6 — Seed the `@portava` account

`checkWritePathColumns.ts:944` runs `select handle, is_official from profiles where
handle = 'portava' limit 1` and **fails the whole `api-server-check-all` job** if the
row is absent (`:947`) or has `is_official = false` (`:957`). This is a data check
inside a schema check, and a schema-only restore does not satisfy it.

From `artifacts/api-server`, with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set
in your shell **to the CI project's values**:

```
node --env-file-if-exists=.env --import tsx/esm src/scripts/seed-portava-account.ts
```

Note there is no `seed:portava-account` entry in `package.json` — invoke the file
directly, as the check's own error message instructs.

**Read the output.** `seed-portava-account.ts:213`–`:216` prints a warning and
**exits 0** when the credentials are absent. A zero exit from this script does not
mean it seeded anything. You are looking for `Profile inserted successfully.` or the
patch path's message, not for a silent success.

**Verify:** in the CI SQL editor —

```
select handle, is_official from profiles where handle = 'portava';
select count(*) from auth.users;
```

One profile row with `is_official = true`, and `auth.users` count ≥ 1. That second
query is also what unblocks §2.2 / `checkRankEventsSurfaces`.

### Step 7 — Configure the workflow's environment

- Repo → Settings → Secrets and variables → Actions → **Variables**: set
  `CI_SUPABASE_PROJECT_REF` = `hwokxgbmezheskbzskfr`.
- Repo → Settings → Environments → `ci-nonprod-supabase` → **Secrets**: set
  `SUPABASE_URL` (the CI project's URL), `SUPABASE_PROJECT_TOKEN`,
  `SUPABASE_SERVICE_ROLE_KEY`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` — all from the **CI**
  project.

`KNOWN_PROD_PROJECT_REF` is already correct at `live-db.yml:150`; leave that line
alone. `assert-nonprod-supabase.sh:62` hard-fails if it is empty or malformed, by
design.

**But note what `live-db.yml:150` is and is not.** It is the workflow's top-level
`env:` block. It configures **GitHub Actions runners only**. It puts nothing in your
shell. Both `KNOWN_PROD_PROJECT_REF` and `CI_SUPABASE_PROJECT_REF` must *also* be
exported locally before any guarded script will run on your machine — see §5.2, which
is the very next thing you do.

**Verify:** nothing to run yet. Step 8 is the verification.

### Step 8 — Verify by hand, before you let CI tell you anything

See §5. Do not skip to the Actions tab.

---

## 4. Checks whose meaning depends on data existing

These are the vacuous-green candidates. Each is stated with the mechanism, so you can
re-derive the conclusion rather than trusting this document.

### 4.1 `check:missing-live-columns` — passes having checked *nothing*

`checkMissingLiveColumns.ts:412`:

```ts
if (SKIP_TABLES.has(table) || !liveTables.has(table)) { skippedCount++; continue; }
```

On a database with no tables, `liveTables` is empty, so **every** column claim takes
the `continue`. The script reaches `:452` and prints `✔ check:missing-live-columns
PASSED — no missing columns.` and exits 0. `SKIP_TABLES` is currently empty
(`:125`–`:127`), so the skip is entirely driven by what is live.

Its own comment argues the table-missing case "is already caught by `audit:schema`" —
which is true **only while `audit:schema` also points at a real schema**. Replay the
migrations and both halves of that argument collapse at once.

**Fixture needed:** none beyond the schema restore. After step 4 this check is
meaningful. Its `⤳ N column claim(s) skipped` line (`:449`) is the tell — a large
skip count after bootstrap means your restore was incomplete.

### 4.2 `check:media-objects` — zero rows is a pass, and the seeder makes it worse

`checkMediaObjects.ts:134`: `if (dangling.length === 0)` → prints `✅ every post_media
row has its Storage object` and exits 0. Once `post_media` **exists and is empty** —
the state §3 leaves you in — the dangling set is empty and the check is green having
compared nothing to nothing. Same for the orphan count.

**Note the precondition, because the current CI project does not meet it.** With no
tables at all, `post_media` does not exist, the Management API returns non-2xx for
the dangling query, and `checkMediaObjects.ts:94` (`if (!res.ok) throw new Error(…)`)
throws. The process dies non-zero. This check does **not** go vacuously green on a
table-less database; it goes vacuously green on a *restored, unseeded* one. That is
the state you are creating.

**The obvious fixture is a trap.** `seed-test-media.ts` inserts `post_media` rows with
`storage_bucket: "post-media"` and `storage_path:
"${userId}/${postId}/media.mp4"` (`:479`–`:480`) and performs **zero storage
uploads** — verified by reading the file: it contains no `.storage`, no `upload(`,
and no `createBucket` anywhere in its 696 lines. Its only other occurrence of the
word "storage" is a Google sample-video URL (`:100`), which it stores in `public_url`
— a field `checkMediaObjects` never looks at. Every row it writes names a Storage
object that will never exist.

> **Do not run `pnpm seed:test-media` as part of this bootstrap.** Not as a fixture,
> not "to have some data", not to see the check do something. It guarantees 100%
> dangling rows and turns `check:media-objects` permanently red on a database that is
> otherwise correct. The resulting red is an artefact of the seeder and carries no
> information about the schema, the storage layer, or the bootstrap. It is also
> unguarded (§3 step 1), so it will run against whatever `SUPABASE_URL` is in your
> shell.

**Recommendation: do not trust `check:media-objects` in CI, and say so out loud.**
A correct fixture requires uploading a real object to the CI `post-media` bucket and
inserting a `post_media` row whose `storage_path` matches it exactly — plus a second,
deliberately dangling row, or the check still cannot distinguish "working" from
"nothing to look at". Nothing in this repo builds that pair today.

Until someone writes that fixture, treat this job's green as *no signal*. It is the
one check in `schema-drift` whose subject — reconciling `post_media` rows against
production's actual bucket contents — genuinely only exists in production. See §7.

### 4.3 The RLS "returns empty" assertions — satisfied by emptiness

`rlsHardening.test.ts` seeds its own users via `auth.admin.createUser` (`:99`,
`:107`), which is why the suite is meaningful on a clean schema. But several of its
assertions target tables it **never seeds**:

- `:243`–`:250` anon read of `notifications` → `.limit(5)`, `assert.deepEqual(data,
  [])`
- `:281`–`:288` anon read of `user_follows` → same shape
- `:291`–`:298` anon read of `user_friendships` → same shape

An **existing but empty** table returns `[]` whether RLS is enforcing anything or
not. These three assertions pass on a restored, unseeded database with RLS fully
disabled.

**The relation has to exist for that to be true, and that is worth stating
precisely.** Each of the three runs `assert.ifError(error)` *before* its
`deepEqual(data, [])` (`:249`, `:287`, `:297`). PostgREST returns an error, not an
empty result, for a relation it does not know about — so on a table-less database
`assert.ifError` fails and these three tests go **red**, not vacuously green. Their
vacuity begins the moment the schema restores and ends the moment somebody seeds
those tables. Between those two points — i.e. for the entire post-bootstrap life of
this project until the fixture below exists — they are tautologies.

**Fixture needed:** one service-role-inserted row in each of `notifications`,
`user_follows`, `user_friendships`, belonging to a user the anon client is not. With a
row present, `[]` becomes evidence. Without one, it is a tautology.

This is not built today. Until it is, read those three assertions as decorative and
rely on the suite's wrong-user tests (`:302` onward), which do seed their subjects.

### 4.4 What is *not* vacuous on an empty database

Stated for symmetry, so nobody "fixes" a correct red:

- **`audit:schema`** — every table claim missing produces a loud red. Correct, with
  the caveat in 4.4.1 below.
- **`check:write-path-columns`** — missing tables plus the missing `@portava` row
  (`:947`) exit 1. Correct.
- **`check:rank-events-surfaces`** — zero CHECK constraints, or empty `auth.users`,
  exit 3 / BLOCKED. Explicitly fail-closed; its own header calls the empty-`auth.users`
  case `"FATAL, never rejected"`. Correct.

#### 4.4.1 A partial restore is *understated*, in both audits

A loud red is not the same as a proportionate one. When a table is missing, every
**column** claim on that table is dropped rather than reported:

- `auditMigrationsVsLive.ts`, `isMissing()` (`:531`–`:537`): the `column` case does
  `if (!live.relations.has(table)) return false;` — **returns `false`**, i.e. "not
  missing". The table is reported once; its columns are reported zero times.
- `checkMissingLiveColumns.ts:412`: `if (SKIP_TABLES.has(table) || !liveTables.has(table))
  { skippedCount++; continue; }` — same suppression, but it *counts* it.

So a half-restored database reports N missing tables and hides however many hundred
column claims sit on them. The object count in `audit:schema`'s output is therefore
a **floor**, not a measure, and reading it as "only N things are wrong" is the
mistake this subsection exists to prevent.

**The reliable completeness signal is `check:missing-live-columns`' skip count**, not
either audit's failure count:

```
  ⤳ N column claim(s) skipped (table not yet live — audit:schema covers those).
```

emitted at `checkMissingLiveColumns.ts:449`. After a faithful restore, N should be
small; a large N means tables did not restore and everything above it is worth less
than it looks.

**Two mechanical caveats on that line, both of which will catch you out:**

1. It is printed inside the `missing.length === 0` branch (`:441`–`:453`) — i.e. it
   appears **only when the check otherwise passes**. If `check:missing-live-columns`
   exits 1, you do not get the skip count at all.
2. To get it in the failing case, re-run with `--verbose` (`:59`), which prints
   `⤳ <key> (table X not live — skipped)` per claim at `:414`. Count the lines.

`SKIP_TABLES` (`:125`–`:127`) is currently **empty**, so on a correct bootstrap every
skip is driven by what actually failed to restore — which is what makes the number
readable at all.

---

## 5. Confirming the bootstrap worked — without trusting a green run

The workflow's green is the last thing you should look at, because §4 lists three ways
to get one for free. Confirm the bootstrap the other way round: **prove each check can
still go red.**

### 5.1 Read the numbers, not the checkmarks

Run the counting queries from step 4 against CI and production side by side. If public
tables, policies, functions and triggers are all in the same order of magnitude, the
schema restored. If any is zero, it did not.

### 5.2 Run the checks locally, against CI, and read their output text

**Four environment variables, not two.** All four commands below import a guard
front door as their first import — `check:rank-events-surfaces` the strict one, the
other three the read-only one — and with `PORTAVA_PROD_READ_ONLY_AUDIT` unset, which
is the state you want here, **both doors behave identically**: they spawn
`.github/scripts/assert-nonprod-supabase.sh` before any client is constructed. That
script hard-fails on an unset `KNOWN_PROD_PROJECT_REF` (`:62`) and on an unset
`CI_SUPABASE_PROJECT_REF` (`:71`), and the guard collapses any non-zero status into
`process.exit(2)`. Export only `SUPABASE_URL` and
`SUPABASE_PROJECT_TOKEN` and **every command in this section exits 2 having proved
nothing** — including both negative controls in §5.3, which is the entire "do not
trust a green run" mechanism.

Step 7's `KNOWN_PROD_PROJECT_REF` at `live-db.yml:150` does not help here: that is a
workflow `env:` block, read by GitHub Actions runners. It is not your shell.

From `artifacts/api-server`:

```
export SUPABASE_URL='https://hwokxgbmezheskbzskfr.supabase.co'
export SUPABASE_PROJECT_TOKEN='<the CI project token>'
export CI_SUPABASE_PROJECT_REF=hwokxgbmezheskbzskfr
export KNOWN_PROD_PROJECT_REF=ajrurzioarfkagpuxfnb
```

`SUPABASE_URL` must match `^https://[a-z0-9]+\.supabase\.co/?$` exactly
(`assert-nonprod-supabase.sh:84`) — no path, no trailing anything else — or it is
refused as unparseable. Keep these two refs the way round they are written above;
setting `CI_SUPABASE_PROJECT_REF` to the production ref is refused by the secondary
assertion at `:103`, which is what that assertion is for.

Then:

```
pnpm run audit:schema
pnpm run check:missing-live-columns
pnpm run check:write-path-columns
pnpm run check:rank-events-surfaces
```

A first line of `[ciSupabaseGuard] Supabase allowlist asserted in-process…` — or
`[ciProdReadOnlyAuditGuard] Supabase allowlist asserted in-process…` for the three
that use the read-only door — is how you know the guard passed rather than the
script simply not needing it. If you see `REFUSED` after either tag, the exports are
wrong and nothing downstream ran.

If instead you see a boxed `READ-ONLY AUDIT OF PRODUCTION — PERMITTED` banner, stop:
`PORTAVA_PROD_READ_ONLY_AUDIT` is set in your shell and that command just read
**production**, not the CI project you are bootstrapping. Unset it and start the
section again.

What you are reading for, in each:

- `audit:schema` — **expect drift, and expect it to be exactly the drift in §5.2.1.**
  Per `live-db.yml:327` the first run should be red. Compare the output line by line
  against that list. A wall of "table X is missing" means the restore was incomplete.
  A clean pass on the first run is suspicious: it is what migration replay would
  produce, so ask where your schema actually came from.
- `check:missing-live-columns` — look at the `⤳ N column claim(s) skipped` line
  (`:449`). A large N means tables did not restore, and the `PASSED` above it is
  worthless. Note §4.4.1: that line only prints when the check otherwise passes; if
  it exits 1, re-run with `--verbose` to get the per-claim skip lines.
- `check:write-path-columns` — must reach `✓ @portava profile row present
  (is_official=true).` If it does not, step 6 did not do what you thought.
- `check:rank-events-surfaces` — must print a `GATE live_pulse:` verdict line. Exit 3
  with `auth.users is empty` means step 6 failed. Exit 2 means credentials **or the
  guard**, not data — check for `[ciSupabaseGuard] REFUSED` above it before you go
  looking at tokens.

### 5.2.1 The expected first red, object by object

`audit:schema` does not report everything it parses. Two curated filters sit in front
of it, and **both were curated against production** — which is why, after a faithful
schema-only restore *from* production, the first run's output is predictable rather
than merely "interesting":

- **`SKIP_FILES` (`auditMigrationsVsLive.ts:121`–`:129`)** removes three files from
  the audit **entirely** — `0050_rent_a_buddy.sql` (superseded by
  `0134_rent_buddy_schema_rebuild.sql`), `0105_compass_performance_indexes.sql`
  (references columns that do not exist live), `0041_notifications.sql` (superseded by
  `0062_notifications_schema.sql`). Nothing they claim can ever be reported.
- **`ALLOWLIST` (`:138`–`:172`)** suppresses **29 claims** — 27 columns, 1 index, 2
  policies. These are the known repo-name → live-name divergences (`feature_flags.key`
  → `flag`, `events.status` → `state`, and so on).
- `checkMissingLiveColumns` carries its own smaller `SKIP_FILES` (`:119`) and an
  **empty** `SKIP_TABLES` (`:125`–`:127`).

So the first run should report **exactly the 13 objects already catalogued in
`docs/schema-reconciliation-2026-08-08.md` §2** ("Category B — declared, never
applied"), and nothing else:

| Declared in | Object | Kind |
|---|---|---|
| `20260731_post_event_links.sql` | `post_event_links` | **table** |
| | `idx_post_event_links_post_id` | index |
| | `idx_post_event_links_event_id` | index |
| `20260811_media_rls.sql` | `media_assets_public_select` | policy |
| | `media_attachments_public_select` | policy |
| `0026_highlights.sql` | `users_view_highlight_replies` | policy |
| `2033_rls_hardening.sql` | `users_view_highlight_replies` (same object, claimed by two files) | policy |
| `0186_geo_indexes.sql` | `user_location_state_geo_idx` | index |
| | `events_geo_idx` | index |
| | `posts_geo_idx` | index |
| | `hidden_gems_geo_idx` | index |
| | `hidden_gems_approx_geo_idx` | index |
| `2044_hidden_gems_canonical_place_id.sql` | `hidden_gems_canonical_place_idx` | index |

**This list is the difference between a correct restore and an incomplete one.** Use
it as an equality test, not a floor:

- **More than this** — anything not in the table above — means your restore dropped
  objects production has. Do not start authoring migrations for them. Go back to
  step 4.
- **Fewer than this, or a clean pass** — the schema did not come from production.
  That is what migration replay produces (§1).
- **`tags.tagged_at` will not appear.** It is allowlisted (`:142`), even though
  `schema-reconciliation` §2 records it as a real absence that reached executing code.
  Allowlisted is not the same as absent; do not read its silence as presence.
- **The three `storage.objects` policies (§2.4) will also be reported** if you have
  not done step 5 yet, because `:247` reads `pg_policies` for `schemaname in
  ('public','storage')`. Do step 5 first and they disappear.
- **No column claims on `post_event_links` will appear**, even though the table is
  missing and its columns are claimed. That is `isMissing()` suppressing them —
  §4.4.1. The table's absence is reported once; its columns are invisible.

Two honest limits on the list itself. It was produced on **2026-08-08** against
production as it stood then (that document's §0: 250 files, 3,726 claimed objects);
if production or the migration files have moved since, re-derive it rather than
trusting the table. And it is net of the skip-list and allowlist above — it is the
expected *reportable* drift, not the expected *total* drift.

### 5.3 Negative controls — the actual confirmation

**Same shell, same four exports as §5.2.** Both controls re-run guarded scripts; in a
fresh terminal with only `SUPABASE_URL` and `SUPABASE_PROJECT_TOKEN` set, both exit 2
at the guard, and an exit-2 refusal looks nothing like the failure you are trying to
provoke. Confirm `[ciSupabaseGuard] … Proceeding.` or
`[ciProdReadOnlyAuditGuard] … Proceeding.` appears in each run — and that no
`READ-ONLY AUDIT OF PRODUCTION` banner does.

A check that has never been observed failing has not been observed working. Two cheap
ones, both reversible, both in CI only:

1. **Break the schema deliberately.** In the CI SQL editor, drop one column that a
   migration adds — pick a leaf column, note its exact definition first. Re-run
   `check:missing-live-columns`. It **must** name that column and exit 1. Restore the
   column. If it passed, the check is skipping the table (§4.1) and your restore is
   incomplete.
2. **Break the fixture deliberately.** `update profiles set is_official = false where
   handle = 'portava';` then re-run `check:write-path-columns`. It must fail at
   `:957`. Set it back to `true`, or re-run the seeder.

Only after both negative controls behave should you look at a workflow run.

### 5.4 Then, and only then, trigger the workflow

Actions → *CI (live DB)* → Run workflow. Read the job summary, not the badge:

- The `check:all` step lifts every per-check `PASSED:`/`FAILED:` line into the summary
  (`live-db.yml:289`–`:295`). Read all seven.
- `GATE live_pulse: PERMITTED` must appear literally; its absence is a block whatever
  the exit code (`:313`).
- `schema-drift` red on the first run is the expected, documented outcome — see §7.
- The concurrency group is global and does **not** queue (`:96`–`:131`). A pending run
  can be evicted by a push to any branch. Evicted runs render as *cancelled*, and
  `live-db-verdict` (`:590`) converts any non-`success` upstream result into an
  explicit failure. "Not red" is not "verified" for this workflow.

---

## 6. Ordering summary

1. Confirm the CI project ref. You are the only guard on the seeders — the two guard
   front doors have nine importers between them and no seeder is among them
   (§3 step 1). Keep `PORTAVA_PROD_READ_ONLY_AUDIT` out of this shell.
2. Read production's `postgis` extension **schema**, then install postgis into that
   same schema in CI (§2.5 A→B→C). `postgis_version()` is not a verification.
3. Schema-only, `public`-scoped dump from production. Inspect the file; `INSERT INTO`
   count must be 0.
4. Restore into CI. Compare object counts against production, and confirm the
   `geography`/`geometry` column count is non-zero.
5. Create `post-media` and `profile-media` buckets (privacy read from production's
   **dashboard**, not with a service-role key); apply `0103`'s storage policies.
6. Run `seed-portava-account.ts` against CI. Read its output — exit 0 is not proof.
7. Set `CI_SUPABASE_PROJECT_REF` and the four `ci-nonprod-supabase` secrets. That
   configures Actions only, not your shell.
8. Export all **four** guard variables (§5.2), then verify by hand (§5), including
   both negative controls, *before* reading a CI run. Check the first run's drift
   against §5.2.1 as an equality test.

**Never, at any point:** `pnpm seed:test-media` (§4.2). It inserts `post_media` rows
and uploads nothing, guaranteeing 100% dangling rows and a permanently red, entirely
meaningless `check:media-objects`.

---

## 7. What CI will and will not catch once bootstrapped

### Will catch

- A migration that claims an object the live schema does not have — a new table,
  column, view, function, index, policy or enum value that was authored in a file and
  never applied. (`audit:schema`, `check:missing-live-columns`.) **Two carve-outs,
  both below:** column claims on a *missing table* are suppressed rather than
  reported (§4.4.1), and **trigger** claims are matched without a schema filter, so a
  trigger claim passing is not evidence the trigger exists in `public`.
- Application code in `src/routes` / `src/services` referencing a column no migration
  declares. `checkWritePathColumns.ts` reads the TypeScript AST — an **independent
  second source**, not the migrations — and diffs it against
  `information_schema.columns`. This one survives regardless of how the schema was
  loaded, and it is the strongest check in the set.
- The `rank_events.surface` CHECK actually rejecting or accepting `'live_pulse'`, via
  a real rolled-back INSERT. A behavioural probe, not text matching.
- RLS policy behaviour and the `profiles.role` / `is_official` write boundaries, for
  the tables the three suites seed themselves. Policies and triggers are the object
  under test; a clean schema is the right substrate for them.

### Will **not** catch — state this plainly rather than implying coverage

- **Live objects with no migration.** This is the drift class this repo actually
  documented — "12 of 15 live triggers and 6 of 56 live functions have no migration
  authoring them" (`live-db.yml:321`–`:324`). `isMissing()` (`:535`) only asks
  *migrations ⊆ live*. **Nothing enumerates live objects that no migration authors.**
  Neither audit will ever report that class, in either bootstrap. A prod-shaped CI
  database is *necessary* for these audits to mean anything; it is not *sufficient*
  for the finding they were written about.
- **Changed definitions.** Both audits compare the **existence of a name**, never a
  definition. A widened CHECK constraint (the 2078/2079 case), a changed function
  body, an altered column type, a policy rewritten to be permissive — all invisible.
  The object still exists; the audit is satisfied.
- **Most things outside `public` — but not all, and the exception is a
  false-negative, not extra coverage.** Live-side reads in `fetchLiveSchema()` are
  scoped to `nspname = 'public'` (`:231`–`:253`) with **two** departures:
  - `pg_policies` also covers `storage` (`:247`) — deliberate, and it is why §2.4
    matters. Extra coverage.
  - **The trigger query has no namespace filter at all** (`:259`–`:262`):

    ```sql
    select c.relname as t, tr.tgname as g
      from pg_trigger tr join pg_class c on c.oid = tr.tgrelid
     where not tr.tgisinternal
    ```

    No join to `pg_namespace`, no `nspname` predicate. Trigger claims are keyed
    `table.trigger`, so a claim is satisfied by **any** non-internal trigger of that
    name on **any** relation of that name, in **any** schema — `auth`, `storage`,
    `realtime`, `net`, `cron`, all of them platform-provisioned and present in a
    brand-new CI project the operator never touched. A migration's trigger can be
    entirely absent from `public` and still be reported as satisfied.

    This is a false negative in **exactly the object class the documented drift
    finding is about** — `live-db.yml:321`–`:324`, "12 of 15 live triggers and 6 of
    56 live functions have no migration authoring them". Treat any trigger claim that
    *passes* as unproven. To check one yourself, in the CI SQL editor:

    ```sql
    select n.nspname, c.relname, tr.tgname
      from pg_trigger tr
      join pg_class c on c.oid = tr.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where not tr.tgisinternal
     order by 1, 2, 3;
    ```

    Any row whose `nspname` is not `public` is a row `audit:schema` is willing to
    count as a satisfied claim. (The same unqualified shape appears in the step 4
    verification query as originally written; it is filtered to `public` there for
    this reason.)
- **`check:media-objects`, at all, until someone builds the fixture in §4.2.** Its
  subject is production's actual bucket contents versus production's `post_media`
  rows. That reconciliation cannot be replicated in CI — a CI project has neither the
  rows nor the objects — and the available seeder manufactures false failures. Its
  green in CI is not a signal. It is only meaningful run against production, manually,
  read-only — which is now a supported thing to do rather than a thing you had to
  work around the guard to do: see below.
- **Production drift itself.** Once CI points at `hwokxgbmezheskbzskfr`, no scheduled
  job is watching `ajrurzioarfkagpuxfnb`. The nightly cron (`:90`) audits the CI
  project's schema against the migrations. If production drifts tomorrow, this
  workflow will not notice.

  What exists to fill that gap is **manual, not scheduled**: the four read-only
  audits can be pointed at production from a terminal, deliberately, with

  ```
  export KNOWN_PROD_PROJECT_REF=ajrurzioarfkagpuxfnb
  export SUPABASE_URL='https://ajrurzioarfkagpuxfnb.supabase.co'
  export SUPABASE_PROJECT_TOKEN='<a production project token>'
  export PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production'
  pnpm run audit:schema          # and check:missing-live-columns,
                                 # check:write-path-columns, check:media-objects
  ```

  Each prints a banner naming the ref it resolved before it reads anything. This is
  **not** a substitute for a watching job and is not meant to become one: the mode is
  refused outright whenever a CI marker variable is present — every `GITHUB_*`,
  `RUNNER_*` and `ACTIONS_*` variable included — so a workflow does not get here by
  inheriting an `env:` block or by setting one variable. (A `run:` step that
  explicitly unsets the whole runner environment first could; that residual is stated
  in `docs/ci/README.md` § *The read-only production audit mode*, not claimed away.)
  A scheduled production watcher would still be a separate job with a separate
  design — and it must never reuse `scripts/pre-release-check.sh`, which soft-skips
  the audit to exit 0 when no token is present. `check:rank-events-surfaces` and the
  three RLS suites are **not** in that list and cannot be: they write.
- **Any commit whose run was evicted.** Global concurrency plus non-queueing eviction
  means a commit can have no live-DB verdict at all (`:104`–`:126`). Cancelled never
  reads as success, but absence of red is not presence of green.

### The one-sentence version

Once bootstrapped, CI verifies that **everything the migrations declare exists in a
production-shaped schema**, and that **RLS and the write boundaries behave** — but it
does not verify that the migrations describe the database, only that they are a subset
of it, and it says nothing at all about what production looks like today.
