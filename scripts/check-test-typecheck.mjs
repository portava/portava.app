#!/usr/bin/env node
// Test-suite typecheck ratchet.
//
// WHY THIS EXISTS
// ---------------
// Both packages deliberately kept their test files OUT of the typechecked
// program: artifacts/api-server/tsconfig.json excludes "src/test", and
// travel-buddy-standalone/tsconfig.json excludes "**/*.test.ts(x)". That is
// how a whole defect class survived — a fixture asserting a shape production
// never emits compiles fine when nothing compiles it, and the resulting green
// test reads as coverage of behaviour that does not exist.
//
// tsconfig.test.json in each package compiles those files. This script gates
// the result. It cannot be a plain pass/fail today: turning the compiler on
// exposed a four-figure backlog, and fixing it in one sweep is not something
// to do blind. So the gate is a RATCHET — a per-file baseline that may only
// go DOWN.
//
// PER-FILE, not a total. A total-only baseline lets an error introduced in
// file A hide behind an error removed from file B; the count is unchanged and
// the gate says nothing. Every file carries its own ceiling.
//
// STALENESS IS ALSO A FAILURE. If a file's real count drops below its
// baseline, this exits non-zero and tells you to re-record. A baseline that
// drifts above reality is a gate that has quietly stopped gating — the same
// failure mode as the CI steps in this repo that were green because nothing
// invoked them.
//
// COMPILER AUTHENTICITY comes free here, and deliberately so. On 2026-08-23 a
// branch was reported "typecheck clean" while carrying four type errors,
// because `npx tsc` resolved to the decoy npm package named `tsc`, which
// prints a banner and exits 0. Against this script that decoy fails loudly:
// it reports zero errors, every baselined file reads as "improved", and the
// staleness branch below exits 1. A gate whose baseline is non-zero cannot be
// satisfied by a compiler incapable of producing output.
//
// THIS GATE'S ANSWER DEPENDS ON GENERATED FILES THAT GIT DOES NOT CARRY, and
// that has already cost three commits of guessing. travel-buddy-standalone's
// tsconfig.test.json includes `expo-env.d.ts` and `.expo/types/**/*.ts`; both
// are produced by the Expo tooling and both are GITIGNORED. A working copy
// that has run `expo` has them, a fresh clone — every CI runner — does not,
// and their presence changes ambient globals: with `expo-env.d.ts` the
// DOM-flavoured `setInterval`/`clearInterval` merge in, without it only
// @types/node's. Source that is clean here can therefore be two diagnostics
// above its ceiling in CI, in a file nobody touched.
//
// To reproduce a CI count locally, move both aside and delete the incremental
// cache first:
//
//   cd travel-buddy-standalone
//   mv .expo /tmp/expo-types && mv expo-env.d.ts /tmp/expo-env.d.ts
//   rm -f .test.tsbuildinfo
//   node ../scripts/check-test-typecheck.mjs --package travel-buddy-standalone
//   # …then MOVE THEM BACK.
//
// The fix for a file caught this way is to stop restating a signature that
// varies and name it instead (`as unknown as typeof global.setInterval`), not
// to raise the ceiling — the ratchet fails on a stale baseline too, so a
// number that is right in one environment is wrong in the other either way.
//
// Usage:
//   node scripts/check-test-typecheck.mjs --package <dir> --project <name> \
//        --baseline <name> [--update]
//
// --package is relative to the repo root; --project and --baseline are
// relative to --package.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) return fallback;
  return process.argv[i + 1];
}

const packageDir = arg('package');
const projectName = arg('project', 'tsconfig.test.json');
const baselineName = arg('baseline', 'test-typecheck-baseline.json');
const update = process.argv.includes('--update');

if (!packageDir) {
  console.error('check-test-typecheck: --package <dir> is required');
  process.exit(2);
}

const pkgPath = join(REPO_ROOT, packageDir);
const projectPath = join(pkgPath, projectName);
const baselinePath = join(pkgPath, baselineName);

for (const [label, p] of [['project', projectPath]]) {
  if (!existsSync(p)) {
    console.error(`check-test-typecheck: ${label} not found: ${p}`);
    process.exit(2);
  }
}

// The package-local compiler, never a PATH lookup — see the decoy note above.
const tsc = join(pkgPath, 'node_modules', '.bin', 'tsc');
if (!existsSync(tsc)) {
  console.error(
    `check-test-typecheck: no compiler at ${tsc}. Install the package's ` +
      'dependencies first. Falling back to a PATH `tsc` is exactly how the ' +
      'decoy package got in, so this is fatal rather than a warning.',
  );
  process.exit(2);
}

const run = spawnSync(tsc, ['-p', projectPath, '--noEmit'], {
  cwd: pkgPath,
  encoding: 'utf8',
  maxBuffer: 128 * 1024 * 1024,
});

if (run.error) {
  console.error(`check-test-typecheck: could not run the compiler: ${run.error.message}`);
  process.exit(2);
}

const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;

// tsc prints "path/to/file.ts(LINE,COL): error TSxxxx: message". Continuation
// lines of a multi-line diagnostic are indented and carry no "): error TS", so
// this counts diagnostics, not lines.
const DIAGNOSTIC = /^(?<file>[^(\s][^(]*)\((?<line>\d+),(?<col>\d+)\): error (?<code>TS\d+):/;

const counts = new Map();
let total = 0;
for (const raw of output.split('\n')) {
  const m = DIAGNOSTIC.exec(raw);
  if (!m) continue;
  const file = m.groups.file.replace(/\\/g, '/');
  counts.set(file, (counts.get(file) ?? 0) + 1);
  total += 1;
}

// A compiler that exits non-zero must have said why. If it did not, the run
// is unusable and an unestablished result is not a pass.
if (run.status !== 0 && total === 0) {
  console.error(
    `check-test-typecheck: the compiler exited ${run.status} but produced no ` +
      'parseable diagnostics. That result cannot be scored, so it fails. Raw ' +
      'output follows:\n' +
      output.slice(0, 4000),
  );
  process.exit(2);
}

// ── A RUN THAT MEASURED ALMOST NOTHING IS NOT AN IMPROVEMENT ────────────────
//
// TypeScript stops after parsing when a program will not parse, and it does so
// for the WHOLE PROGRAM — every semantic error in every other file silently
// disappears. Measured on 2026-09-14 rather than reasoned about: one in-flight
// file with unquoted-codepoint object keys collapsed the run to "27 diagnostics
// across 1 files", and this script then reported all 116 baselined files as
// IMPROVED. `--update` at that moment would have written 864 real ceilings down
// to nothing, in a file whose own header says counts may only go DOWN — the
// erasure would have looked exactly like the success it is meant to record, and
// the next 864 regressions would have sailed through.
//
// THE TEST IS THE SHAPE OF THE RESULT, NOT THE ERROR CODE, and that distinction
// was learned the hard way. The first version of this guard failed on any TS1xxx
// code. `src/test/geofence.test.ts` carried a TS1117 — a duplicate object key,
// which tsc reports AFTER a successful parse and alongside full semantic
// checking — and it was one of the 864 baselined diagnostics all along. A code
// taxonomy would have failed the build on a diagnostic the ratchet was
// legitimately counting. So this asks the only question that actually matters:
// did this run look at the same corpus the baseline did?
if (existsSync(baselinePath)) {
  let prior;
  try { prior = JSON.parse(readFileSync(baselinePath, 'utf8')); } catch { prior = null; }
  const priorFiles = prior && prior.files ? Object.keys(prior.files) : [];
  const stillOnDisk = priorFiles.filter((f) => existsSync(join(pkgPath, f)));
  if (stillOnDisk.length >= 8 && counts.size * 2 < stillOnDisk.length && total * 2 < (prior.total ?? 0)) {
    console.error(
      `check-test-typecheck: this run reported diagnostics in ${counts.size} file(s) against a ` +
        `baseline covering ${stillOnDisk.length} that are still on disk, and ${total} total against ` +
        `${prior.total}. A corpus does not improve that way all at once — the usual cause is a file ` +
        'that will not PARSE, which makes TypeScript skip semantic checking for the entire program.\n\n' +
        'Look for a syntax error first. This is exit 2 — the result could not be established — and ' +
        'emphatically NOT a baseline that may be recorded with --update.',
    );
    process.exit(2);
  }
}

const sorted = Object.fromEntries([...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));

if (update) {
  const payload = {
    _comment: [
      'Per-file ceiling for the test-suite typecheck. Generated by',
      'scripts/check-test-typecheck.mjs --update. Counts may only go DOWN;',
      'when they do, re-record with --update in the same commit so the',
      'baseline never sits above reality. Do not hand-edit.',
    ],
    project: `${packageDir}/${projectName}`,
    total,
    files: sorted,
  };
  writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`check-test-typecheck: wrote ${baselinePath} (${total} diagnostics across ${counts.size} files)`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(
    `check-test-typecheck: no baseline at ${baselinePath}. Create it with --update.`,
  );
  process.exit(2);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
} catch (err) {
  console.error(`check-test-typecheck: ${baselinePath} is not valid JSON: ${err.message}`);
  process.exit(2);
}

const baseFiles = baseline.files ?? {};
const regressed = [];
const improved = [];

for (const [file, n] of counts) {
  const ceiling = baseFiles[file] ?? 0;
  if (n > ceiling) regressed.push({ file, was: ceiling, now: n });
}
for (const [file, ceiling] of Object.entries(baseFiles)) {
  const n = counts.get(file) ?? 0;
  if (n < ceiling) improved.push({ file, was: ceiling, now: n });
}

console.log(
  `check-test-typecheck: ${packageDir}/${projectName} — ${total} diagnostics ` +
    `across ${counts.size} files (baseline ${baseline.total} across ` +
    `${Object.keys(baseFiles).length}).`,
);

let failed = false;

if (regressed.length > 0) {
  failed = true;
  console.error('');
  console.error('::error::New type errors in the test suite. These files are above their baseline:');
  for (const r of regressed) {
    console.error(`  ${r.file}: ${r.was} -> ${r.now}`);
  }
  console.error('');
  console.error(
    'Fix the new errors. Do NOT raise the baseline to make this pass, and do ' +
      'not reach for @ts-expect-error or `any` — the point of this gate is that ' +
      'a fixture describing a shape production never emits stops compiling.',
  );
}

if (improved.length > 0) {
  failed = true;
  console.error('');
  console.error('::error::The baseline is stale — these files now have FEWER errors than it records:');
  for (const r of improved) {
    console.error(`  ${r.file}: ${r.was} -> ${r.now}`);
  }
  console.error('');
  console.error(
    'This is a failure on purpose. A ceiling above reality has stopped being a ' +
      'ceiling. Re-record it in the same commit that earned the improvement:',
  );
  console.error(
    `  node scripts/check-test-typecheck.mjs --package ${packageDir} --project ${projectName} --update`,
  );
}

if (failed) process.exit(1);

console.log('check-test-typecheck: OK — no file is above its baseline, and no baseline is stale.');
