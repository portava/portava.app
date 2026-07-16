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

// ── Pre-check: cross-tree path guard ─────────────────────────────────────────
// Run before discovering or executing any test files so a path typo surfaces
// immediately with a clear message rather than as a cryptic ENOENT mid-suite.
console.log('── Pre-check: cross-tree path guard ──');
const guardResult = spawnSync(
  'pnpm',
  ['--filter', '@workspace/scripts', 'run', 'test:cross-tree-paths'],
  { stdio: 'inherit' },
);
if (guardResult.error?.code === 'ENOENT') {
  console.error(
    'Could not find pnpm — ensure it is installed and on PATH before running standalone tests',
  );
  process.exit(1);
}
if ((guardResult.status ?? 1) !== 0) {
  console.error(
    '\nCross-tree path guard failed — fix the broken path(s) above before re-running the standalone tests.',
  );
  process.exit(guardResult.status ?? 1);
}
console.log('Cross-tree path guard passed.\n');

// Known-broken node:test files, excluded from the run. Fix and remove.
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

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx/esm', '--test', ...toRun],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
