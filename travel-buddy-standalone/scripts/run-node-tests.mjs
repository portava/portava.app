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
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

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

// Static guard against fork-copied tests from artifacts/travel-buddy that
// break under this tree's runner:
//   (a) extensionless relative imports — node:test + tsx needs explicit .ts
//   (b) paths that assume the main tree layout (e.g. '../../../../travel-buddy-standalone/...')
function lintTestFile(file) {
  const src = readFileSync(file, 'utf8');
  const problems = [];
  const lines = src.split('\n');
  // Statement-position static imports/re-exports, plus dynamic import()/require().
  // Deliberately NOT matching bare `from '...'` mid-line, which appears inside
  // string assertions and comments in source-level tests.
  const staticImportRe =
    /^\s*(?:import|export)\b[^'"]*(['"])(\.{1,2}\/[^'"]*)\1/;
  const dynamicImportRe =
    /(?:\bimport\s*\(|\brequire\s*\()\s*(['"])(\.{1,2}\/[^'"]*)\1/g;
  const hasExtension = (spec) => /\.[a-zA-Z0-9]+$/.test(spec);
  lines.forEach((line, i) => {
    if (line.includes('fork-lint-ok')) return; // explicit per-line suppression
    const specs = [];
    const sm = staticImportRe.exec(line);
    if (sm) specs.push(sm[2]);
    let m;
    dynamicImportRe.lastIndex = 0;
    while ((m = dynamicImportRe.exec(line)) !== null) specs.push(m[2]);
    for (const spec of specs) {
      if (!hasExtension(spec)) {
        problems.push(
          `${file}:${i + 1}: extensionless relative import '${spec}' — add an explicit .ts extension (node:test + tsx requires it)`,
        );
      }
    }
    if (/(?:\.\.\/){4,}/.test(line) || /travel-buddy-standalone\//.test(line)) {
      problems.push(
        `${file}:${i + 1}: path assumes the main tree layout ('../../../../' or 'travel-buddy-standalone/...') — use paths relative to this standalone tree, or append '// fork-lint-ok' if the cross-tree reference is intentional`,
      );
    }
  });
  return problems;
}

const lintProblems = toRun.flatMap(lintTestFile);
if (lintProblems.length > 0) {
  console.error(
    'Fork-copy lint failed — these test files look copied verbatim from artifacts/travel-buddy:\n' +
      lintProblems.map((p) => `  - ${p}`).join('\n'),
  );
  process.exit(1);
}

console.log(`Running ${toRun.length} node:test files (${broken.size} known-broken excluded).`);

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx/esm', '--test', ...toRun],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
