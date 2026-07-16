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
 *     artifacts/travel-buddy/src/**\/__helpers__\/*.ts
 *     artifacts/travel-buddy/src/**\/__testUtils__\/*.ts
 *     artifacts/travel-buddy/src/**\/__support__\/*.ts
 *     travel-buddy-standalone/src/**\/*.test.ts
 *     travel-buddy-standalone/src/**\/__fixtures__\/*.ts
 *     travel-buddy-standalone/src/**\/__mocks__\/*.ts
 *     travel-buddy-standalone/src/**\/__helpers__\/*.ts
 *     travel-buddy-standalone/src/**\/__testUtils__\/*.ts
 *     travel-buddy-standalone/src/**\/__support__\/*.ts
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
  // path.resolve, path.join, pathResolve, and fileURLToPath are unambiguous —
  // they are always path-computing calls regardless of imports.
  const unambiguousPat = new RegExp(
    `\\b(?:const|let|var)\\s+${identifier}\\s*=\\s*(?:path\\.resolve|path\\.join|pathResolve|fileURLToPath)\\s*\\(([^)]*)\\)`,
  );
  const um = unambiguousPat.exec(fileContent);
  if (um) {
    // Guard against a broken intermediate chain: when the first argument is a
    // plain identifier, check whether that identifier is itself assigned from a
    // bare resolve()/join() that is NOT imported from 'node:path'.  If so the
    // chain is broken and we must NOT suppress the UNRESOLVABLE warning.
    const rawArgs = um[1]!;
    const firstArg = (rawArgs.split(',')[0] ?? '').trim();
    if (
      firstArg !== '__dirname' &&
      firstArg !== '__dir' &&
      /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(firstArg)
    ) {
      const baseBarePat = new RegExp(
        `\\b(?:const|let|var)\\s+${firstArg}\\s*=\\s*(resolve|join)\\s*\\(`,
      );
      const bbm = baseBarePat.exec(fileContent);
      if (bbm) {
        const fnName = bbm[1]!;
        const importPat = new RegExp(
          `import\\s*\\{[^}]*\\b${fnName}\\b[^}]*\\}\\s*from\\s*['"]node:path['"]`,
        );
        if (!importPat.test(fileContent)) {
          // The intermediate variable comes from a non-path package — the chain
          // is broken; do NOT suppress the UNRESOLVABLE warning.
          return false;
        }
      }
    }
    return true;
  }

  // Bare resolve() / join() are only path-computing when the name is imported
  // from 'node:path'.  A resolve() from a promise library (or any other
  // package) must NOT suppress the UNRESOLVABLE warning.
  const bareNamePat = new RegExp(
    `\\b(?:const|let|var)\\s+${identifier}\\s*=\\s*(resolve|join)\\s*\\(`,
  );
  const bm = bareNamePat.exec(fileContent);
  if (bm) {
    const fnName = bm[1]!;
    const importPat = new RegExp(
      `import\\s*\\{[^}]*\\b${fnName}\\b[^}]*\\}\\s*from\\s*['"]node:path['"]`,
    );
    if (importPat.test(fileContent)) return true;
  }

  return false;
}

/**
 * Tries to statically resolve `varName` to an absolute filesystem path by
 * tracing its assignment through the file.
 *
 * Handles these base cases (= the test file's own directory):
 *   - `__dirname`  (CJS global)
 *   - `const x = import.meta.dirname`
 *   - `const x = path.dirname(fileURLToPath(import.meta.url))`
 *
 * And these recursive cases (all string-literal segments):
 *   - `const x = path.resolve(base, 'seg1', 'seg2', ...)`
 *   - `const x = path.join(base, 'seg1', 'seg2', ...)`
 *
 * Returns null when any argument is dynamic or the chain cannot be traced.
 */
function tryResolveStaticVariable(
  varName: string,
  fileContent: string,
  testDir: string,
  depth = 0,
): string | null {
  if (depth > 8) return null;

  // CJS global — always equals the test file's directory.
  if (varName === '__dirname') return testDir;

  // const x = import.meta.dirname
  const metaDirnamePat = new RegExp(
    String.raw`\b(?:const|let|var)\s+${varName}\s*=\s*import\.meta\.dirname\b`,
  );
  if (metaDirnamePat.test(fileContent)) return testDir;

  // const x = path.dirname(fileURLToPath(import.meta.url))  ← ESM idiom
  const fileURLPat = new RegExp(
    String.raw`\b(?:const|let|var)\s+${varName}\s*=\s*path\.dirname\s*\(\s*fileURLToPath\s*\(`,
  );
  if (fileURLPat.test(fileContent)) return testDir;

  // const x = path.resolve(base, 'seg1', ...) or path.join(base, 'seg1', ...)
  // Capture the raw argument list between the outer parens (single-line calls only).
  const resolveCallPat = new RegExp(
    String.raw`\b(?:const|let|var)\s+${varName}\s*=\s*path\.(?:resolve|join)\s*\(([^)]+)\)`,
  );
  const m = resolveCallPat.exec(fileContent);

  // Also handle bare resolve(base, ...) / join(base, ...) when the function is
  // imported directly from 'node:path':
  //   import { resolve } from 'node:path'
  //   import { join }    from 'node:path'
  if (!m) {
    const barePat = new RegExp(
      String.raw`\b(?:const|let|var)\s+${varName}\s*=\s*(resolve|join)\s*\(([^)]+)\)`,
    );
    const bm = barePat.exec(fileContent);
    if (bm) {
      const fnName = bm[1]!;
      // Only treat as path.resolve/join if that name is imported from node:path.
      const importPat = new RegExp(
        `import\\s*\\{[^}]*\\b${fnName}\\b[^}]*\\}\\s*from\\s*['"]node:path['"]`,
      );
      if (importPat.test(fileContent)) {
        const rawArgs = bm[2]!;
        const argParts = rawArgs.split(',').map((s) => s.trim());
        if (argParts.length < 1) return null;
        const [baseArgRaw, ...segArgRaws] = argParts;
        const baseArg = baseArgRaw!.trim();
        let basePath: string;
        if (
          (baseArg.startsWith("'") && baseArg.endsWith("'")) ||
          (baseArg.startsWith('"') && baseArg.endsWith('"'))
        ) {
          const literal = baseArg.slice(1, -1);
          basePath = path.isAbsolute(literal) ? literal : path.resolve(testDir, literal);
        } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(baseArg)) {
          const resolved = tryResolveStaticVariable(baseArg, fileContent, testDir, depth + 1);
          if (resolved === null) return null;
          basePath = resolved;
        } else {
          return null;
        }
        const segments: string[] = [];
        for (const raw of segArgRaws) {
          const seg = raw.trim();
          if (
            (seg.startsWith("'") && seg.endsWith("'")) ||
            (seg.startsWith('"') && seg.endsWith('"'))
          ) {
            segments.push(seg.slice(1, -1));
          } else {
            return null;
          }
        }
        return path.resolve(basePath, ...segments);
      }
    }
    return null;
  }

  const rawArgs = m[1]!;
  // Split on top-level commas (these calls never nest beyond one level here).
  const argParts = rawArgs.split(',').map((s) => s.trim());
  if (argParts.length < 1) return null;

  const [baseArgRaw, ...segArgRaws] = argParts;
  const baseArg = baseArgRaw!.trim();

  // Resolve the base argument — either a string literal or another variable.
  let basePath: string;
  if (
    (baseArg.startsWith("'") && baseArg.endsWith("'")) ||
    (baseArg.startsWith('"') && baseArg.endsWith('"'))
  ) {
    const literal = baseArg.slice(1, -1);
    basePath = path.isAbsolute(literal) ? literal : path.resolve(testDir, literal);
  } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(baseArg)) {
    const resolved = tryResolveStaticVariable(baseArg, fileContent, testDir, depth + 1);
    if (resolved === null) return null;
    basePath = resolved;
  } else {
    return null; // complex expression — cannot resolve statically
  }

  // All remaining arguments must be plain string literals.
  const segments: string[] = [];
  for (const raw of segArgRaws) {
    const seg = raw.trim();
    if (
      (seg.startsWith("'") && seg.endsWith("'")) ||
      (seg.startsWith('"') && seg.endsWith('"'))
    ) {
      segments.push(seg.slice(1, -1));
    } else {
      return null; // dynamic segment — cannot resolve
    }
  }

  return path.resolve(basePath, ...segments);
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
export function collectHelperFiles(dir: string): string[] {
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
        if (
          parentDir === '__fixtures__' ||
          parentDir === '__mocks__' ||
          parentDir === '__helpers__' ||
          parentDir === '__testUtils__' ||
          parentDir === '__support__'
        ) {
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

      // Try to statically resolve the variable through its path.resolve/join
      // assignment chain (all-literal segments).  When successful, treat it as
      // a normal resolvable entry so the guard can existence-check it.
      const staticResolved = tryResolveStaticVariable(identifier, content, testDir);
      if (staticResolved !== null) {
        found.push({
          testFile,
          line: lineIdx + 1,
          rawArg: identifier,
          resolved: staticResolved,
        });
        continue;
      }

      // Variables assigned from path.resolve / path.join / etc. that we could
      // not fully trace (dynamic segments) are legitimate code — skip them to
      // avoid false positives.
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

  it('traces a multi-segment path.resolve variable chain and confirms the file exists', () => {
    const fixture = path.join(FIXTURES_DIR, 'cross-tree-path-resolve-valid.test.ts');
    const entries = extractCrossTreePaths(fixture);

    // pkgPath is assigned via path.resolve(pkgRoot, 'package.json') where
    // pkgRoot = path.resolve(here, '../..') and here = path.dirname(fileURLToPath(…)).
    // The guard should fully trace this chain to scripts/package.json.
    const resolvable = entries.filter((e) => !e.unresolvable);
    assert.ok(
      resolvable.length >= 1,
      'expected at least one resolvable entry in the path-resolve-valid fixture',
    );

    const entry = resolvable.find((e) => e.rawArg === 'pkgPath');
    assert.ok(
      entry,
      `expected a resolvable entry for the identifier "pkgPath"; got: ${JSON.stringify(resolvable)}`,
    );
    assert.ok(
      fs.existsSync(entry.resolved),
      `pkgPath resolved to "${entry.resolved}" which does not exist`,
    );
  });

  it('traces a multi-segment path.resolve chain to a non-existent file and marks it missing', () => {
    const fixture = path.join(FIXTURES_DIR, 'cross-tree-path-resolve-invalid.test.ts');
    const entries = extractCrossTreePaths(fixture);

    const resolvable = entries.filter((e) => !e.unresolvable);
    assert.ok(
      resolvable.length >= 1,
      'expected at least one resolvable entry in the path-resolve-invalid fixture',
    );

    const entry = resolvable.find((e) => e.rawArg === 'badPath');
    assert.ok(
      entry,
      `expected a resolvable entry for the identifier "badPath"; got: ${JSON.stringify(resolvable)}`,
    );
    assert.equal(
      fs.existsSync(entry.resolved),
      false,
      `expected the resolved path "${entry.resolved}" to be missing (it is the invalid-fixture target)`,
    );
  });

  it('traces a bare resolve() variable chain (import { resolve } from node:path) and confirms the file exists', () => {
    const fixture = path.join(FIXTURES_DIR, 'cross-tree-path-resolve-bare-import-valid.test.ts');
    const entries = extractCrossTreePaths(fixture);

    // pkgPath is assigned via resolve(pkgRoot, 'package.json') where
    // pkgRoot = resolve(here, '../..') and here = path.dirname(fileURLToPath(…)).
    // resolve is imported directly from 'node:path'.
    // The guard should trace this chain to scripts/package.json.
    const resolvable = entries.filter((e) => !e.unresolvable);
    assert.ok(
      resolvable.length >= 1,
      'expected at least one resolvable entry in the bare-import-valid fixture',
    );

    const entry = resolvable.find((e) => e.rawArg === 'pkgPath');
    assert.ok(
      entry,
      `expected a resolvable entry for the identifier "pkgPath"; got: ${JSON.stringify(resolvable)}`,
    );
    assert.ok(
      fs.existsSync(entry.resolved),
      `pkgPath resolved to "${entry.resolved}" which does not exist`,
    );
  });

  it('traces a bare join() variable chain (import { join } from node:path) and confirms the file exists', () => {
    const fixture = path.join(FIXTURES_DIR, 'cross-tree-path-join-bare-import-valid.test.ts');
    const entries = extractCrossTreePaths(fixture);

    // pkgPath is assigned via join(pkgRoot, 'package.json') where
    // pkgRoot = join(here, '../..') and here = path.dirname(fileURLToPath(…)).
    // join is imported directly from 'node:path'.
    // The guard should trace this chain to scripts/package.json.
    const resolvable = entries.filter((e) => !e.unresolvable);
    assert.ok(
      resolvable.length >= 1,
      'expected at least one resolvable entry in the bare-join-import-valid fixture',
    );

    const entry = resolvable.find((e) => e.rawArg === 'pkgPath');
    assert.ok(
      entry,
      `expected a resolvable entry for the identifier "pkgPath"; got: ${JSON.stringify(resolvable)}`,
    );
    assert.ok(
      fs.existsSync(entry.resolved),
      `pkgPath resolved to "${entry.resolved}" which does not exist`,
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

  it('flags an identifier assigned from resolve() imported outside node:path as unresolvable', () => {
    // cross-tree-non-path-resolve.test.ts imports `resolve` from 'some-promise-lib',
    // not from 'node:path'.  The guard must NOT treat this as a path-computing
    // call and must emit an UNRESOLVABLE entry for `crossTreePath`.
    const fixture = path.join(FIXTURES_DIR, 'cross-tree-non-path-resolve.test.ts');
    const entries = extractCrossTreePaths(fixture);

    const unresolvableEntries = entries.filter((e) => e.unresolvable === true);
    assert.ok(
      unresolvableEntries.length >= 1,
      `expected at least one UNRESOLVABLE entry when resolve() comes from a non-path package; got: ${JSON.stringify(entries)}`,
    );

    const entry = unresolvableEntries.find((e) => e.rawArg === 'crossTreePath');
    assert.ok(
      entry,
      `expected an unresolvable entry for "crossTreePath"; got: ${JSON.stringify(unresolvableEntries)}`,
    );
  });

  it('flags an identifier assigned from join() imported outside node:path as unresolvable', () => {
    // cross-tree-non-path-join.test.ts imports `join` from 'some-array-lib',
    // not from 'node:path'.  The guard must NOT treat this as a path-computing
    // call and must emit an UNRESOLVABLE entry for `crossTreePath`.
    const fixture = path.join(FIXTURES_DIR, 'cross-tree-non-path-join.test.ts');
    const entries = extractCrossTreePaths(fixture);

    const unresolvableEntries = entries.filter((e) => e.unresolvable === true);
    assert.ok(
      unresolvableEntries.length >= 1,
      `expected at least one UNRESOLVABLE entry when join() comes from a non-path package; got: ${JSON.stringify(entries)}`,
    );

    const entry = unresolvableEntries.find((e) => e.rawArg === 'crossTreePath');
    assert.ok(
      entry,
      `expected an unresolvable entry for "crossTreePath"; got: ${JSON.stringify(unresolvableEntries)}`,
    );
  });

  it('flags pkg as unresolvable when an intermediate variable uses a non-path resolve() in a chain', () => {
    // cross-tree-non-path-resolve-chain.test.ts has:
    //   const root = resolve('../../../')          ← resolve from 'some-promise-lib'
    //   const pkg  = path.resolve(root, 'package.json')
    //   fs.readFileSync(pkg, 'utf8')
    //
    // Because `root` is produced by a non-path resolve(), tryResolveStaticVariable
    // cannot trace the chain to a static path and returns null.  The guard must
    // then NOT suppress the UNRESOLVABLE warning via isAssignedFromPathResolver —
    // it must flag `pkg` as unresolvable so the broken chain is visible.
    const fixture = path.join(FIXTURES_DIR, 'cross-tree-non-path-resolve-chain.test.ts');
    const entries = extractCrossTreePaths(fixture);

    const unresolvableEntries = entries.filter((e) => e.unresolvable === true);
    assert.ok(
      unresolvableEntries.length >= 1,
      `expected at least one UNRESOLVABLE entry when path.resolve() chains through a non-path resolve(); got: ${JSON.stringify(entries)}`,
    );

    const entry = unresolvableEntries.find((e) => e.rawArg === 'pkg');
    assert.ok(
      entry,
      `expected an unresolvable entry for the identifier "pkg"; got: ${JSON.stringify(unresolvableEntries)}`,
    );
  });

  it('detects a broken cross-tree path in a __helpers__-style non-test file', () => {
    // cross-tree-helpers-style-broken.ts simulates the kind of helper that
    // would live inside a __helpers__, __testUtils__, or __support__ directory.
    // It contains an intentionally broken readFileSync path.  This test verifies
    // that extractCrossTreePaths catches broken paths in such files — mirroring
    // what the expanded collectHelperFiles scan now does for those directories
    // in addition to __fixtures__ and __mocks__.
    const fixture = path.join(FIXTURES_DIR, 'cross-tree-helpers-style-broken.ts');
    const entries = extractCrossTreePaths(fixture);

    const brokenEntries = entries.filter(
      (e) => !e.unresolvable && e.rawArg.includes('this-helpers-style-file-does-not-exist'),
    );
    assert.ok(
      brokenEntries.length >= 1,
      'expected at least one resolvable entry referencing "this-helpers-style-file-does-not-exist" in the __helpers__-style broken fixture',
    );

    const entry = brokenEntries[0]!;
    assert.equal(
      fs.existsSync(entry.resolved),
      false,
      `expected the resolved path "${entry.resolved}" to be missing (intentionally broken __helpers__-style fixture)`,
    );
  });
});

// ── Tests: collectHelperFiles directory-name matching ─────────────────────────

describe('collectHelperFiles — directory-name matching for __testUtils__ and __support__', () => {
  /**
   * These tests confirm that collectHelperFiles picks up .ts files placed inside
   * __testUtils__ and __support__ directories, not just __fixtures__ and __mocks__.
   * They use temporary directories so no permanent files need to live in the
   * source tree solely to exercise the guard.
   */

  function withTempTree(
    structure: Record<string, string>,
    fn: (tmpRoot: string) => void,
  ): void {
    const tmpRoot = fs.mkdtempSync(path.join(import.meta.dirname, '__tmp-'));
    try {
      for (const [rel, content] of Object.entries(structure)) {
        const full = path.join(tmpRoot, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
      }
      fn(tmpRoot);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  it('collects .ts files from a __testUtils__ directory', () => {
    withTempTree(
      {
        'src/__testUtils__/testHelper.ts': '// test utility\nexport const foo = 1;\n',
        'src/__testUtils__/anotherHelper.ts': '// another utility\nexport const bar = 2;\n',
      },
      (tmpRoot) => {
        const srcDir = path.join(tmpRoot, 'src');
        const found = collectHelperFiles(srcDir);
        assert.ok(
          found.some((f) => f.endsWith('testHelper.ts')),
          `expected "testHelper.ts" to be collected; got: ${JSON.stringify(found)}`,
        );
        assert.ok(
          found.some((f) => f.endsWith('anotherHelper.ts')),
          `expected "anotherHelper.ts" to be collected; got: ${JSON.stringify(found)}`,
        );
      },
    );
  });

  it('collects .ts files from a __support__ directory', () => {
    withTempTree(
      {
        'src/__support__/supportUtil.ts': '// support utility\nexport const baz = 3;\n',
      },
      (tmpRoot) => {
        const srcDir = path.join(tmpRoot, 'src');
        const found = collectHelperFiles(srcDir);
        assert.ok(
          found.some((f) => f.endsWith('supportUtil.ts')),
          `expected "supportUtil.ts" to be collected; got: ${JSON.stringify(found)}`,
        );
      },
    );
  });

  it('collects .ts files from __testUtils__, __support__, and __helpers__ in one tree', () => {
    withTempTree(
      {
        'src/__testUtils__/a.ts': 'export const a = 1;\n',
        'src/__support__/b.ts': 'export const b = 2;\n',
        'src/__helpers__/c.ts': 'export const c = 3;\n',
        // These should NOT be collected (wrong directory name).
        'src/utils/d.ts': 'export const d = 4;\n',
        'src/e.ts': 'export const e = 5;\n',
      },
      (tmpRoot) => {
        const srcDir = path.join(tmpRoot, 'src');
        const found = collectHelperFiles(srcDir);
        assert.ok(
          found.some((f) => f.endsWith('a.ts')),
          `expected __testUtils__/a.ts to be collected; got: ${JSON.stringify(found)}`,
        );
        assert.ok(
          found.some((f) => f.endsWith('b.ts')),
          `expected __support__/b.ts to be collected; got: ${JSON.stringify(found)}`,
        );
        assert.ok(
          found.some((f) => f.endsWith('c.ts')),
          `expected __helpers__/c.ts to be collected; got: ${JSON.stringify(found)}`,
        );
        assert.equal(
          found.filter((f) => f.endsWith('d.ts') || f.endsWith('e.ts')).length,
          0,
          `utils/ and src-root .ts files must not be collected; got: ${JSON.stringify(found)}`,
        );
      },
    );
  });

  it('does not collect .test.ts files inside __testUtils__ or __support__', () => {
    withTempTree(
      {
        'src/__testUtils__/helper.ts': 'export const h = 1;\n',
        'src/__testUtils__/helper.test.ts': 'import assert from "node:assert/strict";\n',
        'src/__support__/stub.ts': 'export const s = 2;\n',
        'src/__support__/stub.test.ts': 'import assert from "node:assert/strict";\n',
      },
      (tmpRoot) => {
        const srcDir = path.join(tmpRoot, 'src');
        const found = collectHelperFiles(srcDir);
        const testFilesInFound = found.filter(
          (f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx'),
        );
        assert.equal(
          testFilesInFound.length,
          0,
          `.test.ts files must not be returned by collectHelperFiles; got: ${JSON.stringify(testFilesInFound)}`,
        );
        // But the plain .ts helpers must be present.
        assert.ok(
          found.some((f) => f.endsWith('helper.ts') && !f.endsWith('.test.ts')),
          `expected __testUtils__/helper.ts to be collected; got: ${JSON.stringify(found)}`,
        );
        assert.ok(
          found.some((f) => f.endsWith('stub.ts') && !f.endsWith('.test.ts')),
          `expected __support__/stub.ts to be collected; got: ${JSON.stringify(found)}`,
        );
      },
    );
  });
});
