/**
 * workflow-paths.test.ts
 *
 * Unit tests for `globToRegExp`, the matcher that mirrors GitHub Actions
 * `paths:` filter semantics.
 *
 * Uses Node.js built-in test runner (Node 20+).
 * Run:
 *   pnpm --filter @workspace/scripts run test:workflow-paths
 *
 * Matching semantics mirror GitHub Actions:
 *   *   → any segment character except /
 *   **  → any path sequence, including zero or more / segments
 *   Literal patterns must match the full relative path.
 *
 * WHAT USED TO BE HERE
 * ────────────────────
 * This file also asserted the `paths:` filters of two workflow files —
 * `.github/workflows/sync-standalone-check.yml` and
 * `.github/workflows/standalone-drift.yml` — 24 assertions across three
 * describe blocks. Every one of them threw ENOENT: neither workflow exists on
 * this line of history. They were retired on 2026-08-11 rather than repaired.
 * See the commit for the full reasoning; in short, the files exist only on
 * `origin/main`, whose history is completely disjoint from this one, and
 * importing executable workflow definitions across that gap would be adding
 * unreviewed CI rather than restoring anything.
 *
 * The YAML `paths:` parser and the workflow-loading helpers went with them:
 * they existed only to feed those assertions. `globToRegExp` stays because its
 * unit tests below are self-contained and still pass.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// ── glob matcher ──────────────────────────────────────────────────────────────

/**
 * Converts a GitHub Actions glob pattern to a JavaScript RegExp.
 *
 * Rules (matching GitHub's documented semantics):
 *   **   → matches any sequence of characters, including /
 *   *    → matches any sequence of characters except /
 *   ?    → matches any single character except /
 *   .    → literal dot
 *   All other regex metacharacters are escaped.
 *
 * The pattern must match the full path (anchored ^ and $).
 */
function globToRegExp(pattern: string): RegExp {
  let regexStr = '^';

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];

    if (ch === '*' && pattern[i + 1] === '*') {
      // `**` — consume the second `*` and any adjacent slashes.
      i++; // skip second `*`
      // `/**/` in the middle, `**/` at start, `/**` at end → match any path segment sequence
      if (pattern[i + 1] === '/') {
        i++; // skip the `/` after `**`
        regexStr += '(?:.+/)?'; // zero or more directory segments + slash
      } else {
        regexStr += '.*'; // end-of-pattern `**`
      }
    } else if (ch === '*') {
      regexStr += '[^/]*';
    } else if (ch === '?') {
      regexStr += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
  }

  regexStr += '$';
  return new RegExp(regexStr);
}

// ── glob matcher unit tests ───────────────────────────────────────────────────

describe('globToRegExp — unit tests', () => {
  // These are pure string-matching tests — no path is ever resolved on disk —
  // but they use paths that exist on this line so a reader can check them.
  test('literal path matches exactly', () => {
    const re = globToRegExp('scripts/pre-release-check.sh');
    assert.ok(re.test('scripts/pre-release-check.sh'));
    assert.ok(!re.test('scripts/pre-release-check.sh.bak'));
    assert.ok(!re.test('other/pre-release-check.sh'));
  });

  test('** matches across directory boundaries', () => {
    const re = globToRegExp('travel-buddy-standalone/src/**');
    assert.ok(re.test('travel-buddy-standalone/src/services/calendar.ts'));
    assert.ok(re.test('travel-buddy-standalone/src/lib/supabase.ts'));
    assert.ok(re.test('travel-buddy-standalone/src/index.ts'));
    assert.ok(!re.test('artifacts/api-server/src/routes/trips.ts'));
    assert.ok(!re.test('travel-buddy-standalone/app/index.tsx'));
  });

  test('* does not cross directory boundaries', () => {
    const re = globToRegExp('travel-buddy-standalone/*.json');
    assert.ok(re.test('travel-buddy-standalone/package.json'));
    assert.ok(!re.test('travel-buddy-standalone/src/config.json'));
  });

  test('a literal workflow-file pattern matches exactly', () => {
    const re = globToRegExp('.github/workflows/unwired-checks.yml');
    assert.ok(re.test('.github/workflows/unwired-checks.yml'));
    assert.ok(!re.test('.github/workflows/ci.yml'));
  });
});
