# Database Architecture — current state

*Derived from the repository, 2026-09-07. Every claim below cites a file that was read; where a
number is a census it says which command produced it. `00_README.md` and `00_STATUS.md` still list
`07`–`12` as proposal stubs — this document is no longer one, and the other five are.*

This is a **documentation-of-reality** document. It describes one Postgres database per
environment, the 416-file migration chain that partly describes it, the ledger that records what
was applied, and the four or five places where the obvious reading of that machinery is wrong in a
way that has already cost time. Sections 3, 4 and 7 carry the traps; read them before writing a
migration.

## 1. The physical picture

Postgres 17.6, hosted by Supabase (`baseline/20260819_baseline_structure.sql:4-5`). **Two
projects, and they are not interchangeable:**

| Role | Project ref | Display name | Reached by |
|---|---|---|---|
| **Production** | `ajrurzioarfkagpuxfnb` | `travel-buddy` | the app; `.replit:151`; pinned as the denylist value at `.github/workflows/live-db.yml:183` |
| **CI** | `hwokxgbmezheskbzskfr` | `portava-ci` | every CI job that touches a database (`scripts/src/apply-migrations.ts:8`) |

A third project, `zheztcvfhkwbouspesew`, **also displays as `travel-buddy`** and is reachable by
the same account-level token. That is why every target check in this repo compares **refs and
never names** — "the project called travel-buddy" resolves to two different databases
(`.github/scripts/assert-nonprod-supabase.sh:38-53`).

**Two principals reach the data, and only one of them is subject to RLS.**

- The **api-server** constructs its client with `SUPABASE_SERVICE_ROLE_KEY`
  (`artifacts/api-server/src/lib/supabase.ts:4,20`). `service_role` bypasses RLS entirely. Every
  policy in section 8 is therefore *irrelevant* to the API and load-bearing for the client.
- The **mobile client** talks to PostgREST directly with the publishable/anon key
  (`travel-buddy-standalone/src/lib/supabase.ts:14,21`), as `anon` or `authenticated`. RLS and
  table grants are the whole of the boundary there.

Three schemas matter: `public` (387 tables in the baseline), `storage` (8, Supabase-managed), and
**`authz`** — see section 7.

## 2. There is no single description of the schema. There are three, and they disagree

| Source | What it is | Size |
|---|---|---|
| `artifacts/api-server/baseline/20260819_baseline_structure.sql` | schema-only `pg_dump`, captured 2026-08-19 | 387 `public` tables, 76 functions, 741 policies, 69 enums, 10 views |
| `artifacts/api-server/src/migrations/` | the canonical forward chain | 416 `.sql` files |
| the live database | the only authority | not derivable from either |

Neither file source is complete, and the gaps run **both** ways (counts from `CREATE TABLE`
extraction over both sources):

- **124 of the 387 baseline tables are created by no file in the canonical chain.** That includes
  the entire core spine — `profiles`, `posts`, `trips`, `trip_members`, `events`, `messages`,
  `message_threads`, `circles`, `circle_memberships`, `user_follows`, `user_friendships`,
  `memories` — and the whole `rent_buddy_*` marketplace. The chain *alters* these tables
  constantly; it never creates them.
- **53 tables the canonical chain declares are absent from the baseline.** Nine are the `buddy_*`
  compat views over `rent_buddy_*` (present in the baseline as views, not tables) or the
  superseded `0050_rent_a_buddy.sql`. The other ~44 are the post-cutover band's own output —
  `canonical_events`, `sources`, `freshness_policies`, the `intel_*` family, `protected_zones`,
  `schema_migration_ledger`, `wall_*`.

The repo's answer is not to pick one. `src/scripts/lib/canonicalSchema.ts:19-23` defines the
**canonical schema** as *baseline ⊕ every migration replayed over it*, and deliberately builds it
as a **superset**: an ambiguity resolves toward including a column, because a missed column blocks
unrelated work while an extra one only defers the catch to the live check
(`canonicalSchema.ts:25-45`). Three checks then divide the question, and none subsumes another
(`checkSchemaReferences.ts:29-37`):

| Check | Question | Needs a DB? |
|---|---|---|
| `check:schema-references` | does the code name columns the **repo declares**? | no |
| `check:enum-literals` | do filter **values** exist in the declared vocabulary? | no |
| `check:writerless-reads` | can the data **exist at all** — does anything write this table? | no |
| `check:write-path-columns` / `check:missing-live-columns` | does the **live** schema have them? | yes |
| `audit:schema` | does **live** contain every object the migrations claim? | yes |

The static three run on every PR (`.github/workflows/ci.yml:201,216,230`) precisely because the
live lane is starved — of 100 sampled live-DB runs, 64 were cancelled and 45 % of commits got no
verdict at all (`canonicalSchema.ts:7-11`).

## 3. The migration chain: one canonical tree, everything else frozen

`git ls-files '*.sql'` returns **628** tracked SQL files across a dozen directories. Exactly one
is replayable:

| Root | Status | Files |
|---|---|---|
| `artifacts/api-server/src/migrations/` | **canonical** — all new migrations | 416 |
| `artifacts/api-server/migrations/` | frozen legacy (no `src/`), 2026-07-17 | 71 |
| `migrations/` (repo root) | archived 2026-08-08; **never audited against live** | 34 |
| `reconciliation-staging/` | proposals awaiting owner review — **not applied, not canonical** | 20 |
| `artifacts/api-server/baseline/` | non-executable dump; must never overlap canonical | 1 |
| 15 other roots + 13 loose files | frozen drops and handoff packages | rest |

`src/scripts/frozenMigrationRoots.ts` pins **every file in 19 frozen roots by sha256**, so an
in-place edit is caught, not just a new filename; `reconciliation-staging` and `baseline` are
*allowlisted by name* rather than hash-pinned because their contents are expected to change
(`frozenMigrationRoots.ts:55-71`). `check:frozen-dir` additionally sweeps for migration-shaped
files in roots nobody listed (`checkFrozenDir.ts:8,99-112`).

`auditMigrationsVsLive.ts:76-83` scans **only** the canonical dir; `--include-legacy` adds
`artifacts/api-server/migrations/` and nothing else. The repo-root `migrations/` tree is outside
its reach entirely, by decision (`docs/migrations.md` § "Why the root `migrations/` tree is not
included").

### 3.1 The numbering bands

Apply order is a **plain byte-wise comparison of the whole filename**
(`scripts/src/apply-migrations.ts:196-200`) — written out explicitly rather than as `.sort()` so
that no locale can ever be consulted. Four bands coexist in that one lexicographic sequence:

| Band | Convention | Count | Meaning |
|---|---|---|---|
| `0010`–`0209` | legacy 4-digit | 185 | pre-baseline history. Sorts first. |
| `20260720`–`20260815` | 8-digit dated | 27 | a parallel convention. Sorts **between** `0209` and `2027` — `"2026…" < "2095…"` on the second character. |
| `2027`–`2095` | legacy 4-digit | 71 | late pre-cutover work. |
| `2120`–`2309` | **post-cutover forward band, 2100-2999** | 133 | everything authored after the 2026-08-19 baseline cutover. |

The bands cannot interleave ambiguously, and that is by construction rather than luck.
`src/scripts/migrationPrefixRules.ts:32` confines every **new** 4-digit prefix to
`/^2[1-9]\d{2}_/` — a range whose second digit (1–9) can never appear in a `YYYYMMDD` prefix in
this century (always `0`). Without it, a future `20270101_foo.sql` would sort *below* `"2100"` and
be silently classified as pre-cutover (`migrationPrefixRules.ts:5-25`;
`docs/RECONCILIATION-PACKET.md:384`). **2096–2099 are a permanently unusable reserved buffer**
(`migrationPrefixRules.ts:28-29`), so there is no ambiguous edge immediately below 2100 either.

`2100`–`2118b` is separately reserved for the `reconciliation-staging/` proposals and has already
been collided with once — `2100`–`2102`/`2109` were renumbered to `2120`–`2123`, which is why the
lowest post-cutover canonical file is `2120`
(`2143_plan_geofences_policy_convergence.sql:7-10`). A post-cutover file announces itself:

```
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
```

119 of the 416 files carry that banner (`grep -l` over the canonical dir), the earliest being
`2120_canonical_events.sql:4-13`.

### 3.2 Prefix collisions, and why the number is not a date

Two prefixes are shared, permanently: **`2059`** and **`2089`**. Both pairs were verified applied
before being documented, so neither file could be renumbered — renaming an applied file only makes
the record wrong (`checkMigrationPrefixes.ts:74-108`). The allowlist matches on the **exact file
set**, so a third file taking `2059` fails like any other collision. `check:migration-prefixes`
enforces this on every build; it was itself a registered script that nothing ran until 2026-08-09
(`docs/migrations.md` § "The gate").

**A lower prefix does not mean an earlier file.** `2221_compass_ai_writing_default_off.sql` does
not appear in `2254`'s enumerated backfill list, so it was authored *after* the ledger existed
despite sorting 33 files below it. Prefix order is apply order; it is not authorship order and it
is not evidence of age.

## 4. The ledger — and the single most important predicate in the repository

`public.schema_migration_ledger` (`2254_schema_migration_ledger.sql`) is the record of what was
applied to a given database. Before it, there was none: verified 2026-08-09, no table matching
`%migration%` existed in `public` or `supabase_migrations` (`docs/migrations.md` § "Prefix
collisions"). Shape, fixed because the applier is built against it (`2254:88-99`):

| Column | Meaning |
|---|---|
| `filename` `text` PK | e.g. `2224_route_hop_signal.sql` |
| `checksum` `text NOT NULL` | sha256 of the file's bytes at apply time, **or the literal string `backfill`** |
| `applied_at` `timestamptz` | |
| `applied_by` `text NOT NULL` | `'ci'` \| `'manual'` \| `'backfill'`, pinned by a CHECK (`2254:147`) |
| `notes` `text` | carries the applier's run id, which is how `certify:migrations` scopes itself |

RLS enabled with **no policies** and `anon`/`authenticated` revoked (`2254:156`) — a ledger a
client can write is not a ledger.

### 4.1 THE TRAP: a ledger row is not evidence of an apply

`2254` seeded a row for **every one of the 382 filenames on disk when it ran** (`2254:205`,
postcondition `2254:653`) — including the files that had never been applied to anything. The two
sources disagree on how many those were, and neither is worth rounding: `2254:11-18` names five
(`2220`, `2223`, `2224`, `2250`, `2252`) while `apply-migrations.ts:853-856` names eight, adding
`2222`, `2251` and `2253`. The count is not the point; the seeding is. Those rows carry
`applied_by='backfill'` and the literal string `'backfill'` where a hash belongs, and the table's
own comment says what they assert:

> **This filename existed in `src/migrations/` at the moment `2254` ran.** It is *not* evidence
> that the file was ever applied to this database, and nothing verified that it was.
> — `2254:50-53`

So presence of a row is **not** the test. Provenance is:

```ts
export function isProofOfApply(row: LedgerRow): boolean {
  if (row.applied_by !== "ci" && row.applied_by !== "manual") return false;
  return SHA256_HEX_RE.test(row.checksum);          // /^[0-9a-f]{64}$/
}
```
`scripts/src/apply-migrations.ts:870-873`, regex at `:845`.

An applier that skipped on "there is a row" would skip every one of those unapplied migrations
**forever**, apply nothing, and leave `CI (live DB)` red on main for exactly the original reason
(`apply-migrations.ts:848-869`). The same rule binds every human reading the table: for any
**pre-`2254`** file the ledger has nothing to say, and live object inspection is still the only
evidence (`checkMigrationPrefixes.ts:52-64`).

A real sha256 is also never *computed* for a backfill row on the way past: hashing today's bytes
would produce a genuine digest of the wrong thing, and 64 hex characters in a column called
`checksum` read as "this is what ran" (`2254:65-76`). `check:migration-ledger` therefore counts
non-hash checksums as **NOT COMPARED** and prints how many it skipped, rather than reporting ~382
false mismatches on its first run (`checkMigrationLedger.ts:32-37`).

The arithmetic today: 382 backfilled + 34 files added since (`2221` plus `2255`–`2309`) = the 416
on disk, with **zero** orphaned ledger names.

## 5. The applier

`pnpm --filter @workspace/scripts run db:apply-migrations` (`scripts/src/apply-migrations.ts`,
1488 lines, most of it argument). It exists because five migrations reached `main` and were never
applied, so `CI (live DB)` went red **on main itself** and the repair each time was a contributor
hand-pasting old migrations through the Management API — unordered, unrecorded, and dependent on
somebody noticing (`apply-migrations.ts:4-23`).

- **Ordered** — the byte-wise chain order of §3.1, with `assertUnambiguousOrder()` refusing to act
  on a *pending* set whose relative order is undefined rather than picking a side
  (`:230-252`).
- **Recorded** — the ledger `INSERT` sits between the migration's last statement and the `COMMIT`,
  so "applied but unrecorded" is unreachable (`:963-1006`). `ON CONFLICT DO UPDATE`, not
  `DO NOTHING`: an upgraded backfill row must stop being a backfill row, or the same file is
  offered forever (`:966-981`).
- **Automatic** — invoked by `.github/workflows/live-db.yml:705`.

**Shapes it refuses, by name** (`classifyMigration`, `:610-729`), because a false claim of
atomicity is worse than a refusal:

| Refusal | Why |
|---|---|
| an interior `COMMIT`, a second `BEGIN` block, `START TRANSACTION` | an inner `COMMIT` commits the **outer** transaction, leaving the ledger row outside it |
| a top-level `ROLLBACK` / `ABORT` / `SAVEPOINT` | e.g. `2182`'s post-apply verification probe — not replayable, apply by hand |
| SQL before the opening `BEGIN`, or a non-assertion tail after the final `COMMIT` | half the file would run outside the transaction (`analyseTail`, `:551-608`) |
| `CREATE INDEX CONCURRENTLY` | Postgres cannot run it in a transaction block at all, so it can never be atomic with its ledger row |
| a file with no SQL at all | a ledger row asserting that something ran when nothing did |

Two details worth knowing before you trust a grep. The transaction-statement scanner is comment-,
string- and dollar-quote-aware, because `COMMIT` appears inside plpgsql bodies in this tree
(`:281-292`); and the keyword masker for `CONCURRENTLY` strips comments **recursively, including
inside dollar-quoted bodies** (`maskForKeywordScan`, `:458-511`). Consequence, verified: five
canonical files contain the word `CONCURRENTLY` and all five have it only in prose — `0186_geo_indexes.sql:47-49`
merely *advises* using it if a table grows. **No file in the tree currently trips that refusal;
it is a forward rule.**

142 canonical files open with a line-initial `BEGIN;`. Those are unwrapped and re-wrapped so the
ledger row joins the same transaction — semantics preserved, atomicity now including the record
(`:58-83`).

`--apply-unproven <files>` is the only way to apply a file sitting behind a backfill row, and it
is deliberately an explicit per-file list and never a mode: replaying a migration that *was* in
fact applied is the destructive direction and nothing in the ledger can tell the two apart, so a
human decides per file (`:908-931`).

## 6. CI: what runs, where, and why your PR is red

`.github/workflows/live-db.yml`, job **`schema-drift`** (`:561`). Steps, in order:

1. **Allowlist preflight** — `assert-nonprod-supabase.sh` (`.github/workflows/live-db.yml:614`). This is a fail-fast duplicate,
   **not** the protection. The load-bearing assertion is in the execution path: every entry point
   imports `src/lib/ciSupabaseGuard.mjs` (or the read-only door) as its **first** import, and ES
   module evaluation order means the guard runs to completion before `@supabase/supabase-js` is
   even loaded (`ciSupabaseGuard.mjs:21-44`). Deleting the YAML step, `if: false`-ing it, or
   writing a brand-new workflow does not get past it. The script is an **allowlist** — exactly one
   acceptable ref (`assert-nonprod-supabase.sh:211`) — with the production ref as a secondary
   assertion (`:219`), and it refuses outright if a Supabase CLI, committed link state, or any
   libpq connection string is present, because those reach a database without resolving a ref at
   all (`:135-186`).
2. **`db:apply-migrations:dry-run`** on **every ref including PRs** (`:690`). It reads the ledger,
   computes the order, classifies every pending file, and **writes nothing**. This is what turns
   "this migration cannot be applied atomically with its ledger row" into a red on the PR that
   introduces it instead of a red on main after it merges.
3. **`db:apply-migrations`** — `github.ref == 'refs/heads/main'` only (`:705`). Applying an
   unmerged branch's migrations to the shared CI database would leave it ahead of main with no
   commit accounting for it.
4. **`certify:migrations`** — main only (`:716`). A separate process reading the catalog, because
   an applier's own report is a claim about a request and not about a database
   (`certifyMigrations.ts:6-11`). Five stages, stopping at the first failure: ledger parity
   (delegated to `check:migration-ledger`, never reimplemented), declared objects, grants + RLS,
   the migrations' **own postcondition `DO` blocks re-run after the commit**, then the repo-wide
   live checks (`certifyMigrations.ts:26-44`).
5. **`audit:schema`**, **`check:media-objects`**, **`audit:shadow-append-only`** — every ref
   (`:727,734,755`).

### 6.1 THE TRAP: a PR that adds a migration is red until that migration is applied out-of-band

Step 5 runs on PRs; step 3 does not. `audit:schema` fails (exit 1) when a migration file claims an
object the live catalog does not have, and it has **no post-cutover exemption** — its `SKIP_FILES`
set holds four named files and nothing else (`auditMigrationsVsLive.ts:142-163`). So a PR adding
`2310_whatever.sql` is red on `schema-drift` from the moment it is pushed until somebody applies
that migration to the CI project. `2120_canonical_events.sql:8-13` states this in its own header
as expected behaviour, not a finding.

This is a known, accepted cost of ordering the apply behind the merge. Do not "fix" it by
allowlisting the new objects — an allowlist entry written optimistically ("migration pending")
becomes a permanent hole, and one already shipped a raw Postgres error to users
(`.agents/memory/db-column-drift.md` § "ALLOWLIST entries can permanently hide a real drift").

## 7. THE TRAP: the authorization helpers live in schema `authz`, not `public`

`2182_close_authz_rpc_oracle.sql` closed an anonymous predicate oracle: `is_blocked(a,b)`,
`in_accepted_circle(viewer,target)` and `can_see_location(viewer,target)` are `SECURITY DEFINER`
and take **the caller's identity as a parameter**, so any anonymous caller with the publishable key
got a boolean oracle over the social and location-privacy graph — proven live against production
(`2182:19-31`). The fix moved them out of PostgREST's reach without touching a single body:

```sql
CREATE SCHEMA IF NOT EXISTS authz;                                    -- 2182:87
GRANT USAGE ON SCHEMA authz TO anon, authenticated, service_role;     -- 2182:92
ALTER FUNCTION public.is_blocked(uuid, uuid)         SET SCHEMA authz; -- 2182:95
ALTER FUNCTION public.in_accepted_circle(uuid, uuid) SET SCHEMA authz;
ALTER FUNCTION public.can_see_location(uuid, uuid)   SET SCHEMA authz;
```

`ALTER FUNCTION … SET SCHEMA` mutates `pg_proc` in place, so the OID, ACL and every dependency edge
survive and all four RLS policies keep binding with zero expression changes (`2182:65-71`).

**What this means when you write a policy.** Reference these three as `authz.is_blocked(a, b)` and
`authz.in_accepted_circle(viewer, target)`. A migration that writes `public.is_blocked(...)` in a
`USING` clause **fails at apply time** against any database where 2182 has landed.

**And the deliberate exception:** `viewer_is_blocked(target_id)` **stays in `public`** — it derives
the caller from `auth.uid()` internally and was never vulnerable, so 2182 left it untouched
(`2182:33-34`; defined `2033_rls_hardening.sql:23`, search_path pinned
`0201_pin_search_path_authz_functions.sql:81`). `can_see_post(p_id)`, `can_see_trip(t_id)` and
`shares_trip_with(other)` likewise stay in `public`. So the rule is not "authorization functions
live in `authz`" — it is "the three that trust a parameter live in `authz`; the ones that read
`auth.uid()` live in `public`", and getting the split wrong breaks RLS DDL at apply time.

**The environments disagree, and that is the sharp edge.** 2182's own status block records it
applied to **CI on 2026-08-28** with a production dry run passing inside `BEGIN…ROLLBACK`, and the
production press still **PENDING OWNER** (`2182:10-14`). Tools must therefore resolve the schema at
runtime rather than hard-code either prefix — `verify-search-path-hazard.mjs:166-180` looks each
function up in `pg_proc` restricted to `('public','authz')` and fails loudly if it finds it in
neither or both, precisely because a hard-coded `public.` errors on a migrated database and a
hard-coded `authz.` errors on one that is not.

`authz` also holds newer helpers written there from birth: `authz.viewer_in_call(uuid)`
(`2199_call_participants_rls_recursion.sql:87,115,124`), whose postconditions assert that `anon`
and `authenticated` **retain EXECUTE** — revoke it and RLS cannot evaluate the policy at all
(`2199:190-192`).

## 8. RLS and grant posture

RLS is enabled on **every** table in the baseline: 387 of 387 in `public`, 8 of 8 in `storage`.
The interesting axis is not enablement, it is whether a table has any policy at all
(`src/scripts/rlsDispositions.ts:36-37`, generated mechanically from the baseline at `:29`):

| Class | Count | Meaning |
|---|---|---|
| `RLS_REQUIRED` | 327 | RLS on, ≥ 1 policy |
| `DENY_ALL_BY_DESIGN` | 60 | RLS on, **zero** policies — deny-all to every role but `service_role`, which bypasses RLS |
| `REVIEWED_EXEMPT` | 0 | |
| `NEEDS_REVIEW` | 0 | |

Independently reproduced here by diffing `ENABLE ROW LEVEL SECURITY` targets against
`CREATE POLICY` targets in the baseline: the same 60. Every `public` table must carry exactly one
entry — no default, no inherited silence — and `src/test/rlsDispositions.test.ts:19-27` re-parses
the committed baseline at test time and fails on any table with no entry.

The 60 are the server-mediated tables: moderation and admin audit (`admin_access_log`,
`compass_admin_actions`, `trust_admin_actions`, `feature_flag_audit_log`,
`post_media_moderation_ledger`, `ranking_config_audit_log`, `call_moderation_actions`), the
internal caches (`place_living_cache`, `compass_*_cache`, `weather_cache`), and a handful of
social tables the client is not allowed to reach directly (`friend_requests`, `post_reactions`,
`comment_likes`). Note 55 tables in the chain also carry explicit
`REVOKE ALL … FROM anon/authenticated` (grep over the canonical dir), which is belt to RLS's
braces.

**The canonical pattern for a restricted table** is `2217_protected_locations.sql:156-161`:

```sql
ALTER TABLE public.protected_zones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.protected_zones FROM PUBLIC;
REVOKE ALL ON public.protected_zones FROM anon;
REVOKE ALL ON public.protected_zones FROM authenticated;
REVOKE ALL ON public.protected_zones FROM service_role;      -- ← the one people omit
GRANT SELECT, INSERT, UPDATE, DELETE ON public.protected_zones TO service_role;
```

That fifth line is not decoration. **Supabase's `public` schema carries `ALTER DEFAULT PRIVILEGES`
granting ALL to `service_role` at `CREATE TABLE` time**, so a bare `GRANT INSERT, SELECT` after a
`CREATE TABLE` establishes no limit whatsoever. `2092_discovery_shadow_serves.sql:192-195` did
exactly that, its header claimed `service_role` held "INSERT and SELECT and nothing else", and the
live catalog said `DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE`
(`2093_discovery_shadow_serves_grants.sql:5-22`). The revoke must come first and be unconditional
(`2093:104-105`).

Nothing caught it, and *why* is the useful part: `audit:schema` **does** model table grants, but as
a **presence** check — "is each grant a migration claimed actually present?" It cannot see excess
privilege and does not model `REVOKE` at all (`auditShadowAppendOnly.ts:6-19`). Both claimed grants
were present, so the audit was correct to report nothing.

`2217` is also the reference for two policy judgements worth copying. It **ships empty on
purpose** — which real-world addresses are protected is a policy decision with a named owner, not a
schema decision, and an empty table is safe by construction (`2217:11-24`). And it is
**deliberately not feature-flagged**: a privacy gate with an off switch is not a gate, and the
natural default of a new flag (OFF) is the unsafe direction (`2217:26-32`).

## 9. Append-only tables

Three independent mechanisms, and the argument for each is that any one of them can silently fail
to land (`2120_canonical_events.sql:26-36`):

1. **Grants** narrowed to `INSERT, SELECT` for `service_role`, with the revoke first (§8).
2. **RLS** enabled, deny-by-default.
3. **Triggers that `RAISE` on any mutation**, so the statement fails regardless of who issues it.

The canonical trigger set is `discovery_shadow_serves`' three
(`auditShadowAppendOnly.ts:101-103`):

| Trigger | Level | Why it exists separately |
|---|---|---|
| `discovery_shadow_serves_no_update` | `BEFORE UPDATE … FOR EACH ROW` | the actual guard (`2092:209-213`) |
| `discovery_shadow_serves_no_update_stmt` | `BEFORE UPDATE … FOR EACH STATEMENT` | a row-level trigger fires only for matched rows, so `UPDATE … WHERE false` would succeed. With this, the property is verifiable by a statement that touches nothing (`2092:215-231`) |
| `discovery_shadow_serves_no_truncate` | `BEFORE TRUNCATE … FOR EACH STATEMENT` | `TRUNCATE` fires **no** row-level triggers at all (`2093:114-118`) |

`audit:shadow-append-only` asserts the **exact** grant set rather than a claimed subset — the only
form of the question that answers "can this table be mutated" — plus RLS-on and all three triggers
enabled (`auditShadowAppendOnly.ts:42-55`). It runs in CI at `live-db.yml:755`; before that wiring
it was a committed script nothing invoked.

**The statement-level UPDATE/DELETE trigger has been retracted twice, and the reason generalises.**
A `BEFORE … FOR EACH STATEMENT` trigger fires when the statement *starts*, so it cannot tell
"nothing here to protect" from "someone is rewriting history". `DELETE FROM profiles` cascades into
`intel_observations`, the statement trigger refused, and the live-DB RLS suite's fixture teardown
died — a security suite red for a reason three subsystems away
(`2137_intel_stmt_trigger_removal.sql:10-32`). Migrations `2276`/`2277`/`2279` re-attached the same
guard to three new tables and reproduced the identical failure on PR #402, removed again by
`2292_intel_stmt_trigger_removal_ig_campaign.sql:1-27`. **TRUNCATE guards are untouched** in both
cases, because nothing else stands between an append-only table and `TRUNCATE`.

**Append-only governs correction, not retention.** `intel_append_only()` refuses `UPDATE`
unconditionally but permits `DELETE` inside a transaction that has explicitly declared an erasure:

```sql
SET LOCAL portava.erasure_in_progress = 'on';
```

`SET LOCAL` scopes it to that transaction so the permission cannot leak onto later work on the same
connection, and the declaration *is* the audit trail — an ordinary bug cannot delete an
observation, and a deletion worker says out loud that it is erasing
(`2130_intel_storage.sql:67-101`). A table that cannot be deleted from cannot honour a right to
erasure.

## 10. Deletion dispositions

`executeAccountDeletion` keeps an **anonymised tombstone** `profiles` row rather than deleting it,
so no FK cascade hanging off `profiles` ever fires and every table must be cleared by hand.
Measured against production 2026-08-22: **255 tables carry a user-identifying column and 229 of
them are untouched by deletion** (`src/lib/deletionDispositions.ts:6-10`).

The manifest does not fix that; it makes it impossible to grow silently. Every user-keyed baseline
table sits in exactly one bucket and `check:deletion-coverage` fails when a **new** table appears
in none: `ERASED_BY_CASCADE` (46 entries, `:32`), `RETAINED_WITH_REASON` (1, `:230`),
`UNCLASSIFIED_BACKLOG` (225, `:256`). The backlog is explicitly **not a decision** — being on it
means the data survives deletion and nobody has said whether it should
(`deletionDispositions.ts:18-27`).

## 11. The entity map

316 distinct table names are created by the canonical chain (`CREATE TABLE` extraction over the
canonical dir returns 323; seven are prose inside comments). Grouped by the migration that
introduces each family — the spine itself is in the baseline, not here:

| Domain | Representative tables | Introduced by |
|---|---|---|
| **Spine** (baseline only) | `profiles`, `posts`, `trips`, `trip_members`, `events`, `messages`, `message_threads`, `circles`, `circle_memberships`, `user_follows`, `user_friendships`, `memories` | — |
| Trips & plans | `trip_plan_items`, `trip_budget`/`trip_checklists`/`trip_documents`/`trip_notes`, `route_plans`/`route_legs`/`route_stops`, `trip_readiness_*`, `trip_reservations` | `0010`, `0058`, `0079`, `0170`, `0172` |
| Geo & location | `user_location_state`, `location_sessions`, `geo_zones`, `plan_geofences`, `plan_checkins`, `trip_crew_location_*`, `locate_friends_*` | `0025`, `0033`–`0041`, `2219` |
| Discovery & places | `discovery_places`, `discovery_cache`, `discovery_geocode_cache`, `places`, `canonical_locations`, `fsq_places`, `place_living_cache`, `place_days`, `hidden_gems` | `0029`, `0043`, `0125`, `0168`, `0184`, `2028`, `2047`, `2063` |
| Ranking & shadow | `rank_events`, `content_distribution_stats`, `ranking_debug_samples`, `discovery_shadow_serves`, `discovery_place_photos` | `0153`, `2059`–`2060`, `2092`–`2095` |
| Compass / intelligence graph | `compass_*` (≈35 tables), `compass_graph_nodes`/`_edges`, `compass_city_models`, `compass_city_confidence` | `0051`–`0055`, `0104`, `20260723`–`20260730` |
| Canonical event spine | `canonical_events`, `sources`, `freshness_policies` | `2120`–`2122` |
| Intel / claims | `intel_claims`, `intel_observations`, `intel_evidence`, `intel_state_snapshots`, `intel_reward_ledger`, `intel_presence_verifications`, `intel_attributions`, `intel_historical_patterns` | `2130`, `2167`–`2181`, `2273`–`2280` |
| Memory projection | `memory_events`, `memory_projections`, `memory_feedback`, `memory_policy` | `2183`, `2192` |
| Media | `media_assets`, `media_attachments`, `post_media`, `media_events`, `media_dedup_*`, `media_view_requests`, `media_intent_signals` | `0103`, `0191`, `2039`–`2046`, `2256`–`2257` |
| Passport & stamps | `passport_stamps`, `passport_stamps_gps`, `passport_memories`, `universal_stamp_catalog`, `stamp_definitions`, `user_stamps`, `stamp_milestones`, `passport_telemetry_events` | `0025`, `0042`, `0081`, `0121`, `2051`, `2287` |
| Social & safety | `blocks`, `reports`, `moderation_actions`, `user_privacy_settings`, `user_restrictions`, `safe_return_*`, `appeals` | `0015`, `0063`–`0070`, `0167` |
| Rent-a-buddy | `rent_buddy_*` (≈40, baseline) + `rent_buddy_availability`, rollout tables, `buddy_*` compat views | baseline, `0090`, `0133`–`0134`, `0160` |
| Calling & E2EE | `call_sessions`, `call_participants`, `call_preferences`, `devices`, `key_packages` | `0155`–`0156`, `20260801`–`20260802` |
| Wall | `wall_session_intents`, `wall_telemetry_events` | `2271`, `2308` |
| Platform | `feature_flags`, `feature_flag_audit_log`, `admin_access_log`, `job_health`, `schema_migration_ledger`, `protected_zones` | `0037`, `0017`, `0118`, `2035`, `2217`, `2254` |

Two naming facts that recur as bugs: `feature_flags`' key column is **`flag`**, not `key`
(`baseline:` `CREATE TABLE public.feature_flags`), and coordinate columns are **inconsistent across
tables** — `user_location_state` uses `lat`/`lng` while other layers use `latitude`/`longitude`
(`.agents/memory/db-column-drift.md`). Recall is unreliable here; check the baseline.

Storage: 8 Supabase-managed tables and exactly **4** policies on `storage.objects` in the baseline
— owner-scoped insert/delete on `post-media` (with an extension allowlist) and public read /
service write on `stamp-artwork`. `post_media_storage_public_read`, which granted role `public`
SELECT on every object in the post-media bucket, was dropped by
`2089_revoke_post_media_public_read.sql`.

## 12. What is NOT built, and why

- **Nothing applies a migration to production.** The applier's target guard refuses the production
  ref unconditionally, even if an operator sanctions it (`apply-migrations.ts:100-106`). Production
  migrations are applied by a human pasting SQL into the Supabase SQL editor or POSTing to the
  Management API, and **no mechanism in this repository can reach that**
  (`docs/RECONCILIATION-PACKET.md:560`). CI proves a migration on `portava-ci`; the production
  press is a separate, deliberate act. `2182` has been in that state since 2026-08-28.
- **The repo-root `migrations/` tree is never audited against live**, with or without
  `--include-legacy`. It partly overlaps both other chains and would produce mass false-positive
  drift (`docs/migrations.md` § "Why the root `migrations/` tree is not included"). It is frozen,
  not reconciled.
- **The inverse audit is built but runs in no workflow.** `audit:live-unexplained`
  (`auditLiveVsCanonical.ts:1-24`) asks the reverse question — "does every object that exists
  *live* have a canonical explanation?" — against the model *baseline + canonical ≥ `"2100"` +
  the explained ledger*. Its only caller is `.github/scripts/clean-build-proof.sh:172-174`, whose
  own header says it is wired to `.github/workflows/clean-build-proof.yml`
  (`clean-build-proof.sh:14`) — **and that file does not exist**; `.github/workflows/` holds
  `ci.yml`, `live-db.yml` and `unwired-checks.yml` and nothing else. So the drift the forward
  audit structurally cannot see — live objects no migration declares — is still found by accident
  (`docs/schema-reconciliation-2026-08-08.md:27-31`: a complete live-side inventory has never been
  performed).
- **The 20 `reconciliation-staging/` proposals are unapplied**, by design — dropping them into the
  canonical tree would turn `audit:schema` red and falsely imply they are ready
  (`reconciliation-staging/README.md:11-16`). Promotion happens one file at a time —
  `2143_plan_geofences_policy_convergence.sql:3-10` promotes staging `2100` with its blocking
  query resolved and one real defect in it fixed — which is the intended path: one file, one
  review, one renumber out of the reserved band.
- **`src/lib/database.types.ts` is stale and is not regenerated by anything.** Verified: it has
  406 `Row:` entries and no entry for `protected_zones`, `wall_telemetry_events`,
  `schema_migration_ledger` or `availability_windows`. It drifts in **both** directions — it can
  name columns live does not have (code compiles, every insert fails with PGRST204) and omit
  columns live does have (`.agents/memory/db-column-drift.md`). The live-column snapshot the drift
  tests read (`src/test/generated/liveColumns.json`) is refreshed only by an explicit
  `refresh:live-columns` run against a live database (`scripts/src/refresh-live-columns.ts:1-17`).
- **The baseline has not been recaptured since 2026-08-19.** Everything the post-cutover band has
  built since is invisible to it, which is why `deletionDispositions.ts:33-42` cannot yet list
  `phone_verification_challenges` even though the service already deletes it. A recapture is a
  prerequisite for several open items, not a chore.
- **Event Truth** — the append-only decision store that would make a ranked page reconstructable
  six months later — is Phase-B gated and unbuilt: no migrations exist for it. `rank_events`
  remains mutable state, not an event log. See `04_Behavior_Engine.md`.
- **There is no local replica of production, and `DATABASE_URL` is not one.** `DATABASE_URL` is
  read in exactly four files, all under `lib/db/`, and no api-server route reaches production
  through it. A query against it succeeds, returns rows, and tells you nothing about production —
  the worst possible failure shape. Use the Management API `database/query` endpoint
  (`.agents/memory/live-db-vs-local-postgres.md`).

## Corrections to earlier records

- `.agents/memory/migration-applied-vs-committed.md:6` states "there is **no migration runner** in
  this repo and **no `schema_migrations` table**". Both halves are now out of date: there is a
  runner (`scripts/src/apply-migrations.ts`, wired at `live-db.yml:690,705`) and there is a ledger
  (`public.schema_migration_ledger`, `2254`). **The entry's actual lesson survives intact and is
  now sharper**: a committed file is still not evidence of an apply, and — per §4.1 — neither is a
  ledger row, unless `isProofOfApply()` accepts it.
- `docs/database-audit.md` is dated 2026-07-04 and predates the baseline, the cutover, the ledger
  and the applier. Treat it as history.
- `docs/migrations.md`'s "applied" column carries its own warning and has been wrong in both
  directions. Ask `check:migration-ledger` first; for anything pre-`2254`, inspect the live objects.
