# CI

## Read this first

**Before these workflows existed, every check in this repository was advisory.**

That is not a figure of speech. There was no `.github/` directory. Nothing ran
on push, on pull request, or on merge. Every check in this repo — and there are
a lot of good ones — ran only when a human remembered to type its name, or
clicked a Replit workflow button. The consequences were not hypothetical:

- `check:all` in `artifacts/api-server` ran six static checks and **zero tests**.
- A test-runner flag (`--test-force-exit`) silently dropped **54-133 tests per
  green run** for months, and the repo's own memory file was instructing agents
  to restore it.
- `check:migration-prefixes` was correct, committed, and **failing on a real
  collision** — while everyone saw green, because nothing invoked it.
- A token-naming invariant test was retargeted onto a different token family
  and stayed green.
- 12 of 15 live triggers and 6 of 56 live functions have no migration
  authoring them.
- `replit.md` carried a CI status badge pointing at
  `.github/workflows/pre-release.yml`, and `docs/eas-runbook.md` referenced a
  step inside it. **That file did not exist.** The badge advertised a CI that
  was never committed.

And two more, found by adversarial review of the *first* version of these
workflows — because a CI system is not exempt from its own rule:

- Every check step invoked its package script through pnpm's workspace-selector
  form, **which exits 0 when it matches nothing.** A renamed package or a deleted
  script would have reported success having run no code.
- The non-production guard was a **denylist of one ref** while this document
  claimed non-production was "enforced mechanically". Any unlisted project —
  including a second production project — passed it.

And one found by five consecutive rounds of failing to fix it the same way:

- The Supabase allowlist was a **step in a YAML file**, and everything else was
  an attempt to prove that step was present, unconditional, first, and real.
  Each round's scan was defeated by a construct the previous round did not
  model — comments, `env:` indirection, `if:`, step order, shell conditionals,
  `secrets[...]` index form. **The scan was always one construct behind**,
  because no finite pattern set closes an unbounded expression surface. The fix
  was to stop scanning: the assertion now lives *inside* every process that can
  reach Supabase, so there is no step to skip. See
  [The allowlist is enforced in the execution path](#the-allowlist-is-enforced-in-the-execution-path).

Every one of those was found by a human going looking. That is the problem
these workflows exist to fix.

The governing rule, which every design decision below follows from:

> **A missing secret, a missing tool, or a skipped step must never read as
> success.**

And the rule that bounds it, because a CI system cannot be the last word on its
own integrity:

> **Everything that checks this repository lives in this repository. The
> outermost guard is therefore branch protection plus review of `.github/**`, not
> another file.**

That boundary is deliberate, and it is stated in full — with what is and is not
enforced mechanically, and the concrete settings that carry the rest — in
[Where mechanical enforcement ends](#where-mechanical-enforcement-ends). **Read
that section before adding another guard.**

---

## The workflows

| File | Needs secrets? | What it covers |
| --- | --- | --- |
| `.github/workflows/ci.yml` | No | api-server typecheck + credential-free checks, the ~392-file api-server suite, the whole standalone `check:all`, and CI's own integrity |
| `.github/workflows/live-db.yml` | **Yes** | api-server `check:all` incl. the live_pulse deploy gate, schema-drift audit, and the three live-DB security suites |
| `.github/workflows/unwired-checks.yml` | No | checks that exist in this repo and are invoked by nothing. On probation — see below |
| `.github/scripts/run-live-suite.sh` | — | scoring helper for the three live-DB suites; used only by `live-db.yml` |
| `.github/scripts/pnpm-run.sh` | — | the only sanctioned way to run a package script; asserts the package and script exist first |
| `.github/scripts/assert-ci-scripts.mjs` | — | fail-fast preflight: every `(dir, package, script)` triple named under `.github/` exists |
| `.github/scripts/assert-nonprod-supabase.sh` | — | the Supabase project **allowlist policy**; one implementation, run by the in-process chokepoint below and, as a fail-fast duplicate, by three workflow steps |
| `artifacts/api-server/src/lib/ciSupabaseGuard.mjs` | — | **the strict front door.** Imported first by the five entry points that write or are not sanctioned to read production; runs the allowlist policy before any client is constructed or query issued. This is what keeps CI off production |
| `artifacts/api-server/src/lib/ciProdReadOnlyAuditGuard.mjs` | — | **the read-only front door.** Imported first by the four SELECT-only audits. Identical in CI; outside CI only, and on a deliberate named request, it also permits a read-only audit of the declared production project |
| `artifacts/api-server/src/lib/supabaseTargetPolicy.mjs` | — | the single implementation behind both doors. Takes the mode as an argument; each door passes a hard-coded constant. Only the two doors may import it, enforced by `check:guard-coverage` |
| `artifacts/api-server/scripts/check-guard-coverage.mjs` | — | counts who is actually behind each door: every `src/` file that can reach Supabase is guarded or exempt-with-a-reason, and the read-only capability is granted to exactly four named files |
| `.github/scripts/check-unrunnable-tests.mjs` | — | test files no runner CI invokes will execute, with its own limits printed |

### Jobs

**`ci.yml`** (six jobs):

- `preflight` — no install, no network. Asserts every `(package directory,
  package name, script)` triple named under `.github/` exists on disk. The other
  three heavy jobs `needs:` it.
- `api-server-static` — `typecheck`, then `check:frozen-dir`,
  `check:async-handlers`, `check:migration-prefixes`, `check:test-runner-flags`
  as individually-named steps, then `check:test-registration` plus a
  registered-test-file count floor.
- `api-server-tests` — the curated single-line `test` script (392 files).
- `standalone-checks` — `travel-buddy-standalone`'s own `check:all`.
- `ci-self-check` — no install, no network; asserts CI cannot be defanged, and
  runs the unrunnable-test guard. Deliberately **not** gated on `preflight`, so
  CI's own integrity is checked even when the preflight is red.
- `ci-verdict` — `if: always()`, needs every other job. Fails unless each
  reported `success`, naming the ones that did not. **This is the check to put
  in branch protection, and the other five must not be.** See "A skipped job is
  scored as a pass" below.

**`live-db.yml`** (five jobs):

- `preflight` — the same credential-free script-existence guard.
- `api-server-check-all` — the full seven-check aggregate including the
  live_pulse gate.
- `schema-drift` — `audit:schema` and `check:media-objects`.
- `live-db-security-suites` — the three live-DB suites, one step each.
- `live-db-verdict` — `if: always()`. Fails unless every other job reported
  `success`, so a cancelled or skipped job resolves to an explicit red instead of
  an ambiguous grey. See "Concurrency" below.

**`unwired-checks.yml`** (four jobs): `preflight`, `root-workspace`,
`standalone`, and `unwired-verdict` — the same `if: always()` verdict job, for
the same reason. When this workflow leaves probation and goes into branch
protection, `unwired-verdict` is the check to require.

### A skipped job is scored as a pass

GitHub does not fail a job whose `needs` failed — it **skips** it. And a skipped
required status check is scored as **successful**. Three jobs in `ci.yml` and two
in `unwired-checks.yml` declare `needs: preflight`, so a broken preflight left
them all grey-but-satisfied: required checks that ran no code at all, reported as
green. That is the same "did not run reads as passed" failure this CI exists to
remove, reintroduced by the dependency edge added to fail fast.

Each workflow therefore ends in a verdict job that runs with `if: always()`,
needs every other job, and fails unless each reported `success`. Only its success
implies the rest actually ran. Hyphenated job ids are read with bracket notation
(`needs['api-server-static'].result`) because `needs.api-server-static` parses as
a subtraction in the expression language.

#### The required status checks — the only correct list

This is the authoritative statement. Nothing else in this document overrides it.
A required status check in GitHub is a **check run**, which is a **job**, named by
that job's `name:`. Requiring the individual jobs is the defect the verdict jobs
exist to repair, because a skipped job satisfies a required check.

| Require this check | Provided by | Add it |
| --- | --- | --- |
| `CI · verdict (skipped or cancelled is not a pass)` | `ci.yml`, job `ci-verdict` | Now |
| `live DB · verdict (cancelled or skipped is not a pass)` | `live-db.yml`, job `live-db-verdict` | Once the non-production Supabase project is configured |
| `unwired · verdict (skipped or cancelled is not a pass)` | `unwired-checks.yml`, job `unwired-verdict` | Once that workflow is green and leaves probation |

**Require the verdict jobs. Never require the individual jobs.** Adding
`api-server · node:test suite` or `standalone · check:all …` to the required list
does not add safety and actively removes some: if `preflight` fails, those jobs
are *skipped*, a skipped check run is scored **successful**, and the branch
becomes mergeable on the strength of three checks that executed nothing. The
verdict job is the only check whose success is evidence that the others ran.

---

## How package scripts are invoked, and why it is not the obvious way

**`pnpm`'s workspace-selector form exits 0 when it matches nothing.**

Reproduced against pnpm 10.26.1:

- a selector that matches no package prints `No projects matched the filters`
  and **exits 0**;
- a selector that matches a package which has no such script also **exits 0**.

Every one of these workflows was originally written that way. That meant every
check step reported **success** if the package name was misspelt, if a package
was renamed or moved, or if the script it named was renamed or deleted — a check
that did not run, reporting that it passed. That is the identical failure this
whole effort exists to eliminate, reintroduced by the tool.

So no workflow uses that form. Two layers replace it, and neither depends on
pnpm's exit-code semantics:

1. **`.github/scripts/pnpm-run.sh <package-dir> <package-name> <script>`** —
   every invocation. Before pnpm is executed at all it asserts the directory
   exists, that its `package.json` declares **exactly** that package name, and
   that the script is present and non-empty. Only then does it `cd` into the
   directory and `exec pnpm run <script>`, so the script's exit code is the
   step's exit code with nothing in between.
2. **The `preflight` job** in all three workflows runs
   `.github/scripts/assert-ci-scripts.mjs`, which scans every YAML, shell **and
   `.mjs`** file under `.github/` for those invocations and checks all of them
   against `package.json` on disk — before any job installs anything. It also
   rejects a parameterised invocation, because an argument it cannot resolve is a
   step it cannot verify.

   **`.mjs` was outside the scan until now**, which put both of this CI's own
   node guards outside every rule in that file — the selector ban, the
   command-position pnpm allowlist, all of it. Appending
   `"cd artifacts/api-server && pnpm run typecheck"` and
   `"pnpm --filter @workspace/api-server run test"` to
   `check-unrunnable-tests.mjs` left the preflight exiting **0**. It does not
   now. `assert-ci-scripts.mjs` itself is excluded from the *call-site* half of
   the scan for the same reason `pnpm-run.sh` and `run-live-suite.sh` are: a
   guard that bans a form has to quote that form in the error it prints, and
   contorting error messages to dodge a scanner is the wrong trade. The
   selector-form ban still applies to it.

What now happens in the two cases that used to pass:

| Broken thing | Old behaviour | New behaviour |
| --- | --- | --- |
| **Package name wrong** (typo, rename, move) | `No projects matched the filters`, exit **0**, step **green**, zero code run | `preflight` fails naming the mismatch (`package.json declares 'X', CI names it 'Y'`) and the dependent jobs never start. If run in isolation, `pnpm-run.sh` fails with the same message. Exit **1** both ways |
| **Script name wrong** (renamed or deleted) | exit **0**, step **green**, zero code run | `preflight` fails naming the missing script and listing the scripts that do exist; `pnpm-run.sh` fails identically at the step. Exit **1** both ways |

Third layer: `ci-self-check` scans `.github/` for the selector form and fails the
build if anyone reintroduces it, alongside `continue-on-error`, `|| true`,
`|| :` and `--if-present`. The selector scan is **not** anchored to the flag
being pnpm's first argument, and it covers the short `-F` alias as well as the
long flag and the `=`-joined spelling — the earlier single pattern matched one
spelling only, and `pnpm -F X run y`, `pnpm -r --filter X run y` and
`pnpm run --filter=X y` all walked past it.

Fourth layer, and the one that closes the larger gap: banning the selector form
only ever said how *not* to invoke a package script. Nothing required a step to
use `pnpm-run.sh` at all, so `cd artifacts/api-server && pnpm run typecheck` was
legal under every pattern — and invisible to the `(dir, name, script)`
verification, because it names none of them literally. `preflight` now enumerates
every **command-position** pnpm invocation under `.github/` and permits only
three: `pnpm --version`, `pnpm store path` and `pnpm install --frozen-lockfile`.
Anything else must go through `pnpm-run.sh` or the preflight fails.

`node <file>` invocations (there is one, for the standalone route-registry guard
that has no `package.json` script) are not affected by this hazard — node exits
non-zero on a missing file — but that step still checks the file exists first, so
a moved script produces a sentence rather than a module-resolution stack trace.

### Why `check:all` is split across two workflows

`artifacts/api-server/scripts/run-all-checks.sh` runs seven things. The last
three (`check:write-path-columns`, `check:missing-live-columns`, and the
`check:rank-events-surfaces` gate) need live credentials and correctly
`process.exit(2)` without them, which `run_check` scores as a failure. That is
the right behaviour and it was not changed. It does mean `check:all` cannot
pass in a credential-free job, so:

- the four credential-free checks are invoked individually in `ci.yml`, by the
  same script names `run-all-checks.sh` uses, so fork PRs still get them;
- the full `check:all` runs in `live-db.yml`, where the credentials exist.

The gate is invoked through `run-all-checks.sh` rather than directly, on
purpose: `run_gate()`'s two-condition scoring (exit 0 **and** the literal line
`GATE live_pulse: PERMITTED`) should have exactly one implementation.

---

## Secrets

Configure these on a GitHub **Environment** named `ci-nonprod-supabase`
(repo → Settings → Environments → New environment). Create it before the first
run; the credential jobs reference it by name. Do not add required reviewers —
that turns every push into a blocked deployment.

These names are not invented here. `scripts/print-github-secrets.sh` already
prescribes `SUPABASE_URL`, `SUPABASE_PROJECT_TOKEN` and `EXPO_TOKEN`, and
`docs/eas-runbook.md` documents `SUPABASE_PROJECT_TOKEN` as the CI-preferred
token with creation instructions.

| Secret | Used by | What it is for |
| --- | --- | --- |
| `SUPABASE_URL` | all three credential jobs | The **non-production** project URL, `https://<project-ref>.supabase.co`. Every credential-dependent script and all three live-DB suites read it. |
| `SUPABASE_PROJECT_TOKEN` | `api-server-check-all`, `schema-drift` | Project-scoped Management API token. Read by every Management-API check: `checkWritePathColumns`, `checkMissingLiveColumns`, `checkMediaObjects`, `auditMigrationsVsLive`, `checkRankEventsSurfaces`. The code reads `SUPABASE_PROJECT_TOKEN \|\| SUPABASE_ACCESS_TOKEN`; CI must use the former. **It is not read-only — it can write**, as [this document states below](#what-it-does-not-establish) at `:469-470`. This row previously quoted `docs/eas-runbook.md` calling it "Project-scoped, read-only… **Preferred.**"; that quotation contradicted the same file two hundred lines down, and the runbook has been corrected. Store and rotate it as a write-capable secret. |
| `SUPABASE_SERVICE_ROLE_KEY` | `live-db-security-suites` | Service-role key. The three suites use it to create fixtures and to re-read authoritatively. |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | `live-db-security-suites` | Anon key. The suites use it to open real unauthenticated and real signed-in sessions — that is the whole point of an RLS test. The code also accepts `SUPABASE_ANON_KEY` as a fallback, but CI sets the `EXPO_PUBLIC_` name. |

`SUPABASE_ACCESS_TOKEN` is the *developer-local* token. `docs/eas-runbook.md`
says of it: "Never commit or store this in CI." Do not use it here.

`EXPO_TOKEN` is not used by anything in these workflows. It is only needed for
EAS build jobs, which are out of scope.

### Repository variables (not secrets)

| Variable | Job | Required? | Purpose |
| --- | --- | --- | --- |
| `CI_SUPABASE_PROJECT_REF` | every credential job in `live-db.yml` | **Yes** | The one Supabase project ref CI is allowed to touch. Empty means every credential job fails closed. An environment *secret* of the same name works too and is used when the variable is unset. |
| `API_TEST_MIN_PASS` | `api-server-tests` | **Yes** | Hard floor on the api-server suite's passing-test total. Empty means the job fails and tells you the value to set. See "API_TEST_MIN_PASS is mandatory" below. |
| `API_TEST_MAX_SKIPPED` | `api-server-tests` | No (defaults to `0`) | Maximum tolerated skipped tests in the api-server suite. The assertion is on by default; this only raises the ceiling. |
| `STANDALONE_MAX_SKIPPED` | `standalone-checks` | No (defaults to `0`) | Maximum tolerated skipped tests in the standalone `check:all` — applied **independently to each half**, `node:test` and jest. Same contract and same default as `API_TEST_MAX_SKIPPED`. |

Every one of these thresholds is validated as a bare non-negative integer before
it is compared. This is not pedantry: these blocks run under `set -uo pipefail`
with no `set -e`, and `[ "$PASS" -lt "$MIN_PASS" ]` with a non-integer
`MIN_PASS` exits **2** with "integer expression expected" — which `if` scores as
**false**. A value of `6,186`, `TBD`, or `6186 ` therefore did not fail the
assertion, it *deleted* it, and the step went green with the floor switched off.
A threshold that is not a bare integer is now a hard failure.

---

## The Supabase credentials MUST point at the one sanctioned CI project

**This is not a recommendation, and it is an allowlist.**

`.replit`'s `[userenv.shared]` block hardcodes
`SUPABASE_URL = "https://ajrurzioarfkagpuxfnb.supabase.co"`. That is the live
project the app runs against. **CI must never point at it** — and, equally, must
never point at any other project nobody sanctioned.

Reasons, in order of severity:

1. **The suites create and delete real auth users.**
   `profileRoleNotSelfWritable.test.ts` and `isOfficialPrivileged.test.ts`
   create fixture users through the service-role client and delete them
   afterwards.
2. **They transiently promote and demote a test victim.** Those two suites
   mutate `profiles.role` and `profiles.is_official` on fixture rows to prove
   that the unauthorised paths are refused and the sanctioned path works. A
   crashed run can leave a fixture user behind in a promoted state.
3. **The live_pulse gate performs a real write probe.**
   `checkRankEventsSurfaces` attempts an `INSERT` into `public.rank_events`
   inside a `DO` block that ends in an unconditional `RAISE`, then runs
   `provePristine()` to assert no row matching its sentinel prefix survived. It
   is always rolled back — but it is still a write attempt against `auth.users`
   and `rank_events`.
4. **`schema-drift` reads the full live schema** through the Management API.

### The allowlist is enforced in the execution path

**This is the load-bearing mechanism. Read this before the two sections that
follow it, both of which describe secondary things.**

The assertion is **not** a workflow step. It is the first thing that executes
inside every process that can reach Supabase: a **guard front door**, imported
as the first `import` in each entry point. Because ES modules evaluate their
imports before the importing module's body — and before every sibling import,
including `@supabase/supabase-js` — a refusal means the entry point's own code
never runs at all: no client is constructed, no Management API call is made, no
query is issued, no auth user is created.

There are **two front doors over one policy**, and which one a file imports is
the whole of what distinguishes them:

| front door | rule |
| --- | --- |
| `src/lib/ciSupabaseGuard.mjs` | the sanctioned CI project, or exit 2. No exceptions, no mode, no variable |
| `src/lib/ciProdReadOnlyAuditGuard.mjs` | the same — **plus**, outside CI only and on a deliberate named request, a read-only audit of the declared production project |

Both call `assertSupabaseTarget()` in `src/lib/supabaseTargetPolicy.mjs`, each
passing a **hard-coded** mode constant. Nothing in the environment changes which
mode a door asks for.

The nine entry points, which are every path by which a CI job actually reaches
Supabase, plus one that no workflow invokes:

| live-db.yml job | invokes | entry point | front door | how it reaches Supabase |
| --- | --- | --- | --- | --- |
| `api-server-check-all` | `check:all` → `scripts/run-all-checks.sh` | `src/scripts/checkWritePathColumns.ts` | read-only | Management API; **SELECT only** |
| `api-server-check-all` | `check:all` → `scripts/run-all-checks.sh` | `src/scripts/checkMissingLiveColumns.ts` | read-only | Management API; **SELECT only** |
| `api-server-check-all` | `check:all` → `scripts/run-all-checks.sh` | `src/scripts/checkRankEventsSurfaces.ts` | **strict** | Management API; **real `INSERT` probe**, rolled back |
| `schema-drift` | `audit:schema` | `src/scripts/auditMigrationsVsLive.ts` | read-only | Management API; **SELECT only** |
| `schema-drift` | `check:media-objects` | `src/scripts/checkMediaObjects.ts` | read-only | Management API; **SELECT only** |
| `live-db-security-suites` | `run-live-suite.sh` | `src/test/rlsHardening.test.ts` | **strict** | `supabase-js`; anon + service-role reads |
| `live-db-security-suites` | `run-live-suite.sh` | `src/test/profileRoleNotSelfWritable.test.ts` | **strict** | `supabase-js`; **creates/deletes auth users**, mutates `profiles.role` |
| `live-db-security-suites` | `run-live-suite.sh` | `src/test/isOfficialPrivileged.test.ts` | **strict** | `supabase-js`; **creates/deletes auth users**, mutates `profiles.is_official` |
| *(none — not wired into CI)* | — | `src/scripts/checkDiscoveryCacheKeys.ts` | **strict** | Management API; SELECT only, but see below |

The other four checks in `run-all-checks.sh` — `check:frozen-dir`,
`check:async-handlers`, `check:migration-prefixes`, `check:test-runner-flags` —
read only files on disk, reach no database, and deliberately do not import a
guard. A fifth, `check:guard-coverage`, is what makes the coverage of both doors
a fact rather than a claim; see
[Who is behind each door](#who-is-behind-each-door).

`checkDiscoveryCacheKeys.ts` is SELECT-only and is nevertheless behind the
**strict** door. That is a deliberate default rather than an oversight: it is a
diagnostic, not one of the four audits whose purpose is watching production, and
the narrow capability below is granted by adding a file to a reviewed list, not
by being read-only. Granting it later is a two-line change plus an entry in
`READ_ONLY_AUDIT_ENTRY_POINTS`.

#### One policy, two doors, nine import sites — and why not one call site

These nine paths **do not converge on a common connection helper**, and that is
a fact about the tree rather than a preference. The six scripts each talk to
the Supabase **Management API** by hand — `process.env.SUPABASE_URL`,
`new URL(...).hostname.split(".")[0]`, then `fetch(https://api.supabase.com/…)`
— six independent copies sharing nothing. The three suites each call
`createClient()` from `@supabase/supabase-js` against PostgREST and the auth
admin API: a different protocol, a different host, different credentials.
`src/lib/supabase.ts`'s `getServiceClient()` is the **application's** helper;
none of the nine use it, and putting the guard there would refuse to let the
production API server boot — a process that is *supposed* to talk to production.

So convergence was *created* rather than assumed: one policy module, which does
not restate the allowlist but **runs
`.github/scripts/assert-nonprod-supabase.sh`**, reached through two doors,
imported first at each of the nine entry points. There is one implementation of
the rule and one implementation of the policy.

#### Why the read-only four are different

The uniform rule was right for the processes that **write** and wrong for the
four that only **read**. Those four exist to audit production — the live-drift
findings in `docs/migrations.md`, and the 114 dangling `post_media` rows, came
out of exactly these scripts pointed at exactly that project. Under one uniform
guard they could not do the thing they are for, and in the Replit workspace,
whose `SUPABASE_URL` is the production project (`.replit:148`), `check:all`
failed on every run for a reason that had nothing to do with the code under
test. A check that is red for an unrelated reason stops being read.

Each of the four was re-read before being moved, and issues **SELECTs only**:

| entry point | what it sends |
| --- | --- |
| `auditMigrationsVsLive.ts` | `pg_class`, `information_schema.columns`, `pg_proc`, `pg_indexes`, `pg_policies`, `pg_type`/`pg_enum`, `pg_trigger` |
| `checkMissingLiveColumns.ts` | `information_schema.columns`, `pg_class` |
| `checkMediaObjects.ts` | `post_media` ⋈ `storage.objects` (dangling rows), orphan-object count |
| `checkWritePathColumns.ts` | `information_schema.columns`, `pg_class`, and one row from `profiles` (`handle = 'portava'`) |

`checkWritePathColumns.ts` is on that list despite its name: the
"write sites" it reports are `.insert()`/`.upsert()`/`.update()` calls it finds
in the **TypeScript AST of `src/routes` and `src/services`**. It performs none of
them.

#### The read-only production audit mode

It is **not** a variable that disables the guard, and there still is no such
thing. It is narrower in four ways, each of which fails closed on its own:

1. **It is not reachable from the write-capable entry points at all.** They
   import `ciSupabaseGuard.mjs`, which passes the strict mode as a hard-coded
   constant. No variable changes that. Setting the intent variable in one of
   those processes is a **refusal**, not a no-op — `pnpm run test:rls-hardening`
   with it set fails even against the sanctioned CI project — so the attempt is
   visible instead of silently ignored.
2. **It is refused inside CI, before anything else is looked at.** If any CI
   marker is *present* in the environment the mode is refused outright, before
   its own value is even examined. **Presence, not truth**: `CI=` (empty)
   refuses exactly as `CI=true` does. The markers are a named list (`CI`,
   `CONTINUOUS_INTEGRATION`, `GITLAB_CI`, `CIRCLECI`, `JENKINS_URL`, `TF_BUILD`,
   `VERCEL`, … ) **plus three whole families — any `GITHUB_*`, `RUNNER_*` or
   `ACTIONS_*` variable** (except `GITHUB_TOKEN`, which Actions does not set on
   its own and developers commonly export for `gh`). GitHub Actions exports
   roughly twenty of those on every runner and a workflow cannot remove them
   through `env:`.

   **The residual, stated rather than glossed.** This is an environment test and
   a `run:` step is a shell, so
   `run: unset CI GITHUB_ACTIONS … && pnpm run audit:schema` would defeat it. No
   environment test can prevent that. The claim that is actually made is
   narrower: **no workflow reaches this mode by accident**, by inheriting an
   `env:` block, or by setting one variable — defeating it takes a conspicuous
   line that unsets every `GITHUB_*`, `RUNNER_*` and `ACTIONS_*` variable *and*
   types this repo's intent sentence, in a branch-protected file a human reads.
   That is the same answer this document gives for every other property of
   `.github/**`, and it is why the sentence "no CI job can reach production"
   below is scoped to jobs as written rather than to jobs as conceivable.
3. **The request is a sentence, not a flag.**
   `PORTAVA_PROD_READ_ONLY_AUDIT` must be exactly
   `read-only-audit-against-production`. `1`, `true`, `yes` and `on` are each
   refused, with a message that names the real value. When it is accepted the
   process prints a banner naming the mode, the ref it resolved, the declared
   production ref, and that it is read-only.
4. **It permits exactly one target.** Not "any project that is not the CI
   project" — the ref resolved from `SUPABASE_URL` must equal
   `KNOWN_PROD_PROJECT_REF`. A second production project, a colleague's project,
   a customer's project or a typo that happens to resolve is refused here for the
   same reason the CI rule is an allowlist rather than a denylist.

What it does **not** establish, stated so it is not read as more than it is:

- it does not make the credential read-only. The Management API token in the
  environment can write; the mode constrains what the *process* does;
- it does not verify the SQL. No pattern inspects what a script sends. The
  read-only claim rests on those four files having been read, and on the set
  being closed and enforced (below);
- it is not an assertion that reading production is free. It is an assertion
  that a person asked for it in a sentence they had to mean to type, and that a
  build does not arrive here without a line that deliberately dismantles its own
  environment first (point 2).

#### Who is behind each door

`artifacts/api-server/scripts/check-guard-coverage.mjs` runs first in
`run-all-checks.sh`, reads only files on disk, and fails the build on any of:

- a file under `src/` that can reach Supabase and imports neither door nor
  appears on `EXEMPT` with a written reason;
- a guard import that is **not the first import** in its file (the mechanism is
  evaluation order, so second place is a weaker property than the header claims);
- **any file other than the two doors importing `supabaseTargetPolicy.mjs`
  directly** — that module takes the mode as an argument, so a direct import is
  how a write-capable entry point would hand itself the capability;
- **any file outside `READ_ONLY_AUDIT_ENTRY_POINTS` importing the read-only
  door**, and any file listed there that stops importing it. Both directions,
  so the four cannot quietly become five or three;
- a file importing both doors at once;
- vacuity — nothing scanned, no reachable files, an empty exempt list, an empty
  read-only list, an entry with no reason, an entry naming a file that is not
  there.

Demonstrated: pointing `rlsHardening.test.ts` at the read-only door fails this
check with exit 1 and a message naming the file; so does importing the policy
module directly; so does dropping a listed file back to the strict door.

#### Fail closed, always, and still no opt-out

Every outcome other than "the resolved ref is the sanctioned ref" — or the one
named mode above — is a refusal. There is deliberately **no environment variable
that disables either guard** and **no "credentials absent, so skip" branch**:

| state | outcome |
| --- | --- |
| `CI_SUPABASE_PROJECT_REF` unset or malformed | refuse |
| `KNOWN_PROD_PROJECT_REF` unset or malformed | refuse |
| `SUPABASE_URL` empty or unparseable | refuse |
| resolved ref ≠ sanctioned ref | refuse |
| resolved ref = `KNOWN_PROD_PROJECT_REF` | refuse (secondary) |
| the policy script is missing, **unreadable**, `bash` cannot be spawned, or the child is killed | refuse |
| `PORTAVA_PROD_READ_ONLY_AUDIT` set, strict door | refuse |
| `PORTAVA_PROD_READ_ONLY_AUDIT` set, read-only door, any CI marker present | refuse |
| `PORTAVA_PROD_READ_ONLY_AUDIT` set to anything but the exact value | refuse |
| `PORTAVA_PROD_READ_ONLY_AUDIT` exact, outside CI, resolved ref = declared production, read-only door | **proceed**, with a banner |

The policy script is located and read on **every** path, including the read-only
one, which does not execute it — a tree where the repo's single written
statement of what production is has gone missing runs nothing.

A refusal exits **2**, not 1. Every caller already treats 2 as a hard failure,
and `checkRankEventsSurfaces.ts`'s exit-code contract reserves 1 for *"the
process died involuntarily"* — a refusal is a decision, not a crash, so exiting 1
there would make `run_gate()` in `scripts/run-all-checks.sh` print exactly the
wrong diagnosis. `run-live-suite.sh` fails on any non-zero exit, so 2 is red for
the three suites too.

#### What this cost, and it is accepted

`pnpm run audit:schema`, `pnpm run check:all` and `pnpm run test:rls-hardening`
refuse to run **anywhere** — including a developer laptop — unless
`CI_SUPABASE_PROJECT_REF` and `KNOWN_PROD_PROJECT_REF` are set. That is the
point. Some of these processes create and delete real auth users and write-probe
a real table; the caller must state which project that may happen in, and what
production is, before any of it starts. Export both, or put them in
`artifacts/api-server/.env` (all of these scripts are launched with
`--env-file-if-exists=.env`).

For the four read-only audits, and only for those four, there is now one more
way through — a **named, deliberate, non-CI** read-only audit of the declared
production project:

```
cd artifacts/api-server
export SUPABASE_URL='https://<production-ref>.supabase.co'
export SUPABASE_PROJECT_TOKEN='<token>'
export KNOWN_PROD_PROJECT_REF=<production-ref>
export PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production'

pnpm run audit:schema
pnpm run check:missing-live-columns
pnpm run check:write-path-columns
pnpm run check:media-objects
```

`check:all` under those exports is **partially** green by design: the three
read-only checks in it run, and `check:rank-events-surfaces` refuses with exit 2
because the intent variable is set and that script writes. That is the intended
shape — the audits report, the write probe stays home — and `check:all` as a
whole is red, which is correct: it did not all run.

`CI_SUPABASE_PROJECT_REF` is **not** read on this path, and the example above
therefore omits it: when the mode is accepted the allowlist script is located
and read but not executed, because by construction it would refuse — the target
is production. `KNOWN_PROD_PROJECT_REF` carries the whole of the decision here,
which is why it is required and shape-checked. Verified by execution: with
`CI_SUPABASE_PROJECT_REF` unset and everything else as above, the guard prints
its banner and proceeds.

#### Demonstrated by execution: skipping the YAML step no longer helps

Run with the workflow step **never executed** — only the work commands, with the
environment those jobs would have. Node 24 runs these `.ts` entry points
directly, so no `node_modules` and no test runner were involved. Outbound
HTTPS was pinned to a dead local port (`--use-env-proxy` with
`https_proxy=http://127.0.0.1:9`), so a "before" run proves it reached out by
failing with `ECONNREFUSED 127.0.0.1:9` without anything leaving the machine.

| run | `SUPABASE_URL` | allowlist env | result |
| --- | --- | --- | --- |
| **before** `checkMediaObjects.ts` | production ref | present | reached the Management API call — `TypeError: fetch failed / ECONNREFUSED`, exit **1** |
| **before** `checkRankEventsSurfaces.ts` | production ref | present | entered `main()` and tried to read production's `pg_constraint`: `GATE live_pulse: BLOCKED (the live constraint listing could not be read)`, exit **3** |
| **before** `rlsHardening.test.ts` | production ref | present | `@supabase/supabase-js` **loaded**; 16 tests registered against production |
| **after** `checkMediaObjects.ts` | production ref | present | `REFUSED`, exit **2**, no request attempted |
| **after** `checkRankEventsSurfaces.ts` | production ref | present | `REFUSED`, exit **2**, no probe, no `GATE` line |
| **after** `checkMissingLiveColumns.ts` | production ref | present | `REFUSED`, exit **2** |
| **after** all three suites | production ref | present *or absent* | `REFUSED`, exit **2**; `@supabase/supabase-js` **never loaded**; `tests 1, pass 0, fail 1` |
| **after** any entry point | production ref | **absent** (an undeclared job in another workflow) | `REFUSED` on `KNOWN_PROD_PROJECT_REF is empty or not configured` |
| **after** `checkMediaObjects.ts` | **sanctioned CI ref** | present | `Supabase target verified` → proceeded to the request. Not a blanket denial |

The "before" rows are the byte-copy baseline of the same files. The "after" rows
are the working tree. The only difference is the first `import`.

#### Demonstrated by execution: the read-only mode, and its four refusals

Same method — real entry points under Node 24, no `node_modules`, outbound HTTPS
pinned to `127.0.0.1:9`, so a run that PROCEEDS proves it by failing with
`ECONNREFUSED` rather than by reaching Supabase. `CI` was confirmed unset in the
shell before the matrix ran. `checkMediaObjects.ts` stands for the read-only
four; `ciSupabaseGuard.mjs` was run directly for the strict door, which is
byte-for-byte the first thing `rlsHardening.test.ts` evaluates.

| run | `SUPABASE_URL` | `PORTAVA_PROD_READ_ONLY_AUDIT` | `CI` | result |
| --- | --- | --- | --- | --- |
| `checkMediaObjects.ts` | production | exact value | unset | banner, then `ECONNREFUSED` at the Management API call — **proceeded**, exit 1 |
| `ciProdReadOnlyAuditGuard.mjs` alone | production | exact value | unset | banner, exit **0** |
| `checkMediaObjects.ts` | production | exact value | `true` | `REFUSED`, exit **2** |
| `checkMediaObjects.ts` | production | exact value | `` (empty) | `REFUSED`, exit **2** — presence, not truth |
| `checkMediaObjects.ts` | production | exact value | unset, `GITHUB_ACTIONS=true` | `REFUSED`, exit **2** |
| `ciProdReadOnlyAuditGuard.mjs` alone | production | exact value | unset, `GITHUB_WORKSPACE=/x` | `REFUSED`, exit **2** — the family rule, not the named list |
| `ciProdReadOnlyAuditGuard.mjs` alone | production | exact value | unset, `RUNNER_TEMP=/x` | `REFUSED`, exit **2** |
| `ciProdReadOnlyAuditGuard.mjs` alone | production | exact value | unset, `GITHUB_TOKEN=x` | proceeds, exit **0** — the one documented exception |
| `checkMediaObjects.ts` | production | `1` | unset | `REFUSED`, exit **2** |
| `checkMediaObjects.ts` | production | `true` | unset | `REFUSED`, exit **2** |
| `ciSupabaseGuard.mjs` (the RLS suites' door) | production | exact value | unset | `REFUSED`, exit **2** |
| `ciSupabaseGuard.mjs` | **sanctioned CI ref** | exact value | unset | `REFUSED`, exit **2** — the strict door refuses the *request*, not just the target |
| `checkRankEventsSurfaces.ts` (write probe) | production | exact value | unset | `REFUSED`, exit **2**, no probe |
| `checkMediaObjects.ts` | production | **unset** | unset | `REFUSED`, exit **2** (allowlist) |
| `checkMediaObjects.ts` | **sanctioned CI ref** | unset | unset | `Supabase target verified` → **proceeded**, exit 1 at `ECONNREFUSED` |
| `ciProdReadOnlyAuditGuard.mjs` alone | **sanctioned CI ref** | unset | `true` | proceeds, exit **0** — CI on the normal path is unaffected |

Fail-closed controls, all with the mode requested and `CI` unset, all exit **2**:
`KNOWN_PROD_PROJECT_REF` unset; `SUPABASE_URL` unset; `SUPABASE_URL` with a path
(`…​.supabase.co/rest/v1`, unparseable); a third project's ref; the sanctioned CI
ref; and the policy script present but `chmod 000` (`EACCES` → refuse, restored
to mode 644 afterwards and verified byte-identical).

#### Where this still ends

Deleting the guard `import` from an entry point disables the assertion for that
entry point. `check:guard-coverage` now catches exactly that for any file under
`src/` that names a Supabase credential variable or calls `createClient()` — it
was written for this residual and it closes most of it. What it does **not**
close is a file that reaches Supabase by some route those two patterns do not
see, and it does not read anyone's SQL.

That residual is stated rather than papered over, and it is a different shape
from the one this change replaced:

- it is a **source diff in the file that does the querying**, sitting directly
  above the code that talks to the database — not a workflow-configuration edit
  that looks like plumbing;
- it cannot be disguised as `if:`, step order, a comment, an `env:` indirection,
  or a new job in a new workflow file, which is the entire class that defeated
  five rounds of YAML scanning;
- **deleting a guard module is loud and fail-closed**: its importers then fail to
  load with `ERR_MODULE_NOT_FOUND`, and `check:guard-coverage` reports them as
  unguarded on the CI surface.

#### What is now true that was not: production is reachable from a guarded script

This document previously said, in effect, that a guarded entry point could not
reach production at all. That is no longer true and should not be read that way.
Four of the nine can reach production — deliberately, read-only, outside CI, on
a typed request — and the honest statement of the guarantee is narrower:

- **no CI job as written can reach production through any of the nine.** The
  mode is refused whenever a CI marker is present, and the allowlist refuses
  production on every other path. A job that explicitly unset the entire
  `GITHUB_*`/`RUNNER_*`/`ACTIONS_*` environment first could — see the residual in
  point 2 above. That line would be visible in a branch-protected file;
- **no write-capable entry point can reach production, in CI or out of it.** The
  capability is not in the module they import, and asking for it makes them
  refuse;
- **four read-only entry points can reach production from a terminal**, after
  the operator sets a sentence-shaped variable, and they say so loudly when they
  do.

An overstatement in the direction of "safer than it is" is the failure mode this
repo keeps hitting — a denylist described as an allowlist, a skipped assertion
printed as a pass. This section exists so the next reader gets the narrower true
claim instead of the comfortable one.

Building a scanner to prove the import is present would be round six of the same
mistake at one level down. The answer is the same one this document already
gives for `.github/**`: branch protection plus a human reading the diff. See
[Where mechanical enforcement ends](#where-mechanical-enforcement-ends).

### The allowlist policy itself

This used to be a **denylist of exactly one ref** — the production project,
copied out of `.replit` — while this document claimed non-production was
"enforced mechanically". It was not. A denylist answers *"is this the project I
thought to forbid?"*. The question that matters is *"is this the project I
sanctioned?"*, and the denylist answered that wrongly for every ref nobody
listed: a **second production project**, a personal project, a customer project,
a typo that happens to resolve. All of those passed.

It is now an allowlist, in one place —
`.github/scripts/assert-nonprod-supabase.sh`. It is run by the in-process
chokepoint described above (which is what actually enforces it) and, as a
fail-fast duplicate that reports the same refusal ~90 seconds earlier, by one
step in each of the three credential jobs. It fails, in this order:

1. **`CI_SUPABASE_PROJECT_REF` is empty** → fail closed. With no sanctioned
   project there is nothing to compare against, and a job that cannot say what
   database it is about to write to does not run.
2. **`SUPABASE_URL` does not match `^https://[a-z0-9]+\.supabase\.co/?$`** →
   fail. Its project ref cannot be resolved, so it cannot be checked at all, and
   an unverifiable target is treated as an unsafe one.
3. **The resolved ref ≠ `CI_SUPABASE_PROJECT_REF`** → fail. *Any* other ref,
   listed or not, known or not.
4. **Secondary:** the resolved ref equals `KNOWN_PROD_PROJECT_REF` → fail even
   though the allowlist matched. This is the one case an allowlist cannot catch
   by itself: an operator setting the expected CI ref *to* production.

Exactly one input passes: a parseable URL whose ref equals the sanctioned ref and
is not the production ref.

Ordered before all four, and new: **`KNOWN_PROD_PROJECT_REF` must itself be set,
and must be a bare project ref.** It used to be optional, guarded inside the
script by `[ -n "$KNOWN_PROD_PROJECT_REF" ]` — and it is set in exactly one
place, the top-level `env:` block of `live-db.yml`. Deleting that **single line
of YAML** therefore deleted the production denylist, and the script still printed
`Supabase target verified` and exited **0**, with one line of its output changed
from `passed` to `SKIPPED`. Reproduced with the variable unset and both
`SUPABASE_URL` and `CI_SUPABASE_PROJECT_REF` pointing at the production ref: exit
0. A malformed value (a full URL rather than a ref) was equally quiet — present,
evaluated, and incapable of ever matching. Both now fail closed before anything
else is checked. The cost is accepted: the script can no longer be run without
declaring what production is.

### The YAML scan, demoted: a secondary detector for undeclared jobs

> **This scan is no longer what keeps CI off production.** The in-process
> chokepoint is. Read this section as *"how undeclared credential jobs get
> noticed"*, not as *"how the database is protected"* — five rounds of hardening
> it were each defeated by a construct the previous round did not model
> (comments, `env:` indirection, `if:`, step order, shell conditionals,
> `secrets[...]` index form), and the sixth would have been too. The reason it
> kept losing is structural: it was trying to prove a property of YAML, and YAML
> can express the step's disablement in unbounded ways. Nothing below closes
> that; the chokepoint above makes it not matter.

What the scan is still worth keeping for, now that it decides nothing:

1. **Declaration drift.** `REQUIRED_CREDENTIAL_JOBS` names the jobs the repo
   believes are credential-bearing. A job that joins that set by accident — an
   `env:` inheritance, a `secrets: inherit` reusable workflow, an
   `environment:` declaration — is surfaced as *"credential job not declared"*,
   which is a **useful review signal about scope**, not a safety mechanism.
2. **Fail-fast.** The three `run: bash .github/scripts/assert-nonprod-supabase.sh`
   steps still run, and still fail a misconfigured job in ~20 seconds instead of
   after checkout, corepack, cache restore and a full `pnpm install`. Keeping
   them is a latency choice. Their **removal is no longer a safety event**: the
   entry points assert for themselves, as the demonstration above shows.

Two defects were fixed in this scan before it was demoted. They are recorded
because they are the reason for the demotion, not because the fixes are
load-bearing.

#### The set of credential jobs is declared, not derived

This rule used to pick its own subject: the jobs it applied to were the ones
whose body still contained the literal text `secrets.` on a non-comment line.
The claim made for that — *"derived from the jobs' own text, so a fourth
credential job added later is covered the day it is written"* — **was wrong, and
in the more dangerous direction.** A derived subject can be left by ordinary
refactoring; no adversary is required. Move the secret into a workflow-level or
job-level `env:` block and read it as `$SUPABASE_URL`; take it through a
reusable workflow with `secrets: inherit`, or a composite action; put it behind a
matrix or any other variable indirection — and the job no longer contains
`secrets.`, so it stopped being a credential job, and **the requirement to run
the allowlist stopped applying to it**, silently.

Reproduced against the clean tree: adding
`INHERITED_DB_URL: ${{ secrets.SUPABASE_URL }}` to the top-level `env:` block and
a `rank-events-backfill` job that `curl`s `$INHERITED_DB_URL` with no allowlist
step left the preflight exiting **0** and still printing *"3 of 3 credential
job(s)"* — a count of the jobs it had decided to look at, not of the jobs that
could reach the database.

So `REQUIRED_CREDENTIAL_JOBS` is now the **authority**, and divergence fails in
both directions: a declared job that does not run the guard fails, and an
undeclared job that touches a credential fails as *"credential job not
declared"*, forcing a human to add it on purpose. An empty or malformed list, an
unparseable `jobs:` mapping, and a declared job with no detectable credential
route are all failures too — see
[what the routes do and do not cover](#what-the-credential-routes-do-not-cover).

#### And the invocation must be run, not merely mentioned

That assertion was `body.includes('assert-nonprod-supabase.sh')` over unstripped
YAML — a substring test. **A `#` comment naming the file satisfied it**, and each
of those three steps sits under an eight-line comment block that names the file.
Reproduced: replacing all three
`run: bash .github/scripts/assert-nonprod-supabase.sh` steps with a single
comment left the preflight printing *"call sites verified in 3 credential
job(s)"* and exiting **0**, with the guard invoked nowhere and the credential
jobs free to run against any project `SUPABASE_URL` happened to hold.

Comments are now stripped, and the invocation must be in **run position** — start
of a `run: |` block line, after a `run:` key, or after a shell operator, with an
interpreter in front of it and not after a `#`. The preflight's note line reads:

```
NOTE: Credential jobs in .github/workflows/live-db.yml are DECLARED by
REQUIRED_CREDENTIAL_JOBS, not inferred: 3 of 3 declared job(s) verified as
RUNNING .github/scripts/assert-nonprod-supabase.sh (not merely mentioning it):
api-server-check-all, schema-drift, live-db-security-suites. Undeclared jobs
found touching credentials: none (of 5 job(s) parsed; secret-derived env names
seen: CI_SUPABASE_PROJECT_REF, EXPO_PUBLIC_SUPABASE_ANON_KEY,
SUPABASE_PROJECT_TOKEN, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL).
```

Both denominators are printed on purpose. *3 of 3* is now measured against the
declared list rather than against a set the check derived for itself, and the
job count plus the resolved secret-derived env names show what the second
direction actually looked at.

<a id="what-the-credential-routes-do-not-cover"></a>

#### What the credential routes do *not* cover

The routes are a **floor, not a proof**. A job is caught if it references the
`secrets` context in **either** documented form — the property form
`secrets.NAME` **or** the index form `secrets['NAME']`, `secrets[format(…)]`,
`secrets[matrix.x]` — references a name defined transitively from either of
those in a workflow-level or job-level `env:` block, references one of the
Supabase credential env var names, passes `secrets:` to a reusable workflow, or
declares an `environment:`. What is still outside them:

- **matrix and other variable indirection that never touches the `secrets`
  context at all.** The index form is covered now; a matrix value that *is* the
  target — `url: ${{ matrix.project_url }}`, fed from a job output or a
  checked-in matrix literal — is not, unless the name it lands in happens to be
  one of the Supabase credential env var names. Earlier revisions of this
  document and of the comments in `assert-ci-scripts.mjs` said matrix
  indirection was closed by making the job list declared rather than derived.
  That is only half true: the **declared list** is unaffected by indirection,
  but the **tripwire that notices an undeclared job** still has to see a route,
  and this one it does not see;

- a credential reaching a step through a **third-party action's output** or a
  file written by an earlier step, under a name this file does not model;
- a credential that a **script in the repository** reads from the ambient
  environment without the workflow ever naming it — the guard script itself does
  this with `CI_SUPABASE_PROJECT_REF`;
- GitHub's rule that a workflow-level `env:` block is inherited by **every** job
  whether or not the job names the key. This check deliberately requires a
  *reference*, because treating inheritance alone as use would mark
  `preflight` and `live-db-verdict` — which hold no credentials and need no
  allowlist — as credential jobs;
- **any other workflow.** The rule is scoped to `live-db.yml`, the only workflow
  that runs with database credentials.

That residual is the reason the list is the authority and the routes are only a
tripwire on top of it: the routes exist to make *forgetting* to declare a job
loud, not to make declaring one unnecessary. A declared job that shows no route
at all also fails, so the tripwire cannot rot into a no-op unnoticed. Nothing
here is a substitute for the review of `.github/**` described in
[Where mechanical enforcement ends](#where-mechanical-enforcement-ends).

`CI_SUPABASE_PROJECT_REF` is supplied by **you**, as a repository variable
(Settings → Secrets and variables → Actions → Variables) or as an environment
secret of the same name on `ci-nonprod-supabase`. It is not hardcoded here,
because it names an infrastructure choice this repo cannot make for you. A
project ref is not sensitive, so the variable is the natural home.

`KNOWN_PROD_PROJECT_REF` is still at the top of `live-db.yml`. **If production
ever moves, update it** — but it is now the second line of defence, not the
first, so a stale value no longer leaves the door open. **Removing it is no
longer possible without every credential job going red**, which is the point:
the line is load-bearing and now behaves like it.

### Setting up the non-production project

A human has to do this; CI cannot choose a project for you.

1. Create a separate Supabase project for CI.
2. Apply the repo's migrations to it. If the schema is missing, these checks
   fail for the wrong reason.
3. **Seed at least one row in `auth.users`.** `checkRankEventsSurfaces` exits 3
   ("BLOCKED") if `auth.users` is empty, because no FK-valid `user_id` exists
   for its probe.
4. Create a project-scoped token and put it in `SUPABASE_PROJECT_TOKEN`.
5. Put that project's URL, service-role key and anon key in the other three
   secrets.
6. **Set `CI_SUPABASE_PROJECT_REF`** to that project's ref — the `<project-ref>`
   in `https://<project-ref>.supabase.co`, letters and digits only, no URL.
   Until you do, every credential job fails at the allowlist preflight, by
   design.

Whether these suites pass against a fresh non-production project, whether they
need seed data beyond a bootstrap auth user, and whether their fixture cleanup
is complete enough to run repeatedly have **never been verified** — they have
only ever been run by hand, against whatever project the developer had
configured. Expect to iterate on the first few runs.

### Concurrency: runs are evicted, not queued

Because these jobs share one database, `live-db.yml` uses a single **global**
concurrency group (`live-db-shared-supabase-project`) with
`cancel-in-progress: false`. An in-flight run is never cancelled mid-fixture, and
two runs never race on each other's fixtures.

**They do not queue.** An earlier version of this document said they did; that
was wrong, and it mattered. GitHub keeps at most **one in-progress** run and at
most **one pending** run per concurrency group. When a third run arrives, the run
that was pending is **cancelled** and the newcomer takes its place. Because the
group is not keyed on `github.ref`, that eviction crosses refs: a push to branch
B can cancel branch A's pending live-DB run.

That trade is deliberate — never racing two runs against one shared database is
worth more than guaranteeing every commit gets a slot — but its consequences are
stated rather than papered over:

- **An evicted run is `cancelled`, never `success`.** GitHub renders it as
  cancelled, and a cancelled run does not satisfy a required status check.
  Eviction cannot produce a false green.
- **It can leave a commit with no live-DB verdict at all.** For this workflow,
  "not red" is not "verified". If a commit you care about was evicted, re-run it
  (Actions → Re-run all jobs) once the in-progress run finishes.
- **`live-db-verdict` closes the ambiguity that can be closed.** It runs with
  `if: always()` and fails unless every other job in the run reported `success`,
  so a job cancelled mid-run, or skipped because a `needs` failed, becomes an
  explicit red with a message naming the job. The residual it cannot cover is a
  run evicted while still *pending*: no job of that run ever starts, so nothing
  can execute for it. GitHub renders that run as cancelled.

If you would rather have per-ref parallelism than a serialized shared database,
key the group on `${{ github.ref }}` — but then two refs can run these fixtures
against the same project simultaneously, and that is a correctness problem, not a
scheduling one. Do not change it without deciding which you want.

---

## How the "skip is not a pass" problem is handled

This is the subtle part, and it is the reason `run-live-suite.sh` exists.

The three live-DB suites are **allowlisted, not registered**, and that was the
right call. The curated `test` script pins `SUPABASE_URL=http://127.0.0.1:9`
inline, so registering them there would bury a permanent skip inside a green
suite. They were correctly kept out and given their own `test:*` scripts.

But all three do this:

```ts
const CREDS_AVAILABLE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);
describe("…", { skip: !CREDS_AVAILABLE }, () => { … })
```

None of them sets `process.exitCode`. **Without credentials they skip every
test and exit 0.** `rlsHardening.test.ts`'s own header states that "All tests
are skipped when credentials are absent so CI still passes without a live
Supabase connection" — the failure mode, written down as a feature. Two of the
three at least print a banner saying "A skip is not a pass"; `rlsHardening`
prints nothing at all.

So the exit code of those three scripts is **not a usable signal on its own**.
Three defences, all required:

1. **Preflight (primary).** Every credential job's *first* step asserts each
   secret it needs is non-empty and fails with a message naming the missing
   one. It runs before checkout and before install.
2. **Output contract (secondary).** `run-live-suite.sh` fails the step if the
   suite reports `pass == 0`, any `skipped != 0`, a non-zero `fail` count, an
   unparseable summary, `tests != pass`, or prints the no-live-credentials
   banner. Every `skip:` in those three files is gated on `!CREDS_AVAILABLE`, so
   with credentials present the expected skipped count is exactly 0.

   **That the wrapper is USED is now asserted, not just that it exists.** The
   preflight required `run-live-suite.sh` to be present and said nothing about
   whether anything called it. Rewriting the three steps to
   `bash .github/scripts/pnpm-run.sh …` — a one-word edit each, leaving the
   workflow looking identical and every other assertion satisfied — returned all
   three suites to **exit-code-only** scoring, which is precisely the scoring
   that reports a credential-less skip as a pass. Reproduced: the preflight
   exited 0 and said nothing. It now records *which* wrapper each call site uses
   and requires `run-live-suite.sh`, in run position, for each of the three
   suites by name; invoking one through `pnpm-run.sh` is a named failure.
3. **What is deliberately absent.** No `if: ${{ secrets.X != '' }}` on any job.
   That renders a missing secret as a grey **skip** on the PR, which reads as
   fine. Missing credentials must be red.

The deeper fix — making the suites themselves fail closed rather than skip —
requires editing `artifacts/api-server/src`, which was out of scope for this
work. It is the same class of fix as `run_gate`'s grep, and it is worth doing.

---

## Fork pull requests

The workflows assume PRs come from the same repository. State of play if a fork
PR ever arrives:

GitHub does not expose repository or environment secrets to workflows triggered
by `pull_request` from a fork. The secret expands to the empty string.

- `ci.yml` — **fully unaffected.** It reads no secrets, so every job runs
  normally and means exactly what it means on a same-repo PR.
- `unwired-checks.yml` — **fully unaffected**, same reason.
- `live-db.yml` — its credential-free `preflight` job (script existence) passes
  normally, and **every credential job goes red at its own secrets preflight**,
  after which `live-db-verdict` goes red too. That is the intended outcome.
  Without those preflights, the three live-DB suites would have gone **green
  having asserted nothing** — the exact green-by-absence this effort exists to
  eliminate. A fork PR that cannot be fully verified must say so loudly.
  (`CI_SUPABASE_PROJECT_REF` supplied as a repository *variable* IS visible to
  fork PRs, unlike a secret — but `SUPABASE_URL` and the keys are not, so the
  secrets preflight fails first and the allowlist is never the deciding check.)

`docs/eas-runbook.md` (line ~347) documents an older intent: "Job skipped with
`::warning::` annotation | Fork PR — repository secrets unavailable | Expected;
check runs on merge to main where secrets are present." **That is the
skip-as-success pattern and it was not adopted.** If some fork accommodation is
ever wanted, it must be a visible, named, non-green state.

**Do not reach for `pull_request_target`** to hand secrets to fork code. That
executes untrusted PR code with secret access.

---

## What CI deliberately does NOT cover

**Anything requiring a physical device, an emulator, or a native toolchain.**

`travel-buddy-standalone` runs fully headless in CI, and that is not an
accident — it is how the repo is already set up:

- `pnpm test` → `node --import tsx/esm --test`. Plain Node. Files that genuinely
  need a native runtime are explicitly excluded via `KNOWN_BROKEN` in
  `scripts/run-node-tests.mjs`, with reasons recorded in the source (e.g.
  `expo-modules-core@3.0.30 requires native sweet/setUpJsLogger.fx — not in
  Node`, and the `react-native@0.81.5` esbuild "Unexpected typeof" wall).
- `pnpm test:component` → jest with `preset: 'jest-expo'` (react-test-renderer,
  no device) and then `jest-expo/web` (jsdom + react-dom).
  `jest.config.js`'s `moduleNameMapper` stubs every native module that would
  otherwise demand a device: maplibre, Sentry, async-storage,
  draggable-flatlist, lucide-react-native, expo-router.

So: no Android SDK, no Xcode, no emulator, no Maestro. Specifically excluded:

- **The E2EE native verification** described in `docs/handover-2026-08-08.md`,
  which needs "A physical device, or an emulator on a KVM host." Its tests are
  in `KNOWN_BROKEN`. This is a manual bar and remains one.
- **`e2e/maestro/saved_places_filter_reset.yaml`.** A real Maestro flow that no
  package.json script invokes. Left alone.
- **EAS builds.** `EXPO_TOKEN` is not configured or used here.

Also not covered:

- **`scripts/pre-release-check.sh`** — 600 lines aggregating 9 checks (was 12 until the three sync-standalone drift checks retired with `artifacts/travel-buddy` on 2026-08-14), invoked
  by nothing. It is *not* reused, because it soft-skips exactly the way this
  effort forbids: its own comments say engagement-indexes is "Skipped
  gracefully (warning only, not failure) when neither `SUPABASE_PROJECT_TOKEN`
  nor `SUPABASE_ACCESS_TOKEN` is set", and schema-audit "Soft-skips (warning
  only, exit 0) when no token … so a network blip or a developer without
  credentials is not blocked." Those are green-by-absence by design. Its
  valuable part (`audit:schema`) is invoked directly in `live-db.yml` instead,
  behind a preflight. **If you ever wire this script into CI, you must assert
  the secrets are present first, because it will happily return 0 without
  them.**
- **`@workspace/scripts` `test:db-triggers` and `test:engagement-indexes`** —
  both reference `SUPABASE` in their source, so they belong in the credential
  tier. Their exit contracts were not read, so they were not wired blind.
- **`src/scripts/checkAdminGuard.ts` and
  `src/scripts/check-media-bucket-privacy.ts`** — orphans with zero references
  repo-wide, no package.json script, unknown exit contracts. Not wired blind.
  **Both deserve a human's attention**, especially the admin guard.

---

## Known gaps this CI reports but cannot fix

### Test files that no runner CI invokes will execute

**Five of them, in two classes — and this list is still not exhaustive.**

An earlier version of this guard searched only for `*.test.tsx` under `src` and
`app`, found three files, and this document presented those three as the complete
set. They were not. A second class was missing entirely.

The guard now lives in `.github/scripts/check-unrunnable-tests.mjs` (run by
`ci-self-check`) so that its reasoning, its baseline, and its stated limits are in
one reviewable place.

It is also, now, in the preflight's `REQUIRED_CI_SCRIPTS` list — it was absent
entirely — and marked `mustBeInvoked`, so both halves of its erasure are loud.
Deleting the file alone always failed noisily (`Cannot find module`). Deleting
the file **and** the one `ci-self-check` step that runs it was completely silent:
the baseline of five files, the class-A/class-B reasoning and the premise
assertions would simply have been gone, and `ci-self-check` would have run one
step fewer and stayed green. The preflight now fails if nothing under `.github/`
invokes it.

It covers:

**Class A — a `*.test.ts` or `*.test.tsx` under `src/`, `app/` or `server/` that
no configured runner matches.** The guard no longer hardcodes a filename shape;
it evaluates each file against all three runners' real rules and reports the ones
nothing claims.

The premise this class rested on was **wrong**, and not harmlessly so. It said
`run-node-tests.mjs` "discovers only names ending `.test.ts`" and concluded the
unrunnable shape was `.test.tsx`. But the suffix is the *second* filter. The
first is `const ROOTS = ['src', 'server'];` — node:test never walks `app/` at
all. So an `app/**/foo.test.ts` is rejected by node:test (wrong directory), by
`test:component` (not `.component.test.`) and by `jest.web.config.js` (not
`.webrender.test.`), and was matched by **no version of this guard**, because the
old Class A only ever looked at `.test.tsx`. The mirror hole existed on the other
side: jest's `testMatch` roots are `src/` and `app/`, so a `server/**/*.test.tsx`
or a `server/**/*.component.test.ts` was invisible too — `server/` was not even
walked.

The runner rules, read from source and asserted as premises on every run:
`run-node-tests.mjs` roots `['src','server']`, skip `src/test`, suffix
`.test.ts`, excluding `.component.test.`; `test:component` -> `jest.config.js`
`testMatch` `src/**` and `app/**`, filtered to
`--testPathPattern='\.component\.test\.'`; `jest.web.config.js` matches only
`*.webrender.test.*` under those same two roots. Findings on the current tree
(unchanged by the correction — the tree happens to contain no `app/**/*.test.ts`
today, which is exactly why the hole was never noticed):

```
src/components/map/__tests__/MapCarousel.cardHeight.test.tsx
src/components/map/__tests__/MapEntityActionRow.test.tsx
src/services/__tests__/livekitBridge.activeSpeakers.test.tsx
```

**Class B — anything under `src/test/`.** Both configured runners exclude that
directory outright: `run-node-tests.mjs` has
`if (full === 'src/test') continue;`, and `jest.config.js` lists
`<rootDir>/src/test/` in `testPathIgnorePatterns`. A file there runs only if some
`package.json` script names it explicitly.

```
src/test/compassComponents.test.ts          B1 — named by no script at all; runs nowhere
src/test/stampGracefulDegradation.test.ts   B2 — named only by `test:stamps`, which
                                                 scripts/run-all-checks.sh never invokes,
                                                 so it runs only when a human types it
```

B2 is the pre-CI status quo in miniature: a test that exists, works, and only
runs when somebody remembers. It is reported, not exempted.

Fixing any of these means renaming files (touching `src/`) or editing
`package.json` — both outside the scope of the CI work. So they are **baselined**,
the same way the repo already baselines `UNREGISTERED_TESTS_ALLOWLIST.json`: the
five known files are listed with their class, a **sixth fails the build
immediately**, a file that changes class fails, and a baselined file that gets
fixed or deleted must be removed from the list — which stops the baseline from
quietly becoming permanent.

The guard also **asserts its own premises** — that `run-node-tests.mjs` still
skips `src/test`, still discovers by `.test.ts`, that jest still ignores
`src/test/`, and that `test:component` still filters on `.component.test.`. If a
runner's rules change, the guard goes red demanding to be re-derived rather than
silently checking for the wrong thing.

#### What this guard does NOT cover

It prints these limits on every run, in the log and in the job summary, so a
green result cannot be mistaken for "every test in this tree runs":

- **The `KNOWN_BROKEN` list in `scripts/run-node-tests.mjs`** — 30 unique files
  excluded from node:test discovery with recorded reasons (the
  `react-native@0.81.5` esbuild wall, `expo-modules-core` native requirements).
  They do not run either. Growth there is caught by the node:test **discovery
  floor of 142** in `ci.yml`, which drops when an entry is added — not by this
  guard.
- **Other jest `testPathIgnorePatterns` entries** (currently
  `src/services/__tests__/fsqPhotoLookup.test.ts`, which *is* run by
  `run-node-tests.mjs`, so it is not orphaned).
- **`artifacts/api-server`** — covered separately by `check:test-registration`,
  its ghost-path assertion, and the registered-file floor of 392.
- **`e2e/maestro` flows** — no script invokes them; CI runs no device tests at
  all. Out of scope by design, not by oversight.
- **The frozen legacy tree `artifacts/travel-buddy`.** ARCHIVED 2026-08-14 (`bc1bef404`); no longer an uncovered surface.
- **Tests that do run but assert nothing meaningful.** No static check sees that.

### Ghost paths in the curated test list

`check-test-registration.mjs` detects registered paths with no file on disk —
a typo'd entry that runs nothing — but only `console.warn`s about it and does
**not** fail. At HEAD there are 0 ghosts, so this is latent rather than active.
Since fixing it means editing the script, `ci.yml` asserts on its *output*
instead and fails if any ghost is reported. That is the same technique
`run_gate()` uses: score the output, not just the exit code.

### The `--forceExit` asymmetry

`travel-buddy-standalone`'s `test:component` uses jest's `--forceExit`.
`checkTestRunnerFlags.ts` bans only the node-specific spellings and says so
explicitly ("Jest … spells its equivalents differently — `--testNamePattern`,
`--testPathPattern`, `--shard`, `--forceExit` — so none of those collide here
and legitimate jest scripts are untouched"). That is a documented, deliberate
exemption. But it is the **same hazard class** that cost this repo months on
the api-server side. It was not changed unilaterally. It is worth a look.

---

## `API_TEST_MIN_PASS` is mandatory

**It used to be optional, and this document told you to set it only after the
first green run.** That meant the documented default state of the api-server
suite was: no floor on the passing-test total, and no assertion that anything
was skipped. This repo lost **54-133 tests per green run for months** to a
truncating runner flag. A suite with no floor is not a missing nicety; it is the
known failure mode, shipped switched off.

So the `api-server-tests` job now enforces four things, and three of them need no
configuration at all:

| Assertion | Default | Configurable by |
| --- | --- | --- |
| `fail == 0` | always | — |
| `skipped <= 0` | **0, enforced by default** | `API_TEST_MAX_SKIPPED` (raises the ceiling only) |
| `tests == pass + fail + skipped` | always — 0 unaccounted | — |
| `pass >= number of registered test files` | computed from `artifacts/api-server/package.json` on every run (392 today) | — |
| `pass >= API_TEST_MIN_PASS` | **required — an unset value fails the job** | `API_TEST_MIN_PASS` |

Plus the pre-existing rules: a non-zero exit fails, and totals that cannot be
parsed fail (an unestablished result is not a pass — `skipped` is now in that
set, because it is asserted).

**The accounting row is new, and `tests` was the count that had never been
compared to anything.** It was parsed, integer-checked, printed in the summary
table, and measured against nothing. `node:test`'s `tests` total is
`pass + fail + skipped + todo + cancelled`, so with `fail == 0` and
`skipped == 0` — both enforced — the **entire `todo` and `cancelled` population
was invisible to every assertion in the job**. A suite converted wholesale to
`it.todo(...)`, or one whose process died mid-run leaving tests cancelled, keeps
`pass > 0`, `fail == 0` and `skipped == 0` intact and clears both floors, because
a todo test asserted nothing and is counted nowhere else. Demonstrated:
`tests=6386 pass=6186 fail=0 skipped=0` was green and is now red, naming the 200.
The same assertion is applied to the standalone `node:test` half, and
`run-live-suite.sh` already had it.

**The structural floor** (`pass >= registered files`) needs no historical figure
and no operator action, and it moves with the suite because it is derived from
`package.json` at runtime. Every registered path is a file the runner was told to
execute; a file contributing zero passing tests means files were registered but
not run. It is genuinely a *floor*, though — the real totals are in the
thousands, so it cannot catch a 2% shrink. That is what the ratchet is for.

**The ratchet** (`API_TEST_MIN_PASS`) is what would have caught the historical
bug, so it is required. On a fresh repo the first run is expected to be **red at
this one step**, *after* the suite itself has passed and printed its totals, with
an error naming the exact value to set:

> `API_TEST_MIN_PASS is not configured … This run passed 6186 tests. Set the
> repository variable API_TEST_MIN_PASS=6186 … The suite itself PASSED; this step
> fails because the suite has no floor.`

Set it (Settings → Secrets and variables → Actions → Variables) and re-run. That
is the whole bootstrap. It is deliberately not skippable: the repo's own recorded
figures disagree (~6186 in `.agents/memory/api-server-testing.md`, 5,968 in
`WAVE3-APPLY-NOTES.md`, and a range of truncated figures in
`checkTestRunnerFlags.ts`), the two lower ones predate the `--test-force-exit`
removal, and none could be reproduced while writing this — so the correct value
can only come from a real run. What is *not* acceptable is running without one.

**`API_TEST_MAX_SKIPPED`** defaults to `0` and exists only so a legitimate skip
can be admitted deliberately, in a PR that names the suite and the reason.
Deleting the assertion is not the alternative to raising it.

Two further floors are enforced, both derived from source:

| Floor | Value | Where |
| --- | --- | --- |
| api-server registered `.test.ts` paths | 392 | `ci.yml`, `api-server-static` |
| standalone node:test files discovered | 142 | `ci.yml`, `standalone-checks` |

Raising any of these as the suites grow is expected. **Lowering one is a
deliberate reduction in coverage and must be justified in the PR that does it.**
Never lower one to turn a red build green.

### The jest half of the standalone `check:all`

**It was asserted by the existence of one line.** `standalone-checks` gave the
`node:test` half six assertions and gave the jest half `grep -qE '^Tests:'` — one
matching line anywhere in the log. That is the larger half of the job: 324
`.component.test.*` files plus 2 `.webrender.test.*` files, run serially at
`maxWorkers: 1`. Every one of these was green under the old check, and all of
them are red now (verified by running the real step against synthetic logs):

| Log | Old | New |
| --- | --- | --- |
| `Tests: 0 total` twice | pass | fail — 0 passing tests, and 0 suites against 326 files on disk |
| `Tests: 47 failed, 2000 passed, 2000 total` | pass | fail — failing tests |
| only the native summary printed (`jest -c jest.web.config.js` never ran) | pass | fail — fewer than 2 summary blocks |
| `Test Suites: 200 … total` (126 files stopped running) | pass | fail — below the files-on-disk floor |
| `Tests: 3 skipped, …` | pass | fail — skipped ceiling |
| `Tests: 3 todo, …` | pass | fail — todo asserts nothing |

The jest half now has the same six assertions the `node:test` half has:

| Assertion | Value |
| --- | --- |
| jest summary blocks | `>= 2` — `test:component` invokes jest twice (native, then `jest.web.config.js`); one summary means one invocation never ran |
| suites reported `>=` matching files on disk | computed on every run by walking `src/` and `app/` for `*.component.test.*` and `*.webrender.test.*`, minus `src/test/` (326 today) |
| suites failed `== 0` | a suite that fails to load reports no tests, so per-test counts can look clean while whole files never executed |
| tests failed `== 0` | — |
| tests passed `> 0` | the condition the old one-line check could not see |
| skipped `<= max`, todo `== 0`, totals add up | `STANDALONE_MAX_SKIPPED`, default 0 |

Every figure is **summed across both jest summaries** rather than read from the
last one — reading only the last would silently drop the native run, which is 324
of the 326 files. The suite floor is computed from the tree rather than
hardcoded, so it rises with the suite on its own and there is no stale number to
maintain.

`STANDALONE_MAX_SKIPPED` applies to **each half independently**.

---

## `unwired-checks.yml` is on probation

Every check in that workflow is real, committed, maintained code that no
`check:all`, no `.replit` workflow, and nothing else has ever invoked: the root
`typecheck`, `lint` and `check:hook-order`, api-server's `check:api-prefix`,
eight `@workspace/scripts` suites, and two `travel-buddy-standalone` guards that
— note the asymmetry — **do** run in the frozen legacy tree
`artifacts/travel-buddy` but not in the tree everyone actually edits. RESOLVED by the
2026-08-14 archival (`bc1bef404`): the asymmetry is gone, and the two guards now run only
as explicit steps in unwired-checks.yml.

Their current pass/fail status is **unknown**. They could not be executed while
this was written (no `node_modules`, no database). Some will likely be red on
the first run. `root: lint` is the most likely, simply because eslint has never
run over these four trees.

### What the root `typecheck` actually covers

`pnpm run typecheck` at the root is `pnpm -r run typecheck`: it runs in whichever
workspace members **define** a `typecheck` script. That is not the same as "all
of them", and `pnpm -r run <script>` does not fail when fewer members match than
you assumed.

An earlier version of this document and of `unwired-checks.yml` said it covers
"api-server + `lib/*` + scripts". **Verified false. It does not cover `lib/*` at
all** — no `lib/*` member defines a `typecheck` script. What it really covers,
read from each `package.json`:

| Covered | Not covered (defines no `typecheck` script) |
| --- | --- |
| `@workspace/api-server` (`artifacts/api-server`) | `@workspace/api-client-react` (`lib/api-client-react`) |
| `@workspace/mockup-sandbox` (`artifacts/mockup-sandbox`) | `@workspace/api-spec` (`lib/api-spec`) — has no `tsconfig.json` either |
| ~~`@workspace/travel-buddy`~~ (archived 2026-08-14, `bc1bef404`) | `@workspace/api-zod` (`lib/api-zod`) |
| `@workspace/scripts` (`scripts`) | `@workspace/db` (`lib/db`) |
| `expo-openmls` (`packages/expo-openmls`) | |

`lib/db` and `lib/api-zod` are type-checked only *indirectly*, as project
references of `artifacts/api-server/tsconfig.json`. `lib/api-client-react` is
referenced by nothing and type-checked by nothing. `travel-buddy-standalone` is a
separate workspace root and is not covered either; its own `typecheck` runs
inside `standalone-checks` via `check:all`.

This membership is not left to a comment. `.github/scripts/assert-ci-scripts.mjs`
(the `preflight` job) asserts each covered member **by name** and prints the real
current coverage to the job summary. If a member drops its `typecheck` script,
the preflight goes red instead of the recursive run quietly covering less.

### `typecheck:libs` was removed, not wired

The root `typecheck:libs` script (`tsc --build`) is **not** in
`unwired-checks.yml`, and should not be added back as-is. It could only ever
fail, and never for a reason a PR author could act on:

- `tsc --build` with no argument resolves `./tsconfig.json`, whose first line is
  `"extends": "expo/tsconfig.base"`, and **`expo` is not a dependency of the root
  workspace** (root `devDependencies`: `@types/node`, `eslint`,
  `eslint-plugin-react-hooks`, `typescript`, `typescript-eslint`,
  `zod-validation-error`). The extends cannot resolve and tsc aborts before
  typechecking anything.

A permanently red step that reports a tooling defect is one discarded exit code
away from being no check at all — the exact decay these workflows exist to
prevent — so it was removed with this note rather than shipped.

Two more facts, so nobody restores it by adding `expo` and assumes it then does
what its name says:

- root `tsconfig.json` declares **no `references`**, so `tsc --build` there builds
  no `lib/*` project. The name `typecheck:libs` is wrong.
  `lib/api-client-react`, `lib/api-zod` and `lib/db` each have their own
  composite `tsconfig.json`, and none is referenced from the root.
- root `tsconfig.json`'s `include` is `["**/*.ts", "**/*.tsx", …]` with no
  `exclude`, so it would pull in every tree in the repo at once, including
  `travel-buddy-standalone`.

**This is a repo defect, recorded here rather than hidden in a red job.** Fixing
it means editing root `package.json` or `tsconfig.json` (add `expo`, or repoint
the script at a `tsconfig` with real `references` to the three composite `lib/*`
projects), which the CI work was not permitted to do. Until then, `lib/*` is
type-checked only through `api-server`'s project references, and
`lib/api-client-react` is not type-checked at all.

**A red run there is a finding, not a CI bug.** It is the same finding as
`check:migration-prefixes`: a correct check, failing on something real, while
everyone saw green because nothing ran it.

Two acceptable responses to a red step:

1. fix what it found, or
2. delete that specific step, in a PR, with a written justification.

Discarding its exit code is not on the list, and `ci-self-check` will fail the
build if anyone tries.

It is a **separate workflow** so that a day-one red does not obscure the core
signal. **That separation has an expiry.** Once these are green, add
`unwired · verdict (skipped or cancelled is not a pass)` — the verdict job, not
`root-workspace` or `standalone` — to the required status checks. Until then it
is honest about being new rather than pretending to be a gate.

---

## Design rules these workflows follow

Enforced mechanically by the `ci-self-check` job, which scans every file under
`.github/` for forbidden constructs. Comment lines are stripped before matching,
so prose may name them; the patterns are written with bracket escapes so the
check does not match its own source.

1. **No `continue-on-error`.** Anywhere.
2. **No `|| true`, no `|| :`, no `--if-present`.** A discarded exit code is a
   discarded check.
2b. **No workspace-selector form, in any spelling** — long flag, short `-F`
   alias, `=`-joined, or with the flag anywhere but first. That form exits 0 when
   it matches nothing, so a renamed package or a deleted script reports success
   having run no code. **And no bare `pnpm run …` either**: every package-script
   invocation goes through `.github/scripts/pnpm-run.sh <dir> <package-name>
   <script>`, which asserts all three exist first and which passes literal values
   so `preflight` can verify the call site up front. Enforced by `ci-self-check`
   and by the `preflight` job.
3. **Explicit top-level `permissions: contents: read`** in all three workflows.
   No job writes, comments, or publishes. Nothing needs more.
4. **Pinned action versions.** No `@main`, no `@latest`. See the hardening note
   below.
5. **Triggers are `branches: ['**']`** on both `push` and `pull_request`, not a
   named allowlist. A named allowlist is exactly how a working branch silently
   loses CI.
6. **Counts are printed.** Where success depends on a total, the total goes to
   the job summary so a silent shrink is visible to a human reading the run.
7. **Generous timeouts.** A timeout kill is indistinguishable from a hang and
   would itself be a green-by-not-running failure. See the note below.
8. **An unestablished result is a failure.** A suite that exits 0 without
   printing parseable totals fails. This mirrors `run_gate()`: an absent verdict
   line is a block, whatever the exit code.

### Where `set -uo pipefail` is used without `-e`

Several steps deliberately omit `-e`, capture an exit code via `PIPESTATUS`,
print counts and per-check attribution, and *then* re-raise the code. This is
the same technique `run-all-checks.sh` uses (`set -uo pipefail`, deliberately
not `-e`, with a `FAILED` accumulator): it lets a step report what happened
before it fails, instead of aborting at the first non-zero and telling a human
nothing. **Every captured code is re-raised.** Nothing is suppressed.

Similarly, the credential-free check steps use
`if: ${{ !cancelled() && steps.install.outcome == 'success' }}` so that all of
them report, rather than stopping at the first failure. Each failure gets its
own red X against its own step name, so "CI failed" always names the check that
failed.

---

## Runtime environment

**Node 24.** Set as `NODE_VERSION` at the top of each workflow and pinned to the
major, matching `.replit`'s `modules = ["nodejs-24", …]` and
`docs/eas-runbook.md`'s required-tools table ("node | 24.x (LTS)").

> **Node 24 is inferred, not enforced by the repo.** There is no `engines` field
> in any `package.json`, no `.nvmrc`, and no `.tool-versions`. If CI ever pins a
> different major, **nothing in the repo will object** — which is itself a gap
> worth closing, ideally with an `engines` field.

**pnpm, twice.** The repo has **two independent workspace roots**:

- the repo root (`pnpm-workspace.yaml`: `artifacts/*`, `lib/*`, `packages/*`,
  `scripts`), with `"packageManager": "pnpm@10.26.1"`;
- `travel-buddy-standalone`, with its **own** lockfile and its own
  `pnpm-workspace.yaml` (`packages: []`), and **no** `packageManager` field.

Workflows run `corepack enable` only — never `corepack prepare pnpm@latest`,
which would float. Corepack walks up from the working directory and finds the
root's `pnpm@10.26.1` in both trees, so both get the same pinned version. Each
job prints `pnpm --version` and `node --version` so the actual versions are in
the log.

Both installs use `pnpm install --frozen-lockfile`. **If a lockfile is stale,
the job fails at install.** That is the correct failure; expect it on the first
run if either lockfile has drifted.

**Caching.** The pnpm store is cached under two separate keys, hashed from each
lockfile separately. This is deliberate: root `.npmrc` sets
`auto-install-peers=false` while the standalone lockfile header shows
`autoInstallPeers: true` — the two trees resolve peers differently, so no store
config assumption is shared between them.

`pnpm-workspace.yaml` declares `onlyBuiltDependencies: [esbuild]`, so
approve-builds prompting should not block a CI install.

### Timeouts

| Job | Timeout | Why |
| --- | --- | --- |
| `api-server-tests` | 30 min | The repo gives three mutually inconsistent runtimes for the same command: ~119s at HEAD, "well over 5 minutes" in the git-superseded version of that same memory file, and ~7.5 min in `WAVE3-APPLY-NOTES.md`. Both slow figures predate the `--test-force-exit` removal and carry smaller test counts. None was measured on a GitHub runner, which is slower than the Replit box. |
| `standalone-checks` | 60 min | `jest.config.js` pins `maxWorkers: 1` (without it jest OOMs), so 324 component files + 2 webrender files run strictly serially. Long by construction. |

Both are set well above every recorded figure **on purpose**. A timeout kill is
indistinguishable from a hang, and would be exactly the "green by not running"
class of failure this effort exists to kill. Let them fail on the real signal,
not on the clock.

---

## Suggested hardening

**Pin actions by commit SHA.** The workflows currently use major-version tags
(`actions/checkout@v4`, `actions/setup-node@v4`, `actions/cache@v4`). Those are
pins, not `@latest`, but they still float within v4. Converting them to full
commit SHAs is stricter and is the recommended end state. It was not done here
because the SHAs could not be verified from this environment, and an
unverifiable SHA fails the workflow at checkout. To do it:

```bash
gh api repos/actions/checkout/git/refs/tags/v4.2.2 --jq .object.sha
```

then write `actions/checkout@<sha> # v4.2.2`.

**Branch protection is not in this section.** It used to be, and it said: "make
`CI` a required status check. Add `CI (live DB)` … and `Unwired checks
(probation)`." That instruction was **wrong and has been deleted**, not softened.
It named *workflows*; required status checks are *jobs*, so following it meant
picking the individual jobs out of the checks list — and a skipped job is scored
as a successful required check, which is the exact defect the verdict jobs were
added to repair. Following the deleted advice would have reinstated it while
looking like hardening.

The correct and only list is in
[The required status checks](#the-required-status-checks--the-only-correct-list):
the three **verdict** jobs, never the individual jobs.

**Fix the stale badge.** `replit.md:5` still points at
`.github/workflows/pre-release.yml`, which does not exist, and
`docs/eas-runbook.md:364` references a step inside it. Repoint both at the
workflows that now exist. (Those two files were not modified by this work.)

---

## Where mechanical enforcement ends

**This section is the outermost layer, and it is prose on purpose.** Read it
before adding another guard.

Three rounds of adversarial review have been run against these workflows. Round
one found one blocker. Round two found none. Round three found three — not
because the workflows got worse, but because each fix adds a guard, and every
guard invites the question *"and what guards that?"*. That question always has an
answer, and the answer is always another file in this repository, which invites
the question again. **The regress does not terminate inside the repo.** It is
stopped here, deliberately, and the stopping point is written down so the next
person can tell a boundary from an oversight.

### What IS enforced mechanically

Precisely this, and it is a lot:

**Before anything installs — `preflight` (`.github/scripts/assert-ci-scripts.mjs`),
in all three workflows.** Scans every `.yml`, `.yaml`, `.sh` and `.mjs` file
under `.github/`, with comment lines stripped, and fails on any of:

- a `(package directory, package name, script)` triple named in CI that does not
  exist on disk — wrong directory, renamed package, deleted or empty script;
- an invocation whose arguments are shell variables (unresolvable is unverifiable);
- `pnpm`'s workspace-selector form in **any** spelling — long flag, short `-F`,
  `=`-joined, flag in any argument position;
- any **command-position** `pnpm` invocation that is not one of exactly three:
  `--version`, `store path`, `install --frozen-lockfile`. This is what makes
  `cd artifacts/api-server && pnpm run typecheck` — which uses no banned flag —
  fail;
- a missing `REQUIRED_CI_SCRIPTS` file: `pnpm-run.sh`, `run-live-suite.sh`,
  `assert-nonprod-supabase.sh`, `check-unrunnable-tests.mjs`;
- `check-unrunnable-tests.mjs` existing but invoked by nothing under `.github/`;
- any of the three live-DB security suites not being **run through**
  `run-live-suite.sh` (and invoking one through `pnpm-run.sh` is named
  separately);
- any job **declared** in `REQUIRED_CREDENTIAL_JOBS` not **running**
  `assert-nonprod-supabase.sh` — in run position, comments do not count — and
  unconditionally, not only when this file still manages to notice the job takes
  a credential. *(Secondary since the chokepoint landed: this now reports a
  missing fail-fast step, not a missing protection. See
  [The allowlist is enforced in the execution path](#the-allowlist-is-enforced-in-the-execution-path).)*
- any job in `live-db.yml` **not** on that list that reaches a credential by one
  of the modelled routes — a `secrets.` reference, a name defined (transitively)
  from `secrets.` in a workflow-level or job-level `env:` block, one of the
  Supabase credential env var names, a reusable-workflow call passing `secrets:`,
  or an `environment:` declaration — which fails as *"credential job not
  declared"* rather than silently leaving the guarded set;
- any declared credential job disappearing by id; the `jobs:` parse yielding an
  empty set; `REQUIRED_CREDENTIAL_JOBS` being empty or unreadable; or a declared
  job showing **no** credential route at all (the detector reporting its own
  blindness). A rule with nothing to check is a rule that passes vacuously, and
  every one of those is treated as a failure;
- a workspace member named in `REQUIRED_RECURSIVE_TYPECHECK` no longer defining a
  `typecheck` script, so `pnpm -r run typecheck` cannot quietly cover less.

**Per invocation — `.github/scripts/pnpm-run.sh`.** Directory exists,
`package.json` declares exactly the expected name, script is present and
non-empty; only then `cd` and `exec pnpm run`, so the exit code passes through
untouched.

**Per live-DB suite — `.github/scripts/run-live-suite.sh`.** Scores on output,
not exit code: fails on the no-credentials banner, unparseable counts,
`fail != 0`, `pass == 0`, `skipped != 0`, `tests == 0`, or `tests != pass`.

**Per PROCESS that can reach Supabase — the two guard front doors,
`artifacts/api-server/src/lib/ciSupabaseGuard.mjs` (five entry points) and
`…/ciProdReadOnlyAuditGuard.mjs` (the four read-only audits).** The chokepoint,
and the thing that actually keeps CI off production. Imported first by all nine
entry points; runs `.github/scripts/assert-nonprod-supabase.sh` before any
client is constructed or query issued, and exits **2** on any refusal: unset or
malformed `KNOWN_PROD_PROJECT_REF`, unset or malformed
`CI_SUPABASE_PROJECT_REF`, unparseable `SUPABASE_URL`, a resolved ref that is
not the sanctioned one, a sanctioned ref that is production, or an inability to
evaluate the policy at all. **No YAML edit can skip it** — a job that omits,
disables, reorders or never had the workflow step is still refused at runtime.
The read-only door's production-audit mode is refused outright whenever a CI
marker variable is present, so it changes nothing about what CI can reach; see
[The read-only production audit mode](#the-read-only-production-audit-mode).

**Per FILE that can reach Supabase — `check:guard-coverage`.** Every file under
`artifacts/api-server/src/` that names a Supabase credential variable or calls
`createClient()` imports a front door or is on an exempt list with a written
reason; the guard import is the FIRST import; only the two doors import the
policy module; and the read-only capability belongs to exactly the four files
named in `READ_ONLY_AUDIT_ENTRY_POINTS`, checked in both directions.

**Per credential job — the same policy script as a fail-fast step.** Same
verdict, ~90 seconds earlier, before checkout costs are paid. Plus each
credential job's own first step, which fails when any secret it needs is empty.

**Counts, not just exit codes.** api-server: `fail == 0`, `skipped <= max`,
`tests == pass + fail + skipped`, `pass >= registered files` (derived from
`package.json` each run), `pass >= API_TEST_MIN_PASS` (mandatory). Standalone
`node:test`: discovery floor 142, `fail == 0`, `pass > 0`, `skipped <= max`,
`pass >= files discovered`, full accounting. Standalone jest: `>= 2` summary
blocks, suites `>=` matching files on disk, no failing suite, no failing test,
`pass > 0`, `skipped <= max`, `todo == 0`, totals add up. Every operator-supplied
threshold is validated as a bare integer first, because a non-integer silently
*deletes* a `[ … -lt … ]` assertion rather than failing it.

**Integrity — `ci-self-check`.** No `continue-on-error`, `|| true`, `|| :`,
`--if-present` or selector form anywhere under `.github/`; plus the
unrunnable-test guard and its baseline.

**Verdicts — `ci-verdict`, `live-db-verdict`, `unwired-verdict`.** `if: always()`,
needs every other job in the workflow, fails unless each reported `success`, so a
skipped or cancelled job cannot be scored as a pass.

### What is NOT enforced, and cannot be

**A sufficiently determined edit to `.github/` disables any of it, and nothing
in the repository can stop that, because the thing checking the checks is itself
in the repository.**

That is not a defect to be fixed by another file. Every mechanism above is a file
under `.github/`, executed by a workflow defined under `.github/`, in the same
commit as the change being reviewed. Specifically, and to be concrete about it:

- Deleting the `preflight` job, or the one step in it that runs
  `assert-ci-scripts.mjs`, removes every assertion in the first list above.
  Nothing asserts that the preflight runs.
- Deleting a verdict job, or removing a job id from its `needs:` list, restores
  "a skipped job is a green required check". Nothing asserts the verdict jobs
  exist or that their `needs:` lists are complete.
- The floors (392, 142, `API_TEST_MIN_PASS`), the ceilings
  (`API_TEST_MAX_SKIPPED`, `STANDALONE_MAX_SKIPPED`), the `REQUIRED_*` lists in
  `assert-ci-scripts.mjs`, and the `BASELINE` in `check-unrunnable-tests.mjs` are
  all numbers and lists in editable files. Lowering, widening or extending any of
  them is a legal diff that produces a green build.
- `ci-self-check`'s pattern list can be shortened.
- The whole `.github/` directory can be deleted, which is how this repository
  spent its entire history before these workflows existed.

**Neither of the two obvious "fixes" for that is being built, and this is the
deliberate stopping point:**

1. *A guard asserting the verdict jobs exist.* It would live in `.github/` and
   would itself be deletable, so it moves the problem one file over.
2. *A guard asserting `assert-ci-scripts.mjs` is invoked.* Same, and it would
   have to be invoked by something, which nothing would assert.

**If you are reading this because you noticed that gap: it is not an oversight.
Do not add layer four.** Adding it buys no safety against the threat it appears
to address, and it costs a file that future readers must understand, maintain,
and eventually be misled by when it goes stale. The honest move is to stop and
say where the line is, which is what this section does.

Also outside mechanical reach, for the record:

- **Whether a test that runs asserts anything meaningful.** No static check sees
  a vacuous assertion. `check-unrunnable-tests.mjs` prints this among its own
  limits on every run.
- **Whether a lowered floor was justified.** The workflows require the PR to
  change the number; only a reviewer can judge the reason.
- **Whether the sanctioned Supabase project is genuinely non-production.** The
  allowlist proves the resolved ref equals a ref *someone declared*. That someone
  is a human, and the declaration is the trust anchor.
- **Whether a file that reaches Supabase by some route the coverage check cannot
  see is guarded.** Deleting `import "../lib/ciSupabaseGuard.mjs";` (or the
  read-only door's import) from one of the nine entry points is now caught:
  `check:guard-coverage` classifies every file under `src/` that names a
  Supabase credential variable or calls `createClient()`, and an unguarded one
  on the CI surface fails the build. What remains outside that is a file that
  reaches the database through neither pattern — a hardcoded or
  externally-supplied URL, with no credential variable named — and transitive
  reach through `getServiceClient()`, which is out of scope deliberately because
  the production API server is supposed to boot.
- **Whether the four read-only audits are actually read-only.** Nothing inspects
  their SQL. They were read; the set is closed and enforced; a fifth member is a
  reviewable diff. That is the guarantee, and it is not the same as a proof.
- **Whether the secrets contain what their names claim.**
- **GitHub's own behaviour** — that a skipped required check is scored as
  successful is a platform rule this repo can only work around, not change.

### Therefore: branch protection and review of `.github/**`

**The outermost guard is not in the repository. It is the branch protection rule
plus a human reading `.github/` diffs.** Everything above is defence in depth
*inside* the fence; these two settings are the fence.

Configure on the default branch (Settings → Branches → branch protection rule, or
a repository ruleset):

1. **Require status checks to pass before merging**, and require exactly these
   three — the verdict jobs, never the individual jobs. See
   [The required status checks](#the-required-status-checks--the-only-correct-list).
   - `CI · verdict (skipped or cancelled is not a pass)`
   - `live DB · verdict (cancelled or skipped is not a pass)` *(once the
     non-production project is configured)*
   - `unwired · verdict (skipped or cancelled is not a pass)` *(once green)*
2. **Require branches to be up to date before merging**, so the verdict was
   reached against what is actually being merged.
3. **Require a pull request before merging**, with **at least 1 approving
   review**, and **dismiss stale approvals when new commits are pushed** — an
   approval of an earlier diff is not an approval of the `.github/` change
   appended after it.
4. **Require review from Code Owners**, backed by a `CODEOWNERS` file. There is
   none in this repository today; this is the one piece of setup this section
   asks for:

   ```
   # .github/CODEOWNERS
   /.github/    @your-org/your-team
   /docs/ci/    @your-org/your-team
   ```

   That is what makes "a change to CI is reviewed by someone who owns CI" a rule
   rather than a hope.
5. **Do not allow bypassing the above settings**, including for administrators,
   and **block force pushes and branch deletion**. A bypass makes every setting
   above advisory, which is the word this entire effort exists to remove.

#### What a reviewer of a `.github/**` diff should actually look for

The mechanisms cannot check these; a person can, in about two minutes:

- a **removed step or job** — especially `preflight`, any `*-verdict`, or a
  `Preflight — Supabase target …` step;
- a **shortened `needs:` list** on a verdict job;
- a **lowered floor or raised ceiling**: `392`, `142`, `API_TEST_MIN_PASS`,
  `API_TEST_MAX_SKIPPED`, `STANDALONE_MAX_SKIPPED`;
- a **wrapper swap**: `run-live-suite.sh` → `pnpm-run.sh`, or either → a bare
  `pnpm run`;
- **entries removed** from `REQUIRED_CI_SCRIPTS`, `REQUIRED_CREDENTIAL_JOBS`,
  `REQUIRED_OUTPUT_SCORED_SUITES`, `REQUIRED_RECURSIVE_TYPECHECK`, or
  `SELECTOR_FORMS` / the `ci-self-check` pattern list — `REQUIRED_CREDENTIAL_JOBS`
  is now the **authority** on which jobs must run the Supabase allowlist, so
  removing an id there deletes that job's requirement outright;
- a **narrowed `credentialRoutes()`** or a shortened
  `SUPABASE_CREDENTIAL_ENV_NAMES` in `assert-ci-scripts.mjs`: that is how an
  undeclared credential job stops being caught, and it is a green diff;
- **`BASELINE` growth** in `check-unrunnable-tests.mjs` — the baseline records
  debt, it is not a place to put new debt;
- **`KNOWN_PROD_PROJECT_REF`** changed or removed;
- an **assertion turned into an echo**, or a comparison whose operand became a
  variable that might be empty.

Each of those is a legal, green diff. That is precisely why it needs eyes.

---

## Contract duplication warning

`src/scripts/checkRankEventsSurfaces.ts`'s EXIT CODE CONTRACT block states it is
mirrored in `docs/migrations.md`,
`docs/algorithm/rank-events-signal-gaps.md` and `scripts/run-all-checks.sh` —
"Change one, change all."

**`.github/workflows/live-db.yml` is now a fourth place** that depends on the
literal verdict line `GATE live_pulse: PERMITTED`. It asserts the line is
present in the `check:all` output, in addition to `run_gate()`'s own check, so
that if `run_gate` is ever weakened or the gate is dropped from
`run-all-checks.sh` the job notices instead of quietly losing the deploy gate.
Add this file to that list when the contract changes.

For reference, the contract:

| Exit | Meaning | Verdict |
| --- | --- | --- |
| 0 | PROCEED — probe INSERT accepted and rolled back | pass, **only if** the GATE line is also present |
| 1 | the script never chooses 1 — involuntary death | **block** (a crash proves nothing) |
| 2 | CANNOT-RUN — no URL, no token, or unparseable ref | **block** ("A gate that silently no-ops without credentials is not a gate.") |
| 3 | BLOCKED — rejected, or result could not be established | **block** |
