#!/usr/bin/env node
/**
 * Test-fixture shape guard — fails when a test fixture claims to be a type it
 * is not.
 *
 * WHY THIS EXISTS (2026-09-03)
 * ----------------------------
 * `tsconfig.json` excludes `**\/*.test.ts` and `**\/*.test.tsx` from the
 * typecheck. Test fixtures therefore get NO compiler help, and the same failure
 * has now recurred six times in this repo: a fixture invents a field the DTO
 * never had, the code under test reads it, and the assertion passes because the
 * fixture and the consumer agree with each other while both disagree with the
 * producer.
 *
 * Confirmed instances: `buddy.headline` (BuddyProfile has `tagline`),
 * `trip.destination` (TripRow has `destinationCity`), `loc.displayName` /
 * `loc.handle` (CircleMemberLocation has `name`), `g.thumbnail_url`
 * (hidden_gems has `image_url`), plus `claimType: "crowd"` and the singular
 * search types before them.
 *
 * WHAT IT CHECKS
 * --------------
 * `tsconfig.tests.json` puts the test files back into a program (with ambient
 * test-runner globals from scripts/types/test-globals.d.ts, so the run is not
 * drowned in ~15,000 "Cannot find name 'describe'"). From that program's
 * diagnostics this guard keeps ONLY the object-literal shape family:
 *
 *   TS2353  object literal specifies a property the target type does not have
 *   TS2561  ...the same, with a spelling suggestion
 *   TS2739  object literal is missing several required properties
 *   TS2741  object literal is missing one required property
 *   TS2352  a cast between insufficiently-overlapping types — but ONLY when the
 *           SOURCE is an anonymous object literal. `x as Record<string, unknown>`
 *           on a named interface is a normal test idiom, not a bad fixture.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK
 * -----------------------------------
 * Everything else `tsconfig.tests.json` reports — implicit anys, RN prop
 * variance, matcher signatures (~245 diagnostics today). Those are real debt,
 * but gating on them would be a different and much larger project, and mixing
 * them in here would bury the class this guard exists for. Running
 * `tsc -p tsconfig.tests.json` by hand shows them all; this guard is silent
 * about them BY DESIGN, and a green result here does not mean the test files
 * typecheck.
 *
 * WHERE THE OTHER HALF OF THE COVERAGE LIVES
 * -------------------------------------------
 * This guard looks at `*.test.ts(x)` files ONLY. Fixtures that live in a normal
 * module — `src/__fixtures__/mapEntities.ts`, for instance — are already in
 * `tsconfig.json`'s program, so `pnpm run typecheck` fails on them directly and
 * with stricter rules. Both run under `check:all`, so the two halves together
 * cover every fixture; neither alone does. That is also the argument for putting
 * new fixtures in a normal module and building them from the real producer
 * rather than writing literals inside a test.
 *
 * `tsc` exits non-zero because of those other diagnostics. That is expected:
 * this script reads tsc's OUTPUT and ignores its exit code, and instead fails
 * loudly if tsc produced no parseable output at all — a guard that silently
 * passes when its analysis did not run is the failure it exists to prevent.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'scripts', 'TEST_FIXTURE_SHAPE_BASELINE.json');
const TSCONFIG = 'tsconfig.tests.json';

/** The object-literal shape family. See the header for why each is here. */
const SHAPE_CODES = new Set(['2353', '2561', '2739', '2741']);
/** TS2352 qualifies only when the source is an anonymous object literal. */
const CAST_CODE = '2352';

function fail(msg) {
  console.error(`\n✘ check:test-fixture-shapes — ${msg}\n`);
  process.exit(1);
}

// ── Preconditions. A guard whose inputs moved has not run; it has lied. ───────

if (!existsSync(join(ROOT, TSCONFIG))) {
  fail(`${TSCONFIG} not found. It is the program this guard analyses.`);
}
if (!existsSync(join(ROOT, 'scripts', 'types', 'test-globals.d.ts'))) {
  fail(
    'scripts/types/test-globals.d.ts not found. Without it the tsc run is ~15,000 ' +
      '"Cannot find name \'describe\'" errors and the real findings are unfindable.',
  );
}
const appTsconfig = readFileSync(join(ROOT, 'tsconfig.json'), 'utf8');
if (!/"\*\*\/\*\.test\.tsx?"/.test(appTsconfig)) {
  fail(
    'tsconfig.json no longer excludes **/*.test.ts(x). That exclusion is the PREMISE for this ' +
      'guard — if tests are now in the main typecheck, delete this script and tsconfig.tests.json ' +
      'rather than running both.',
  );
}

const tsc = join(ROOT, 'node_modules', '.bin', 'tsc');
if (!existsSync(tsc)) fail('node_modules/.bin/tsc not found — run pnpm install.');

// ── Run ───────────────────────────────────────────────────────────────────────

const res = spawnSync(tsc, ['-p', TSCONFIG, '--noEmit', '--pretty', 'false'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

if (res.error) fail(`could not run tsc: ${res.error.message}`);

const DIAG = /^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/;
const all = output
  .split('\n')
  .map((l) => DIAG.exec(l.trimEnd()))
  .filter(Boolean)
  .map((m) => ({ file: m[1], line: Number(m[2]), code: m[4], message: m[5] }));

// tsc is EXPECTED to report other diagnostics. Zero parsed lines means the run
// did not happen (bad config, crash) — not that the tree is clean.
if (all.length === 0) {
  fail(
    'tsc produced no parseable diagnostics at all. That is not "clean": this program has ~245 ' +
      `known non-shape diagnostics. Something stopped the run.\n--- tsc output ---\n${output.slice(0, 4000)}`,
  );
}

const isTestFile = (f) => /\.test\.tsx?$/.test(f);
/** TS2352's source type is the text between the first pair of quotes. */
const castSourceIsLiteral = (msg) => /^Conversion of type '\{/.test(msg);

const findings = all.filter(
  (d) =>
    isTestFile(d.file) &&
    (SHAPE_CODES.has(d.code) || (d.code === CAST_CODE && castSourceIsLiteral(d.message))),
);

// ── Compare against the baseline ─────────────────────────────────────────────
//
// Keyed by file + code, NOT by line: line numbers churn on every edit, and a
// baseline that churns is a baseline nobody keeps honest. Counts are compared so
// a new occurrence in an already-listed file is still caught.

const key = (d) => `${d.file}|TS${d.code}`;
const counts = new Map();
for (const d of findings) counts.set(key(d), (counts.get(key(d)) ?? 0) + 1);

const baseline = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).entries ?? {}
  : {};

const problems = [];
for (const [k, n] of [...counts].sort()) {
  const allowed = baseline[k] ?? 0;
  if (n > allowed) {
    problems.push(
      `NEW  ${k} — ${n} finding(s), baselined ${allowed}\n` +
        findings
          .filter((d) => key(d) === k)
          .map((d) => `       ${d.file}:${d.line}  TS${d.code}: ${d.message}`)
          .join('\n'),
    );
  }
}
// A baseline entry that no longer reproduces is also an error: debt records must
// not outlive the debt. Same rule as ORPHANED_TESTS_ALLOWLIST and the CI
// unrunnable-test baseline.
for (const [k, allowed] of Object.entries(baseline).sort()) {
  const n = counts.get(k) ?? 0;
  if (n < allowed) {
    problems.push(
      `STALE ${k} — baselined ${allowed}, now ${n}. Lower or remove the entry in ` +
        'scripts/TEST_FIXTURE_SHAPE_BASELINE.json.',
    );
  }
}

if (problems.length > 0) {
  console.error('\n✘ check:test-fixture-shapes — fixture shapes that do not match their types:\n');
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(
    'A fixture that claims a type it does not have is how this repo has shipped the same bug six\n' +
      'times: the fixture and the consumer agree with each other while both disagree with the\n' +
      'producer. Fix the fixture against the REAL type — or, better, build it by calling the real\n' +
      'producer (see src/__fixtures__/mapEntities.ts).\n' +
      `\nRe-run just this check:  node scripts/check-test-fixture-shapes.mjs\n` +
      `Full diagnostics:        ./node_modules/.bin/tsc -p ${TSCONFIG} --noEmit\n`,
  );
  process.exit(1);
}

console.log(
  `check:test-fixture-shapes — no fixture/type mismatches ` +
    `(${all.length} total diagnostics scanned, ${findings.length} in the gated shape family).`,
);
