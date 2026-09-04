/**
 * eventCachedLocation — §12 rung 2, "Event-local cached location".
 *
 * The properties under test are exactly the three the task names for this rung:
 *   1. it is CACHED AT CHECK-IN WITH EXPLICIT CONSENT — no consent, no cache;
 *   2. it has a BOUNDED TTL — the cache stops emitting once its clock runs out,
 *      and the bound can never exceed the position decay horizon;
 *   3. it is produced THROUGH THE EXISTING MODEL — it is an ordinary
 *      `LocateSignal` at the `event_cached_location` rung, and `resolvePosition`
 *      ranks it below a live fix.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_EVENT_CACHE_TTL_MS,
  EVENT_CACHE_MAX_TTL_MS,
  cacheEventCheckInLocation,
  eventCachedSignal,
  isEventCacheLive,
  sampleWithEventCacheFallback,
  type EventCheckInCache,
} from '../eventCachedLocation.ts';
import { DECAY_BOUNDARIES_MS } from '../presenceLadder.ts';
import { resolvePosition, type LocateSignal } from '../locateFriends.ts';

const NOW = 1_800_000_000_000;
const DA_NANG = { lat: 16.047079, lng: 108.220518 };

function freshCache(over: Partial<Parameters<typeof cacheEventCheckInLocation>[0]> = {}) {
  const r = cacheEventCheckInLocation({
    lat: DA_NANG.lat,
    lng: DA_NANG.lng,
    venueLabel: 'Food Court',
    consent: true,
    now: NOW,
    ...over,
  });
  assert.ok(r.ok, 'expected a cache');
  return r.cache;
}

// ── 1 · explicit consent ──────────────────────────────────────────────────────

describe('§12 rung 2 · caching is its own explicit yes', () => {
  test('no consent, no cache — every non-true value refuses', () => {
    for (const consent of [false, undefined as unknown as boolean, null as unknown as boolean, 1 as unknown as boolean, 'yes' as unknown as boolean]) {
      const r = cacheEventCheckInLocation({ lat: DA_NANG.lat, lng: DA_NANG.lng, consent, now: NOW });
      assert.equal(r.ok, false, `consent=${String(consent)} must refuse`);
      assert.equal(r.ok === false && r.reason, 'consent_required');
    }
  });

  test('a built cache always records consent === true', () => {
    const cache = freshCache();
    assert.equal(cache.consent, true);
  });

  test('a non-finite coordinate refuses', () => {
    for (const p of [{ lat: Number.NaN, lng: 0 }, { lat: 0, lng: Number.POSITIVE_INFINITY }, { lat: 200, lng: 0 }]) {
      const r = cacheEventCheckInLocation({ lat: p.lat, lng: p.lng, consent: true, now: NOW });
      assert.equal(r.ok, false);
      assert.equal(r.ok === false && r.reason, 'invalid_point');
    }
  });
});

// ── 2 · bounded TTL ─────────────────────────────────────────────────────────

describe('§12 rung 2 · the cache is bounded and expires', () => {
  test('the max TTL never exceeds the position decay horizon', () => {
    assert.equal(EVENT_CACHE_MAX_TTL_MS, DECAY_BOUNDARIES_MS.last_known);
    assert.ok(DEFAULT_EVENT_CACHE_TTL_MS <= EVENT_CACHE_MAX_TTL_MS);
  });

  test('a TTL past the ceiling is clamped DOWN, not honoured', () => {
    const cache = freshCache({ ttlMs: EVENT_CACHE_MAX_TTL_MS * 10 });
    assert.equal(cache.expiresAt - cache.capturedAt, EVENT_CACHE_MAX_TTL_MS);
  });

  test('a zero / negative / NaN TTL falls back to the default, never to forever', () => {
    for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const cache = freshCache({ ttlMs: ttl });
      assert.equal(cache.expiresAt - cache.capturedAt, DEFAULT_EVENT_CACHE_TTL_MS);
    }
  });

  test('the rung emits a signal before expiry and NOTHING after it', () => {
    const cache = freshCache({ ttlMs: 10 * 60_000 });
    // Just inside the window.
    assert.ok(eventCachedSignal(cache, cache.expiresAt - 1) != null);
    assert.ok(isEventCacheLive(cache, cache.expiresAt - 1));
    // At and past expiry — the rung goes silent (§12's chain moves on).
    assert.equal(eventCachedSignal(cache, cache.expiresAt), null);
    assert.equal(eventCachedSignal(cache, cache.expiresAt + 60_000), null);
    assert.equal(isEventCacheLive(cache, cache.expiresAt), false);
  });

  test('an unconsented object smuggled in is not live and emits nothing', () => {
    const forged = { ...freshCache(), consent: false } as unknown as EventCheckInCache;
    assert.equal(isEventCacheLive(forged, NOW), false);
    assert.equal(eventCachedSignal(forged, NOW), null);
  });
});

// ── 3 · produced through the existing model ─────────────────────────────────

describe('§12 rung 2 · it is an ordinary signal on the ladder', () => {
  test('the signal is at the event_cached_location rung and carries the check-in evidence', () => {
    const cache = freshCache();
    const signal = eventCachedSignal(cache, NOW + 60_000);
    assert.ok(signal);
    assert.equal(signal.rung, 'event_cached_location');
    assert.equal(signal.observedAt, cache.capturedAt);
    assert.deepEqual(signal.position, { lat: DA_NANG.lat, lng: DA_NANG.lng });
    assert.equal(signal.checkpointLabel, 'Food Court');
  });

  test('a live network fix always outranks the cache — the cache cannot promote itself', () => {
    const cache = freshCache();
    const cached = eventCachedSignal(cache, NOW + 60_000)!;
    const live: LocateSignal = { rung: 'network_location', observedAt: NOW, position: DA_NANG };
    // Offered in the "wrong" order, the chain still prefers the live fix.
    const resolved = resolvePosition([cached, live], NOW, { subjectKey: 'm1' });
    assert.equal(resolved.rung, 'network_location');
  });

  test('with no live fix, the chain answers on the cached rung', () => {
    const cache = freshCache();
    const cached = eventCachedSignal(cache, NOW + 60_000)!;
    const resolved = resolvePosition([cached], NOW, { subjectKey: 'm1' });
    assert.equal(resolved.rung, 'event_cached_location');
  });
});

// ── the fallback sampler ──────────────────────────────────────────────────────

describe('sampleWithEventCacheFallback', () => {
  const live: LocateSignal = { rung: 'network_location', observedAt: NOW, position: DA_NANG };

  test('a fresh network fix wins', () => {
    const cache = freshCache();
    assert.equal(sampleWithEventCacheFallback(live, cache, NOW), live);
  });

  test('with no fresh fix it falls back to the cache', () => {
    const cache = freshCache();
    const out = sampleWithEventCacheFallback(null, cache, NOW + 60_000);
    assert.equal(out?.rung, 'event_cached_location');
  });

  test('with neither, it offers nothing', () => {
    assert.equal(sampleWithEventCacheFallback(null, null, NOW), null);
    const cache = freshCache({ ttlMs: 60_000 });
    assert.equal(sampleWithEventCacheFallback(null, cache, cache.expiresAt + 1), null);
  });
});
