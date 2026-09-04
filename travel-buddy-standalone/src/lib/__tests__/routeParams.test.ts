/**
 * firstParam — the route-param normalization contract.
 *
 * Two properties matter and they are easy to conflate:
 *
 *   1. NORMALIZATION IS TOTAL. Every shape Expo Router can deliver — absent,
 *      scalar, repeated — comes back as `string | null`, never `any`.
 *   2. NORMALIZATION IS NOT VALIDATION. The helper hands back the string the
 *      URL carried. It does not parse numbers, and it does not narrow enums.
 *      A caller that needs either must still do it, and the type system now
 *      forces that because the result is `string | null` rather than `any`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { firstParam } from '../routeParams.ts';
import { isMapEntryPoint, type MapEntryPoint } from '../../features/map/telemetry/mapTelemetry.ts';

describe('firstParam — every shape Expo Router can deliver', () => {
  test('a scalar string passes through unchanged', () => {
    assert.equal(firstParam('gems'), 'gems');
  });

  test('undefined becomes null', () => {
    assert.equal(firstParam(undefined), null);
  });

  test('a repeated param (?a=1&a=2) takes the first value', () => {
    assert.equal(firstParam(['first', 'second']), 'first');
  });

  test('an empty array is absence, not an empty string', () => {
    assert.equal(firstParam([]), null);
  });

  test('an empty string is preserved — the URL did carry it', () => {
    // Distinct from absence on purpose: `?title=` is not the same as no title.
    assert.equal(firstParam(''), '');
  });
});

describe('firstParam — normalization is not parsing', () => {
  test('a numeric param comes back as a STRING, not a number', () => {
    const zoom = firstParam('11');
    assert.equal(zoom, '11');
    assert.equal(typeof zoom, 'string');
  });

  test('a malformed numeric param is NOT coerced into a trusted number', () => {
    // The whole point: the caller still has to parse and validate. Returning
    // NaN, 0, or a silently-dropped value here would make a malformed URL look
    // like a real coordinate.
    for (const bad of ['not-a-number', '12abc', 'Infinity', '', '-']) {
      const v = firstParam(bad);
      assert.equal(typeof v, 'string', `${bad} must stay a string`);
      assert.equal(v, bad);
    }
  });

  test('an enum-like param is NOT narrowed by normalization', () => {
    // firstParam returns string|null for 'zzz' exactly as it does for 'tab'.
    // Only the caller's guard can tell them apart — which is why the guard
    // exists and why the result type must not be `any`.
    assert.equal(firstParam('zzz-injected'), 'zzz-injected');
    assert.equal(isMapEntryPoint(firstParam('zzz-injected')), false);
    assert.equal(isMapEntryPoint(firstParam('tab')), true);
  });
});

describe('firstParam — the type boundary, checked by the compiler', () => {
  test('its result cannot reach a union consumer unvalidated', () => {
    // These @ts-expect-error lines are ASSERTIONS, not suppressions: if
    // firstParam ever widened back to `any`, the assignment would compile, the
    // expected error would not occur, and `@ts-expect-error` itself becomes a
    // type error — so the test suite's typecheck goes red. That is the
    // compile-time half of this contract, and it is why the helper's return
    // type is the thing under test rather than its runtime behaviour.

    // @ts-expect-error string | null is not assignable to MapEntryPoint
    const bad: MapEntryPoint = firstParam('tab');
    void bad;

    // Validated, it is assignable — the guard is the only legitimate door.
    const raw = firstParam('tab');
    const good: MapEntryPoint = isMapEntryPoint(raw) ? raw : 'unknown';
    assert.equal(good, 'tab');
  });

  test('a rejected value falls to the union member meant for it', () => {
    const raw = firstParam('circle');
    const resolved: MapEntryPoint = isMapEntryPoint(raw) ? raw : 'unknown';
    assert.equal(resolved, 'unknown');
  });
});
