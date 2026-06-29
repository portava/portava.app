/**
 * workflow-paths.test.ts
 *
 * Verifies that the `paths:` filters in the drift-check GitHub Actions
 * workflows are correctly scoped after the recent narrowing pass.
 *
 * Uses Node.js built-in test runner (Node 20+).
 * Run:
 *   pnpm --filter @workspace/scripts run test:workflow-paths
 *
 * What is checked for each workflow file
 * ──────────────────────────────────────
 *  MUST trigger (paths that belong to the watched surface):
 *    • A source file inside artifacts/travel-buddy/src/
 *    • scripts/sync-standalone.sh   (the sync tool itself)
 *    • The workflow file's own path (self-reference convention)
 *
 *  MUST NOT trigger (paths explicitly outside the watched surface):
 *    • A source file inside artifacts/api-server/src/
 *
 * Matching semantics mirror GitHub Actions:
 *   *   → any segment character except /
 *   **  → any path sequence, including zero or more / segments
 *   Literal patterns must match the full relative path.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── path resolution ───────────────────────────────────────────────────────────

const REPO_ROOT = resolve(new URL('../../', import.meta.url).pathname);

function workflowPath(name: string): string {
  return resolve(REPO_ROOT, '.github', 'workflows', name);
}

// ── YAML `paths:` parser ──────────────────────────────────────────────────────

/**
 * Extracts the first `paths:` list from a GitHub Actions workflow YAML.
 * Works by finding `paths:` under an `on: push:` or `on: pull_request:`
 * trigger and collecting the indented list entries that follow.
 *
 * This is intentionally a simple line-based parser — it only needs to handle
 * the subset of YAML produced by these workflow files.
 */
function parseWorkflowPaths(yamlContent: string): string[] {
  const lines = yamlContent.split('\n');
  const patterns: string[] = [];
  let inPathsBlock = false;
  let pathsIndent = -1;

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Detect the start of a `paths:` block (any indentation level).
    if (!inPathsBlock && /^\s+paths:\s*$/.test(trimmed)) {
      inPathsBlock = true;
      pathsIndent = -1; // Will be set from the first list item.
      continue;
    }

    if (inPathsBlock) {
      // List item: `      - "some/glob/**"`
      const m = trimmed.match(/^(\s+)-\s+"(.+)"$/);
      if (m) {
        if (pathsIndent === -1) pathsIndent = m[1].length;
        // Stop collecting if we've moved to a shallower indent level.
        if (m[1].length < pathsIndent) { inPathsBlock = false; continue; }
        patterns.push(m[2]);
        continue;
      }
      // A non-list line at or outside the block indent ends the block.
      const indent = trimmed.match(/^(\s*)/)?.[1].length ?? 0;
      if (trimmed !== '' && indent <= (pathsIndent === -1 ? 0 : pathsIndent - 2)) {
        inPathsBlock = false;
      }
    }
  }

  return patterns;
}

// ── GitHub Actions glob matcher ───────────────────────────────────────────────

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

/**
 * Returns true if `filePath` matches any pattern in `patterns`, using the same
 * semantics as GitHub Actions `paths:` filters.
 */
function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  return patterns.some(p => globToRegExp(p).test(filePath));
}

// ── helpers ───────────────────────────────────────────────────────────────────

function loadPatterns(workflowName: string): string[] {
  const content = readFileSync(workflowPath(workflowName), 'utf8');
  const patterns = parseWorkflowPaths(content);
  assert.ok(
    patterns.length > 0,
    `No paths: patterns found in ${workflowName}`,
  );
  return patterns;
}

function assertTriggers(
  desc: string,
  file: string,
  patterns: string[],
): void {
  assert.ok(
    matchesAnyPattern(file, patterns),
    `Expected "${file}" to match at least one path pattern, but it matched none.\n` +
      `  Patterns checked:\n${patterns.map(p => `    - ${p}`).join('\n')}`,
  );
}

function assertDoesNotTrigger(
  desc: string,
  file: string,
  patterns: string[],
): void {
  assert.ok(
    !matchesAnyPattern(file, patterns),
    `Expected "${file}" NOT to match any path pattern, but it matched.\n` +
      `  Matching pattern(s):\n` +
      patterns
        .filter(p => globToRegExp(p).test(file))
        .map(p => `    - ${p}`)
        .join('\n'),
  );
}

// ── glob matcher unit tests ───────────────────────────────────────────────────

describe('globToRegExp — unit tests', () => {
  test('literal path matches exactly', () => {
    const re = globToRegExp('scripts/sync-standalone.sh');
    assert.ok(re.test('scripts/sync-standalone.sh'));
    assert.ok(!re.test('scripts/sync-standalone.sh.bak'));
    assert.ok(!re.test('other/sync-standalone.sh'));
  });

  test('** matches across directory boundaries', () => {
    const re = globToRegExp('artifacts/travel-buddy/src/**');
    assert.ok(re.test('artifacts/travel-buddy/src/screens/Home.tsx'));
    assert.ok(re.test('artifacts/travel-buddy/src/lib/supabase.ts'));
    assert.ok(re.test('artifacts/travel-buddy/src/index.ts'));
    assert.ok(!re.test('artifacts/api-server/src/routes/trips.ts'));
    assert.ok(!re.test('artifacts/travel-buddy/app/index.tsx'));
  });

  test('* does not cross directory boundaries', () => {
    const re = globToRegExp('artifacts/travel-buddy/*.json');
    assert.ok(re.test('artifacts/travel-buddy/package.json'));
    assert.ok(!re.test('artifacts/travel-buddy/src/config.json'));
  });

  test('self-reference workflow path matches exactly', () => {
    const re = globToRegExp('.github/workflows/sync-standalone-check.yml');
    assert.ok(re.test('.github/workflows/sync-standalone-check.yml'));
    assert.ok(!re.test('.github/workflows/standalone-drift.yml'));
  });
});

// ── sync-standalone-check.yml path filter tests ───────────────────────────────

describe('sync-standalone-check.yml — paths filter', () => {
  let patterns: string[];

  // Load once; individual tests use the cached list.
  test('workflow file is parseable and has path patterns', () => {
    patterns = loadPatterns('sync-standalone-check.yml');
  });

  test('TRIGGERS: artifacts/travel-buddy/src/ change', () => {
    patterns ??= loadPatterns('sync-standalone-check.yml');
    assertTriggers(
      'travel-buddy src change',
      'artifacts/travel-buddy/src/screens/TripsScreen.tsx',
      patterns,
    );
  });

  test('DOES NOT TRIGGER: artifacts/api-server/src/ change', () => {
    patterns ??= loadPatterns('sync-standalone-check.yml');
    assertDoesNotTrigger(
      'api-server src change',
      'artifacts/api-server/src/routes/trips.ts',
      patterns,
    );
  });

  test('TRIGGERS: scripts/sync-standalone.sh change', () => {
    patterns ??= loadPatterns('sync-standalone-check.yml');
    assertTriggers(
      'sync script change',
      'scripts/sync-standalone.sh',
      patterns,
    );
  });

  test('TRIGGERS: self-reference (.github/workflows/sync-standalone-check.yml)', () => {
    patterns ??= loadPatterns('sync-standalone-check.yml');
    assertTriggers(
      'workflow self-ref',
      '.github/workflows/sync-standalone-check.yml',
      patterns,
    );
  });
});

// ── standalone-drift.yml path filter tests ────────────────────────────────────

describe('standalone-drift.yml — paths filter', () => {
  let patterns: string[];

  test('workflow file is parseable and has path patterns', () => {
    patterns = loadPatterns('standalone-drift.yml');
  });

  test('TRIGGERS: artifacts/travel-buddy/src/ change', () => {
    patterns ??= loadPatterns('standalone-drift.yml');
    assertTriggers(
      'travel-buddy src change',
      'artifacts/travel-buddy/src/screens/TripsScreen.tsx',
      patterns,
    );
  });

  test('DOES NOT TRIGGER: artifacts/api-server/src/ change', () => {
    patterns ??= loadPatterns('standalone-drift.yml');
    assertDoesNotTrigger(
      'api-server src change',
      'artifacts/api-server/src/routes/trips.ts',
      patterns,
    );
  });

  test('TRIGGERS: scripts/sync-standalone.sh change', () => {
    patterns ??= loadPatterns('standalone-drift.yml');
    assertTriggers(
      'sync script change',
      'scripts/sync-standalone.sh',
      patterns,
    );
  });

  test('TRIGGERS: self-reference (.github/workflows/standalone-drift.yml)', () => {
    patterns ??= loadPatterns('standalone-drift.yml');
    assertTriggers(
      'workflow self-ref',
      '.github/workflows/standalone-drift.yml',
      patterns,
    );
  });
});

// ── extra edge-case paths ─────────────────────────────────────────────────────

describe('sync-standalone-check.yml — additional boundary cases', () => {
  let patterns: string[];

  test('setup', () => {
    patterns = loadPatterns('sync-standalone-check.yml');
  });

  test('TRIGGERS: travel-buddy-standalone/src/ change', () => {
    patterns ??= loadPatterns('sync-standalone-check.yml');
    assertTriggers(
      'standalone src change',
      'travel-buddy-standalone/src/lib/supabase.ts',
      patterns,
    );
  });

  test('DOES NOT TRIGGER: artifacts/api-server/package.json', () => {
    patterns ??= loadPatterns('sync-standalone-check.yml');
    assertDoesNotTrigger(
      'api-server package.json',
      'artifacts/api-server/package.json',
      patterns,
    );
  });

  test('DOES NOT TRIGGER: README.md at repo root', () => {
    patterns ??= loadPatterns('sync-standalone-check.yml');
    assertDoesNotTrigger('repo root README', 'README.md', patterns);
  });

  test('TRIGGERS: pnpm-workspace.yaml', () => {
    patterns ??= loadPatterns('sync-standalone-check.yml');
    assertTriggers('workspace manifest', 'pnpm-workspace.yaml', patterns);
  });

  test('TRIGGERS: artifacts/travel-buddy/app/ change', () => {
    patterns ??= loadPatterns('sync-standalone-check.yml');
    assertTriggers(
      'travel-buddy app dir change',
      'artifacts/travel-buddy/app/(tabs)/index.tsx',
      patterns,
    );
  });
});
