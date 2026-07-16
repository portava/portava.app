/**
 * Static guard: no service file may call supabase.auth.getSession() to obtain
 * an access token.
 *
 * `freshToken()` in apiToken.ts is the only place that may read getSession()
 * and then hand the resulting access_token to the API server.  Any service
 * that calls getSession() *and* extracts access_token from the result bypasses
 * the proactive-refresh logic and can silently send an expired token.
 *
 * This test reads every .ts file under src/services/ (excluding apiToken.ts,
 * which is the helper itself) and asserts that no such file contains both
 * `getSession` and an `access_token` extraction from its result.
 *
 * Legitimate uses of getSession() — e.g. reading `session.user.id` to build a
 * storage path — do not touch access_token and therefore pass this check.
 *
 * Run with:
 *   node --import tsx/esm --test \
 *     src/services/__tests__/getSession.bypassGuard.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Recursively collect all .ts files under `dir`. */
function collectTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTs(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Returns true when `src` contains a pattern that indicates getSession() is
 * being used to extract an access token — the only forbidden use in service
 * files.
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

// ── scan ─────────────────────────────────────────────────────────────────────

const SERVICES_DIR = join(new URL('.', import.meta.url).pathname, '../');
const EXEMPT_FILE = 'apiToken.ts'; // the helper itself — always allowed

const serviceFiles = collectTs(SERVICES_DIR).filter(
  (f) => !f.endsWith(EXEMPT_FILE) && !f.endsWith('.test.ts'),
);

// ── tests ─────────────────────────────────────────────────────────────────────

describe('getSession bypass guard — travel-buddy-standalone services', () => {
  it('has at least one service file to scan (sanity check)', () => {
    assert.ok(
      serviceFiles.length > 0,
      `No .ts service files found under ${SERVICES_DIR} — discovery is broken`,
    );
  });

  for (const filePath of serviceFiles) {
    const label = relative(SERVICES_DIR, filePath);

    it(`${label} does not use getSession() to extract an access token`, () => {
      const src = readFileSync(filePath, 'utf8');
      const violates = bypassesTokenHelper(src);
      assert.ok(
        !violates,
        `${label} calls getSession() AND references access_token.\n` +
          `Use freshToken() from ./apiToken.ts instead — it proactively\n` +
          `refreshes the session before handing the token to the API server.`,
      );
    });
  }
});
