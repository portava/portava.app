/**
 * dead-routes-guard.test.ts
 *
 * Asserts that no source file contains a navigation link to routes that exist
 * on disk but must remain unreachable from any user-facing navigation path.
 *
 * WHY: /live-map is a "coming soon" stub — tapping through to it damages user
 * trust. The route file is kept (data model + privacy rules exist in the DB)
 * but no screen may link to it until the full MapLibre implementation ships.
 *
 * Pattern: node:test + fs scan — no external dependencies.
 * Run:
 *   pnpm --filter @workspace/scripts run test:dead-routes
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ── Config ─────────────────────────────────────────────────────────────────────

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '../../');

/**
 * Source roots to scan.
 *
 * This listed artifacts/travel-buddy as a second root until that tree was
 * archived (bc1bef404). The stale root did not fail: it scanned an absent
 * directory, contributed zero findings, and the guard went green. It was
 * removed — but removing the entry fixed the instance and left the hole.
 *
 * THE HOLE, AND WHY IT IS CLOSED BELOW
 * ====================================
 * A conditional floor was added afterwards — `if (fs.existsSync(root))` around
 * the at-least-one-file assertion — which floors a root that exists and is
 * empty, and still passes a root that DOES NOT EXIST. That is the precise case
 * that already happened once. The floor was guarding every scenario except the
 * one from the incident.
 *
 * The sibling guard, fixture-import-guard.test.ts:118, asserts unconditionally.
 * That contrast is the whole argument: two guards of the same shape, one of
 * which cannot pass vacuously and one of which could.
 *
 * A configured root that does not exist is a CONFIGURATION DEFECT, not a pass.
 * There is no reading of this file under which scanning nothing is the correct
 * outcome, so the floor is now unconditional.
 */
export const SOURCE_ROOTS = [path.join(WORKSPACE_ROOT, 'travel-buddy-standalone')];

/**
 * Routes that must not be reachable from any navigation path.
 * Each entry has a human-readable reason so the error message is actionable.
 */
export const DEAD_ROUTES: Array<{ route: string; reason: string }> = [
  {
    route: '/live-map',
    reason:
      'The live map is a "coming soon" stub (no MapLibre integration yet). ' +
      'Remove the link or gate it behind a feature flag when the full map ships.',
  },
];

/**
 * Patterns that would constitute a navigation link to a given route.
 * Matches: router.push('/live-map'), href="/live-map", pathname: '/live-map',
 * router.replace('/live-map'), Link href="/live-map", etc.
 */
function navigationPatterns(route: string): RegExp[] {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`router\\.(?:push|replace|navigate)\\(['"](${escaped})['"\\s,]`),
    new RegExp(`href=['"](${escaped})['"]`),
    new RegExp(`pathname:\\s*['"]${escaped}['"]`),
    new RegExp(`['"](${escaped})['"]\\s*as\\s+any`),
  ];
}

/** Directories and file suffixes that are allowed to reference dead routes (e.g. the route file itself). */
const SKIP_DIRS = ['node_modules', '.expo', '.git'];
const SKIP_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];

// ── Helpers ────────────────────────────────────────────────────────────────────

export function collectSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.includes(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts'))) {
        if (SKIP_SUFFIXES.some((s) => entry.name.endsWith(s))) continue;
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

function scanForLinks(files: string[], route: string): Violation[] {
  const patterns = navigationPatterns(route);
  const violations: Violation[] = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pat of patterns) {
        if (pat.test(line)) {
          violations.push({ file, line: i + 1, text: line.trim(), pattern: pat.toString() });
        }
      }
    }
  }
  return violations;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('dead-routes guard', () => {
  // The loops below generate one test per (root × route). Either list going
  // empty would generate ZERO tests, and a describe block containing no tests
  // passes. Vacuity is failure, so both lists are floored before the loops.
  it('has something to check — SOURCE_ROOTS and DEAD_ROUTES are both non-empty', () => {
    assert.ok(
      SOURCE_ROOTS.length > 0,
      'SOURCE_ROOTS is empty — this guard would generate no tests and pass.',
    );
    assert.ok(
      DEAD_ROUTES.length > 0,
      'DEAD_ROUTES is empty — this guard would generate no tests and pass. ' +
        'If every dead route has genuinely shipped, delete the guard deliberately ' +
        'rather than emptying its list and leaving a green check behind.',
    );
  });

  for (const root of SOURCE_ROOTS) {
    const label = path.relative(WORKSPACE_ROOT, root);
    const files = collectSourceFiles(root);

    for (const { route, reason } of DEAD_ROUTES) {
      it(`no source file in ${label} links to ${route}`, () => {
        // UNCONDITIONAL floor. A root that does not exist, and a root that
        // exists and is empty, are both configuration defects — in each case
        // this guard scanned nothing and reported success, which is
        // indistinguishable from having checked.
        assert.ok(
          fs.existsSync(root),
          `SOURCE_ROOTS names ${label}, which does not exist. ` +
            `A guard pointed at an absent directory scans nothing and passes — ` +
            `fix the path or remove the root.`,
        );
        assert.ok(
          files.length > 0,
          `No source files found in ${label} — check SOURCE_ROOTS config`,
        );

        const violations = scanForLinks(files, route);

        if (violations.length > 0) {
          const report = violations
            .map((v) => `  ${path.relative(WORKSPACE_ROOT, v.file)}:${v.line}\n    ${v.text}`)
            .join('\n');
          assert.fail(
            `Found ${violations.length} navigation link(s) to ${route} in ${label}:\n${report}\n\n` +
              `Reason this route must stay unreachable: ${reason}`,
          );
        }
      });
    }
  }
});
