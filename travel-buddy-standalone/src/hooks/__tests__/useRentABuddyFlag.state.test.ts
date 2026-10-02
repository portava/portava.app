/**
 * useRentABuddyFlag — OFF is not the same as UNREADABLE (lane tm-rab).
 *
 * The Rent-a-Buddy layout gates the whole route group on `rent_buddy_enabled`.
 * `_resolveFlag` returns `false` for BOTH "the flag is off" and "the flags could
 * not be fetched", so a network failure rendered the same COMING SOON screen as
 * a switched-off feature — a failed read shown as a state (the DV-83 rule) —
 * and neither screen said which gate refused or what unblocks it.
 *
 * `_resolveFlagState` keeps the three apart:
 *   on       — flags.rent_buddy_enabled === true
 *   off      — the endpoint answered and the flag is false or absent
 *   unknown  — fetch threw, a non-2xx answer, or a body without `flags`
 * and an `unknown` is never cached, so "Try again" really does try again.
 *
 * Run: node --import tsx/esm --test src/hooks/__tests__/useRentABuddyFlag.state.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { _resolveFlagState, _resetFlagCache } from '../useRentABuddyFlag.ts';

const realFetch = globalThis.fetch;
let fetchCalls = 0;

function answer(status: number, body: unknown) {
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

beforeEach(() => { _resetFlagCache(); fetchCalls = 0; });
afterEach(() => { globalThis.fetch = realFetch; });

describe('_resolveFlagState', () => {
  it('on', async () => {
    answer(200, { flags: { rent_buddy_enabled: true } });
    assert.equal(await _resolveFlagState('http://x', 1000), 'on');
  });

  it('off when the flag is false', async () => {
    answer(200, { flags: { rent_buddy_enabled: false } });
    assert.equal(await _resolveFlagState('http://x', 1000), 'off');
  });

  it('off when the flag is absent from a good answer', async () => {
    answer(200, { flags: {} });
    assert.equal(await _resolveFlagState('http://x', 1000), 'off');
  });

  it('unknown when the endpoint errors', async () => {
    answer(500, { error: 'db_error' });
    assert.equal(await _resolveFlagState('http://x', 1000), 'unknown');
  });

  it('unknown when fetch throws', async () => {
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    assert.equal(await _resolveFlagState('http://x', 1000), 'unknown');
  });

  it('unknown when the body has no flags map', async () => {
    answer(200, { nope: true });
    assert.equal(await _resolveFlagState('http://x', 1000), 'unknown');
  });

  it('an unknown is not cached — the next call fetches again', async () => {
    answer(500, {});
    await _resolveFlagState('http://x', 1000);
    answer(200, { flags: { rent_buddy_enabled: true } });
    assert.equal(await _resolveFlagState('http://x', 1001), 'on');
    assert.equal(fetchCalls, 2);
  });

  it('a known answer is cached within the TTL', async () => {
    answer(200, { flags: { rent_buddy_enabled: false } });
    await _resolveFlagState('http://x', 1000);
    await _resolveFlagState('http://x', 2000);
    assert.equal(fetchCalls, 1);
  });
});
