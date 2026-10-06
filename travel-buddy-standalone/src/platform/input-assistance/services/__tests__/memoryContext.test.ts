/**
 * OD-INPUT-3 / census G25 — the inspect view's parse. An answer that is not
 * exactly the server's shape is UNREADABLE (rendered with a retry), never "off"
 * and never "you have no memories".
 *
 * Run: node --test --experimental-strip-types src/platform/input-assistance/services/__tests__/memoryContext.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_CONTEXT_DISCLOSURE_VERSION, memoryFactLabel, parseMemoryContextView } from '../memoryContext.ts';

const BASE = { available: true, enabled: true, currentDisclosureVersion: MEMORY_CONTEXT_DISCLOSURE_VERSION, factsUnavailable: false };

test('facts:null (nothing read) and facts:[] (read, empty) stay different answers', () => {
  assert.equal(parseMemoryContextView({ ...BASE, enabled: false, facts: null })!.facts, null);
  assert.deepEqual(parseMemoryContextView({ ...BASE, facts: [] })!.facts, []);
});

test('a fact list is parsed; a malformed fact makes the WHOLE view unreadable', () => {
  const v = parseMemoryContextView({ ...BASE, facts: [{ city: 'Hội An', country: 'Vietnam', occurredAt: null }] });
  assert.deepEqual(v!.facts, [{ city: 'Hội An', country: 'Vietnam', occurredAt: null }]);
  assert.equal(parseMemoryContextView({ ...BASE, facts: [{ city: '' }] }), null);
  assert.equal(parseMemoryContextView({ ...BASE, facts: 'Tokyo' }), null);
});

test('missing state fields are unreadable, not off', () => {
  assert.equal(parseMemoryContextView({ enabled: false }), null);
  assert.equal(parseMemoryContextView(null), null);
});

test('a failed memory read while on is carried as factsUnavailable', () => {
  assert.equal(parseMemoryContextView({ ...BASE, facts: null, factsUnavailable: true })!.factsUnavailable, true);
});

test('labels name the place the way the person knows it', () => {
  assert.equal(memoryFactLabel({ city: 'Hội An', country: 'Vietnam', occurredAt: null }), 'Hội An, Vietnam');
  assert.equal(memoryFactLabel({ city: 'Tokyo', country: null, occurredAt: null }), 'Tokyo');
});
