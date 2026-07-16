/**
 * Static guard: no file in the scanned source directories may call
 * supabase.auth.getSession() to obtain an access token.
 *
 * `freshToken()` in apiToken.ts is the only place that may read getSession()
 * and then hand the resulting access_token to the API server.  Any file
 * that calls getSession() *and* extracts access_token from the result bypasses
 * the proactive-refresh logic and can silently send an expired token.
 *
 * Scanned directories (all under src/):
 *   - services/  — API helpers and data-fetching utilities
 *   - hooks/     — React hooks (useRecentPlaces, etc.)
 *   - lib/       — Shared library utilities (resolveCanonical, etc.)
 *
 * This test reads every .ts file in those directories (excluding apiToken.ts,
 * which is the helper itself) and asserts that no such file contains both
 * `getSession` and an `access_token` extraction from its result.
 *
 * Legitimate uses of getSession() — e.g. reading `session.user.id` to build a
 * storage path — do not touch access_token and therefore pass this check.
 *
 * A companion guard (below) additionally scans the entire src/ tree for
 * locally-defined functions whose body contains both strings — catching
 * wrappers placed outside the primary scanned directories.
 *
 * Run with:
 *   node --import tsx/esm --test \
 *     src/services/__tests__/getSession.bypassGuard.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { join, relative } from 'node:path';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Recursively collect all .ts and .tsx files under `dir`. */
function collectTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTs(full, out);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Returns true when `src` contains a pattern that indicates getSession() is
 * being used to extract an access token — the only forbidden use.
 *
 * Detection strategy:
 *   1. The file contains `getSession` (it calls or references the method).
 *   2. The file also contains `access_token` (extracted from the result).
 *
 * Legitimate getSession() calls (reading user.id for a storage path, etc.)
 * never touch access_token, so they pass cleanly.
 */
function bypassesTokenHelper(src: string): boolean {
  return src.includes('getSession') && src.includes('access_token');
}

/**
 * Extracts the text of every brace-delimited function body found in `src`.
 *
 * Uses a simple brace-counting walk — not a full AST parser — but sufficient
 * for this guard.  Matches all common function definition forms:
 *   - `function name(`
 *   - `async function name(`
 *   - `const name = (async)? function(`
 *   - `const name = (async)? (args) => {`
 *   - `const name = async arg => {`
 *   - method shorthand `name(` inside class/object bodies
 */
function extractFunctionBodies(src: string): string[] {
  // Regex that matches the start of a function definition.
  // We do NOT rely on the regex to capture the full body — it only locates
  // the start position; brace counting does the rest.
  const fnStart =
    /(?:(?:async\s+)?function\s*\w*\s*\(|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:function\s*\(|\([^)]*\)\s*=>|\w+\s*=>))/g;

  const bodies: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = fnStart.exec(src)) !== null) {
    // Scan forward from the end of the match to find the opening `{`.
    let i = match.index + match[0].length;
    while (i < src.length && src[i] !== '{' && src[i] !== '\n') i++;
    if (i >= src.length || src[i] !== '{') continue; // arrow with expression body — no block

    // Walk the block counting braces to find the matching `}`.
    let depth = 0;
    const start = i;
    while (i < src.length) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      i++;
    }
    bodies.push(src.slice(start, i));
  }

  return bodies;
}

/**
 * Extracts the expression text of every expression-body arrow function found
 * in `src` (i.e. arrows without a brace-delimited block: `() => expr`).
 *
 * Scans forward from the end of the arrow (`=>`) token, skipping whitespace
 * (including newlines, so multi-line expressions like `() =>\n  expr;` are
 * captured in full).  Collection stops at a semicolon or an unmatched closing
 * paren/bracket at depth 0.  Nested calls such as `.then(...)` are included
 * because their parens raise the depth above 0.
 *
 * Complements `extractFunctionBodies`, which only handles block bodies (`{…}`).
 */
function extractExpressionArrowBodies(src: string): string[] {
  // Matches the declarator + arrow of an expression-body arrow function.
  // Must NOT capture the `{` that a block-body arrow would have next.
  const fnStart =
    /(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/g;

  const bodies: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = fnStart.exec(src)) !== null) {
    let i = match.index + match[0].length;

    // Skip all whitespace (including newlines) to reach the expression start.
    while (i < src.length && /\s/.test(src[i])) i++;

    // If the next non-space character is `{` this is a block body — already
    // handled by extractFunctionBodies; skip it here to avoid double-counting.
    if (i >= src.length || src[i] === '{') continue;

    // Collect the expression body, tracking paren/bracket nesting so that
    // nested calls like `.then(…)` are fully included.
    let depth = 0;
    const start = i;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '(' || ch === '[') {
        depth++;
      } else if (ch === ')' || ch === ']') {
        if (depth > 0) {
          depth--;
        } else {
          // Unmatched closing delimiter — we have stepped outside the
          // expression (e.g. the arrow is itself inside a call argument).
          break;
        }
      } else if (ch === ';' && depth === 0) {
        break;
      }
      i++;
    }
    if (i > start) {
      bodies.push(src.slice(start, i));
    }
  }

  return bodies;
}

/**
 * Returns true when `src` contains a locally-defined function whose body
 * contains both `getSession` and `access_token`.
 *
 * This catches the pattern where a developer hides a bypass inside a wrapper
 * like `async function freshToken()` or `const getToken = async () => { … }`
 * that is defined outside the primary scanned directories (services/hooks/lib),
 * so the top-level file-scan guard would never see it.
 *
 * Expression-body arrows (`const getToken = () => expr`) are also checked via
 * `extractExpressionArrowBodies` so that a chained call like:
 *   `const getToken = () => supabase.auth.getSession().then(…access_token…);`
 * is not able to sneak past the guard.
 */
function definesLocalTokenWrapper(src: string): boolean {
  // Fast pre-filter: both strings must be present somewhere in the file.
  if (!src.includes('getSession') || !src.includes('access_token')) return false;
  // Check whether any individual block-body function contains both strings.
  if (
    extractFunctionBodies(src).some(
      (body) => body.includes('getSession') && body.includes('access_token'),
    )
  )
    return true;
  // Also check expression-body arrows — extractFunctionBodies skips these.
  return extractExpressionArrowBodies(src).some(
    (body) => body.includes('getSession') && body.includes('access_token'),
  );
}

// ── scan ─────────────────────────────────────────────────────────────────────

// src/services/__tests__/ → src/
const SERVICES_DIR = join(new URL('.', import.meta.url).pathname, '../');
const SRC_DIR = join(SERVICES_DIR, '../');
const EXEMPT_FILE = 'apiToken.ts'; // the helper itself — always allowed

// Directories covered by the primary guard (relative to SRC_DIR).
// hooks/ and lib/ were added because violations were found there in practice.
const SCANNED_DIRS = ['services', 'hooks', 'lib'].map((d) => join(SRC_DIR, d));

const scannedFiles = SCANNED_DIRS.flatMap((dir) =>
  existsSync(dir) ? collectTs(dir) : [],
).filter(
  (f) =>
    !f.endsWith(EXEMPT_FILE) &&
    !f.endsWith('.test.ts') &&
    !f.endsWith('.test.tsx'),
);

// All directories under src/ — used by the companion guard so that a wrapper
// placed in components/, screens/, utils/, context/, etc. cannot sneak past.
const ALL_SRC_FILES = existsSync(SRC_DIR)
  ? collectTs(SRC_DIR).filter(
      (f) =>
        !f.endsWith(EXEMPT_FILE) &&
        !f.endsWith('.test.ts') &&
        !f.endsWith('.test.tsx'),
    )
  : [];

// ── unit tests for definesLocalTokenWrapper (expression-body arrows) ───────────

describe('definesLocalTokenWrapper — expression-body arrow detection', () => {
  it('flags a single-line expression-body arrow that chains getSession + access_token', () => {
    const src = `const getToken = () => supabase.auth.getSession().then(({ data }) => data.session?.access_token);`;
    assert.ok(
      definesLocalTokenWrapper(src),
      'Single-line expression-body arrow with getSession + access_token should be flagged',
    );
  });

  it('flags a multi-line expression-body arrow spanning getSession + access_token', () => {
    const src = [
      'const getToken = () =>',
      '  supabase.auth.getSession().then(({ data }) => data.session?.access_token);',
    ].join('\n');
    assert.ok(
      definesLocalTokenWrapper(src),
      'Multi-line expression-body arrow with getSession + access_token should be flagged',
    );
  });

  it('flags an async expression-body arrow with getSession + access_token', () => {
    const src = `const getToken = async () => supabase.auth.getSession().then(({ data }) => data.session?.access_token);`;
    assert.ok(
      definesLocalTokenWrapper(src),
      'Async expression-body arrow with getSession + access_token should be flagged',
    );
  });

  it('does NOT flag an expression-body arrow that uses getSession without access_token', () => {
    const src = `const getUserId = () => supabase.auth.getSession().then(({ data }) => data.session?.user?.id);`;
    assert.ok(
      !definesLocalTokenWrapper(src),
      'Expression-body arrow reading user.id (no access_token) should pass',
    );
  });

  it('does NOT flag a file that has access_token as a plain string constant unrelated to getSession', () => {
    const src = `const HEADER = 'access_token';\nconst doThing = () => supabase.auth.getSession().then(s => s.data.session?.user?.id);`;
    assert.ok(
      !definesLocalTokenWrapper(src),
      'access_token as an unrelated constant with getSession-only-for-userId should pass',
    );
  });

  it('still flags a block-body arrow that wraps getSession + access_token', () => {
    const src = [
      'const getToken = async () => {',
      '  const { data } = await supabase.auth.getSession();',
      '  return data.session?.access_token;',
      '};',
    ].join('\n');
    assert.ok(
      definesLocalTokenWrapper(src),
      'Block-body arrow with getSession + access_token should still be flagged',
    );
  });

  it('does NOT flag a file with neither getSession nor access_token', () => {
    const src = `const add = (a: number, b: number) => a + b;`;
    assert.ok(!definesLocalTokenWrapper(src), 'Unrelated arrow should pass');
  });
});

// ── primary guard ─────────────────────────────────────────────────────────────

describe('getSession bypass guard — travel-buddy services/hooks/lib', () => {
  it('has at least one file to scan (sanity check)', () => {
    assert.ok(
      scannedFiles.length > 0,
      `No .ts files found under ${SRC_DIR}{services,hooks,lib} — discovery is broken`,
    );
  });

  for (const filePath of scannedFiles) {
    const label = relative(SRC_DIR, filePath);

    it(`${label} does not use getSession() to extract an access token`, () => {
      const src = readFileSync(path.resolve(filePath), 'utf8');
      const violates = bypassesTokenHelper(src);
      assert.ok(
        !violates,
        `${label} calls getSession() AND references access_token.\n` +
          `Use freshToken() from services/apiToken.ts instead — it proactively\n` +
          `refreshes the session before handing the token to the API server.`,
      );
    });
  }
});

// ── companion guard — local wrapper functions anywhere in src/ ─────────────────

describe(
  'getSession bypass guard — companion: no locally-defined wrapper in all of src/',
  () => {
    it('has at least one file to scan (sanity check)', () => {
      assert.ok(
        ALL_SRC_FILES.length > 0,
        `No .ts files found under ${SRC_DIR} — discovery is broken`,
      );
    });

    for (const filePath of ALL_SRC_FILES) {
      const label = relative(SRC_DIR, filePath);

      it(
        `${label} does not define a local function that wraps getSession() + access_token`,
        () => {
          const src = readFileSync(path.resolve(filePath), 'utf8');
          const violates = definesLocalTokenWrapper(src);
          assert.ok(
            !violates,
            `${label} defines a local function whose body contains both getSession() and access_token.\n` +
              `This is a hidden bypass of the stale-token guard.\n` +
              `Remove the local wrapper and use freshToken() from services/apiToken.ts instead.`,
          );
        },
      );
    }
  },
);
