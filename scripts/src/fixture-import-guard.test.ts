/**
 * Fixture-import guard
 *
 * Asserts that no production screen file (app/**) imports from fixture/mock
 * data paths. This test would have caught the post/[id].tsx cebu-fixture leak
 * fixed in the July 2026 follow-up audit pass.
 *
 * Pattern: node:test + fs scan — no external dependencies.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ── Config ─────────────────────────────────────────────────────────────────────

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '../../');

/** Directories containing production screen files to guard. */
// Was two roots until artifacts/travel-buddy was archived (bc1bef404). The
// guard asserts each root yields at least one screen file, so a stale root here
// fails loudly rather than silently scanning nothing — which is how this entry
// was caught.
const SCREEN_ROOTS = [path.join(WORKSPACE_ROOT, 'travel-buddy-standalone/app')];

/**
 * Patterns that are NOT allowed in production screen imports.
 * Covers both relative paths (../../src/data/cebu) and aliased names.
 */
const BANNED_PATTERNS: RegExp[] = [
  // Cebu fixture data
  /from\s+['"][^'"]*\/data\/cebu['"]/,
  // pulseFeed fixture (re-exports from __fixtures__)
  /from\s+['"][^'"]*\/data\/pulseFeed['"]/,
  // Any direct __fixtures__ import
  /from\s+['"][^'"]*\/__fixtures__['"]/,
  // Any path ending in /fixtures/
  /from\s+['"][^'"]*\/fixtures\/['"]/,
  // Any mockData import
  /from\s+['"][^'"]*mockData['"]/,
  // Aliased fixture barrel
  /from\s+['"]@fixtures['"]/,
  // require() variants
  /require\s*\(\s*['"][^'"]*\/data\/cebu['"]\s*\)/,
  /require\s*\(\s*['"][^'"]*\/data\/pulseFeed['"]\s*\)/,
];

/** Globs that are allowed to contain fixture imports (test/story files). */
const ALLOWED_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx', '.stories.tsx'];

// ── Helpers ────────────────────────────────────────────────────────────────────

function collectScreenFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.expo') continue;
        walk(full);
      } else if (entry.isFile() && (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts'))) {
        if (ALLOWED_SUFFIXES.some((s) => entry.name.endsWith(s))) continue;
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

interface Violation {
  file: string;
  line: number;
  text: string;
  pattern: string;
}

function scanForViolations(files: string[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pat of BANNED_PATTERNS) {
        if (pat.test(line)) {
          violations.push({ file, line: i + 1, text: line.trim(), pattern: pat.toString() });
        }
      }
    }
  }
  return violations;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('fixture-import guard', () => {
  for (const root of SCREEN_ROOTS) {
    const label = path.relative(WORKSPACE_ROOT, root);

    it(`no production screen in ${label} imports fixture/cebu data`, () => {
      const files = collectScreenFiles(root);
      const violations = scanForViolations(files);

      if (violations.length > 0) {
        const report = violations
          .map((v) => `  ${path.relative(WORKSPACE_ROOT, v.file)}:${v.line}\n    ${v.text}`)
          .join('\n');
        assert.fail(
          `Found ${violations.length} fixture import(s) in production screens:\n${report}\n\n` +
          `Fix: wire the screen to a real service call instead of importing from fixture data.`,
        );
      }

      // At least one file scanned (guards against empty dir false-pass)
      assert.ok(files.length > 0, `No screen files found in ${label} — check SCREEN_ROOTS config`);
    });
  }
});
