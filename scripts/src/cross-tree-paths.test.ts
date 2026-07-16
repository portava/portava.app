/**
 * cross-tree-paths.test.ts
 *
 * Catches typos in cross-tree file paths used inside test files before they
 * silently fail at runtime with ENOENT.
 *
 * WHY: A cross-tree readPkg / readFileSync call in a test resolves a relative
 * path at the moment the test runs. If the path is wrong (e.g. one too many
 * `../` levels), Node throws ENOENT and the test suite shows a single cryptic
 * crash instead of a meaningful assertion failure. This guard resolves every
 * such path at lint-check time and fails loudly with a clear message.
 *
 * WHAT IS CHECKED:
 *   - readPkg('...')  calls (the readPkg helper used in sdk54-downgrade-compat
 *     tests resolves its argument relative to `__dir` — the test file's dir)
 *   - readFileSync(pathResolve(__dir, '...'), ...) calls
 *   - readFileSync(resolve(__dirname, '...'), ...) calls
 *   Only paths that contain '..' are flagged as cross-tree candidates; pure
 *   local imports (e.g. './foo') that stay inside the test file's own dir are
 *   skipped (they are covered by the TypeScript compiler).
 *
 * SCOPE:
 *   Both canonical trees:
 *     artifacts/travel-buddy/src/**\/*.test.ts
 *     travel-buddy-standalone/src/**\/*.test.ts
 *
 * Pattern: node:test + fs — no external dependencies.
 * Run:
 *   pnpm --filter @workspace/scripts run test:cross-tree-paths
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ── Config ────────────────────────────────────────────────────────────────────

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '../../');

/** Both trees to scan. */
const TEST_ROOTS = [
  path.join(WORKSPACE_ROOT, 'artifacts', 'travel-buddy', 'src'),
  path.join(WORKSPACE_ROOT, 'travel-buddy-standalone', 'src'),
];

/**
 * Patterns that indicate a cross-tree path read in a test file.
 *
 * Each pattern must have one capture group that captures the string literal
 * path argument (without quotes).
 *
 * Supported forms:
 *   readPkg('../../some/path')
 *   readPkg("../../some/path")
 *   readFileSync(pathResolve(__dir, '../../some/path'), ...)
 *   readFileSync(resolve(__dirname, "../../some/path"), ...)
 */
const PATH_PATTERNS: RegExp[] = [
  /\breadPkg\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\breadFileSync\(\s*(?:pathResolve|resolve)\(\s*(?:__dir|__dirname)\s*,\s*['"]([^'"]+)['"]\s*\)/g,
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function collectTestFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.expo') continue;
        walk(full);
      } else if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

interface ExtractedPath {
  testFile: string;
  line: number;
  rawArg: string;
  resolved: string;
}

function extractCrossTreePaths(testFile: string): ExtractedPath[] {
  const content = fs.readFileSync(testFile, 'utf8');
  const lines = content.split('\n');
  const testDir = path.dirname(testFile);
  const found: ExtractedPath[] = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    for (const pattern of PATH_PATTERNS) {
      // Reset lastIndex for global regex reuse
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const rawArg = match[1]!;
        // Only flag paths that traverse parent directories — staying local is
        // handled by TypeScript. Absolute paths are never cross-tree reads in
        // these test files, so skip them too.
        if (!rawArg.includes('..') || path.isAbsolute(rawArg)) continue;
        found.push({
          testFile,
          line: lineIdx + 1,
          rawArg,
          resolved: path.resolve(testDir, rawArg),
        });
      }
    }
  }

  return found;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('cross-tree path existence guard', () => {
  for (const root of TEST_ROOTS) {
    const label = path.relative(WORKSPACE_ROOT, root);
    const testFiles = collectTestFiles(root);

    it(`discovers at least one test file in ${label}`, () => {
      assert.ok(
        testFiles.length > 0,
        `No test files found under ${label} — update TEST_ROOTS if the directory moved`,
      );
    });

    for (const testFile of testFiles) {
      const relFile = path.relative(WORKSPACE_ROOT, testFile);
      const crosspaths = extractCrossTreePaths(testFile);

      // Only emit a test for files that have cross-tree reads — keeps the
      // output clean when a test file has no such reads at all.
      if (crosspaths.length === 0) continue;

      it(`all cross-tree paths in ${relFile} resolve to existing files`, () => {
        const missing: string[] = [];
        for (const cp of crosspaths) {
          if (!fs.existsSync(cp.resolved)) {
            missing.push(
              `  line ${cp.line}: readPkg/readFileSync('${cp.rawArg}')\n` +
              `    resolved → ${cp.resolved}\n` +
              `    (file does not exist)`,
            );
          }
        }

        if (missing.length > 0) {
          assert.fail(
            `${missing.length} cross-tree path(s) in ${relFile} resolve to missing files:\n\n` +
            missing.join('\n\n') +
            '\n\nFix the relative path in the test file so it resolves to an existing file.',
          );
        }
      });
    }
  }
});
