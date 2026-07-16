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
 *   - readFileSync(`${__dir}/...`, ...) calls  ← template-literal form
 *   - readFileSync(`${__dirname}/...`, ...) calls  ← template-literal form
 *   Only paths that contain '..' are flagged as cross-tree candidates; pure
 *   local imports (e.g. './foo') that stay inside the test file's own dir are
 *   skipped (they are covered by the TypeScript compiler).
 *
 *   Additionally, readFileSync calls whose path argument is a plain identifier
 *   (a variable the guard cannot statically resolve) are flagged as
 *   UNRESOLVABLE — the test fails with an explicit message rather than
 *   silently missing a broken path.
 *
 * SCOPE:
 *   Both canonical trees:
 *     artifacts/travel-buddy/src/**\/*.test.ts
 *     artifacts/travel-buddy/src/**\/__fixtures__\/*.ts
 *     artifacts/travel-buddy/src/**\/__mocks__\/*.ts
 *     travel-buddy-standalone/src/**\/*.test.ts
 *     travel-buddy-standalone/src/**\/__fixtures__\/*.ts
 *     travel-buddy-standalone/src/**\/__mocks__\/*.ts
 *
 *   Explicitly NOT scanned:
 *     scripts/src/__fixtures__/  ← guard input files, not guard targets
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
 * Patterns for statically-resolvable cross-tree path reads.
 *
 * Each pattern must have exactly one capture group that yields the relative
 * path suffix (without quotes or the leading `${__dir}/` sigil).
 *
 * Supported forms:
 *   readPkg('../../some/path')
 *   readPkg("../../some/path")
 *   readFileSync(pathResolve(__dir, '../../some/path'), ...)
 *   readFileSync(resolve(__dirname, "../../some/path"), ...)
 *   readFileSync(`${__dir}/../../some/path`, ...)        ← template literal
 *   readFileSync(`${__dirname}/../../some/path`, ...)    ← template literal
 */
const PATH_PATTERNS: RegExp[] = [
  // readPkg('...')  or  readPkg("...")
  /\breadPkg\(\s*['"]([^'"]+)['"]\s*\)/g,

  // readFileSync(pathResolve(__dir, '...') or resolve(__dirname, "...")
  /\breadFileSync\(\s*(?:pathResolve|resolve)\(\s*(?:__dir|__dirname)\s*,\s*['"]([^'"]+)['"]\s*\)/g,

  // readFileSync(`${__dir}/...`)  or  readFileSync(`${__dirname}/...`)
  // The capture group starts AFTER the mandatory "/" separator so the value
  // is a plain relative path (e.g. "../../some/path") with no leading slash.
  /\breadFileSync\(\s*`\$\{(?:__dir|__dirname)\}\/([^`]+)`/g,
];

/**
 * Pattern for readFileSync calls whose first argument is a plain identifier
 * (a variable) rather than a recognisable static literal.  The guard cannot
 * resolve these at analysis time, so it emits an UNRESOLVABLE warning instead
 * of silently skipping the call.
 *
 * Excluded from matching (negative lookahead):
 *   - string literals         '  "  `
 *   - known resolver helpers  pathResolve(  resolve(  path.resolve(  path.join(
 */
const NON_LITERAL_PATTERN =
  /\breadFileSync\(\s*(?!['"`]|(?:pathResolve|resolve|path\.resolve|path\.join)\s*\()([A-Za-z_$][A-Za-z0-9_$.]*)\s*[,)]/g;

/**
 * Returns true when `identifier` is assigned from a path-computing call
 * (path.resolve, path.join, resolve, pathResolve, or fileURLToPath) anywhere
 * in `fileContent`.  Such variables hold computed absolute or relative paths —
 * the guard cannot inline-verify them, but they are legitimate code, not
 * accidental dynamic strings, so they should not trigger an unresolvable
 * warning.
 */
function isAssignedFromPathResolver(identifier: string, fileContent: string): boolean {
  // Match:  const/let/var <identifier> = <resolver>(
  const pat = new RegExp(
    `\\b(?:const|let|var)\\s+${identifier}\\s*=\\s*(?:path\\.resolve|path\\.join|resolve|pathResolve|fileURLToPath)\\s*\\(`,
  );
  return pat.test(fileContent);
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExtractedPath {
  testFile: string;
  line: number;
  /** The captured path argument (or identifier name for unresolvable entries). */
  rawArg: string;
  /**
   * Absolute path the guard resolved, or an empty string when the entry is
   * unresolvable (see `unresolvable`).
   */
  resolved: string;
  /**
   * True when the first argument of readFileSync is a plain variable that the
   * guard cannot statically resolve.  The test fails with an explicit message
   * prompting the author to switch to a static literal form.
   */
  unresolvable?: true;
}

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

/**
 * Collect all `.ts` / `.tsx` helper files that live inside a `__fixtures__`
 * or `__mocks__` directory anywhere under `dir`.
 *
 * These are not test files themselves, but they are imported by tests and can
 * contain their own readFileSync cross-tree reads.  A broken path in one of
 * them propagates silently to every test that imports it, so the guard must
 * check them too.
 *
 * NOTE: scripts/src/__fixtures__/ is intentionally excluded — it lives outside
 * TEST_ROOTS and holds guard input fixtures, not application helper code.
 */
function collectHelperFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.expo') continue;
        walk(full);
      } else if (
        (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.test.tsx')
      ) {
        const parentDir = path.basename(d);
        if (parentDir === '__fixtures__' || parentDir === '__mocks__') {
          results.push(full);
        }
      }
    }
  }
  walk(dir);
  return results;
}

/**
 * Scan a single test file and return every cross-tree path read found in it.
 *
 * Returns two kinds of entries:
 *  1. Resolvable entries — the guard has a resolved absolute path and can
 *     check whether the file exists.
 *  2. Unresolvable entries (`unresolvable: true`) — the readFileSync argument
 *     is a plain identifier; the guard cannot inspect it statically.
 */
export function extractCrossTreePaths(testFile: string): ExtractedPath[] {
  const content = fs.readFileSync(testFile, 'utf8');
  const lines = content.split('\n');
  const testDir = path.dirname(testFile);
  const found: ExtractedPath[] = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;

    // ── 1. Statically-resolvable patterns ──────────────────────────────────
    for (const pattern of PATH_PATTERNS) {
      // Reset lastIndex for global regex reuse across lines
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

    // ── 2. Non-literal (unresolvable) detection ────────────────────────────
    NON_LITERAL_PATTERN.lastIndex = 0;
    let nlMatch: RegExpExecArray | null;
    while ((nlMatch = NON_LITERAL_PATTERN.exec(line)) !== null) {
      const identifier = nlMatch[1]!;
      // Variables assigned from path.resolve / path.join / etc. hold computed
      // paths the guard cannot inline-verify, but they are intentional code —
      // not plain mis-typed strings.  Skip them to avoid false positives.
      if (isAssignedFromPathResolver(identifier, content)) continue;
      found.push({
        testFile,
        line: lineIdx + 1,
        rawArg: identifier,
        resolved: '',
        unresolvable: true,
      });
    }
  }

  return found;
}

// ── Tests: live tree scan ─────────────────────────────────────────────────────

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
        const unresolvable: string[] = [];

        for (const cp of crosspaths) {
          if (cp.unresolvable) {
            unresolvable.push(
              `  line ${cp.line}: readFileSync(${cp.rawArg}, ...)\n` +
              `    '${cp.rawArg}' is a variable — the guard cannot verify it statically.\n` +
              `    Replace it with a static literal or template-literal (\`\${__dir}/...\`) form.`,
            );
          } else if (!fs.existsSync(cp.resolved)) {
            missing.push(
              `  line ${cp.line}: readPkg/readFileSync('${cp.rawArg}')\n` +
              `    resolved → ${cp.resolved}\n` +
              `    (file does not exist)`,
            );
          }
        }

        const problems = [...unresolvable, ...missing];
        if (problems.length > 0) {
          assert.fail(
            `${problems.length} cross-tree path issue(s) in ${relFile}:\n\n` +
            problems.join('\n\n') +
            '\n\nFix the path so the guard can verify it statically.',
          );
        }
      });
    }

    // ── Helper files: __fixtures__ and __mocks__ under this root ─────────────
    const helperFiles = collectHelperFiles(root);

    for (const helperFile of helperFiles) {
      const relFile = path.relative(WORKSPACE_ROOT, helperFile);
      const crosspaths = extractCrossTreePaths(helperFile);

      if (crosspaths.length === 0) continue;

      it(`all cross-tree paths in ${relFile} resolve to existing files`, () => {
        const missing: string[] = [];
        const unresolvable: string[] = [];

        for (const cp of crosspaths) {
          if (cp.unresolvable) {
            unresolvable.push(
              `  line ${cp.line}: readFileSync(${cp.rawArg}, ...)\n` +
              `    '${cp.rawArg}' is a variable — the guard cannot verify it statically.\n` +
              `    Replace it with a static literal or template-literal (\`\${__dir}/...\`) form.`,
            );
          } else if (!fs.existsSync(cp.resolved)) {
            missing.push(
              `  line ${cp.line}: readPkg/readFileSync('${cp.rawArg}')\n` +
              `    resolved → ${cp.resolved}\n` +
              `    (file does not exist)`,
            );
          }
        }

        const problems = [...unresolvable, ...missing];
        if (problems.length > 0) {
          assert.fail(
            `${problems.length} cross-tree path issue(s) in ${relFile}:\n\n` +
            problems.join('\n\n') +
            '\n\nFix the path so the guard can verify it statically.',
          );
        }
      });
    }
  }
});

// ── Tests: fixture-based unit tests ──────────────────────────────────────────

const FIXTURES_DIR = path.join(import.meta.dirname, '__fixtures__');

describe('extractCrossTreePaths — template-literal and non-literal detection', () => {
  it('detects a valid template-literal ${__dir}/... path and confirms the file exists', () => {
    const fixture = path.join(FIXTURES_DIR, 'cross-tree-template-literal-valid.test.ts');
    const entries = extractCrossTreePaths(fixture);

    // The fixture has exactly one `${__dir}/../../package.json` reference.
    const templateEntries = entries.filter((e) => !e.unresolvable);
    assert.ok(
      templateEntries.length >= 1,
      'expected at least one resolvable template-literal entry in the valid fixture',
    );

    const entry = templateEntries.find((e) => e.rawArg.includes('package.json'));
    assert.ok(entry, 'expected an entry whose rawArg includes "package.json"');
    assert.ok(
      fs.existsSync(entry.resolved),
      `template-literal path resolved to "${entry.resolved}" which does not exist`,
    );
  });

  it('detects a template-literal path pointing at a non-existent file', () => {
    const fixture = path.join(FIXTURES_DIR, 'cross-tree-template-literal-invalid.test.ts');
    const entries = extractCrossTreePaths(fixture);

    const templateEntries = entries.filter((e) => !e.unresolvable);
    assert.ok(
      templateEntries.length >= 1,
      'expected at least one resolvable template-literal entry in the invalid fixture',
    );

    const entry = templateEntries.find((e) => e.rawArg.includes('this-file-does-not-exist'));
    assert.ok(entry, 'expected an entry whose rawArg includes "this-file-does-not-exist"');
    assert.equal(
      fs.existsSync(entry.resolved),
      false,
      `expected the resolved path "${entry.resolved}" to be missing (it is the invalid-fixture target)`,
    );
  });

  it('flags a plain-variable readFileSync argument as unresolvable', () => {
    const fixture = path.join(FIXTURES_DIR, 'cross-tree-dynamic-path.test.ts');
    const entries = extractCrossTreePaths(fixture);

    const unresolvableEntries = entries.filter((e) => e.unresolvable === true);
    assert.ok(
      unresolvableEntries.length >= 1,
      'expected at least one unresolvable entry in the dynamic-path fixture',
    );

    const entry = unresolvableEntries.find((e) => e.rawArg === 'crossTreePath');
    assert.ok(
      entry,
      `expected an unresolvable entry for the identifier "crossTreePath"; got: ${JSON.stringify(unresolvableEntries)}`,
    );
  });

  it('does not flag readFileSync with a recognised resolver helper as unresolvable', () => {
    // Inline source with both a valid resolve() call and no plain identifiers.
    const tmpFile = path.join(FIXTURES_DIR, '__tmp-resolver-only.test.ts');
    fs.writeFileSync(
      tmpFile,
      `import fs from 'node:fs';\nconst c = fs.readFileSync(resolve(__dirname, '../../package.json'), 'utf8');\n`,
    );
    try {
      const entries = extractCrossTreePaths(tmpFile);
      const unresolvable = entries.filter((e) => e.unresolvable === true);
      assert.equal(
        unresolvable.length,
        0,
        `resolve(__dirname, ...) should not be flagged as unresolvable; got: ${JSON.stringify(unresolvable)}`,
      );
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('detects a broken cross-tree path in a non-test helper fixture file', () => {
    // cross-tree-helper-broken.ts is a plain .ts helper (not .test.ts) that
    // lives in scripts/src/__fixtures__/.  It contains an intentionally broken
    // readFileSync path.  This test verifies that extractCrossTreePaths works
    // on non-test files too — exactly the same analysis the live helper-file
    // scan applies to __fixtures__ / __mocks__ files under the tree roots.
    const fixture = path.join(FIXTURES_DIR, 'cross-tree-helper-broken.ts');
    const entries = extractCrossTreePaths(fixture);

    const brokenEntries = entries.filter(
      (e) => !e.unresolvable && e.rawArg.includes('this-helper-does-not-exist'),
    );
    assert.ok(
      brokenEntries.length >= 1,
      'expected at least one resolvable entry referencing "this-helper-does-not-exist" in the broken helper fixture',
    );

    const entry = brokenEntries[0]!;
    assert.equal(
      fs.existsSync(entry.resolved),
      false,
      `expected the resolved path "${entry.resolved}" to be missing (intentionally broken helper fixture)`,
    );
  });
});
