/**
 * ciSupabaseGuard.mjs — THE CHOKEPOINT. Imported for its side effect.
 *
 * WHAT CHANGED, AND WHY IT HAD TO
 * ===============================
 *
 * Until now, "CI may only touch the sanctioned Supabase project" was asserted
 * by a STEP in .github/workflows/live-db.yml:
 *
 *     - name: Preflight — Supabase target must be the sanctioned CI project
 *       run: bash .github/scripts/assert-nonprod-supabase.sh
 *
 * and everything else was an attempt to prove that step was present,
 * unconditional, first, and real. .github/scripts/assert-ci-scripts.mjs grew
 * five rounds of that proof, and each round was defeated by a YAML construct
 * the previous scan did not model — comments, `env:` indirection, `if:`, step
 * order, shell conditionals, `secrets[...]` index form. The scan was always one
 * construct behind, because the thing it was scanning — YAML — can express the
 * step's disablement in unbounded ways, and no finite pattern set closes an
 * unbounded surface.
 *
 * This file inverts the arrangement. The assertion is no longer a step that a
 * job may or may not contain; it is the FIRST THING THAT EXECUTES inside every
 * process that can reach Supabase. There is nothing to skip, because the code
 * that talks to the database cannot begin without this module having run to
 * completion first.
 *
 * The mechanism is ES module evaluation order, and it is not defeasible from
 * YAML:
 *
 *   * an `import` is evaluated before the importing module's own body;
 *   * this import is placed FIRST in each entry point, so it is evaluated
 *     before every sibling import — including `@supabase/supabase-js` itself,
 *     which is therefore not even loaded when a target is refused;
 *   * if this module calls process.exit(), the importing module's body never
 *     runs at all: no client is constructed, no URL is fetched, no query is
 *     issued.
 *
 * A workflow author who deletes the YAML step, comments it out, guards it with
 * `if: false`, moves it below the install step, wraps it in a shell
 * conditional, or writes a brand-new job in a brand-new workflow file that this
 * repo's scanners have never heard of, still gets refused — by the process, at
 * the moment it starts, on evidence it reads from its own environment.
 *
 * THIS IS NOW ONE OF TWO FRONT DOORS. THIS ONE IS THE STRICT ONE.
 * ==============================================================
 *
 * The rule this file enforces — the sanctioned CI project, or exit 2 — used to
 * apply uniformly to all nine entry points that import a guard. It was right
 * for the ones that WRITE and wrong for the ones that only read, and the four
 * read-only ones exist primarily to audit PRODUCTION: that is where this
 * repo's live-drift findings came from. See src/lib/ciProdReadOnlyAuditGuard.mjs
 * for the narrow mode that permits exactly that, and only outside CI.
 *
 * The importers of THIS file are the ones whose target must never be anything
 * but the CI project, because they change state:
 *
 *   src/scripts/checkRankEventsSurfaces.ts      real INSERT probe (rolled back)
 *   src/test/rlsHardening.test.ts               create + delete real auth users,
 *   src/test/profileRoleNotSelfWritable.test.ts mutate profiles.role and
 *   src/test/isOfficialPrivileged.test.ts       profiles.is_official
 *
 * THE READ-ONLY MODE IS NOT REACHABLE FROM HERE. THERE IS STILL NO OFF SWITCH.
 * ===========================================================================
 *
 * This file passes MODE_CI_PROJECT_ONLY to src/lib/supabaseTargetPolicy.mjs as
 * a hard-coded constant. Nothing in the environment changes which mode this
 * file asks for. A process that imports this module cannot be talked into the
 * read-only audit mode by any variable, and setting the read-only mode's intent
 * variable in a process that came through this door is a REFUSAL rather than a
 * no-op — so `test:rls-hardening` with that variable set fails, loudly, even
 * against the sanctioned CI project.
 *
 * That is why the capability is a second module rather than a flag: a flag on
 * this module would be reachable from the write-probe and the three RLS suites
 * the moment it existed, and a "disable the guard" variable is precisely the
 * thing that ends up copy-pasted into a workflow.
 *
 * THE ENTRY POINTS THAT IMPORT A GUARD (the full set, as of this change)
 * =====================================================================
 *
 * Reached from live-db.yml's three declared credential jobs:
 *
 *   api-server-check-all  -> check:all -> scripts/run-all-checks.sh
 *       src/scripts/checkWritePathColumns.ts      (read-only front door)
 *       src/scripts/checkMissingLiveColumns.ts    (read-only front door)
 *       src/scripts/checkRankEventsSurfaces.ts    (THIS file; real INSERT
 *                                                  probe, rolled back)
 *   schema-drift
 *       src/scripts/auditMigrationsVsLive.ts      (read-only front door)
 *       src/scripts/checkMediaObjects.ts          (read-only front door)
 *   live-db-security-suites -> .github/scripts/run-live-suite.sh
 *       src/test/rlsHardening.test.ts             (THIS file; supabase-js;
 *       src/test/profileRoleNotSelfWritable.test.ts  creates and deletes real
 *       src/test/isOfficialPrivileged.test.ts        auth users, mutates
 *                                                    profiles.role and
 *                                                    profiles.is_official)
 *
 * Not wired into any workflow: src/scripts/checkDiscoveryCacheKeys.ts. It is
 * SELECT-only and sits behind the READ-ONLY front door
 * (src/lib/ciProdReadOnlyAuditGuard.mjs), not this one, so it can be pointed
 * at declared production outside CI on a deliberate request. It is listed in
 * READ_ONLY_AUDIT_ENTRY_POINTS in scripts/check-guard-coverage.mjs, which is
 * where that grant is recorded and enforced.
 *
 * The other four checks in run-all-checks.sh (frozen-dir, async-handlers,
 * migration-prefixes, test-runner-flags) read only files on disk and reach no
 * database; they deliberately do not import any guard. A fifth,
 * check:guard-coverage, is what makes the coverage of both front doors a fact
 * rather than a claim.
 *
 * WHAT "BOTH FRONT DOORS" DOES NOT MEAN (2026-08-11)
 * =================================================
 *
 * It means both import entry points into this policy. It does NOT mean every
 * path from this repo to a Supabase database. There are FOUR, and this module
 * is the first two:
 *
 *   1. @supabase/supabase-js behind this guard                — covered here
 *   2. the read-only audit path behind ciProdReadOnlyAuditGuard — covered here
 *   3. the Supabase CLI                                        — outside
 *   4. direct libpq via TRIGGER_PSQL_URL / ENGAGEMENT_PSQL_URL — outside
 *
 * (3) is a separate binary. It reads supabase/.temp/linked-project.json, not
 * this module — and that file was committed to this repo pinning the
 * PRODUCTION ref until 2026-08-11.
 *
 * (4) is not merely unguarded, it is structurally outside this architecture.
 * Every assertion downstream of here resolves a project ref and compares it. A
 * libpq connection string carries no ref: there is no SUPABASE_URL to parse,
 * so the allowlist has nothing to bind to and cannot be extended to cover it.
 * scripts/check-db-triggers.sh:194-196 and
 * scripts/check-engagement-indexes.sh:91-94 read those variables today.
 *
 * Both are refused in CI by .github/scripts/assert-nonprod-supabase.sh
 * (runtime: CLI on PATH, committed link state, libpq variables set) and
 * .github/scripts/assert-ci-scripts.mjs (static: CLI invocation in workflow
 * YAML, which catches `npx supabase`). Neither refusal happens here, and
 * neither defends a developer laptop. The coverage this file proves is real
 * and it is coverage of an import surface — say that, rather than letting it
 * be read as coverage of the database.
 *
 * WHY THIS IS ONE POLICY AND NINE IMPORT SITES, NOT ONE CALL SITE
 * ==============================================================
 *
 * The entry points do NOT converge on a shared connection helper, and that is
 * a fact about the tree rather than a preference:
 *
 *   * the six scripts each talk to the Supabase MANAGEMENT API by hand —
 *     `process.env.SUPABASE_URL`, `new URL(...).hostname.split(".")[0]`, then
 *     `fetch("https://api.supabase.com/v1/projects/<ref>/database/query")`.
 *     Six independent copies of that, sharing nothing;
 *   * the three test suites each call `createClient()` from
 *     `@supabase/supabase-js` directly, against PostgREST and the auth admin
 *     API — a different protocol, a different host, different credentials;
 *   * src/lib/supabase.ts `getServiceClient()` is the APPLICATION's helper. The
 *     scripts do not use it and the three suites deliberately do not use it
 *     (they need anon and per-user clients too). Putting this guard there
 *     would refuse to let the production API server boot, which is the opposite
 *     of the intent — that process is SUPPOSED to talk to production.
 *
 * So there is exactly one implementation of the policy
 * (src/lib/supabaseTargetPolicy.mjs, which delegates the allowlist itself to
 * one shell script), reached through two front doors, imported at the top of
 * each process that can reach the database. The alternative — asserting again
 * in each file — is the thing this replaces.
 *
 * THE POLICY IS NOT REIMPLEMENTED HERE
 * ===================================
 *
 * The rules about which project ref is acceptable live in exactly one place,
 * .github/scripts/assert-nonprod-supabase.sh, and this module RUNS that script
 * rather than restating it. A second implementation in JavaScript would be a
 * second thing to keep in step, and the two would diverge on the first change.
 * That script already fails closed on every input this guard cares about:
 *
 *   KNOWN_PROD_PROJECT_REF unset or malformed   -> refuse
 *   CI_SUPABASE_PROJECT_REF unset or malformed  -> refuse   (unset allowlist)
 *   SUPABASE_URL empty or unparseable           -> refuse   (unparseable)
 *   resolved ref != CI_SUPABASE_PROJECT_REF     -> refuse   (not on the list)
 *   resolved ref == KNOWN_PROD_PROJECT_REF      -> refuse   (secondary)
 *
 * FAIL-CLOSED IS THE ONLY OUTCOME THIS MODULE CAN PRODUCE OTHER THAN "PASS"
 * ========================================================================
 *
 * Every way this module can fail to obtain a verdict is a refusal, not a pass:
 * the repo root cannot be located, the policy script is missing or unreadable,
 * `bash` cannot be spawned, the child is killed by a signal, or it exits
 * non-zero. There is deliberately NO environment variable that disables this
 * module, and no "credentials absent so skip" branch — an absent credential is
 * exactly the state in which the three live-DB suites skip every test and exit
 * 0, which is the failure this whole CI effort exists to delete.
 *
 * "No variable that disables this module" is still literally true and is meant
 * to stay that way. The read-only audit mode is not a disablement and is not
 * available here: it is a different module, permitting one named target, for
 * four named read-only files, refused outright inside CI.
 *
 * The consequence is real and accepted: `pnpm run test:rls-hardening` and
 * `pnpm run check:rank-events-surfaces` refuse to run anywhere — including a
 * developer laptop — unless CI_SUPABASE_PROJECT_REF and KNOWN_PROD_PROJECT_REF
 * are set AND SUPABASE_URL names the sanctioned CI project. That is the point.
 * These processes create and delete real auth users and write-probe a real
 * table; the caller must state which project that is allowed to happen in, and
 * what production is, before any of it starts. See docs/ci/README.md
 * § "The allowlist is enforced in the execution path".
 *
 * EXIT CODE 2, DELIBERATELY
 * =========================
 *
 * A refusal exits 2, not 1, and not the policy script's own 1.
 *
 *   * Every caller already treats 2 as a hard failure. `check:media-objects`,
 *     `check:missing-live-columns`, `check:write-path-columns` and
 *     `audit:schema` all document 2 as "environment error / cannot run", and
 *     each is a plain `run:` step, so a non-zero exit fails the job.
 *   * `check:rank-events-surfaces` documents an EXIT CODE CONTRACT in which
 *     2 = CANNOT-RUN and 1 = "the script never chooses 1, so the process died
 *     involuntarily and proved nothing". A refusal is a decision, not a crash,
 *     so exiting 1 there would make scripts/run-all-checks.sh print exactly the
 *     wrong diagnosis. 2 is the code that already means "this did not run, and
 *     that is a block rather than a skip".
 *   * .github/scripts/run-live-suite.sh fails on any non-zero rc, so 2 is a red
 *     for the three suites as well.
 *
 * The policy script's own non-zero statuses are collapsed into 2 on purpose:
 * they are all one class — refused — and preserving the distinction would buy
 * nothing while breaking the contract above. The script's full message is
 * printed verbatim (stdio is inherited), so the specific reason is never lost.
 */

import {
  MODE_CI_PROJECT_ONLY,
  assertSupabaseTarget,
} from "./supabaseTargetPolicy.mjs";

// The mode is a hard-coded constant. It is not read from, defaulted from, or
// influenced by the environment, and there is no second call site in this file.
assertSupabaseTarget(MODE_CI_PROJECT_ONLY, "ciSupabaseGuard");
