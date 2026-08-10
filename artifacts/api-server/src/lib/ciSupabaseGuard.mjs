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
 * THE ENTRY POINTS THAT IMPORT THIS (the full set, as of this change)
 * ==================================================================
 *
 * Reached from live-db.yml's three declared credential jobs:
 *
 *   api-server-check-all  -> check:all -> scripts/run-all-checks.sh
 *       src/scripts/checkWritePathColumns.ts      (Management API query)
 *       src/scripts/checkMissingLiveColumns.ts    (Management API query)
 *       src/scripts/checkRankEventsSurfaces.ts    (Management API; real INSERT
 *                                                  probe, rolled back)
 *   schema-drift
 *       src/scripts/auditMigrationsVsLive.ts      (audit:schema)
 *       src/scripts/checkMediaObjects.ts          (check:media-objects)
 *   live-db-security-suites -> .github/scripts/run-live-suite.sh
 *       src/test/rlsHardening.test.ts             (supabase-js; creates and
 *       src/test/profileRoleNotSelfWritable.test.ts  deletes real auth users,
 *       src/test/isOfficialPrivileged.test.ts        mutates profiles.role and
 *                                                    profiles.is_official)
 *
 * The other four checks in run-all-checks.sh (frozen-dir, async-handlers,
 * migration-prefixes, test-runner-flags) read only files on disk and reach no
 * database; they deliberately do not import this module.
 *
 * WHY THIS IS ONE MODULE AND EIGHT IMPORT SITES, NOT ONE CALL SITE
 * ===============================================================
 *
 * The eight entry points do NOT converge on a shared connection helper, and
 * that is a fact about the tree rather than a preference:
 *
 *   * the five scripts each talk to the Supabase MANAGEMENT API by hand —
 *     `process.env.SUPABASE_URL`, `new URL(...).hostname.split(".")[0]`, then
 *     `fetch("https://api.supabase.com/v1/projects/<ref>/database/query")`.
 *     Five independent copies of that, sharing nothing;
 *   * the three test suites each call `createClient()` from
 *     `@supabase/supabase-js` directly, against PostgREST and the auth admin
 *     API — a different protocol, a different host, different credentials;
 *   * src/lib/supabase.ts `getServiceClient()` is the APPLICATION's helper. The
 *     five scripts do not use it and the three suites deliberately do not use
 *     it (they need anon and per-user clients too). Putting this guard there
 *     would refuse to let the production API server boot, which is the opposite
 *     of the intent — that process is SUPPOSED to talk to production.
 *
 * So there is exactly one implementation of the rule (this file, delegating to
 * one implementation of the policy), imported at the top of each of the eight
 * processes that can reach the database. The alternative — asserting again in
 * each file — is the thing this replaces.
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
 * the repo root cannot be located, the policy script is missing, `bash` cannot
 * be spawned, the child is killed by a signal, or it exits non-zero. There is
 * deliberately NO environment variable that disables this module, and no
 * "credentials absent so skip" branch — an absent credential is exactly the
 * state in which the three live-DB suites skip every test and exit 0, which is
 * the failure this whole CI effort exists to delete.
 *
 * The consequence is real and accepted: `pnpm run audit:schema`,
 * `pnpm run check:all` and `pnpm run test:rls-hardening` now refuse to run
 * anywhere — including a developer laptop — unless CI_SUPABASE_PROJECT_REF and
 * KNOWN_PROD_PROJECT_REF are set. That is the point. These processes create and
 * delete real auth users and write-probe a real table; the caller must state
 * which project that is allowed to happen in, and what production is, before
 * any of it starts. See docs/ci/README.md § "The allowlist is enforced in the
 * execution path".
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

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const POLICY_REL = ".github/scripts/assert-nonprod-supabase.sh";

/** Refuse. Never returns. */
function refuse(message) {
  // ::error:: is GitHub's annotation form; harmless plain text elsewhere.
  console.error(`::error::[ciSupabaseGuard] ${message}`);
  console.error(
    "[ciSupabaseGuard] REFUSED. This process can reach a live Supabase project, " +
      "so it asserts its target for itself before constructing any client and " +
      "before issuing any query. Nothing downstream of this point has run. " +
      "This assertion is part of the execution path, not a workflow step: it " +
      "cannot be skipped by editing YAML. See docs/ci/README.md.",
  );
  process.exit(2);
}

/**
 * Walk up from this file until the policy script is found. Resolving by
 * relative depth alone would break silently the first time this file moves;
 * a search that runs out of parents refuses rather than guessing.
 */
function findPolicyScript() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, POLICY_REL);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

const policyScript = findPolicyScript();

if (policyScript === null) {
  refuse(
    `Could not locate ${POLICY_REL} in any ancestor directory of this module. ` +
      "That file is the single implementation of the Supabase project allowlist. " +
      "Without it there is no way to establish which project this process is " +
      "about to write to, and an unverifiable target is not a safe target.",
  );
}

const result = spawnSync("bash", [policyScript], {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  refuse(
    `Could not execute ${POLICY_REL}: ${result.error.message}. The allowlist ` +
      "could not be evaluated, so this process has no evidence about the " +
      "project it is pointed at.",
  );
}

if (result.signal) {
  refuse(
    `${POLICY_REL} was killed by signal ${result.signal} before reaching a ` +
      "verdict. No verdict is a refusal.",
  );
}

if (result.status !== 0) {
  refuse(
    `${POLICY_REL} refused this target (it exited ${result.status}). Its own ` +
      "message above names the specific reason: an unset or malformed " +
      "CI_SUPABASE_PROJECT_REF or KNOWN_PROD_PROJECT_REF, an empty or " +
      "unparseable SUPABASE_URL, a project ref that is not the sanctioned one, " +
      "or a sanctioned ref that is production.",
  );
}

console.log(
  "[ciSupabaseGuard] Supabase allowlist asserted in-process, before any client " +
    "was constructed and before any query. Proceeding.",
);
