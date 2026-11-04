#!/usr/bin/env node
// Discovers and runs all node:test files so new tests can't be silently skipped.
// Mirrors travel-buddy-standalone/scripts/run-node-tests.mjs.
//
// Discovery: src/**/*.test.ts and server/**/*.test.ts
// Exclusions:
//   - *.component.test.* files (run under jest via `pnpm test:component`)
//   - src/test/** (special runners, e.g. `pnpm test:stamps`)
//   - KNOWN_BROKEN below (documented failures; this script fails loudly if
//     an entry no longer exists so the list can't go stale)

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

// Pre-flight: catch extensionless relative imports before any test starts,
// so failures surface as the guard's clear message instead of a cryptic ESM
// resolution error mid-run.
const guard = spawnSync(
  process.execPath,
  ['scripts/check-import-extensions.mjs'],
  { stdio: 'inherit' },
);
if ((guard.status ?? 1) !== 0) {
  process.exit(guard.status ?? 1);
}

// Pre-flight: reject crash-prone jest.mock stand-ins in component tests
// (bare object-literal factories without requireActual/NOTE, per-file lucide
// mocks) before jest ever runs them.
const mockGuard = spawnSync(
  process.execPath,
  ['scripts/check-test-mocks.mjs'],
  { stdio: 'inherit' },
);
if ((mockGuard.status ?? 1) !== 0) {
  process.exit(mockGuard.status ?? 1);
}

// Pre-flight: reject raw <KeyboardAvoidingView usage in app/ and
// src/components/ — all screens must go through KeyboardSafeView or
// KeyboardSafeScrollView so Android keyboard avoidance is never skipped.
const kavGuard = spawnSync(
  process.execPath,
  ['scripts/check-keyboard-avoiding-view.mjs'],
  { stdio: 'inherit' },
);
if ((kavGuard.status ?? 1) !== 0) {
  process.exit(kavGuard.status ?? 1);
}

// Pre-flight: reject <KeyboardSafeScrollView> + inner <ScrollView> nesting in
// app/ and src/components/ — use <KeyboardSafeView> instead.
const ksvGuard = spawnSync(
  process.execPath,
  ['scripts/check-ksv-inner-scroll.mjs'],
  { stdio: 'inherit' },
);
if ((ksvGuard.status ?? 1) !== 0) {
  process.exit(ksvGuard.status ?? 1);
}

// Known-broken node:test files, excluded from the run. Fix and remove.
//
// Empty since 2026-11-04. The 25 files that were here (react-native's
// "Unexpected typeof" under tsx, and three written in Jest syntax) matched
// neither runner, so none of them had ever run. They are now
// *.component.test.ts files that run under jest (`pnpm test:component`), where
// react-native transforms. Seven had gone stale while unrun (a fake response
// with no headers, a duration limit that moved, an env var set after the module
// read it) and were brought up to date; none hid a product bug. A new file that
// can't run under Node belongs under jest the same way, not in this list.
const KNOWN_BROKEN = [];

const ROOTS = ['src', 'server'];

function collect(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === 'src/test') continue; // special runners
      collect(full, out);
    } else if (
      entry.name.endsWith('.test.ts') &&
      !entry.name.includes('.component.test.')
    ) {
      out.push(full);
    }
  }
}

// Fail loudly if a known-broken entry no longer exists (stale list).
const missing = KNOWN_BROKEN.filter((f) => !existsSync(f));
if (missing.length > 0) {
  console.error(
    'KNOWN_BROKEN entries no longer exist — remove them from scripts/run-node-tests.mjs:\n' +
      missing.map((f) => `  - ${f}`).join('\n'),
  );
  process.exit(1);
}

const files = [];
for (const root of ROOTS) {
  if (existsSync(root)) collect(root, files);
}
files.sort();

const broken = new Set(KNOWN_BROKEN);
const toRun = files.filter((f) => !broken.has(f));

if (toRun.length === 0) {
  console.error('No test files discovered — discovery is broken.');
  process.exit(1);
}

console.log(`Running ${toRun.length} node:test files (${broken.size} known-broken excluded).`);

// ── THE LOADER IS CHOSEN BY NODE MAJOR, AND THE REASON IS WORTH THE LINES ────
//
// On NODE 24 — what CI pins (`NODE_VERSION: '24'` in ci.yml) — `tsx/esm` is the
// right loader and this suite is green.
//
// On NODE 22 IT IS NOT, AND THE FAILURE IS CATASTROPHIC AND UNINFORMATIVE.
// Measured on Node v22.22.2, 2026-09-14: **269 of 272 files fail**, every one
// with `ERR_REQUIRE_CYCLE_MODULE — Cannot require() ES Module … in a cycle`,
// thrown before a single test body runs. The same files pass 272/272 under
// `--import tsx`. It is not the tree: `require(esm)` cycle handling changed
// between 22 and 24, and `tsx/esm` trips it.
//
// WHY THIS MATTERS MORE THAN AN ERGONOMIC ANNOYANCE. A developer or agent on
// Node 22 sees 269 red files and has two readings available: "the client test
// suite is broken" or "the client test suite does not run here". Those lead to
// opposite actions, and the first one is wrong. It has already cost this
// project twice — once recorded as "a property of this container's module
// resolution rather than of the tree", and once as a lane reporting that the
// standalone runner was dark and every client assertion across several censuses
// might be unexecuted. It is not dark in CI. It was dark on that lane's Node.
//
// So: pick the loader that works, and SAY SO, rather than letting the version
// difference surface as 269 stack traces.
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
const loader = nodeMajor >= 24 ? 'tsx/esm' : 'tsx';
if (loader !== 'tsx/esm') {
  console.log(
    `Node ${process.versions.node} < 24: using --import tsx instead of tsx/esm. ` +
      'On Node 22 the tsx/esm loader fails every file with ERR_REQUIRE_CYCLE_MODULE ' +
      'before any test runs — a loader artefact, not a defect in these tests. ' +
      "CI pins Node 24 and uses tsx/esm; this is the local equivalent, not a weaker run.",
  );
}

const result = spawnSync(
  process.execPath,
  ['--import', loader, '--test', ...toRun],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
