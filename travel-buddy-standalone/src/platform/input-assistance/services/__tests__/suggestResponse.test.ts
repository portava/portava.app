/**
 * §41/§57 — the suggest envelope's coercions.
 *
 * These assertions exist because the first attempt at them did NOT work. The
 * `serverMs` handling was inline in `inputAssistance.ts`, and the component
 * test that named it drove a jest MOCK of `requestSuggestions` — so changing
 * `: undefined` to `: 0` left the suite green. The coercion was pulled into a
 * pure module precisely so a mutation to it can be seen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSuggestBody, parseServerMs } from '../suggestResponse.ts';

test('§57: a server that sends no timing yields NO value, never a fabricated zero', () => {
  // A 0 here is indistinguishable from an instantaneous serve and would drag
  // G372's P95 toward a number nothing measured. MUTATION: return 0 instead of
  // undefined and this goes red.
  assert.equal(parseSuggestBody({ requestId: 'r' }).serverMs, undefined);
  assert.equal(parseServerMs(undefined), undefined);
  assert.equal(parseServerMs(null), undefined);
  assert.equal(parseServerMs('42'), undefined, 'a string is not a measurement');
  assert.equal(parseServerMs(Number.NaN), undefined);
});

test('§57: a real measurement survives, rounded, and an impossible one does not', () => {
  assert.equal(parseServerMs(42), 42);
  assert.equal(parseServerMs(42.6), 43);
  assert.equal(parseServerMs(0), 0, 'a genuinely reported 0 is kept — it is a measurement');
  assert.equal(parseServerMs(-1), undefined, 'negative wall-clock is a clock, not a serve');
  assert.equal(parseServerMs(120_001), undefined, 'beyond the ceiling is a clock, not a serve');
});

test('§41: a missing or malformed envelope degrades to a well-formed empty one', () => {
  const p = parseSuggestBody(undefined);
  assert.equal(p.requestId, '');
  assert.equal(p.policyVersion, null);
  assert.deepEqual(p.suggestions, []);
  assert.equal(p.serverMs, undefined);
  assert.deepEqual(parseSuggestBody({ suggestions: 'not an array' }).suggestions, []);
});

test('§44: requestId is kept verbatim when present and empty when not', () => {
  // '' rather than a placeholder: the hook turns a falsy id into null so a
  // telemetry event says "no serve" instead of joining on an empty string.
  assert.equal(parseSuggestBody({ requestId: 'req-1' }).requestId, 'req-1');
  assert.equal(parseSuggestBody({ requestId: 7 }).requestId, '');
});
