/**
 * Unit tests for compass cache helpers — setCachedFeed / getCachedFeed.
 *
 * Verifies that a storage write failure is silently swallowed and does not
 * propagate to the caller.
 *
 * Run via:
 *   node --import tsx/esm --test src/services/__tests__/compass.storage.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setCachedFeed,
  getCachedFeed,
  _setStorageForTest,
  type CompassFeedResponse,
} from '../compass.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeFeed(): CompassFeedResponse {
  return {
    sections: [],
    nextCursor: null,
    fallback: false,
  };
}

/** A fake storage whose setItem always rejects. */
function throwingStorage() {
  const store = new Map<string, string>();
  return {
    store,
    getItem(key: string): Promise<string | null> {
      return Promise.resolve(store.get(key) ?? null);
    },
    setItem(_key: string, _value: string): Promise<void> {
      return Promise.reject(new Error('disk full'));
    },
    removeItem(key: string): Promise<void> {
      store.delete(key);
      return Promise.resolve();
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('setCachedFeed — storage write failure is silent', () => {
  beforeEach(() => {
    _setStorageForTest(throwingStorage());
  });

  afterEach(() => {
    _setStorageForTest(null);
  });

  it('resolves without throwing when setItem rejects', async () => {
    await assert.doesNotReject(
      () => setCachedFeed('user-1', makeFeed()),
      'setCachedFeed must not propagate the storage error to its caller',
    );
  });

  it('getCachedFeed returns null after a failed write — nothing was stored', async () => {
    // Attempt write (will fail silently)
    await setCachedFeed('user-1', makeFeed());

    // Nothing should have been persisted
    const result = await getCachedFeed('user-1');
    assert.equal(
      result,
      null,
      'getCachedFeed must return null when the preceding setCachedFeed write failed',
    );
  });
});
