#!/usr/bin/env node
/**
 * Discovers and runs all node:test files in this package.
 *
 * Why: the previous `test` script was a hand-maintained list of ~40 file
 * paths; any new *.test.ts file that wasn't manually appended simply never
 * ran, so the suite stayed green while coverage silently eroded. This script
 * globs for test files instead, so new tests are picked up automatically.
 *
 * Intentional exclusions (each category documented below):
 *  1. Jest component tests (`*.component.test.{ts,tsx}` and any `*.test.tsx`)
 *     — run via `pnpm test:component` (jest --forceExit, jest-expo preset).
 *  2. `src/test/**` — legacy/special-runner tests. Two have dedicated
 *     scripts (`test:stamps`, `test:invite-gone`); the rest are stale
 *     fork-era tests that were never wired to any runner.
 *  3. KNOWN_BROKEN — pre-existing broken tests that were never in the old
 *     hardcoded list. Each entry needs a reason. If one of these files is
 *     deleted or renamed, this script fails loudly so the list stays fresh.
 */
import { globSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Pre-existing broken tests, excluded intentionally. Fix + remove entries.
const KNOWN_BROKEN = new Map([
  ['src/lib/__tests__/compassIntent.test.ts', "orphan: requires '../compassIntent', module does not exist in this fork"],
  ['src/lib/composerLogic.test.ts', "orphan: requires './composerLogic', module does not exist in this fork"],
  ['src/lib/displayIdentity.test.ts', "orphan: requires './displayIdentity', module does not exist in this fork"],
  ['src/services/sdk54-downgrade-compat.test.ts', 'stale: version-pin assertions reference paths/versions from the pre-fork monorepo layout'],
  ['src/components/discovery/__tests__/SavedPlacesMapView.filterReset.integration.test.ts', 'pre-existing failures: 2 of 8 subtests fail (storage key not cleared on last-place removal)'],
]);

// Fail loudly if a KNOWN_BROKEN entry no longer exists (renamed/deleted).
for (const rel of KNOWN_BROKEN.keys()) {
  if (!existsSync(path.join(root, rel))) {
    console.error(`run-node-tests: KNOWN_BROKEN entry no longer exists: ${rel}\n` +
      'Remove or update the entry in scripts/run-node-tests.mjs.');
    process.exit(1);
  }
}

const discovered = [
  ...globSync('src/**/*.test.ts', { cwd: root }),
  ...globSync('server/**/*.test.ts', { cwd: root }),
].sort();

const files = discovered.filter((rel) => {
  if (rel.includes('.component.test.')) return false; // jest (test:component)
  if (rel.startsWith('src/test/')) return false; // special runners / legacy
  if (KNOWN_BROKEN.has(rel)) return false;
  return true;
});

if (files.length === 0) {
  console.error('run-node-tests: no test files discovered — glob is broken?');
  process.exit(1);
}

console.log(`run-node-tests: running ${files.length} test files (excluded: ${KNOWN_BROKEN.size} known-broken, jest component tests, src/test/** special runners)`);

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx/esm', '--test', ...files],
  { cwd: root, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
