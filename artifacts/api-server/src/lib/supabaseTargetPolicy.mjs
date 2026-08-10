/**
 * supabaseTargetPolicy.mjs — the one implementation behind the TWO guard front
 * doors. Exports a function; importing this file does nothing on its own.
 *
 * DO NOT IMPORT THIS FILE FROM AN ENTRY POINT. Import a front door:
 *
 *   src/lib/ciSupabaseGuard.mjs            — the sanctioned CI project, only.
 *   src/lib/ciProdReadOnlyAuditGuard.mjs   — the same, plus one narrow mode.
 *
 * That is enforced mechanically, not by convention:
 * scripts/check-guard-coverage.mjs fails if any file other than those two
 * imports this module, and fails if any file other than those named
 * read-only audits imports the read-only front door.
 *
 * WHY THERE ARE TWO FRONT DOORS AND NOT ONE FRONT DOOR WITH A SWITCH
 * =================================================================
 *
 * The original guard was uniform: every process that can reach Supabase must
 * be pointed at the sanctioned CI project, or it exits 2. That is the right
 * rule for the four entry points that WRITE — checkRankEventsSurfaces.ts
 * attempts a real INSERT, and the three live-DB suites create and delete real
 * auth users and mutate profiles.role / profiles.is_official. Nothing about
 * this change weakens that; those four cannot reach the mode below at all,
 * because they do not import the module that has it.
 *
 * It was the wrong rule for the audit entry points, which issue SELECTs and
 * nothing else, and whose PRIMARY PURPOSE is auditing production — that is
 * where this repo's live-drift findings came from. Under the uniform guard
 * they could not do the job they exist to do, and the Replit workspace, whose
 * SUPABASE_URL points at production (.replit:148), failed them on every run.
 *
 * The obvious repair — an environment variable that disables the guard — is
 * refused, and ciSupabaseGuard.mjs still says so. A disable switch is a thing
 * that gets copy-pasted into a workflow, and it would be reachable from the
 * write-probe and the RLS suites the moment it existed. So the capability is
 * not a switch on the existing guard; it is a SEPARATE MODULE that the named
 * files import, carrying a mode this module hard-codes at the call site. There
 * is no configuration path from the strict front door to the mode below.
 *
 * THE THREE PROPERTIES THAT MAKE THE MODE SAFE TO EXIST
 * ====================================================
 *
 *   1. IMPOSSIBLE INSIDE CI. If ANY of the CI marker variables below is
 *      PRESENT in the environment — present, not "true", empty string counts —
 *      the mode is refused outright, before its own value is even examined.
 *      GitHub Actions always sets CI, GITHUB_ACTIONS and about twenty more
 *      GITHUB_ and RUNNER_ variables, and a workflow cannot unset them for a step
 *      through `env:`. That is what makes this capability safe to have at all.
 *
 *      THE RESIDUAL, STATED RATHER THAN GLOSSED. This is an environment test,
 *      and a `run:` step is a shell: `run: unset CI GITHUB_ACTIONS … && pnpm
 *      run audit:schema` would defeat it, and no environment test can prevent
 *      that. What is claimed is narrower and still worth having: no workflow
 *      reaches this mode by ACCIDENT, by inheriting an `env:` block, or by
 *      setting one variable. Defeating it takes an explicit, conspicuous line
 *      that unsets every GITHUB_*, RUNNER_* and ACTIONS_* variable on the
 *      runner and names this repo's intent value — in a file under .github/,
 *      which is branch-protected and read by a human. That is a different
 *      shape from a flag, and it is the same answer docs/ci/README.md gives
 *      for every other property of .github/**.
 *
 *   2. DELIBERATE. The request is not a boolean. The variable must be exactly
 *      the sentence-shaped value below; "1", "true", "yes" and "on" are each
 *      refused with the same message that names the real value. An operator
 *      has to mean to type it.
 *
 *   3. SCOPED, AND NARROWER THAN "NOT THE CI PROJECT". The mode permits
 *      exactly one target: the ref declared in KNOWN_PROD_PROJECT_REF. It is
 *      not a general "any project" escape — a colleague's project, a
 *      customer's project or a typo that happens to resolve is still refused,
 *      which is the whole reason the CI rule is an allowlist rather than a
 *      denylist.
 *
 * ASKING FOR THE MODE FROM A WRITE-CAPABLE PROCESS IS A REFUSAL, NOT A NO-OP
 * =========================================================================
 *
 * When the intent variable is set and the process came through the STRICT
 * front door, this module refuses immediately — it does not ignore the
 * variable and fall through to the allowlist. Setting the variable therefore
 * makes the write-capable entry points refuse HARDER, never softer, and
 * `test:rls-hardening` with the variable set fails even when SUPABASE_URL
 * points at the sanctioned CI project.
 *
 * WHAT THIS MODULE CANNOT ESTABLISH, STATED PLAINLY
 * =================================================
 *
 * It cannot prove that the importing file is read-only. Nothing here inspects
 * the caller's SQL. The read-only claim rests on two things that are checkable
 * and were checked: the files that may import the read-only front door
 * are named in scripts/check-guard-coverage.mjs and enforced there, and each
 * of them was read and contains only SELECTs (auditMigrationsVsLive.ts and
 * checkMissingLiveColumns.ts query pg catalogs and information_schema;
 * checkMediaObjects.ts reads post_media and storage.objects;
 * checkWritePathColumns.ts parses the TypeScript AST and issues one SELECT on
 * checkDiscoveryCacheKeys.ts sends five SELECTs over discovery_cache plus a
 * SELECT and a WITH-prefixed SELECT aggregating rank_events, and makes no
 * .insert/.update/.upsert/.delete/.rpc call anywhere in the file). If one of
 * them ever gains a write, moving it back behind
 * the strict front door is the fix, and the list in the coverage check is
 * where that decision is recorded.
 *
 * It also cannot make the Management API token read-only. The token that these
 * audits authenticate with is a project token with write capability; the mode
 * constrains WHAT THE PROCESS DOES, not what the credential could do.
 *
 * FAIL-CLOSED, ON EVERY PATH
 * ==========================
 *
 *   the policy script cannot be located or read  -> refuse (both modes)
 *   the intent variable is set in strict mode    -> refuse
 *   any CI marker variable is present            -> refuse (mode requested)
 *   the intent value is not exactly right        -> refuse
 *   KNOWN_PROD_PROJECT_REF unset or malformed    -> refuse
 *   SUPABASE_URL empty or unparseable            -> refuse
 *   resolved ref != KNOWN_PROD_PROJECT_REF       -> refuse
 *   the mode was not requested                   -> the allowlist policy runs,
 *                                                   exactly as before
 *
 * Every refusal exits 2, for the reasons set out in ciSupabaseGuard.mjs's
 * EXIT CODE 2, DELIBERATELY section — that contract is unchanged.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The strict rule: the sanctioned CI project, or nothing. */
export const MODE_CI_PROJECT_ONLY = "ci-project-only";

/**
 * The strict rule, PLUS: outside CI, with a deliberate intent value, a
 * read-only audit of the declared production project is permitted.
 */
export const MODE_PROD_READ_ONLY_AUDIT = "prod-read-only-audit";

const POLICY_REL = ".github/scripts/assert-nonprod-supabase.sh";

/** The variable that requests the mode. Presence alone is a request. */
export const INTENT_VAR = "PORTAVA_PROD_READ_ONLY_AUDIT";

/**
 * The only accepted value. Deliberately a sentence and not a boolean: "1" and
 * "true" are what a person types to make an error message go away.
 */
export const INTENT_VALUE = "read-only-audit-against-production";

/**
 * Environment variables whose PRESENCE means "this is an automated build".
 * GitHub Actions sets CI, GITHUB_ACTIONS, GITHUB_RUN_ID, GITHUB_WORKFLOW,
 * GITHUB_EVENT_NAME and RUNNER_OS on every runner, unconditionally, and a
 * workflow cannot unset them for a step in any supported way. The rest of the
 * list is the common markers of the other providers, on the principle that
 * "not CI" should not mean "not GitHub".
 */
const CI_MARKER_VARS = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "BUILD_NUMBER",
  "RUN_ID",
  "GITHUB_ACTIONS",
  "GITHUB_RUN_ID",
  "GITHUB_WORKFLOW",
  "GITHUB_EVENT_NAME",
  "GITHUB_JOB",
  "RUNNER_OS",
  "GITLAB_CI",
  "CIRCLECI",
  "TRAVIS",
  "JENKINS_URL",
  "JENKINS_HOME",
  "HUDSON_URL",
  "BUILDKITE",
  "DRONE",
  "TEAMCITY_VERSION",
  "TF_BUILD",
  "APPVEYOR",
  "CODEBUILD_BUILD_ID",
  "BITBUCKET_BUILD_NUMBER",
  "SEMAPHORE",
  "NETLIFY",
  "VERCEL",
  "NOW_BUILDER",
  "HEROKU_TEST_RUN_ID",
  "CIRRUS_CI",
  "WOODPECKER",
  "SCREWDRIVER",
];

/**
 * The shape rules, copied VERBATIM in meaning from
 * .github/scripts/assert-nonprod-supabase.sh. They are duplicated here because
 * the read-only path deliberately does not execute that script (see
 * requirePolicyScript below), and a second copy of two regexes is a smaller
 * risk than a path with no shape checking at all. If the script's regexes
 * change, change these in the same commit.
 */
const BARE_REF_RE = /^[a-z0-9]+$/;
const SUPABASE_URL_RE = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/;

/** Refuse. Never returns. */
function refuse(tag, message) {
  // ::error:: is GitHub's annotation form; harmless plain text elsewhere.
  console.error(`::error::[${tag}] ${message}`);
  console.error(
    `[${tag}] REFUSED. This process can reach a live Supabase project, so it ` +
      "asserts its target for itself before constructing any client and before " +
      "issuing any query. Nothing downstream of this point has run. This " +
      "assertion is part of the execution path, not a workflow step: it cannot " +
      "be skipped by editing YAML. See docs/ci/README.md.",
  );
  process.exit(2);
}

/**
 * Walk up from this file until the policy script is found, then READ it.
 * Resolving by relative depth alone would break silently the first time this
 * file moves; a search that runs out of parents refuses rather than guessing,
 * and a file that exists but cannot be read is refused too — an unreadable
 * policy is not a satisfied policy.
 *
 * This runs on BOTH paths, including the read-only audit path, which does not
 * execute it. That is deliberate: the policy script is this repo's single
 * written statement of what the CI project is and what production is, and no
 * mode of this module runs in a tree where that statement is missing.
 */
function requirePolicyScript(tag) {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, POLICY_REL);
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch (err) {
      if (err && err.code !== "ENOENT") {
        refuse(
          tag,
          `Found ${POLICY_REL} at ${candidate} but could not read it: ` +
            `${err.message}. That file is the single implementation of the ` +
            "Supabase project allowlist. A policy that cannot be read has not " +
            "been satisfied.",
        );
      }
    }
    const parent = resolve(dir, "..");
    if (parent === dir) {
      refuse(
        tag,
        `Could not locate ${POLICY_REL} in any ancestor directory of this ` +
          "module. That file is the single implementation of the Supabase " +
          "project allowlist. Without it there is no way to establish which " +
          "project this process is about to talk to, and an unverifiable " +
          "target is not a safe target.",
      );
    }
    dir = parent;
  }
}

/**
 * Whole FAMILIES of variables whose presence means the same thing. A named list
 * alone is defeatable by a `run:` step that unsets the names — see the RESIDUAL
 * note below — so the families are checked too: GitHub Actions exports roughly
 * twenty GITHUB_ variables and several RUNNER_ and ACTIONS_ ones on every runner, and
 * all of them would have to be named to get past this.
 *
 * GITHUB_TOKEN is the one exclusion. It is NOT set by Actions unless a workflow
 * passes it explicitly, and it IS commonly exported on a developer machine for
 * `gh`; refusing on it would be a false positive that buys nothing.
 *
 * CI_ is deliberately not a prefix: CI_SUPABASE_PROJECT_REF is legitimately set
 * outside CI and is required by the path this mode is an alternative to.
 */
const CI_MARKER_PREFIXES = ["GITHUB_", "RUNNER_", "ACTIONS_"];
const CI_MARKER_PREFIX_EXCEPTIONS = new Set(["GITHUB_TOKEN"]);

/** CI marker variables PRESENT in this environment, whatever their value. */
function presentCiMarkers(env) {
  const found = new Set(
    CI_MARKER_VARS.filter((name) =>
      Object.prototype.hasOwnProperty.call(env, name),
    ),
  );
  for (const name of Object.keys(env)) {
    if (CI_MARKER_PREFIX_EXCEPTIONS.has(name)) continue;
    if (CI_MARKER_PREFIXES.some((p) => name.startsWith(p))) found.add(name);
  }
  return [...found].sort();
}

/** Run the allowlist policy script. Returns only if it passed. */
function runAllowlistPolicy(tag, policyScript) {
  const result = spawnSync("bash", [policyScript], {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    refuse(
      tag,
      `Could not execute ${POLICY_REL}: ${result.error.message}. The allowlist ` +
        "could not be evaluated, so this process has no evidence about the " +
        "project it is pointed at.",
    );
  }

  if (result.signal) {
    refuse(
      tag,
      `${POLICY_REL} was killed by signal ${result.signal} before reaching a ` +
        "verdict. No verdict is a refusal.",
    );
  }

  if (result.status !== 0) {
    refuse(
      tag,
      `${POLICY_REL} refused this target (it exited ${result.status}). Its own ` +
        "message above names the specific reason: an unset or malformed " +
        "CI_SUPABASE_PROJECT_REF or KNOWN_PROD_PROJECT_REF, an empty or " +
        "unparseable SUPABASE_URL, a project ref that is not the sanctioned " +
        "one, or a sanctioned ref that is production.",
    );
  }
}

/**
 * Assert this process may talk to the Supabase project SUPABASE_URL names.
 *
 * @param {typeof MODE_CI_PROJECT_ONLY | typeof MODE_PROD_READ_ONLY_AUDIT} mode
 *   Hard-coded by the calling front door. Never derived from the environment.
 * @param {string} tag Log prefix, so an operator can tell which front door
 *   spoke without reading the stack.
 */
export function assertSupabaseTarget(mode, tag) {
  if (mode !== MODE_CI_PROJECT_ONLY && mode !== MODE_PROD_READ_ONLY_AUDIT) {
    // Not reachable from the two front doors, which pass constants. A third
    // caller with a typo must not be treated as the permissive case.
    refuse(
      tag,
      `Unknown guard mode ${JSON.stringify(mode)}. A mode this module does not ` +
        "recognise is refused rather than defaulted.",
    );
  }

  const env = process.env;
  const policyScript = requirePolicyScript(tag);
  const asked = Object.prototype.hasOwnProperty.call(env, INTENT_VAR);

  // ── The strict front door does not have this capability, and says so. ──────
  if (asked && mode === MODE_CI_PROJECT_ONLY) {
    refuse(
      tag,
      `${INTENT_VAR} is set, but this process is not one of the read-only ` +
        "audits. It writes: it creates or deletes auth users, mutates " +
        "profiles.role / profiles.is_official, or attempts an INSERT probe " +
        "against public.rank_events. The read-only audit mode is not reachable " +
        "from here — this entry point imports src/lib/ciSupabaseGuard.mjs, " +
        "which hard-codes the strict mode, and there is no variable that " +
        "changes that. Setting this variable does not relax anything; it is " +
        "refused so the attempt is visible instead of silently ignored. Unset " +
        `${INTENT_VAR} and point SUPABASE_URL at the sanctioned CI project. ` +
        "See docs/ci/README.md.",
    );
  }

  // ── Not asked for: the original rule, unchanged, for every entry point. ────
  if (!asked) {
    runAllowlistPolicy(tag, policyScript);
    console.log(
      `[${tag}] Supabase allowlist asserted in-process, before any client was ` +
        "constructed and before any query. Proceeding.",
    );
    return;
  }

  // ── Asked for, from a read-only audit. Every gate below fails closed. ──────

  // 1. IMPOSSIBLE INSIDE CI. Checked FIRST and before the value, so that a
  //    workflow gets this refusal no matter what else it configured.
  const markers = presentCiMarkers(env);
  if (markers.length > 0) {
    refuse(
      tag,
      `${INTENT_VAR} is set AND this process is running inside CI ` +
        `(${markers.join(", ")} present in the environment). The read-only ` +
        "production audit mode is refused outright in CI, unconditionally, " +
        "whatever else is configured and whatever those variables are set to " +
        "— presence alone is the signal. This is the property that makes the " +
        "mode safe to exist at all: it is an operator-at-a-terminal " +
        "capability, and no workflow in this repo can reach it. GitHub Actions " +
        "sets CI and GITHUB_ACTIONS on every runner. If you are seeing this " +
        `outside CI, something in your shell exports one of: ${markers.join(", ")}.`,
    );
  }

  // 2. DELIBERATE. Not a boolean.
  if (env[INTENT_VAR] !== INTENT_VALUE) {
    const shown =
      env[INTENT_VAR] === "" ? "the empty string" : JSON.stringify(env[INTENT_VAR]);
    refuse(
      tag,
      `${INTENT_VAR} is ${shown}, which is not the value that requests a ` +
        `read-only production audit. That value is exactly:\n\n    ` +
        `${INTENT_VAR}='${INTENT_VALUE}'\n\n` +
        "It is a sentence rather than a flag on purpose. \"1\", \"true\", " +
        "\"yes\" and \"on\" are what someone types to make an error go away; " +
        "this mode points a process at PRODUCTION, and the request for it " +
        "should be something nobody types by reflex or leaves in a shell " +
        "profile by accident.",
    );
  }

  // 3. The production ref must be declared, and shaped like a ref.
  const prodRef = env.KNOWN_PROD_PROJECT_REF ?? "";
  if (prodRef === "") {
    refuse(
      tag,
      "KNOWN_PROD_PROJECT_REF is empty or not configured, so there is no " +
        "declared production project and this mode has no target it is allowed " +
        "to use. The read-only audit mode permits exactly ONE project — the " +
        "one declared there — and it fails closed without it, the same way " +
        `${POLICY_REL} does. Set it to the project ref of the PRODUCTION ` +
        "Supabase project.",
    );
  }
  if (!BARE_REF_RE.test(prodRef)) {
    refuse(
      tag,
      `KNOWN_PROD_PROJECT_REF is '${prodRef}', which is not a bare project ref ` +
        "(lowercase letters and digits only). A value of the wrong shape can " +
        "never equal a ref resolved from a URL, so the comparison below could " +
        "not succeed — and a mode whose target can never match is a mode that " +
        "would refuse for the wrong reason. It must be the '<project-ref>' " +
        "portion of https://<project-ref>.supabase.co, not a full URL.",
    );
  }

  // 4. The URL must be parseable, or no ref can be resolved from it.
  const url = env.SUPABASE_URL ?? "";
  if (url === "") {
    refuse(
      tag,
      "SUPABASE_URL is empty, so no project ref can be resolved. An " +
        "unresolvable target is not a safe target, in this mode as in every " +
        "other.",
    );
  }
  const match = SUPABASE_URL_RE.exec(url);
  if (match === null) {
    refuse(
      tag,
      "SUPABASE_URL does not match https://<project-ref>.supabase.co — its " +
        "project ref cannot be resolved, so it cannot be compared with " +
        "KNOWN_PROD_PROJECT_REF. An unverifiable target is treated as an " +
        "unsafe one. (The value is not printed.)",
    );
  }
  const resolvedRef = match[1];

  // 5. The ONLY permitted target is the declared production project.
  if (resolvedRef !== prodRef) {
    refuse(
      tag,
      `${INTENT_VAR} requests a read-only audit of PRODUCTION, but the ref ` +
        `resolved from SUPABASE_URL is '${resolvedRef}', and the declared ` +
        `production ref is '${prodRef}'. This mode is not a general "any ` +
        'project" escape: it permits exactly one target, the declared ' +
        "production project. Every other ref — a second production project, a " +
        "colleague's project, a customer's project, a typo that happens to " +
        `resolve — is refused here just as it is by ${POLICY_REL}. If you meant ` +
        `to run against the sanctioned CI project, unset ${INTENT_VAR}: the ` +
        "normal allowlist path is what handles that.",
    );
  }

  // ── Permitted. Say so at length; this is a production connection. ──────────
  const banner = "═".repeat(74);
  console.log(banner);
  console.log(`[${tag}] READ-ONLY AUDIT OF PRODUCTION — PERMITTED`);
  console.log(banner);
  const pad = Math.max(resolvedRef.length, prodRef.length);
  console.log(`  requested by  : ${INTENT_VAR}='${INTENT_VALUE}'`);
  console.log(`  resolved ref  : ${resolvedRef.padEnd(pad)}   (from SUPABASE_URL)`);
  console.log(`  declared prod : ${prodRef.padEnd(pad)}   (KNOWN_PROD_PROJECT_REF)`);
  console.log(`  CI markers    : none present — this mode is refused in CI`);
  console.log("");
  console.log(
    "  This process is about to read PRODUCTION data. It is one of the\n" +
      "  audits permitted to do so, and it issues SELECTs only: no INSERT, no\n" +
      "  UPDATE, no DELETE, no auth user is created or deleted, no row is\n" +
      "  written. That is a property of these files, verified by reading\n" +
      "  them, and enforced by scripts/check-guard-coverage.mjs, which fails if\n" +
      "  any other file imports this front door.",
  );
  console.log(
    "  It is NOT a property of the credential: the Management API token in\n" +
      "  this environment can write. The mode constrains what this process\n" +
      "  does, not what the token could do.",
  );
  console.log(banner);
}
