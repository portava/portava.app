/**
 * census G224 / G212 — the client's half of §34 local SUFFICIENCY, pure.
 *
 * The hook wiring is proven in
 * hooks/__tests__/useInputAssistance.localSufficiency.component.test.tsx. These
 * prove each condition of the gate ON ITS OWN. Two of them are also enforced a
 * second time further down the path (the dictionary refuses a non-public field,
 * and a field that allows no `completion` cannot produce a raw-only list), so a
 * whole-path test alone leaves them unproven — measured: removing either from
 * this module left the component suite green.
 *
 * MUTATION LOG (each applied, watched go red, reverted, `git diff` clean):
 *   - drop `d.privacyClass === 'public'` → "a non-public field is never
 *     sufficient" red.
 *   - drop `d.authoritative === true` → "only an AUTHORITATIVE grant counts" red.
 *   - drop `d.offlinePolicy === 'static_dictionary'` → "only a static_dictionary
 *     surface" red.
 *   - drop the personalization / live / memory / AI checks (each) → "anything
 *     viewer-scoped or time-varying" red.
 *   - `sufficientLocalRows` returns the rows without the entity-hit check →
 *     "a raw-query row alone is not an answer" red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  localAnswerSuffices,
  sufficientLocalRows,
  type LocalSufficiencyFacts,
  type LocalDictionaryPolicy,
} from '../localDictionary.ts';

const GRANTED: LocalSufficiencyFacts = {
  localSufficient: true,
  authoritative: true,
  offlinePolicy: 'static_dictionary',
  privacyClass: 'public',
  allowPersonalization: false,
  allowLiveContext: false,
  allowMemoryContext: false,
  allowAI: false,
};

const LANGUAGE: LocalDictionaryPolicy = {
  context: 'language',
  offlinePolicy: 'static_dictionary',
  privacyClass: 'public',
  entityTypes: ['language'],
  allowedSuggestionTypes: ['entity', 'completion'],
  maxSuggestions: 8,
};

test('intended: a grant with every condition met is sufficient', () => {
  assert.equal(localAnswerSuffices(GRANTED), true);
});

test('fail-closed: no facts, or a grant that is not a literal true', () => {
  assert.equal(localAnswerSuffices(null), false);
  assert.equal(localAnswerSuffices(undefined), false);
  assert.equal(localAnswerSuffices({ ...GRANTED, localSufficient: false }), false);
  assert.equal(localAnswerSuffices({ ...GRANTED, localSufficient: null }), false);
});

test('only an AUTHORITATIVE grant counts', () => {
  assert.equal(localAnswerSuffices({ ...GRANTED, authoritative: false }), false);
  assert.equal(localAnswerSuffices({ ...GRANTED, authoritative: undefined }), false);
});

test('only a static_dictionary surface', () => {
  for (const offlinePolicy of ['cached_local', 'recent_only', 'server_required', 'unavailable', null] as const) {
    assert.equal(localAnswerSuffices({ ...GRANTED, offlinePolicy }), false, String(offlinePolicy));
  }
});

test('PRIVACY: a non-public field is never sufficient', () => {
  for (const privacyClass of ['viewer_scoped', 'owner_only', 'sensitive_location', 'private_message', null] as const) {
    assert.equal(localAnswerSuffices({ ...GRANTED, privacyClass }), false, String(privacyClass));
  }
});

test('anything viewer-scoped or time-varying keeps the round trip', () => {
  assert.equal(localAnswerSuffices({ ...GRANTED, allowPersonalization: true }), false);
  assert.equal(localAnswerSuffices({ ...GRANTED, allowLiveContext: true }), false);
  assert.equal(localAnswerSuffices({ ...GRANTED, allowMemoryContext: true }), false);
  assert.equal(localAnswerSuffices({ ...GRANTED, allowAI: true }), false);
});

test('intended: a dictionary hit is the answer', () => {
  const rows = sufficientLocalRows(LANGUAGE, GRANTED, 'span');
  assert.ok(rows.some((r) => r.label === 'Spanish' && r.source === 'local'));
});

test('a raw-query row alone is not an answer — the request still goes out', () => {
  assert.deepEqual(sufficientLocalRows(LANGUAGE, GRANTED, 'klingonese'), []);
});

test('no grant, or an empty query, yields nothing', () => {
  assert.deepEqual(sufficientLocalRows(LANGUAGE, { ...GRANTED, localSufficient: false }, 'span'), []);
  assert.deepEqual(sufficientLocalRows(LANGUAGE, GRANTED, '   '), []);
  assert.deepEqual(sufficientLocalRows(null, GRANTED, 'span'), []);
});
