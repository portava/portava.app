/**
 * useRentABuddyFlag.test.ts
 *
 * Unit tests for the fetch/cache logic backing `useRentABuddyFlag`.
 *
 * Coverage (per task spec):
 *   1. Returns enabled:false when API returns flags.rent_buddy_enabled = false
 *   2. Returns enabled:true  when API returns flags.rent_buddy_enabled = true
 *   3. Uses cached value within TTL — fetch is NOT called a second time
 *   4. Re-fetches after TTL expires (_cacheTs manually zeroed)
 *   5. Returns enabled:false when fetch rejects (fail-safe / fail-open)
 *
 * Strategy:
 *   The hook's useEffect is React-only and cannot be rendered in node:test.
 *   `_resolveFlag(apiBase, nowMs)` is the extracted pure async function that
 *   contains the full cache-check → fetch → cache-write → return logic.
 *   Tests call `_resolveFlag` directly with a controlled `nowMs` so TTL
 *   expiry is deterministic without sleeping.
 *
 * Run:
 *   node --import tsx/esm --test src/hooks/__tests__/useRentABuddyFlag.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resolveFlag,
  _resetFlagCache,
  _getRawCacheState,
} from '../useRentABuddyFlag.ts';

// ── helpers ───────────────────────────────────────────────────────────────────

const API_BASE = 'https://api.example.com';

function makeFakeResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

// ── flag value propagation ────────────────────────────────────────────────────

describe('useRentABuddyFlag — flag value propagation', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    _resetFlagCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetFlagCache();
  });

  it('returns false when API returns flags.rent_buddy_enabled = false', async () => {
    (globalThis as { fetch: unknown }).fetch = async () =>
      makeFakeResponse({ flags: { rent_buddy_enabled: false } });

    const result = await _resolveFlag(API_BASE);
    assert.equal(result, false);
  });

  it('returns true when API returns flags.rent_buddy_enabled = true', async () => {
    (globalThis as { fetch: unknown }).fetch = async () =>
      makeFakeResponse({ flags: { rent_buddy_enabled: true } });

    const result = await _resolveFlag(API_BASE);
    assert.equal(result, true);
  });

  it('returns false when fetch rejects (fail-safe)', async () => {
    (globalThis as { fetch: unknown }).fetch = async () => {
      throw new Error('network failure');
    };

    const result = await _resolveFlag(API_BASE);
    assert.equal(result, false);
  });

  it('returns false when flags object is absent from response body', async () => {
    (globalThis as { fetch: unknown }).fetch = async () =>
      makeFakeResponse({});

    const result = await _resolveFlag(API_BASE);
    assert.equal(result, false);
  });

  it('returns false when rent_buddy_enabled key is absent from flags map', async () => {
    (globalThis as { fetch: unknown }).fetch = async () =>
      makeFakeResponse({ flags: { some_other_flag: true } });

    const result = await _resolveFlag(API_BASE);
    assert.equal(result, false);
  });
});

// ── cache TTL behaviour ───────────────────────────────────────────────────────

describe('useRentABuddyFlag — cache TTL behaviour', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    _resetFlagCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetFlagCache();
  });

  it('does NOT call fetch a second time while cache is within TTL', async () => {
    let fetchCallCount = 0;
    (globalThis as { fetch: unknown }).fetch = async () => {
      fetchCallCount++;
      return makeFakeResponse({ flags: { rent_buddy_enabled: true } });
    };

    const { ttlMs } = _getRawCacheState();
    const now = Date.now();

    await _resolveFlag(API_BASE, now);
    assert.equal(fetchCallCount, 1, 'first call must fetch');

    const withinTtlMs = now + ttlMs - 1000;
    const second = await _resolveFlag(API_BASE, withinTtlMs);

    assert.equal(fetchCallCount, 1, 'fetch must NOT be called again while cache is fresh');
    assert.equal(second, true, 'cached value must propagate correctly');
  });

  it('re-fetches after TTL expires', async () => {
    let fetchCallCount = 0;
    (globalThis as { fetch: unknown }).fetch = async () => {
      fetchCallCount++;
      return makeFakeResponse({ flags: { rent_buddy_enabled: true } });
    };

    const { ttlMs } = _getRawCacheState();
    const now = Date.now();

    await _resolveFlag(API_BASE, now);
    assert.equal(fetchCallCount, 1, 'first call must fetch');

    const afterTtlMs = now + ttlMs + 1000;
    await _resolveFlag(API_BASE, afterTtlMs);

    assert.equal(fetchCallCount, 2, 'fetch MUST be called again after TTL expires');
  });

  it('cache starts null — _resetFlagCache ensures first call always fetches', async () => {
    let fetchCallCount = 0;
    (globalThis as { fetch: unknown }).fetch = async () => {
      fetchCallCount++;
      return makeFakeResponse({ flags: { rent_buddy_enabled: false } });
    };

    const { cachedEnabled: before } = _getRawCacheState();
    assert.equal(before, null, 'cache must be null before first fetch');

    await _resolveFlag(API_BASE);
    assert.equal(fetchCallCount, 1, 'a null cache must trigger a fetch');
  });

  it('_resetFlagCache zeroes out cachedEnabled and cacheTs', async () => {
    (globalThis as { fetch: unknown }).fetch = async () =>
      makeFakeResponse({ flags: { rent_buddy_enabled: true } });

    await _resolveFlag(API_BASE);

    const { cachedEnabled: after, cacheTs: ts } = _getRawCacheState();
    assert.equal(after, true, 'cache must be populated after a successful fetch');
    assert.ok(ts > 0,         'cacheTs must be non-zero after a successful fetch');

    _resetFlagCache();

    const { cachedEnabled: reset, cacheTs: resetTs } = _getRawCacheState();
    assert.equal(reset, null, 'cachedEnabled must be null after _resetFlagCache');
    assert.equal(resetTs, 0,  'cacheTs must be 0 after _resetFlagCache');
  });

  it('cached flag value from first call is returned unchanged on second call within TTL', async () => {
    let callCount = 0;
    (globalThis as { fetch: unknown }).fetch = async () => {
      callCount++;
      return makeFakeResponse({ flags: { rent_buddy_enabled: callCount === 1 } });
    };

    const { ttlMs } = _getRawCacheState();
    const now = Date.now();

    const first = await _resolveFlag(API_BASE, now);
    assert.equal(first, true, 'first call returns true (callCount=1)');

    const second = await _resolveFlag(API_BASE, now + ttlMs - 1000);
    assert.equal(second, true, 'second call must return the cached true, not re-fetch (which would return false)');
    assert.equal(callCount, 1, 'only one actual HTTP call should have occurred');
  });
});
