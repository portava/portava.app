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

// ── scan ─────────────────────────────────────────────────────────────────────

// src/services/__tests__/ → src/
const SERVICES_DIR = join(new URL('.', import.meta.url).pathname, '../');
const SRC_DIR = join(SERVICES_DIR, '../');
const EXEMPT_FILE = 'apiToken.ts'; // the helper itself — always allowed

// Directories covered by this guard (relative to SRC_DIR).
// hooks/ and lib/ were added because violations were found there in practice.
const SCANNED_DIRS = ['services', 'hooks', 'lib'].map((d) => join(SRC_DIR, d));

const scannedFiles = SCANNED_DIRS.flatMap((dir) =>
  existsSync(dir) ? collectTs(dir) : [],
).filter((f) => !f.endsWith(EXEMPT_FILE) && !f.endsWith('.test.ts'));

// ── tests ─────────────────────────────────────────────────────────────────────

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
