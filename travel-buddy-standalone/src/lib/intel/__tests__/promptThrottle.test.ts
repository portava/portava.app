/**
 * Client 45-minute prompt throttle (spec §6) — pure logic + storage round-trip.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMPT_THROTTLE_WINDOW_MS,
  isSubjectThrottled,
  recordPromptShown,
  loadPromptThrottle,
  type PromptThrottleMap,
} from '../promptThrottleStorage.ts';

const NOW = 1_757_000_000_000;

describe('isSubjectThrottled', () => {
  it('is false for a subject never prompted', () => {
    assert.equal(isSubjectThrottled({}, 'p1', NOW), false);
  });
  it('is true within the 45-minute window', () => {
    const t: PromptThrottleMap = { p1: NOW - 10 * 60_000 };
    assert.equal(isSubjectThrottled(t, 'p1', NOW), true);
  });
  it('is false once the window has elapsed', () => {
    const t: PromptThrottleMap = { p1: NOW - PROMPT_THROTTLE_WINDOW_MS - 1 };
    assert.equal(isSubjectThrottled(t, 'p1', NOW), false);
  });
  it('fails closed on a malformed or future timestamp', () => {
    assert.equal(isSubjectThrottled({ p1: NaN as unknown as number }, 'p1', NOW), true);
    assert.equal(isSubjectThrottled({ p1: NOW + 5_000 }, 'p1', NOW), true);
  });
});

describe('recordPromptShown + storage', () => {
  function fakeStorage() {
    const map = new Map<string, string>();
    return {
      getItem: async (k: string) => map.get(k) ?? null,
      setItem: async (k: string, v: string) => { map.set(k, v); },
      removeItem: async (k: string) => { map.delete(k); },
      _map: map,
    };
  }

  it('stamps the subject and throttles it immediately after', async () => {
    const s = fakeStorage();
    await loadPromptThrottle(s);
    const t = recordPromptShown(s, 'p1', NOW);
    assert.equal(isSubjectThrottled(t, 'p1', NOW + 1_000), true);
    assert.ok(s._map.get('intel_prompt_throttle_v1')?.includes('p1'));
  });

  it('prunes entries older than the window when recording', async () => {
    const s = fakeStorage();
    await loadPromptThrottle(s);
    recordPromptShown(s, 'stale', NOW - PROMPT_THROTTLE_WINDOW_MS - 5_000);
    const t = recordPromptShown(s, 'fresh', NOW);
    assert.equal(t.stale, undefined, 'the stale entry is pruned');
    assert.ok(t.fresh);
  });
});
