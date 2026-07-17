/**
 * compass.ts — setCachedFeed storage-error resilience tests
 *
 * Verifies that a full-storage (or otherwise broken) AsyncStorage cannot crash
 * the app.  setCachedFeed wraps setItem in a try/catch that ignores errors, so
 * the promise must always resolve cleanly and a subsequent getCachedFeed must
 * return null when the write failed.
 *
 * Run with:
 *   node --import tsx/esm --test \
 *     src/services/__tests__/compass.storage.test.ts
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setCachedFeed,
  getCachedFeed,
  _setStorageForTest,
  type CompassFeedResponse,
} from '../compass.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFeed(overrides: Partial<CompassFeedResponse> = {}): CompassFeedResponse {
  return {
    sections: [],
    nextCursor: null,
    fallback: false,
    ...overrides,
  };
}

afterEach(() => {
  // Clear the test-storage override after every test.
  _setStorageForTest(undefined);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('setCachedFeed — storage write failure', () => {
  it('resolves without throwing when setItem rejects (full storage)', async () => {
    _setStorageForTest({
      setItem: (_k: string, _v: string) =>
        Promise.reject(new Error('Storage full')),
      getItem: (_k: string) => Promise.resolve(null),
      removeItem: (_k: string) => Promise.resolve(),
    });

    // Must not throw or produce an unhandled rejection.
    await assert.doesNotReject(
      () => setCachedFeed('user-123', makeFeed()),
      'setCachedFeed must resolve cleanly even when the storage write rejects',
    );
  });

  it('getCachedFeed returns null after a failed write — nothing was cached', async () => {
    const store: Record<string, string> = {};

    _setStorageForTest({
      // setItem always rejects — simulates a full-storage device.
      setItem: (_k: string, _v: string) =>
        Promise.reject(new Error('No space left')),
      getItem: (k: string) => Promise.resolve(store[k] ?? null),
      removeItem: (k: string) => {
        delete store[k];
        return Promise.resolve();
      },
    });

    await setCachedFeed('user-456', makeFeed({ fallback: true }));
    const cached = await getCachedFeed('user-456');

    assert.equal(
      cached,
      null,
      'getCachedFeed must return null when the prior write failed',
    );
  });

  it('resolves without throwing when setItem throws synchronously', async () => {
    _setStorageForTest({
      setItem: (_k: string, _v: string) => {
        throw new Error('Synchronous storage error');
      },
      getItem: (_k: string) => Promise.resolve(null),
      removeItem: (_k: string) => Promise.resolve(),
    });

    await assert.doesNotReject(
      () => setCachedFeed('user-789', makeFeed()),
      'setCachedFeed must handle synchronous throws from setItem',
    );
  });
});
