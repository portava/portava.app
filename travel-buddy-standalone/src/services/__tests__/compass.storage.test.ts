/**
 * compass.storage.test.ts
 *
 * Guards the getStorage() null-return path that exists because `require` is
 * not defined under Node.js ESM (the tsx/esm test runner).
 *
 * Why this matters: if the try/catch guard in getStorage() were accidentally
 * removed, or the require() call were replaced with a static import, Node.js
 * would throw at module load time and the entire test suite would crash.
 * These tests make that regression loud rather than silent.
 *
 * Run:
 *   node --import tsx/esm --test \
 *     src/services/__tests__/compass.storage.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  _getStorageForTest,
  getCachedFeed,
  setCachedFeed,
} from '../compass.ts';

// ── Module load ───────────────────────────────────────────────────────────────

describe('compass.ts — module load under tsx/esm', () => {
  it('imports without throwing', () => {
    // If the module failed to load, this file would not run at all.
    // Asserting that the exported symbol is a function is a concrete check
    // that the module evaluated fully.
    assert.equal(typeof _getStorageForTest, 'function',
      '_getStorageForTest must be a function — module did not load cleanly');
  });
});

// ── getStorage() null guard ───────────────────────────────────────────────────

describe('getStorage() — Node.js ESM environment', () => {
  it('returns null because require() is not available under Node.js ESM', () => {
    const storage = _getStorageForTest();
    assert.equal(storage, null,
      'getStorage() must return null under Node.js ESM (no require); ' +
      'if this fails the try/catch guard in compass.ts has been removed or bypassed');
  });
});

// ── Storage-dependent helpers — no throw when storage is null ─────────────────

describe('getCachedFeed() — storage unavailable', () => {
  it('returns null without throwing when storage is unavailable', async () => {
    const result = await getCachedFeed('user-test-123');
    assert.equal(result, null,
      'getCachedFeed() must return null (not throw) when AsyncStorage is unavailable');
  });

  it('returns null for any userId without throwing', async () => {
    const result = await getCachedFeed('');
    assert.equal(result, null);
  });
});

describe('setCachedFeed() — storage unavailable', () => {
  it('resolves without throwing when storage is unavailable', async () => {
    const fakeFeed = {
      sections: [],
      nextCursor: null,
      fallback: false,
    };
    // Must not throw — a no-op when store is null
    await assert.doesNotReject(
      () => setCachedFeed('user-test-123', fakeFeed),
      'setCachedFeed() must not throw when AsyncStorage is unavailable',
    );
  });
});
