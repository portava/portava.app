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
//
// Two-batch execution:
//   Batch 1 — tsx/esm (ESM mode): the majority of tests.
//   Batch 2 — tsx (CJS mode): files whose imported services mix ESM imports
//     with CJS require() calls (e.g. auth.ts, compass.ts import supabase via
//     a top-level ESM import that tsx/esm compiles to require(), then fails to
//     resolve the .ts extension).  List them explicitly in NEEDS_CJS below;
//     the script fails loudly if any entry no longer exists.

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

// Known-broken node:test files, excluded from the run. Fix and remove.
const KNOWN_BROKEN = [];

// Files that must run under tsx (CJS mode) because the services they import
// mix ESM-style imports with require() calls that tsx/esm cannot resolve.
// Fail loudly if an entry no longer exists so this list can't go stale.
const NEEDS_CJS = [
  'src/services/__tests__/authEnsureProfile.test.ts',
  'src/services/__tests__/compassComponents.test.ts',
  'src/services/__tests__/DiscoveryBlockedUsers.test.ts',
  'src/services/__tests__/DiscoveryCityRefresh.test.ts',
];

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
const missingBroken = KNOWN_BROKEN.filter((f) => !existsSync(f));
if (missingBroken.length > 0) {
  console.error(
    'KNOWN_BROKEN entries no longer exist — remove them from scripts/run-node-tests.mjs:\n' +
      missingBroken.map((f) => `  - ${f}`).join('\n'),
  );
  process.exit(1);
}

// Fail loudly if a NEEDS_CJS entry no longer exists (stale list).
const missingCjs = NEEDS_CJS.filter((f) => !existsSync(f));
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
const needsCjs = new Set(NEEDS_CJS);

// Batch 1: ESM-compatible files (the vast majority).
const esmFiles = files.filter((f) => !broken.has(f) && !needsCjs.has(f));
// Batch 2: CJS-mode files (supabase-dependent services).
const cjsFiles = NEEDS_CJS; // already verified they exist

if (esmFiles.length === 0) {
  console.error('No ESM test files discovered — discovery is broken.');
  process.exit(1);
}

console.log(
  `Running ${esmFiles.length} node:test files (tsx/esm) + ${cjsFiles.length} (tsx) — ${broken.size} known-broken excluded.`,
);

const esmResult = spawnSync(
  process.execPath,
  ['--import', 'tsx/esm', '--test', ...esmFiles],
  { stdio: 'inherit' },
);
if (esmResult.status !== 0) process.exit(esmResult.status ?? 1);

const cjsResult = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...cjsFiles],
  { stdio: 'inherit' },
);
process.exit(cjsResult.status ?? 1);
