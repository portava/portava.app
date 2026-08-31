/**
 * features/media — World/NOW load state machine tests (§4.1/§39).
 *
 * Verifies the degrade contract: an empty projection → empty state (never
 * error, never throw), and a failed refresh over good data keeps showing the
 * stale data (SWR) rather than blanking.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_WORLD_STATE,
  worldReducer,
  isWorldProjectionEmpty,
  shouldRevalidate,
  lensStateFromResult,
  lensStateWithSwr,
  type LensLoadState,
} from '../state/worldState.ts';
import type { MediaWorldProjection } from '../types/mediaContext.ts';
import type { ProjectionResult } from '../types/media.ts';

function fullWorld(): MediaWorldProjection {
  return {
    city: { id: 'c', name: 'Da Nang' },
    cityVisualState: [{ id: 'z', name: 'An Thuong', state: 'building', trend: 'rising' }],
    forYouNow: [],
    changingNow: [],
    generatedAt: null,
  };
}
function emptyWorld(): MediaWorldProjection {
  return { city: null, cityVisualState: [], forYouNow: [], changingNow: [], generatedAt: null };
}

test('isWorldProjectionEmpty', () => {
  assert.equal(isWorldProjectionEmpty(null), true);
  assert.equal(isWorldProjectionEmpty(emptyWorld()), true);
  assert.equal(isWorldProjectionEmpty(fullWorld()), false);
});

test('cold load: idle → loading → ready', () => {
  let s = worldReducer(INITIAL_WORLD_STATE, { type: 'load_start' });
  assert.equal(s.status, 'loading');
  s = worldReducer(s, { type: 'load_result', result: { ok: true, data: fullWorld() }, at: 1000 });
  assert.equal(s.status, 'ready');
  assert.equal(s.loadedAt, 1000);
  assert.equal(s.errorKind, null);
});

test('successful-but-empty payload → empty state, not error', () => {
  let s = worldReducer(INITIAL_WORLD_STATE, { type: 'load_start' });
  s = worldReducer(s, { type: 'load_result', result: { ok: true, data: emptyWorld() }, at: 1 });
  assert.equal(s.status, 'empty');
  assert.equal(s.errorKind, null);
});

test('cold failure → error state (with kind)', () => {
  let s = worldReducer(INITIAL_WORLD_STATE, { type: 'load_start' });
  s = worldReducer(s, {
    type: 'load_result',
    result: { ok: false, data: null, errorKind: 'empty', message: 'x' },
    at: 1,
  });
  assert.equal(s.status, 'error');
  assert.equal(s.errorKind, 'empty');
});

test('refresh over good data revalidates then keeps stale data on failure (SWR)', () => {
  // Start ready with real data.
  let s = worldReducer(INITIAL_WORLD_STATE, { type: 'load_start' });
  s = worldReducer(s, { type: 'load_result', result: { ok: true, data: fullWorld() }, at: 1000 });
  assert.equal(s.status, 'ready');

  // Refresh → revalidating, still holding data.
  s = worldReducer(s, { type: 'load_start' });
  assert.equal(s.status, 'revalidating');
  assert.ok(s.data && !isWorldProjectionEmpty(s.data));

  // Refresh fails → fall back to showing the retained data (ready), record kind.
  s = worldReducer(s, {
    type: 'load_result',
    result: { ok: false, data: null, errorKind: 'network', message: 'x' },
    at: 2000,
  });
  assert.equal(s.status, 'ready');
  assert.equal(s.errorKind, 'network');
  assert.ok(s.data && s.data.cityVisualState.length === 1);
});

test('shouldRevalidate respects ttl and null loadedAt', () => {
  assert.equal(shouldRevalidate(null, 10_000), false);
  assert.equal(shouldRevalidate(0, 50_000, 90_000), false);
  assert.equal(shouldRevalidate(0, 90_000, 90_000), true);
  assert.equal(shouldRevalidate(0, 200_000, 90_000), true);
});

test('lensStateFromResult classifies empty/ready/error generically', () => {
  const isEmpty = (a: number[]) => a.length === 0;
  const ready = lensStateFromResult({ ok: true, data: [1] } as ProjectionResult<number[]>, isEmpty, 5);
  assert.equal(ready.status, 'ready');
  const empty = lensStateFromResult({ ok: true, data: [] } as ProjectionResult<number[]>, isEmpty, 5);
  assert.equal(empty.status, 'empty');
  const err = lensStateFromResult(
    { ok: false, data: null, errorKind: 'server', message: 'x' } as ProjectionResult<number[]>,
    isEmpty,
    5,
  );
  assert.equal(err.status, 'error');
  assert.equal(err.errorKind, 'server');
});

test('lensStateWithSwr keeps stale data on a failed refresh, but errors cold (§39)', () => {
  const isEmpty = (a: number[]) => a.length === 0;
  const good: LensLoadState<number[]> = { status: 'ready', data: [1, 2], loadedAt: 100, errorKind: null };
  const cold: LensLoadState<number[]> = { status: 'idle', data: null, loadedAt: null, errorKind: null };
  const fail = { ok: false, data: null, errorKind: 'network', message: 'x' } as ProjectionResult<number[]>;

  // Failed refresh over good data → keep the stale data, record the kind.
  const swr = lensStateWithSwr(good, fail, isEmpty, 200);
  assert.equal(swr.status, 'ready');
  assert.deepEqual(swr.data, [1, 2]);
  assert.equal(swr.loadedAt, 100); // stale load time retained
  assert.equal(swr.errorKind, 'network');

  // Cold failure (no prior good data) → surface the error.
  const coldFail = lensStateWithSwr(cold, fail, isEmpty, 200);
  assert.equal(coldFail.status, 'error');
  assert.equal(coldFail.errorKind, 'network');

  // A failed refresh over EMPTY (non-null but empty) data is not "good" → error.
  const emptyPrev: LensLoadState<number[]> = { status: 'empty', data: [], loadedAt: 100, errorKind: null };
  assert.equal(lensStateWithSwr(emptyPrev, fail, isEmpty, 200).status, 'error');

  // Success still classifies normally through the SWR wrapper.
  const ok = lensStateWithSwr(good, { ok: true, data: [9] } as ProjectionResult<number[]>, isEmpty, 200);
  assert.equal(ok.status, 'ready');
  assert.deepEqual(ok.data, [9]);
});
