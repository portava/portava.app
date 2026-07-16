#!/usr/bin/env node
// Discovers and runs all node:test files so new tests can't be silently skipped.
// Mirrors travel-buddy-standalone/scripts/run-node-tests.mjs.
//
// Discovery: src/**/*.test.ts and server/**/*.test.ts
// Exclusions:
//   - *.component.test.* files (run under jest via `pnpm test:component`)
//   - src/test/** (files with dedicated special runners that need manual migration)
//   - KNOWN_BROKEN below (documented failures; this script fails loudly if
//     an entry no longer exists so the list can't go stale)
//
// Two-pass execution:
//   - NEEDS_CJS files (services that use extensionless imports) run with --import tsx
//   - All other discovered files run with --import tsx/esm

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

// Known-broken node:test files, excluded from the run. Fix and remove.
const KNOWN_BROKEN = [];

// Files that import services using extensionless imports (CJS resolution).
// These must run with `--import tsx` instead of `--import tsx/esm`.
const NEEDS_CJS = new Set([
  'src/services/__tests__/stampGracefulDegradation.test.ts',
  'src/services/__tests__/tripGoneError.test.ts',
]);

const ROOTS = ['src', 'server'];

function collect(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === 'src/test') continue; // files with dedicated special runners
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
const missingBroken = KNOWN_BROKEN.filter((f) => !existsSync(f));
if (missingBroken.length > 0) {
  console.error(
    'KNOWN_BROKEN entries no longer exist — remove them from scripts/run-node-tests.mjs:\n' +
      missingBroken.map((f) => `  - ${f}`).join('\n'),
  );
  process.exit(1);
}

// Fail loudly if a NEEDS_CJS entry no longer exists (stale list).
const missingCjs = [...NEEDS_CJS].filter((f) => !existsSync(f));
if (missingCjs.length > 0) {
  console.error(
    'NEEDS_CJS entries no longer exist — remove them from scripts/run-node-tests.mjs:\n' +
      missingCjs.map((f) => `  - ${f}`).join('\n'),
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

const cjsFiles = toRun.filter((f) => NEEDS_CJS.has(f));
const esmFiles = toRun.filter((f) => !NEEDS_CJS.has(f));

console.log(
  `Running ${toRun.length} node:test files` +
    ` (${broken.size} known-broken excluded,` +
    ` ${cjsFiles.length} CJS-mode, ${esmFiles.length} ESM-mode).`,
);

let exitCode = 0;

if (cjsFiles.length > 0) {
  console.log('\n── CJS-mode tests (--import tsx) ──');
  const cjsResult = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', ...cjsFiles],
    { stdio: 'inherit' },
  );
  if ((cjsResult.status ?? 1) !== 0) exitCode = cjsResult.status ?? 1;
}

if (esmFiles.length > 0) {
  console.log('\n── ESM-mode tests (--import tsx/esm) ──');
  const esmResult = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', '--test', ...esmFiles],
    { stdio: 'inherit' },
  );
  if ((esmResult.status ?? 1) !== 0) exitCode = esmResult.status ?? 1;
}

process.exit(exitCode);
