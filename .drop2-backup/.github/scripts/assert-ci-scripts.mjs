#!/usr/bin/env node
//
// assert-ci-scripts.mjs — fail-fast preflight for every package script this CI
// invokes. Runs BEFORE any job that installs anything. No dependencies, no
// network, no node_modules required.
//
// WHAT IT ASSERTS, AND WHY
//
// 1. Every (directory, package name, script) triple named anywhere under
//    .github/ actually exists: the directory is there, its package.json
//    declares that exact name, and that script is defined and non-empty.
//
//    This is the fail-fast half of the guarantee that .github/scripts/pnpm-run.sh
//    makes per-invocation. The selector form `pnpm <selector> <pkg> run <script>`
//    EXITS 0 when it matches nothing (verified against pnpm 10.26.1: an
//    unmatched selector prints "No projects matched the filters" and exits 0;
//    a matched package with a missing script also exits 0). A workflow written
//    that way reports SUCCESS when the package is renamed or the script is
//    deleted. Both must be loud failures, and both fail here.
//
// 2. No workflow or shell script under .github/ still uses the selector form.
//    ci.yml's self-check enforces this too; it is repeated here so this
//    preflight is meaningful when run on its own.
//
// 3. The root `typecheck` script is `pnpm -r run typecheck`, i.e. "whatever
//    workspace members happen to define a typecheck script". That is a moving
//    target, and `pnpm -r run <script>` does NOT fail when fewer members match
//    than you assumed. So the members that must define it are asserted by name,
//    and the real coverage is printed — no comment or doc is allowed to be the
//    authority on what that recursive run covers.
//
// Exit 0 only if every assertion holds. Exit 1 otherwise, naming each failure.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

const problems = [];
const notes = [];
function problem(msg) {
  problems.push(msg);
  console.error(`::error::${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Members that MUST define a `typecheck` script for the root recursive
// `pnpm -r run typecheck` to mean what unwired-checks.yml and docs/ci/README.md
// say it means. Derived by reading every workspace member's package.json.
//
// Note what is NOT in this list and cannot be: no lib/* member defines a
// typecheck script (lib/api-client-react, lib/api-spec, lib/api-zod, lib/db —
// checked). The recursive run does not cover them. If one of them gains a
// typecheck script, this preflight will print it under "also covered" and the
// list below can be extended.
// ─────────────────────────────────────────────────────────────────────────────
const REQUIRED_RECURSIVE_TYPECHECK = [
  '@workspace/api-server',
  '@workspace/mockup-sandbox',
  '@workspace/travel-buddy',
  '@workspace/scripts',
  'expo-openmls',
];

// ─────────────────────────────────────────────────────────────────────────────
// Collect every (dir, name, script) triple named under .github/.
//
// Two invocation shapes, both with the three arguments in the same order:
//   bash .github/scripts/pnpm-run.sh      <dir> <name> <script>
//   bash .github/scripts/run-live-suite.sh <label> <dir> <name> <script>
//
// WHICH wrapper a triple was invoked through is recorded, not just the triple.
// The two wrappers are not interchangeable: pnpm-run.sh scores a suite on its
// EXIT CODE, run-live-suite.sh scores it on its OUTPUT. For the three
// credential-dependent suites that skip every describe() and exit 0 when a
// credential is missing, the exit code is not a usable signal, so swapping one
// wrapper for the other silently deletes the only assertion that catches them.
// See REQUIRED_OUTPUT_SCORED_SUITES below.
// ─────────────────────────────────────────────────────────────────────────────
const INVOCATION_PATTERNS = [
  { wrapper: 'pnpm-run.sh', re: /pnpm-run\.sh[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\S+)/g },
  { wrapper: 'run-live-suite.sh', re: /run-live-suite\.sh[ \t]+\S+[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\S+)/g },
];

// ─────────────────────────────────────────────────────────────────────────────
// BANNED pnpm forms, and the tiny allowlist of pnpm invocations that do NOT go
// through pnpm-run.sh.
//
// The old single pattern here was `pnpm` + whitespace + the long selector flag,
// anchored so the flag had to be pnpm's FIRST argument. It therefore matched
// exactly one spelling, and three documented equivalents walked straight past
// it — each of them producing the same exit-0-having-run-nothing behaviour:
//
//   pnpm -F <pkg> run <script>            the short alias, which pnpm documents
//                                         alongside the long form
//   pnpm -r <long-flag> <pkg> run <s>     flag not in first position
//   pnpm run <long-flag>=<pkg> <script>   `=`-joined
//
// Patterns are spelled with bracket escapes so this file's own source stays
// clean now that the scan DOES cover .mjs as well as .yml/.yaml/.sh.
// ─────────────────────────────────────────────────────────────────────────────
const SELECTOR_FORMS = [
  {
    re: new RegExp('pnpm[ \\t][^\\n]*[-][-]filter', 'g'),
    label: "pnpm's long workspace-selector flag",
  },
  {
    re: new RegExp('pnpm[ \\t][^\\n]*[-]F', 'g'),
    label: "pnpm's short workspace-selector alias -F",
  },
];

// THE BIGGER GAP THE SELECTOR BAN NEVER CLOSED.
//
// Banning the selector form says how NOT to invoke a package script. Nothing
// said a step that invokes a package script has to use pnpm-run.sh at all —
// so `cd artifacts/api-server && pnpm run typecheck` was, and remains, entirely
// legal under every pattern above. That form has the same defect the wrapper
// exists to remove: `pnpm run <script>` on a package whose script was deleted
// exits 1, but on a directory that no longer exists, or after a `cd` that
// failed, the step's behaviour is nobody's contract, and none of it is
// verifiable ahead of time by this preflight — the invocation is invisible to
// the (dir, name, script) scan above, so a check written that way silently
// leaves the verified set.
//
// So the rule is inverted: EVERY command-position pnpm invocation under
// .github/ must be one of the three below, or it must not be a direct pnpm call
// at all. Anything else is reported and names pnpm-run.sh.
//
// The three permitted forms are environment plumbing, not check invocations:
// they run no package script, so there is nothing for pnpm-run.sh to assert.
const ALLOWED_PNPM_INVOCATIONS = [
  { re: /^--version\b/, label: 'pnpm --version (printing the resolved version)' },
  { re: /^store[ \t]+path\b/, label: 'pnpm store path (cache key resolution)' },
  {
    re: /^install[ \t]+--frozen-lockfile\b/,
    label: 'pnpm install --frozen-lockfile (workspace install)',
  },
];

// A pnpm at COMMAND position: start of line, after a YAML `key:`, after a shell
// operator (`|`, `&&`, `;`), inside `$(…)` or backticks, optionally prefixed by
// `exec`. This is what makes `cd x && pnpm run y` and `run: pnpm run y` both
// visible, where a start-of-line-only match would see neither.
const PNPM_COMMAND = /(?:^|[|&;(:]|\$\(|`)[ \t]*(?:exec[ \t]+)?pnpm[ \t]+([^\n]*)/g;

// ─────────────────────────────────────────────────────────────────────────────
// COMMENTS ARE PROSE. RUN POSITION IS EXECUTION. The difference is load-bearing.
//
// Every rule below matches against source lines, and two mistakes are possible
// in opposite directions:
//
//   * Treating a comment as code. These files document the constructs they ban,
//     so prose must be able to spell them out. Comment lines are dropped.
//   * Treating a comment as code's ABSENCE-PROOF — the worse one, and the one
//     that was live. The "every credential job must call the production guard"
//     rule was a bare `body.includes('assert-nonprod-supabase.sh')` over
//     unstripped YAML. Reproduced: replacing all three
//     `run: bash .github/scripts/assert-nonprod-supabase.sh` steps with a
//     comment mentioning the filename left this preflight exiting 0 and printing
//     "call sites verified in 3 credential job(s)". The denylist was gone and
//     the check said it was there.
//
// So a "this must be invoked" rule requires the invocation in RUN POSITION:
// start of line (a `run: |` block body), after a YAML `run:` key, or after a
// shell operator — with an interpreter in front of it — and NOT after a '#'.
// ─────────────────────────────────────────────────────────────────────────────
const COMMENT_LINE = /^\s*(#|\/\/)/;
const isCommentLine = (line) => COMMENT_LINE.test(line);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does this single line EXECUTE `<interpreter> <scriptRelPath>`?
 * Comment lines, and matches that sit after a '#' on the line, are prose.
 */
function runsScriptInRunPosition(line, scriptRelPath) {
  if (isCommentLine(line)) return false;
  const re = new RegExp(
    '(?:^|[|&;(]|\\$\\(|`|run:)[ \\t]*(?:exec[ \\t]+)?(?:bash|sh|node)[ \\t]+(?:\\./)?' +
      escapeRe(scriptRelPath) +
      '(?:[ \\t]|$)',
  );
  const m = re.exec(line);
  if (!m) return false;
  return !line.slice(0, m.index).includes('#');
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const githubDir = join(REPO_ROOT, '.github');
if (!existsSync(githubDir)) {
  problem('.github/ does not exist — this preflight is running outside the repo.');
}

// THE SCAN COVERS .mjs NOW, AND THE OMISSION WAS NOT COSMETIC.
//
// This filter used to be /\.(ya?ml|sh)$/, which put every .mjs file under
// .github/ outside EVERY rule in this file: the selector-form ban, the
// command-position pnpm allowlist, and the call-site collection. Two of this
// CI's guards are .mjs (this file and check-unrunnable-tests.mjs), and .mjs is
// the obvious place to put a third. Reproduced: appending
// `const cmd = "cd artifacts/api-server && pnpm run typecheck";` and
// `const sel = "pnpm --filter @workspace/api-server run test";` to
// check-unrunnable-tests.mjs left this preflight exiting 0 — the banned forms
// were simply in a file nothing looked at. The rules now apply to the guards
// themselves, which is where they were least enforced and most needed.
const scanned = existsSync(githubDir)
  ? walk(githubDir).filter((f) => /\.(ya?ml|sh|mjs)$/.test(f))
  : [];

// The wrapper IMPLEMENTATIONS take their package/script as parameters, so their
// own text contains usage strings and `"$VAR"` forms that are not call sites and
// cannot be resolved statically. They are excluded from the call-site scan and
// from the pnpm-invocation allowlist (only from those — the selector-form ban
// below still applies to them). Every real call site passes literal values and
// is checked.
//
// THIS FILE IS ON THE LIST NOW THAT THE SCAN COVERS .mjs, and for the same
// reason rather than a new one: a guard that bans a form has to QUOTE that form
// in the error it prints. Its messages contain `pnpm run <script>`,
// "pnpm-run.sh <dir> <package-name> <script>" and similar, none of which are
// invocations — running the scan over them produced seven bogus "direct pnpm
// invocation" errors and four phantom package directories ('<dir>', 'the',
// 'to'). The alternative was to contort every error message until it dodged the
// scanner, which trades readable failures for a scanner that is happy: exactly
// the wrong direction.
//
// What is NOT relaxed for excluded files: the selector-form ban below still
// applies to all of them, and .github/scripts/check-unrunnable-tests.mjs — the
// other .mjs guard — is NOT excluded and is fully scanned.
const SCAN_EXCLUDED_IMPLEMENTATIONS = [
  '.github/scripts/pnpm-run.sh',
  '.github/scripts/run-live-suite.sh',
  '.github/scripts/assert-ci-scripts.mjs',
];

// EVERY CI SCRIPT WHOSE ABSENCE WOULD BE SILENT MUST BE ASSERTED HERE.
//
// The first two are on this list because they are excluded from the scan above,
// and an exclusion must never be able to hide a deletion.
//
// assert-nonprod-supabase.sh is on it for the same reason arrived at from the
// other direction: NOTHING asserted it. It is the single implementation of the
// allowlist policy that decides which Supabase project may have auth users
// created in it, roles promoted and demoted in it, and rank_events write-probed
// against it.
//
// WHAT ITS DELETION MEANS NOW. When the allowlist was a workflow step, deleting
// the file AND the three steps that called it was completely silent, and that
// is why this entry was added. Since the assertion moved into the execution
// path, deleting the file is fail-closed on its own:
// artifacts/api-server/src/lib/ciSupabaseGuard.mjs refuses when it cannot find
// this script, so all eight entry points exit 2 instead of running unguarded.
// This presence check therefore turns an eight-way runtime refusal into one
// named 20-second failure that says which file went missing. That is worth
// having; it is no longer the thing standing between CI and production.
const REQUIRED_CI_SCRIPTS = [
  {
    path: '.github/scripts/pnpm-run.sh',
    why: 'Every CI package-script invocation is supposed to go through it; without it the workflows are either broken or have gone back to an unchecked invocation form.',
  },
  {
    path: '.github/scripts/run-live-suite.sh',
    why: 'The three credential-dependent api-server suites are scored on their OUTPUT through it, because they skip every test and exit 0 when a credential is missing.',
  },
  {
    path: '.github/scripts/assert-nonprod-supabase.sh',
    why: 'It is the ALLOWLIST that restricts the credential jobs to the one sanctioned non-production Supabase project. Those jobs create and delete real auth users, mutate profiles.role and profiles.is_official, and write-probe public.rank_events. Without it there is no check on which database they do that to.',
    // Not `mustBeInvoked` here because it gets something stronger below: every
    // job in live-db.yml that consumes a secret must call it, in run position.
  },
  {
    // WAS ABSENT FROM THIS LIST ENTIRELY.
    //
    // It is the guard behind ci-self-check's "No NEW unrunnable test files"
    // step, and it holds the BASELINE of five known-unrunnable files. Deleting
    // the file alone fails loudly ("Cannot find module"). Deleting the file AND
    // the one step in ci.yml that runs it was completely silent: the baseline
    // and its class-A/class-B reasoning would simply be gone, new unrunnable
    // test files would stop being detected, and ci-self-check would go green —
    // the same two-line erasure the Supabase guard was vulnerable to.
    path: '.github/scripts/check-unrunnable-tests.mjs',
    why: 'It is the only thing that detects a NEW test file in travel-buddy-standalone that no runner CI invokes will ever execute, and it carries the baseline of the five already known.',
    mustBeInvoked: true,
  },
];

// DELIBERATELY NOT ON THIS LIST: .github/scripts/assert-ci-scripts.mjs itself.
//
// Asserting that THIS file is invoked would have to be done by something, and
// that something would need its own assertion. That regress does not terminate
// inside the repository, because everything that could perform the check is
// itself editable by the change under review. The outermost guard is therefore
// branch protection plus human review of .github/** — stated, not hidden. See
// docs/ci/README.md § "Where mechanical enforcement ends".
for (const { path: impl, why, mustBeInvoked } of REQUIRED_CI_SCRIPTS) {
  if (!existsSync(join(REPO_ROOT, impl))) {
    problem(`${impl} is missing. ${why}`);
    continue;
  }
  if (!mustBeInvoked) continue;
  const callSites = [];
  for (const file of scanned) {
    const rel = file.slice(REPO_ROOT.length + 1);
    if (rel === impl) continue; // a file mentioning its own path is not a caller
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, idx) => {
        if (runsScriptInRunPosition(line, impl)) callSites.push(`${rel}:${idx + 1}`);
      });
  }
  if (callSites.length === 0) {
    problem(
      `${impl} exists but NOTHING under .github/ invokes it. ${why} A guard that is present and called by ` +
        'nobody guards nothing, and its removal from a workflow is completely silent — the job simply runs ' +
        'one step fewer and goes green. Restore the step that runs it, or, if it is genuinely obsolete, ' +
        'delete the file and its entry in REQUIRED_CI_SCRIPTS in the same PR and say why.',
    );
  } else {
    notes.push(`${impl} is invoked at: ${callSites.join(', ')}.`);
  }
}

/**
 * @type {Map<string, {
 *   dir:string, name:string, script:string, sites:string[],
 *   wrappers:Set<string>, runPositionWrappers:Set<string>
 * }>}
 */
const triples = new Map();
const tripleKey = (dir, name, script) => `${dir} ${name} ${script}`;

for (const file of scanned) {
  const rel = file.slice(REPO_ROOT.length + 1);
  const lines = readFileSync(file, 'utf8').split('\n');

  lines.forEach((rawLine, idx) => {
    // Comment lines are prose, not invocations. Strip YAML/bash `#` comments
    // and JS `//` comments (the scan covers .mjs now) so the documentation in
    // these files may spell things out plainly.
    if (isCommentLine(rawLine)) return;
    const site = `${rel}:${idx + 1}`;

    const isImplementation = SCAN_EXCLUDED_IMPLEMENTATIONS.includes(rel);

    for (const { wrapper, re: pattern } of isImplementation ? [] : INVOCATION_PATTERNS) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(rawLine)) !== null) {
        const [, dir, name, script] = m;
        // Skip anything still parameterised — a variable cannot be verified
        // here, and is therefore not allowed (see the check below).
        if ([dir, name, script].some((a) => a.includes('$'))) {
          problem(
            `${site}: a package-script invocation uses a shell variable (${dir} ${name} ${script}). ` +
              'Every CI invocation must name its directory, package and script literally, or this preflight ' +
              'cannot verify it exists and the step becomes unverifiable again.',
          );
          continue;
        }
        const key = tripleKey(dir, name, script);
        const entry = triples.get(key) ?? {
          dir,
          name,
          script,
          sites: [],
          wrappers: new Set(),
          runPositionWrappers: new Set(),
        };
        entry.sites.push(site);
        entry.wrappers.add(wrapper);
        // WHICH wrapper, and whether the line actually RUNS it. A line that
        // merely contains the text is not an invocation — see
        // runsScriptInRunPosition.
        if (runsScriptInRunPosition(rawLine, `.github/scripts/${wrapper}`)) {
          entry.runPositionWrappers.add(wrapper);
        }
        triples.set(key, entry);
      }
    }

    // The selector-form ban applies to EVERY scanned file, implementations
    // included.
    for (const { re, label } of SELECTOR_FORMS) {
      re.lastIndex = 0;
      if (re.test(rawLine)) {
        problem(
          `${site}: ${label} found. The workspace-selector form exits 0 when it matches nothing ` +
            '(pnpm 10.26.1: an unmatched selector prints "No projects matched the filters" and exits 0; a ' +
            'matched package with a missing script also exits 0), so a renamed package or a deleted script ' +
            'would report SUCCESS. Use .github/scripts/pnpm-run.sh <dir> <package-name> <script> instead.',
        );
      }
    }

    // Every command-position pnpm invocation must be one of the three
    // environment-plumbing forms, or it must go through pnpm-run.sh. This is
    // what makes `cd x && pnpm run y` — which uses no selector flag and which
    // the bans above cannot see — a failure.
    // A YAML `name:` scalar is a label, not a command — step names in these
    // workflows legitimately contain prose like "(pnpm version comes from root
    // packageManager)". Nothing on a name: line ever executes.
    const isYamlNameScalar = /^\s*-?\s*name:\s/.test(rawLine);

    if (!isImplementation && !isYamlNameScalar) {
      PNPM_COMMAND.lastIndex = 0;
      let pm;
      while ((pm = PNPM_COMMAND.exec(rawLine)) !== null) {
        const rest = pm[1];
        if (ALLOWED_PNPM_INVOCATIONS.some(({ re }) => re.test(rest))) continue;
        problem(
          `${site}: direct pnpm invocation \`pnpm ${rest.trim()}\` does not go through ` +
            '.github/scripts/pnpm-run.sh. A step that invokes a package script must call ' +
            '`bash .github/scripts/pnpm-run.sh <dir> <package-name> <script>`, which asserts the directory, ' +
            'the package name and the script all exist BEFORE running anything — and which passes literal ' +
            'values, so this preflight can verify the invocation up front. A bare `pnpm run <script>` is ' +
            'invisible to that verification: the step leaves the checked set without anything going red. ' +
            'The only direct pnpm calls permitted under .github/ are: ' +
            ALLOWED_PNPM_INVOCATIONS.map((a) => a.label).join('; ') +
            '.',
        );
      }
    }
  });
}

if (triples.size === 0) {
  problem(
    'No package-script invocations were found under .github/. Either every check was removed, or the ' +
      'invocation shape changed and this preflight is now scanning for something that is not there — ' +
      'in which case it is verifying nothing and must be updated, not ignored.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// THE THREE SUITES THAT MUST BE SCORED ON THEIR OUTPUT, NOT THEIR EXIT CODE.
//
// run-live-suite.sh was asserted to EXIST (REQUIRED_CI_SCRIPTS, above) and
// nothing asserted it was USED. Those are not the same claim, and for these
// three suites the gap is the whole point of the file:
//
//   Each computes CREDS_AVAILABLE from SUPABASE_URL + SERVICE_ROLE_KEY +
//   ANON_KEY, passes `{ skip: !CREDS_AVAILABLE }` to EVERY describe(), and sets
//   no process.exitCode. With any one credential missing or wrong they skip
//   every test and EXIT 0, having asserted nothing about the RLS policies, the
//   profiles.role write boundary or the is_official trigger.
//
// run-live-suite.sh is the only thing that reads the counts and fails on
// pass == 0, skipped != 0, unparseable totals, or tests != pass. Swapping it
// for pnpm-run.sh is a one-word edit per step that leaves the workflow looking
// identical, keeps every other assertion in this file satisfied (the triple
// still resolves, the script still exists), and silently returns all three
// suites to exit-code-only scoring — which is the scoring that reports a
// credential-less skip as a pass. Reproduced: with all three steps rewritten to
// pnpm-run.sh, this preflight exited 0 and said nothing.
//
// So the WRAPPER is asserted, per suite, in run position.
// ─────────────────────────────────────────────────────────────────────────────
const OUTPUT_SCORED_WRAPPER = 'run-live-suite.sh';
const REQUIRED_OUTPUT_SCORED_SUITES = [
  { dir: 'artifacts/api-server', name: '@workspace/api-server', script: 'test:rls-hardening' },
  { dir: 'artifacts/api-server', name: '@workspace/api-server', script: 'test:profile-role-not-self-writable' },
  { dir: 'artifacts/api-server', name: '@workspace/api-server', script: 'test:is-official-privileged' },
];

for (const { dir, name, script } of REQUIRED_OUTPUT_SCORED_SUITES) {
  const entry = triples.get(tripleKey(dir, name, script));
  const what = `${name} ${script}`;

  if (!entry) {
    problem(
      `No CI invocation of '${what}' was found at all. It is one of the three live-DB security suites, and ` +
        `it must be invoked as \`bash .github/scripts/${OUTPUT_SCORED_WRAPPER} <label> ${dir} ${name} ${script}\` ` +
        'from .github/workflows/live-db.yml. If the suite was deliberately retired, remove it from ' +
        'REQUIRED_OUTPUT_SCORED_SUITES in .github/scripts/assert-ci-scripts.mjs in the same PR and say why — ' +
        'a security suite must not be able to leave CI by nobody calling it.',
    );
    continue;
  }

  if (!entry.runPositionWrappers.has(OUTPUT_SCORED_WRAPPER)) {
    problem(
      `'${what}' is named at ${entry.sites.join(', ')} but is not RUN through ` +
        `.github/scripts/${OUTPUT_SCORED_WRAPPER} (wrappers seen in run position: ` +
        `${[...entry.runPositionWrappers].join(', ') || 'none'}). This suite passes ` +
        '`{ skip: !CREDS_AVAILABLE }` to every describe() and exits 0 having skipped everything when a ' +
        'credential is missing, so its exit code is not a usable signal. Only run-live-suite.sh reads the ' +
        'pass/fail/skipped/tests counts out of the output and fails on them.',
    );
  }

  if (entry.wrappers.has('pnpm-run.sh')) {
    problem(
      `'${what}' is invoked through .github/scripts/pnpm-run.sh at ${entry.sites.join(', ')}. pnpm-run.sh ` +
        'scores a suite on its EXIT CODE, and this suite exits 0 when it skips every test for want of a ' +
        'credential — that is exactly the green-having-asserted-nothing outcome run-live-suite.sh exists to ' +
        `catch. Use \`bash .github/scripts/${OUTPUT_SCORED_WRAPPER} <label> ${dir} ${name} ${script}\`.`,
    );
  }
}
// ─────────────────────────────────────────────────────────────────────────────
// DEMOTED. THIS BLOCK IS A SECONDARY DETECTOR FOR UNDECLARED JOBS.
// IT IS NO LONGER WHAT KEEPS CI OFF PRODUCTION. DO NOT REASON AS IF IT WERE.
//
// It used to be. The Supabase allowlist lived as a STEP in live-db.yml, and
// everything below was an attempt to prove that step was present,
// unconditional, first, and real. Five rounds of that, and each round was
// defeated by a construct the previous round did not model: comments, then
// `env:` indirection, then `if:`, then step order, then shell conditionals,
// then the `secrets[...]` index form. The pattern is not bad luck. It is
// structural — this block tries to establish a property of YAML, and YAML can
// express the step's disablement in unbounded ways, so a finite set of rules is
// always one construct behind.
//
// THE FIX WAS TO STOP SCANNING. The assertion now lives in the EXECUTION PATH:
// artifacts/api-server/src/lib/ciSupabaseGuard.mjs is the FIRST import of every
// entry point that can reach Supabase (five scripts under
// artifacts/api-server/src/scripts/ and the three live-DB suites under
// src/test/). It runs assert-nonprod-supabase.sh — the same single
// implementation of the policy — before any client is constructed and before
// any query, and exits 2 if it refuses. A job that omits the YAML step,
// comments it out, guards it with `if: false`, moves it after install, wraps it
// in a shell conditional, or is a brand-new job in a brand-new workflow file
// this scan has never parsed is STILL refused, at runtime, by the process
// itself. Demonstrated by execution; see docs/ci/README.md
// § "The allowlist is enforced in the execution path".
//
// SO WHAT IS THIS BLOCK STILL FOR?
//
//   1. DECLARATION DRIFT — the useful half. REQUIRED_CREDENTIAL_JOBS states
//      which jobs the repo believes are credential-bearing. Direction 2 below
//      surfaces a job that JOINED that set by accident (an `env:` inheritance,
//      `secrets: inherit`, an `environment:` declaration) so a human decides
//      deliberately whether it belongs. That is a scope signal for review.
//   2. FAIL-FAST — direction 1 below keeps the three `run:` steps honest, and
//      those steps are worth ~90 seconds: they report the same refusal before
//      checkout costs, corepack, cache restore and `pnpm install` are paid for.
//
// A failure here now means "a fail-fast step or a declaration is missing",
// NOT "the database is unprotected". The error messages below say so.
//
// Everything from here to the end of this block is retained history: it
// explains why the scan lost, which is why it no longer decides anything.
//
// .github/scripts/assert-nonprod-supabase.sh is asserted to EXIST above, and
// that assertion IS still load-bearing — but for a different reason than
// before. The chokepoint runs that file; if it disappears, the chokepoint
// refuses (it fails closed when the policy script cannot be found), so every
// entry point goes red rather than unguarded. The presence check turns that
// into a 20-second named failure instead of an eight-way one.
//
// ROUND 4 CLOSED "A COMMENT SATISFIES THE GUARD". IT DID NOT CLOSE "WHICH JOBS
// IS THE GUARD EVEN REQUIRED OF", AND THAT WAS THE LARGER HOLE.
//
// The rule used to DERIVE its own subject: the set of jobs it applied to was
// `jobs.filter(body => a non-comment line matches /\bsecrets\./)`. The comment
// here claimed that made a fourth credential job "covered the day it is
// written". It did the opposite. A derived subject can be left by ordinary
// refactoring, no adversary required:
//
//   * move the secret into a workflow-level (or job-level) `env:` block and
//     consume it as `$SUPABASE_URL` — the job body no longer contains the text
//     `secrets.`;
//   * take the credential through a reusable workflow (`secrets: inherit`) or a
//     composite action;
//   * put it behind a matrix or any other variable indirection.
//
// In every case the job stops matching, so the rule stops APPLYING to it, and
// the preflight goes green while reporting "3 of 3 credential job(s)" — a count
// of the jobs it decided to look at, not of the jobs that can reach the
// database. Reproduced against the clean tree: adding
// `INHERITED_DB_URL: ${{ secrets.SUPABASE_URL }}` to the top-level `env:` block
// and a `rank-events-backfill` job that curls `$INHERITED_DB_URL` with no
// allowlist step left this preflight exiting 0 and still printing "3 of 3".
//
// SO THE SET IS NO LONGER DERIVED. REQUIRED_CREDENTIAL_JOBS IS THE AUTHORITY,
// and divergence from it fails in BOTH directions:
//
//   1. Every id on the list must exist in live-db.yml AND must RUN the guard in
//      run position. Unconditional — it does not depend on this file managing
//      to notice that the job still touches a credential.
//   2. Every job NOT on the list that touches credentials by ANY of the routes
//      below fails as "credential job not declared". The fix is for a human to
//      add the id to the list and the guard step to the job, deliberately, in
//      the same PR — not for a detector to quietly absorb it.
//   3. An empty or malformed list is a failure, and so is an unparseable
//      `jobs:` mapping. A rule with nothing to check passes vacuously, and a
//      vacuous pass is the outcome this whole file exists to delete.
//   4. A job that IS on the list but shows no credential route at all is also a
//      failure — that is how this detector reports its own blindness instead of
//      rotting silently into "matches nothing, complains about nothing".
//
// The routes below are a floor, not a proof of completeness. See
// docs/ci/README.md § "Where mechanical enforcement ends" for what remains
// outside them.
//
// AND THE "IS IT CALLED" CHECK ITSELF WAS ONCE SATISFIED BY A COMMENT.
//
// It was `body.includes('assert-nonprod-supabase.sh')` over the job's raw YAML.
// A '#' line mentioning the filename — including the explanatory comment blocks
// that sit above each of these very steps — satisfied it. Reproduced: replacing
// all three `run: bash .github/scripts/assert-nonprod-supabase.sh` steps with a
// single comment left this preflight printing "call sites verified in 3
// credential job(s)" and exiting 0, with the guard invoked nowhere.
//
// The invocation must be in RUN POSITION on a non-comment line.
const PROD_GUARD = 'assert-nonprod-supabase.sh';
const PROD_GUARD_PATH = `.github/scripts/${PROD_GUARD}`;
const LIVE_DB_WORKFLOW = '.github/workflows/live-db.yml';

// THE AUTHORITY. Declared, not derived. Adding a job here without adding the
// guard step fails; adding a credential-touching job to live-db.yml without
// adding it here fails. Both are the point.
const REQUIRED_CREDENTIAL_JOBS = [
  'api-server-check-all',
  'schema-drift',
  'live-db-security-suites',
];

// Names that ARE the Supabase credentials, or that select the database being
// written to. A job naming any of them can reach Supabase regardless of where
// the value came from — `env:`, a matrix, an action's output, or the runner's
// ambient environment. This is the route that survives the indirections the
// `secrets.` text search could not see.
const SUPABASE_CREDENTIAL_ENV_NAMES = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_ANON_KEY',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  'EXPO_PUBLIC_SUPABASE_URL',
  'SUPABASE_PROJECT_TOKEN',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD',
];

/** Whole-word reference to `name` anywhere in `text`. */
function referencesName(text, name) {
  return new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])`).test(text);
}

/**
 * Every `KEY: value` pair inside any `env:` mapping in a YAML text, at any
 * nesting depth — workflow-level, job-level and step-level alike. Indentation
 * is the only structure needed: an `env:` line opens a block, and the block
 * ends at the first line indented no further than it.
 */
function parseEnvAssignments(text) {
  const out = [];
  let blockIndent = null;
  for (const raw of text.split('\n')) {
    if (isCommentLine(raw) || raw.trim() === '') continue;
    const indent = raw.length - raw.trimStart().length;
    if (blockIndent !== null) {
      if (indent > blockIndent) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(raw);
        if (m) {
          out.push({ key: m[1], value: m[2] });
          continue;
        }
      } else {
        blockIndent = null;
      }
    }
    if (/^\s*env:\s*$/.test(raw)) blockIndent = indent;
  }
  return out;
}

/**
 * The env names that carry a secret, transitively. `A: ${{ secrets.X }}` makes
 * A secret-derived; `B: ${{ env.A }}` then makes B secret-derived too. Run to a
 * fixpoint so a chain of indirections cannot launder a credential into a name
 * this file thinks is inert.
 */
function secretDerivedEnvKeys(text) {
  const assignments = parseEnvAssignments(text);
  const derived = new Set();
  for (let grew = true; grew; ) {
    grew = false;
    for (const { key, value } of assignments) {
      if (derived.has(key)) continue;
      if (/\bsecrets\./.test(value) || [...derived].some((k) => referencesName(value, k))) {
        derived.add(key);
        grew = true;
      }
    }
  }
  return derived;
}

/**
 * Every way this job can reach a credential, named. Empty array == no route
 * found, which is a claim about THIS scan and not a proof of safety.
 */
function credentialRoutes(body, secretEnvKeys) {
  const routes = [];
  // A job is a credential job because it USES a credential, not because its
  // prose mentions one. Comment lines are dropped first.
  const lines = body.split('\n').filter((line) => !isCommentLine(line));

  if (lines.some((line) => /\bsecrets\./.test(line))) {
    routes.push('a direct `secrets.` reference');
  }

  const inherited = [...secretEnvKeys].filter((k) => lines.some((line) => referencesName(line, k)));
  if (inherited.length > 0) {
    routes.push(
      '`env:` inheritance of secret-derived name(s) ' +
        `${inherited.join(', ')} ` +
        '(defined from `secrets.` in a workflow-level or job-level `env:` block)',
    );
  }

  const named = SUPABASE_CREDENTIAL_ENV_NAMES.filter((n) =>
    lines.some((line) => referencesName(line, n)),
  );
  if (named.length > 0) {
    routes.push(`reference(s) to the Supabase credential env var name(s) ${named.join(', ')}`);
  }

  if (lines.some((line) => /^\s*secrets:(\s|$)/.test(line))) {
    routes.push('a reusable-workflow call that passes `secrets:` (including `secrets: inherit`)');
  }

  const environmentLine = lines.find((line) => /^ {4}environment:/.test(line));
  if (environmentLine) {
    routes.push(
      `a deployment \`${environmentLine.trim()}\` declaration, which grants the job that ` +
        "environment's secrets whether or not any step names one",
    );
  }

  return routes;
}

/**
 * Split a workflow's `jobs:` mapping into { id -> body } using indentation.
 * Job ids sit at exactly two spaces of indent under a top-level `jobs:` key.
 */
function splitJobs(text) {
  const jobs = new Map();
  let inJobs = false;
  let current = null;
  for (const line of text.split('\n')) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) {
      inJobs = false;
      current = null;
      continue;
    }
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) {
      current = m[1];
      jobs.set(current, []);
      continue;
    }
    if (current) jobs.get(current).push(line);
  }
  return new Map([...jobs].map(([k, v]) => [k, v.join('\n')]));
}

// THE LIST MUST BE A LIST, AND MUST NOT BE EMPTY.
//
// Everything below reads REQUIRED_CREDENTIAL_JOBS as the authority. Emptying it
// would turn "every declared credential job runs the guard" into a statement
// about no jobs — true, vacuous, green. Deleting one entry is a legal diff a
// reviewer must see (docs/ci/README.md lists it under what to look for); an
// empty or malformed list is not a judgement call and fails here.
const badJobIds = REQUIRED_CREDENTIAL_JOBS.filter(
  (id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id),
);
const duplicateJobIds = REQUIRED_CREDENTIAL_JOBS.filter(
  (id, i) => REQUIRED_CREDENTIAL_JOBS.indexOf(id) !== i,
);
let credentialListUsable = true;
if (!Array.isArray(REQUIRED_CREDENTIAL_JOBS) || REQUIRED_CREDENTIAL_JOBS.length === 0) {
  credentialListUsable = false;
  problem(
    'REQUIRED_CREDENTIAL_JOBS in .github/scripts/assert-ci-scripts.mjs is empty or is not an array. ' +
      'It is the AUTHORITY on which jobs must run ' +
      `${PROD_GUARD_PATH}; with nothing in it, "every credential job runs the guard" is a claim about ` +
      'no jobs at all and passes vacuously while the credential jobs run unguarded. Restore the job ids.',
  );
} else if (badJobIds.length > 0 || duplicateJobIds.length > 0) {
  credentialListUsable = false;
  problem(
    'REQUIRED_CREDENTIAL_JOBS in .github/scripts/assert-ci-scripts.mjs could not be read as a list of ' +
      `job ids (bad: ${badJobIds.join(', ') || 'none'}; duplicated: ${duplicateJobIds.join(', ') || 'none'}). ` +
      'An entry that cannot match a job id is an entry that silently checks nothing.',
  );
}

const liveDbPath = join(REPO_ROOT, LIVE_DB_WORKFLOW);
if (!existsSync(liveDbPath)) {
  problem(
    `${LIVE_DB_WORKFLOW} is missing. It is the only workflow that runs with database credentials, and ` +
      'the only place the Supabase project allowlist is applied. Its deletion would remove every live-DB ' +
      'check at once, silently.',
  );
} else if (credentialListUsable) {
  const liveDbText = readFileSync(liveDbPath, 'utf8');
  const jobs = splitJobs(liveDbText);
  const secretEnvKeys = secretDerivedEnvKeys(liveDbText);

  if (jobs.size === 0) {
    problem(
      `Could not parse any jobs out of ${LIVE_DB_WORKFLOW}, so neither half of the credential-job rule ` +
        'can be evaluated and both would otherwise pass vacuously: no declared job could be checked for ' +
        `its ${PROD_GUARD} call, and no undeclared job could be caught touching credentials. ` +
        'Re-derive this parser.',
    );
  }

  // ── Direction 1: every DECLARED credential job exists and RUNS the guard. ──
  const guardedJobs = [];
  for (const required of REQUIRED_CREDENTIAL_JOBS) {
    if (!jobs.has(required)) {
      problem(
        `${LIVE_DB_WORKFLOW} no longer defines the job '${required}', which REQUIRED_CREDENTIAL_JOBS in ` +
          '.github/scripts/assert-ci-scripts.mjs declares to be a credential job. That job carried live-DB ' +
          'coverage and the Supabase allowlist call. If it was deliberately removed or renamed, update ' +
          'REQUIRED_CREDENTIAL_JOBS in the same PR and say why — do not let the set of guarded jobs shrink ' +
          'silently.',
      );
      continue;
    }

    const body = jobs.get(required);
    const guardSites = body
      .split('\n')
      .filter((line) => runsScriptInRunPosition(line, PROD_GUARD_PATH));

    if (guardSites.length > 0) {
      guardedJobs.push(required);
    } else {
      const mentionedOnly = body.includes(PROD_GUARD);
      problem(
        `${LIVE_DB_WORKFLOW} job '${required}' is a declared credential job but never RUNS ` +
          `${PROD_GUARD_PATH}. ` +
          (mentionedOnly
            ? 'It mentions the filename, but every occurrence is a comment or plain text rather than a ' +
              'run: step — and a comment naming a guard is not the guard. '
            : '') +
          'THIS IS A MISSING FAIL-FAST STEP, NOT A MISSING PROTECTION — say that accurately in review. ' +
          'The allowlist is enforced in the execution path: every entry point these jobs reach imports ' +
          'artifacts/api-server/src/lib/ciSupabaseGuard.mjs FIRST, which runs this same policy script ' +
          'before any client is constructed and before any query, and exits 2 if it refuses. So a job ' +
          'without this step does NOT run against whatever SUPABASE_URL happens to hold; it is refused at ' +
          'runtime instead. What the step buys is roughly 90 seconds — the same verdict before checkout ' +
          'costs, corepack, cache restore and `pnpm install` are paid for, and a clearer place to read it. ' +
          'Restore it: `- name: Preflight — Supabase target must be the sanctioned CI project` running ' +
          `\`bash ${PROD_GUARD_PATH}\`. If it was removed on purpose, say why in the PR — and note that ` +
          'removing the in-process import from an entry point is the edit that WOULD remove the ' +
          'protection. See docs/ci/README.md.',
      );
    }

    // The detector must not be allowed to go blind unnoticed. If a job the repo
    // DECLARES to be credential-bearing shows no credential route at all, then
    // either the routes below have stopped seeing how credentials reach these
    // jobs — in which case direction 2 has stopped catching undeclared ones too
    // — or the job genuinely stopped touching the database, which is a change to
    // make on purpose, in this list.
    if (credentialRoutes(body, secretEnvKeys).length === 0) {
      problem(
        `${LIVE_DB_WORKFLOW} job '${required}' is declared in REQUIRED_CREDENTIAL_JOBS, but this preflight ` +
          'can no longer see ANY route by which it reaches a credential (no `secrets.` reference, no ' +
          'secret-derived `env:` name, no Supabase credential env var name, no `secrets:` pass-through, no ' +
          '`environment:`). One of two things is true, and both need a human: the credential now arrives by ' +
          'a route this scan does not model — in which case UNDECLARED credential jobs are no longer being ' +
          'caught either, and the routes in credentialRoutes() must be extended — or the job really has ' +
          'stopped touching the database, in which case remove it from REQUIRED_CREDENTIAL_JOBS and say so.',
      );
    }
  }

  // ── Direction 2: no UNDECLARED job may touch credentials, by any route. ────
  const declared = new Set(REQUIRED_CREDENTIAL_JOBS);
  const undeclared = [];
  for (const [id, body] of jobs) {
    if (declared.has(id)) continue;
    const routes = credentialRoutes(body, secretEnvKeys);
    if (routes.length === 0) continue;
    undeclared.push(id);
    problem(
      `${LIVE_DB_WORKFLOW} job '${id}' touches credentials but is NOT declared in ` +
        'REQUIRED_CREDENTIAL_JOBS in .github/scripts/assert-ci-scripts.mjs. Route(s) found: ' +
        `${routes.join('; ')}. ` +
        'The set of credential jobs is DECLARED, not inferred, precisely so that a job cannot join or ' +
        'leave it by accident: a job that takes its credentials through an `env:` block, a reusable ' +
        'workflow, a matrix or a renamed variable contains no literal `secrets.` of its own, and under the ' +
        'old derived rule it silently stopped being a credential job. This is the half of this rule that ' +
        'is still worth having: it is a SCOPE signal for review — a new job just acquired database ' +
        `credentials — not a claim that the database is unprotected. It is not: if '${id}' reaches ` +
        'Supabase through one of the api-server entry points, that process asserts the allowlist for ' +
        'itself and exits 2 on refusal, with no workflow step involved. (If it reaches Supabase some ' +
        'OTHER way — a raw `curl`, `psql`, the Supabase CLI, a third-party action — then nothing in this ' +
        'repository guards it, and that is the finding to act on.) ' +
        `Add '${id}' to REQUIRED_CREDENTIAL_JOBS AND add the ` +
        '`- name: Preflight — Supabase target must be the sanctioned CI project` step to the job, in the ' +
        'same PR. If this job genuinely cannot reach Supabase, say why in the PR and narrow the route ' +
        'that matched — do not delete the check.',
    );
  }

  notes.push(
    'SECONDARY DETECTOR (the allowlist itself is enforced in-process by ' +
      'artifacts/api-server/src/lib/ciSupabaseGuard.mjs, imported first by every entry point that can ' +
      'reach Supabase; the steps counted below are a fail-fast duplicate). ' +
      `Credential jobs in ${LIVE_DB_WORKFLOW} are DECLARED by REQUIRED_CREDENTIAL_JOBS, not inferred: ` +
      `${guardedJobs.length} of ${REQUIRED_CREDENTIAL_JOBS.length} declared job(s) verified as RUNNING ` +
      `${PROD_GUARD_PATH} (not merely mentioning it): ${guardedJobs.join(', ') || 'none'}. ` +
      `Undeclared jobs found touching credentials: ${undeclared.join(', ') || 'none'} ` +
      `(of ${jobs.size} job(s) parsed; secret-derived env names seen: ` +
      `${[...secretEnvKeys].sort().join(', ') || 'none'}).`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Assert each triple.
// ─────────────────────────────────────────────────────────────────────────────
const rows = [];
for (const { dir, name, script, sites } of [...triples.values()].sort((a, b) =>
  `${a.dir}${a.script}`.localeCompare(`${b.dir}${b.script}`),
)) {
  const pkgPath = join(REPO_ROOT, dir, 'package.json');
  const where = sites.join(', ');

  if (!existsSync(pkgPath)) {
    problem(`package directory '${dir}' has no package.json (referenced at ${where}).`);
    rows.push([dir, name, script, 'NO package.json']);
    continue;
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    problem(`${dir}/package.json is unparseable: ${err.message} (referenced at ${where}).`);
    rows.push([dir, name, script, 'UNPARSEABLE']);
    continue;
  }

  let status = 'ok';
  if (pkg.name !== name) {
    problem(
      `package-name mismatch: ${dir}/package.json declares '${pkg.name}', ` +
        `but CI names it '${name}' (at ${where}). A rename that CI did not follow means the step ` +
        'selects nothing — which the old selector form scored as a pass.',
    );
    status = `NAME IS '${pkg.name}'`;
  }

  const body = (pkg.scripts ?? {})[script];
  if (typeof body !== 'string' || body.trim() === '') {
    problem(
      `script '${script}' is not defined in ${dir}/package.json (referenced at ${where}). ` +
        `Defined scripts: ${Object.keys(pkg.scripts ?? {}).sort().join(', ') || '(none)'}`,
    );
    status = status === 'ok' ? 'MISSING SCRIPT' : `${status} + MISSING SCRIPT`;
  }

  rows.push([dir, name, script, status]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Assert what `pnpm -r run typecheck` actually covers.
// ─────────────────────────────────────────────────────────────────────────────
function workspaceMemberDirs() {
  const wsPath = join(REPO_ROOT, 'pnpm-workspace.yaml');
  if (!existsSync(wsPath)) {
    problem('pnpm-workspace.yaml is missing; workspace membership cannot be established.');
    return [];
  }
  const text = readFileSync(wsPath, 'utf8');
  const globs = [];
  let inPackages = false;
  for (const line of text.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = /^\s+-\s+['"]?([^'"\s#]+)['"]?\s*$/.exec(line);
      if (m) {
        globs.push(m[1]);
        continue;
      }
      if (/^\S/.test(line)) inPackages = false;
    }
  }
  const dirs = [];
  for (const glob of globs) {
    if (glob.endsWith('/*')) {
      const parent = join(REPO_ROOT, glob.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(join(glob.slice(0, -2), entry.name));
      }
    } else if (existsSync(join(REPO_ROOT, glob)) && statSync(join(REPO_ROOT, glob)).isDirectory()) {
      dirs.push(glob);
    }
  }
  return dirs.sort();
}

const withTypecheck = [];
const withoutTypecheck = [];
for (const dir of workspaceMemberDirs()) {
  const pkgPath = join(REPO_ROOT, dir, 'package.json');
  if (!existsSync(pkgPath)) continue;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    continue;
  }
  const body = (pkg.scripts ?? {}).typecheck;
  const entry = { dir, name: pkg.name ?? dir };
  if (typeof body === 'string' && body.trim() !== '') withTypecheck.push(entry);
  else withoutTypecheck.push(entry);
}

const covered = new Set(withTypecheck.map((e) => e.name));
for (const required of REQUIRED_RECURSIVE_TYPECHECK) {
  if (!covered.has(required)) {
    problem(
      `'${required}' no longer defines a 'typecheck' script, so the root 'pnpm -r run typecheck' ` +
        'no longer typechecks it — and a recursive run does not fail when a member drops out. ' +
        'Either restore the script or update REQUIRED_RECURSIVE_TYPECHECK in ' +
        '.github/scripts/assert-ci-scripts.mjs and the coverage claims in ' +
        'unwired-checks.yml and docs/ci/README.md, in the same PR.',
    );
  }
}
const extra = withTypecheck.map((e) => e.name).filter((n) => !REQUIRED_RECURSIVE_TYPECHECK.includes(n));
if (extra.length > 0) {
  notes.push(
    `Also covered by the recursive typecheck (not in the required list): ${extra.join(', ')}. ` +
      'Consider adding them to REQUIRED_RECURSIVE_TYPECHECK so their coverage cannot be lost silently.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Report.
// ─────────────────────────────────────────────────────────────────────────────
function table(header, body) {
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const row of body) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

const scriptTable = table(
  ['package dir', 'package name', 'script', 'status'],
  rows.map((r) => [`\`${r[0]}\``, `\`${r[1]}\``, `\`${r[2]}\``, r[3]]),
);

const typecheckTable = table(
  ['workspace member', 'defines `typecheck`?'],
  [
    ...withTypecheck.map((e) => [`\`${e.name}\` (${e.dir})`, 'yes']),
    ...withoutTypecheck.map((e) => [`\`${e.name}\` (${e.dir})`, '**no — not covered**']),
  ],
);

console.log('');
console.log('CI package-script preflight');
console.log('===========================');
console.log('');
console.log(scriptTable);
console.log('');
console.log('Root `pnpm -r run typecheck` real coverage:');
console.log('');
console.log(typecheckTable);
for (const n of notes) console.log(`\nNOTE: ${n}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      '### CI package-script preflight',
      '',
      'Every `(package directory, package name, script)` triple named under `.github/`,',
      'asserted against `package.json` on disk before any job installs anything.',
      'The workspace-selector form of `pnpm run` exits 0 when it matches nothing, so a',
      'renamed package or a deleted script used to report success. It cannot now.',
      '',
      scriptTable,
      '',
      '#### What `pnpm -r run typecheck` actually covers',
      '',
      typecheckTable,
      '',
      ...notes.map((n) => `> ${n}`),
      '',
    ].join('\n'),
  );
}

if (problems.length > 0) {
  console.error('');
  console.error(`${problems.length} problem(s) found. A CI step that names a package or script that`);
  console.error('does not exist runs nothing — and the selector form scored that as a pass for');
  console.error('months. Fix the workflow or restore the script.');
  process.exit(1);
}

console.log('');
console.log(`All ${rows.length} CI package-script invocation(s) verified against package.json on disk.`);
