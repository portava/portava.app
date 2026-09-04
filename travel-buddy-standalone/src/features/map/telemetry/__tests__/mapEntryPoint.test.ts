/**
 * §35 `map_opened.entry` — the vocabulary guard and the derivation.
 *
 * Written because the screen previously published `mode ?? 'direct'` into this
 * field. Verified against main on 2026-09-04, every production path into /map
 * emitted a value OUTSIDE MapEntryPoint:
 *
 *   router.push('/map')                                -> 'direct'   (not in the union)
 *   router.push('/map?entityTypes=gems')               -> 'direct'
 *   router.push('/map?entityTypes=friends&mode=circle')-> 'circle'   (a §30 MAP MODE)
 *   router.push('/map?entityTypes=stamps&mode=passport')->'passport' (a §30 MAP MODE)
 *   a bare tab open                                     -> 'direct'
 *
 * Nothing caught it: `Array.isArray(params.mode) ? params.mode[0] : …` yields
 * `any` when params.mode is `string | undefined`, so the union was never
 * enforced at the call site, and no test asserted what the screen emits.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAP_ENTRY_POINTS,
  isMapEntryPoint,
  deriveMapEntryPoint,
} from '../mapTelemetry.ts';

describe('isMapEntryPoint', () => {
  test('accepts every member of the union and nothing else', () => {
    for (const e of MAP_ENTRY_POINTS) assert.equal(isMapEntryPoint(e), true, e);
    for (const bad of ['direct', 'circle', 'passport', 'Tab', '', 'TAB']) {
      assert.equal(isMapEntryPoint(bad), false, `${bad} must not be an entry point`);
    }
  });

  test('rejects non-strings rather than coercing them', () => {
    for (const bad of [null, undefined, 0, 1, {}, [], ['tab']]) {
      assert.equal(isMapEntryPoint(bad), false, String(bad));
    }
  });
});

describe('deriveMapEntryPoint — the four real production paths', () => {
  test('a bare tab open is tab', () => {
    assert.equal(deriveMapEntryPoint({}), 'tab');
  });

  test('an in-app push carrying params is a deeplink', () => {
    assert.equal(deriveMapEntryPoint({ entityTypes: 'gems' }), 'deeplink');
  });

  test('a MAP MODE never becomes an entry point', () => {
    // The specific regression: 'circle' and 'passport' are §30 modes and were
    // being published verbatim into an entry-point field.
    assert.equal(deriveMapEntryPoint({ entityTypes: 'friends', mode: 'circle' }), 'deeplink');
    assert.equal(deriveMapEntryPoint({ entityTypes: 'stamps', mode: 'passport' }), 'deeplink');
  });
});

describe('deriveMapEntryPoint — an explicit entry param', () => {
  test('is honoured when it names a real entry point', () => {
    assert.equal(deriveMapEntryPoint({ entry: 'compass' }), 'compass');
    assert.equal(deriveMapEntryPoint({ entry: 'notification', entityTypes: 'gems' }), 'notification');
  });

  test('takes the first value when the param repeats', () => {
    assert.equal(deriveMapEntryPoint({ entry: ['search', 'tab'] }), 'search');
  });

  test('an arbitrary deep-link string is NOT published', () => {
    // An enumerated telemetry dimension fed from a user-controllable query
    // param is unbounded cardinality unless it is narrowed at the boundary.
    assert.equal(deriveMapEntryPoint({ entry: 'zzz-injected' }), 'deeplink');
    assert.equal(deriveMapEntryPoint({ entry: 'direct' }), 'deeplink');
  });

  test('every derived value is a member of the union, whatever the input', () => {
    const inputs: Array<Record<string, string | string[] | undefined>> = [
      {}, { entry: 'direct' }, { mode: 'circle' }, { entry: [] },
      { entry: undefined }, { entry: ['nonsense'] }, { zoom: '11' },
    ];
    for (const p of inputs) {
      assert.equal(isMapEntryPoint(deriveMapEntryPoint(p)), true, JSON.stringify(p));
    }
  });
});
