#!/usr/bin/env node
//
// check-unrunnable-tests.mjs — test files in travel-buddy-standalone that no
// runner CI invokes will ever execute. Green by absence.
//
// THIS GUARD IS NOT EXHAUSTIVE, AND SAYS SO IN ITS OWN OUTPUT.
//
// It covers exactly two classes. The precise limits are printed on every run
// and repeated in docs/ci/README.md. An earlier version covered only class A
// and its three findings were presented as the complete set; they were not.
//
//   CLASS A — a *.test.ts OR *.test.tsx under src/, app/ or server/ that no
//     configured runner matches. Rather than a hardcoded shape, this is now
//     computed by evaluating each file against all three runners' real rules:
//
//     * scripts/run-node-tests.mjs: ROOTS = ['src', 'server'] — it walks those
//       two directories ONLY — skips src/test, takes names ending `.test.ts`,
//       and excludes names containing `.component.test.`
//     * `test:component` -> jest.config.js testMatch src/** and app/** ONLY,
//       further filtered to --testPathPattern='\.component\.test\.'
//     * jest.web.config.js: *.webrender.test.* under src/** and app/** only
//
//     THE PREMISE THIS GUARD USED TO STATE WAS WRONG, AND THE ERROR WAS NOT
//     COSMETIC. It said node:test "discovers only names ending .test.ts",
//     and concluded from that that the unrunnable shape was `.test.tsx`. But
//     the suffix is the SECOND filter; the first is ROOTS, and app/ is not in
//     it. run-node-tests.mjs never walks app/ at all. So an
//     `app/**/foo.test.ts` is discovered by node:test (wrong directory),
//     rejected by test:component (not `.component.test.`) and rejected by
//     jest.web (not `.webrender.test.`) — matched by nothing, and matched by
//     no version of this guard before now either, because the old class A
//     only ever looked at `.test.tsx`. The symmetric hole existed on the other
//     side: jest's roots are src/ and app/, so anything under server/ that
//     node:test does not take — a `server/**/*.test.tsx`, or a
//     `server/**/*.component.test.ts` — was likewise invisible.
//
//   CLASS B — anything under src/test/. BOTH configured runners exclude that
//     directory outright:
//     * scripts/run-node-tests.mjs: `if (full === 'src/test') continue;`
//     * jest.config.js: testPathIgnorePatterns includes '<rootDir>/src/test/'
//     A file there runs only if some package.json script names it explicitly.
//     Sub-classified:
//       B1 no package.json script names the file  -> runnable by NOTHING.
//       B2 a script names it, but scripts/run-all-checks.sh (the `check:all`
//          that CI runs) never invokes that script -> runnable only by a human
//          who remembers to type it. That is the pre-CI status quo this whole
//          effort exists to remove, so it is a finding, not an exemption.
//
// WHAT THIS GUARD DOES **NOT** COVER — do not read a green run as "every test
// in this tree runs":
//   * the KNOWN_BROKEN list in scripts/run-node-tests.mjs (documented,
//     deliberate exclusions with recorded reasons). Growth there is caught
//     instead by the node:test discovery floor in ci.yml, which drops when an
//     entry is added.
//   * jest testPathIgnorePatterns entries other than src/test and .webrender
//     (currently src/services/__tests__/fsqPhotoLookup.test.ts, which IS run by
//     run-node-tests.mjs, so it is not orphaned).
//   * artifacts/api-server — covered separately by check:test-registration, its
//     ghost-path assertion, and the registered-file floor in ci.yml.
//   * e2e/maestro flows — no package.json script invokes them and CI runs no
//     device tests at all. Out of scope by design, not by oversight.
//   * a file that IS executed but whose assertions are vacuous. No static check
//     can see that.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const TREE = join(REPO_ROOT, 'travel-buddy-standalone');

const failures = [];
function fail(msg) {
  failures.push(msg);
  console.error(`::error::${msg}`);
}

function read(relPath) {
  const full = join(TREE, relPath);
  if (!existsSync(full)) return null;
  return readFileSync(full, 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// KNOWN OUTSTANDING DEBT. A file appearing here is already-reported; a file
// NOT here fails the build. A baselined file that is fixed or deleted must be
// removed from this list, so the baseline cannot quietly become permanent.
// The class is part of the key: if a file moves between classes, the reason it
// is unrunnable changed, and this list must be re-read rather than assumed.
// ─────────────────────────────────────────────────────────────────────────────
const BASELINE = [
  // 2026-09-03: MapCarousel.cardHeight and MapEntityActionRow were renamed to
  // *.component.test.tsx so jest actually runs them. Un-orphaning them exposed
  // four real failures in MapEntityActionRow, which had never executed once.
  ['A', 'src/services/__tests__/livekitBridge.activeSpeakers.test.tsx'],
  // Class B, found when this guard was widened. Both live under src/test/,
  // which run-node-tests.mjs and jest each exclude wholesale.
  ['B1', 'src/test/compassComponents.test.ts'],
  ['B2', 'src/test/stampGracefulDegradation.test.ts'],
];

// ─────────────────────────────────────────────────────────────────────────────
// PREMISES. Each class above is only a real finding while the runner config
// still works the way it did when this guard was written. If a premise stops
// holding, the guard's reasoning is stale — that is a failure requiring a human
// to re-derive it, not something to shrug at.
// ─────────────────────────────────────────────────────────────────────────────
const pkgRaw = read('package.json');
if (pkgRaw === null) fail('travel-buddy-standalone/package.json not found.');
const pkg = pkgRaw ? JSON.parse(pkgRaw) : { scripts: {} };
const scripts = pkg.scripts ?? {};

const runner = read('scripts/run-node-tests.mjs');
const jestConfig = read('jest.config.js');
const jestWebConfig = read('jest.web.config.js');
const runAllChecks = read('scripts/run-all-checks.sh');

if (runner === null) fail('travel-buddy-standalone/scripts/run-node-tests.mjs not found.');
if (jestConfig === null) fail('travel-buddy-standalone/jest.config.js not found.');
if (runAllChecks === null) fail('travel-buddy-standalone/scripts/run-all-checks.sh not found.');

if (runner && !/===\s*['"]src\/test['"]/.test(runner)) {
  fail(
    "run-node-tests.mjs no longer skips the src/test directory (`if (full === 'src/test') continue;` is gone). " +
      'That skip is the premise for CLASS B. Re-derive this guard against the new discovery rules ' +
      'and update .github/scripts/check-unrunnable-tests.mjs.',
  );
}
if (runner && !/\.test\.ts['"]\s*\)/.test(runner) && !/endsWith\(\s*['"]\.test\.ts['"]/.test(runner)) {
  fail(
    'run-node-tests.mjs no longer discovers by the `.test.ts` suffix. That suffix rule is one half of the ' +
      'CLASS A premise. Re-derive this guard.',
  );
}

// ── THE OTHER HALF OF THE CLASS A PREMISE, AND THE ONE THAT WAS MISSED. ──────
// The suffix filter only ever applies to directories the walker actually
// enters. `const ROOTS = ['src', 'server'];` is the real first filter, and its
// omission is what let app/**/*.test.ts fall through every version of this
// guard. Read it out of source; never assume it.
const NODE_TEST_ROOTS = (() => {
  const m = runner ? /const\s+ROOTS\s*=\s*\[([^\]]*)\]/.exec(runner) : null;
  if (!m) {
    fail(
      'Could not read `const ROOTS = [...]` out of scripts/run-node-tests.mjs. That array is the FIRST ' +
        'discovery filter — the suffix rule only applies to directories the walker enters — and CLASS A ' +
        'is derived from it. Without it this guard would be reasoning from an assumed set of roots, which ' +
        'is exactly the defect being fixed here. Re-derive this guard.',
    );
    return [];
  }
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
})();

for (const expected of ['src', 'server']) {
  if (NODE_TEST_ROOTS.length > 0 && !NODE_TEST_ROOTS.includes(expected)) {
    fail(
      `run-node-tests.mjs's ROOTS no longer includes '${expected}' (it is now [${NODE_TEST_ROOTS.join(', ')}]). ` +
        'Every .test.ts under that directory just stopped being executed by node:test, silently — a ' +
        'recursive discovery walk does not complain about a root it was not given. Re-derive this guard.',
    );
  }
}

// jest.config.js's testMatch roots. The mirror image of the above: jest covers
// src/ and app/, so anything under server/ that node:test does not take is
// covered by nothing.
const JEST_ROOTS = ['src', 'app'].filter((r) =>
  jestConfig ? new RegExp(`<rootDir>/${r}/\\*\\*`).test(jestConfig) : false,
);
for (const expected of ['src', 'app']) {
  if (jestConfig && !JEST_ROOTS.includes(expected)) {
    fail(
      `jest.config.js's testMatch no longer includes '<rootDir>/${expected}/**'. CLASS A is computed from ` +
        'which runner covers which root; if jest stopped covering that tree, every non-node:test file in ' +
        'it became unrunnable and this guard must be re-derived rather than left reporting the old set.',
    );
  }
}
if (jestConfig && /<rootDir>\/server\/\*\*/.test(jestConfig)) {
  fail(
    "jest.config.js's testMatch now includes '<rootDir>/server/**'. That is a WIDENING of coverage and a " +
      'good thing, but CLASS A currently treats server/ as jest-uncovered. Re-derive this guard so it does ' +
      'not report files that now do run.',
  );
}
if (jestConfig && !/<rootDir>\/src\/test\//.test(jestConfig)) {
  fail(
    "jest.config.js no longer lists '<rootDir>/src/test/' in testPathIgnorePatterns. That exclusion is " +
      'the second half of the CLASS B premise. Re-derive this guard.',
  );
}
if (typeof scripts['test:component'] === 'string' && !/\\\.component\\\.test\\\./.test(scripts['test:component'])) {
  fail(
    "the `test:component` script no longer filters on --testPathPattern='\\.component\\.test\\.'. That " +
      'filter is the premise for CLASS A. Re-derive this guard.',
  );
}
if (jestWebConfig && !/webrender\.test\./.test(jestWebConfig)) {
  fail('jest.web.config.js no longer matches *.webrender.test.* — CLASS A premise stale. Re-derive this guard.');
}

// Which scripts does `check:all` actually run? Parse the run_check lines.
const checkAllScripts = new Set();
for (const m of (runAllChecks ?? '').matchAll(/run_check\s+"[^"]*"\s+pnpm\s+run\s+([^\s]+)/g)) {
  checkAllScripts.add(m[1]);
}
if (checkAllScripts.size === 0 && runAllChecks) {
  fail(
    'Could not parse any `run_check ... pnpm run <script>` lines out of scripts/run-all-checks.sh, so this ' +
      'guard cannot tell which scripts CI actually runs and cannot classify B1 vs B2. Re-derive this guard.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery.
// ─────────────────────────────────────────────────────────────────────────────
function walk(relDir, out = []) {
  const abs = join(TREE, relDir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

// server/ is walked as well as src/ and app/. It is a node:test root, so most
// of what is in it runs — but it is NOT a jest root, so anything there that
// node:test declines (a .test.tsx, or a .component.test.ts) is caught by
// nothing, and the previous two-directory walk could not see it.
const allFiles = [...walk('src'), ...walk('app'), ...walk('server')].sort();

const TEST_FILE = /\.test\.tsx?$/;
const rootOf = (f) => f.split('/')[0];

// ─────────────────────────────────────────────────────────────────────────────
// The three runners, each expressed as the rule its own config states. A file
// matched by none of them is unrunnable. Deriving it this way — instead of
// hardcoding "a .test.tsx" — is what makes app/**/*.test.ts a finding.
//
// KNOWN_BROKEN is deliberately NOT applied to nodeTestDiscovers: those files
// ARE discovered and then excluded on purpose, with recorded reasons, and are
// guarded by ci.yml's discovery floor instead. See the limits printed below.
// ─────────────────────────────────────────────────────────────────────────────
function nodeTestDiscovers(f) {
  if (!NODE_TEST_ROOTS.includes(rootOf(f))) return false; // ROOTS = ['src','server']
  if (f.startsWith('src/test/')) return false; // `if (full === 'src/test') continue;`
  const base = f.slice(f.lastIndexOf('/') + 1);
  if (!base.endsWith('.test.ts')) return false; // .tsx is not discovered
  if (base.includes('.component.test.')) return false; // handed to jest instead
  return true;
}

function jestNativeRuns(f) {
  if (!JEST_ROOTS.includes(rootOf(f))) return false; // testMatch: src/**, app/**
  if (!TEST_FILE.test(f)) return false;
  if (f.startsWith('src/test/')) return false; // testPathIgnorePatterns
  if (f.includes('.webrender.test.')) return false; // testPathIgnorePatterns
  return f.includes('.component.test.'); // test:component's --testPathPattern
}

function jestWebRuns(f) {
  if (!JEST_ROOTS.includes(rootOf(f))) return false;
  return /\.webrender\.test\.tsx?$/.test(f);
}

/** @type {{cls:string, path:string, detail:string}[]} */
const found = [];

// CLASS A — matched by no runner.
for (const f of allFiles) {
  if (!TEST_FILE.test(f)) continue;
  if (f.startsWith('src/test/')) continue; // classified as B below
  if (nodeTestDiscovers(f) || jestNativeRuns(f) || jestWebRuns(f)) continue;

  // Say WHICH rule excluded it from each runner, so the fix is obvious from
  // the annotation without anyone re-reading three config files.
  const root = rootOf(f);
  const reasons = [];
  reasons.push(
    NODE_TEST_ROOTS.includes(root)
      ? f.endsWith('.test.tsx')
        ? 'node:test discovery takes only names ending .test.ts'
        : 'node:test discovery excludes names containing .component.test.'
      : `node:test discovery never walks ${root}/ — run-node-tests.mjs ROOTS is [${NODE_TEST_ROOTS.join(', ')}]`,
  );
  reasons.push(
    JEST_ROOTS.includes(root)
      ? "test:component filters to --testPathPattern='\\.component\\.test\\.'"
      : `jest.config.js testMatch never covers ${root}/ (it lists ${JEST_ROOTS.map((r) => `${r}/**`).join(' and ')})`,
  );
  reasons.push('jest.web.config.js matches only *.webrender.test.*');

  found.push({ cls: 'A', path: f, detail: `matched by no runner — ${reasons.join('; ')}` });
}

// CLASS B
for (const f of allFiles) {
  if (!f.startsWith('src/test/')) continue;
  if (!/\.test\.tsx?$/.test(f)) continue;

  const namingScripts = Object.entries(scripts)
    .filter(([, body]) => typeof body === 'string' && body.includes(f))
    .map(([name]) => name);

  if (namingScripts.length === 0) {
    found.push({
      cls: 'B1',
      path: f,
      detail: 'under src/test/ (excluded by both runners) and named by no package.json script — runs nowhere',
    });
    continue;
  }

  const inCheckAll = namingScripts.filter((s) => checkAllScripts.has(s));
  if (inCheckAll.length === 0) {
    found.push({
      cls: 'B2',
      path: f,
      detail: `under src/test/ (excluded by both runners); named only by ${namingScripts
        .map((s) => `\`${s}\``)
        .join(', ')}, which scripts/run-all-checks.sh never invokes — runs only when a human types it`,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compare against the baseline.
// ─────────────────────────────────────────────────────────────────────────────
const key = (cls, path) => `${cls} ${path}`;
const foundKeys = new Set(found.map((f) => key(f.cls, f.path)));
const baselineKeys = new Set(BASELINE.map(([cls, path]) => key(cls, path)));

const isNew = found.filter((f) => !baselineKeys.has(key(f.cls, f.path)));
const gone = [...baselineKeys].filter((k) => !foundKeys.has(k));

const LIMITS = [
  'This guard covers TWO classes only:',
  '  A  a *.test.ts / *.test.tsx under src/, app/ or server/ that is matched by NONE of the three',
  `     runners, evaluated against their real rules: node:test roots [${NODE_TEST_ROOTS.join(', ')}]`,
  `     + suffix .test.ts + not .component.test.; jest native roots [${JEST_ROOTS.join(', ')}] filtered`,
  '     to .component.test.; jest web *.webrender.test.*. NOTE that node:test does NOT walk app/ and',
  '     jest does NOT cover server/, so app/**/*.test.ts and server/**/*.test.tsx are findings.',
  '  B  anything under src/test/, which run-node-tests.mjs and jest.config.js both exclude wholesale',
  '     (B1 = named by no script at all; B2 = named only by a script that check:all never invokes).',
  '',
  'It does NOT cover, and a green result here does NOT mean these are fine:',
  '  * the KNOWN_BROKEN exclusions in scripts/run-node-tests.mjs (deliberate, documented; growth is',
  '    caught by the node:test discovery floor in ci.yml, not here)',
  '  * other jest testPathIgnorePatterns entries',
  '  * artifacts/api-server (covered by check:test-registration and the registered-file floor)',
  '  * e2e/maestro flows, which no script invokes and which CI deliberately does not run',
  '  * tests that DO run but assert nothing meaningful',
];

const knownBrokenCount = runner
  ? new Set([...runner.matchAll(/^\s*'([^']+\.test\.tsx?)',\s*$/gm)].map((m) => m[1])).size
  : 0;

console.log('Unrunnable / never-invoked test files in travel-buddy-standalone');
console.log('================================================================');
console.log('');
if (found.length === 0) console.log('(none found)');
for (const f of found) console.log(`  [${f.cls}] ${f.path}\n        ${f.detail}`);
console.log('');
console.log('Baselined as known outstanding debt:');
for (const [cls, path] of BASELINE) console.log(`  [${cls}] ${path}`);
console.log('');
console.log(`For context (NOT checked here): scripts/run-node-tests.mjs excludes ${knownBrokenCount} unique`);
console.log("KNOWN_BROKEN file(s) from node:test discovery. Those don't run either; they are deliberate,");
console.log("documented exclusions and are guarded by ci.yml's discovery floor instead.");
console.log('');
console.log(LIMITS.join('\n'));

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      '### Unrunnable / never-invoked test files (travel-buddy-standalone)',
      '',
      '| class | file | why it never runs |',
      '| --- | --- | --- |',
      ...(found.length
        ? found.map((f) => `| ${f.cls} | \`${f.path}\` | ${f.detail} |`)
        : ['| — | (none found) | — |']),
      '',
      'These are **known outstanding debt**, baselined in',
      '`.github/scripts/check-unrunnable-tests.mjs`. A file not on the baseline fails the build;',
      'a baselined file that is fixed or deleted must be removed from the list.',
      '',
      '> **This list is NOT the complete set of tests that do not run.**',
      '',
      '```',
      ...LIMITS,
      '```',
      '',
    ].join('\n'),
  );
}

if (isNew.length > 0) {
  console.error('');
  for (const f of isNew) {
    fail(
      `[${f.cls}] ${f.path} will never be executed by any runner CI invokes (${f.detail}). ` +
        'Bring it under a runner — rename to *.component.test.tsx under src/ or app/ (jest native), ' +
        '*.webrender.test.tsx under src/ or app/ (jest web), or *.test.ts under src/ or server/ and ' +
        'outside src/test/ (node:test discovery) — or, if it genuinely belongs in src/test/, wire its ' +
        'script into travel-buddy-standalone/scripts/run-all-checks.sh. Note the roots are not ' +
        'interchangeable: a *.test.ts under app/ is discovered by nothing, because run-node-tests.mjs ' +
        'walks only src/ and server/.',
    );
  }
}

if (gone.length > 0) {
  console.error('');
  for (const k of gone) {
    fail(
      `Baselined entry "${k}" is no longer reported — the file was fixed, deleted, reclassified, or the ` +
        'runner config changed. Remove or update it in the BASELINE list in ' +
        '.github/scripts/check-unrunnable-tests.mjs so the baseline cannot outlive the debt it records.',
    );
  }
}

if (failures.length > 0) {
  console.error('');
  console.error(`${failures.length} problem(s). See the annotations above.`);
  process.exit(1);
}

console.log('');
console.log(`OK: ${found.length} known unrunnable file(s), all baselined; no new ones.`);
