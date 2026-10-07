/**
 * census G224 / G212, lead ruling PR-D2-5 — the client's half of §34 local
 * SUFFICIENCY, pure.
 *
 * The hook wiring is proven in
 * hooks/__tests__/useInputAssistance.localSufficiency.component.test.tsx, and the
 * ruling's conditions (the shipped list IS the server's answer, for every viewer)
 * in artifacts/api-server/src/test/inputLocalSufficiencyParity.test.ts. These
 * prove each condition of the gate ON ITS OWN.
 *
 * MUTATION LOG (each applied, watched go red, reverted, `git diff` clean):
 *   - drop the context allowlist check → "only language and interest, whatever
 *     the server says" red.
 *   - widen the privacy check to any class → "never owner_only, sensitive or a
 *     private message" red.
 *   - drop `d.authoritative === true` → "only an AUTHORITATIVE grant counts" red.
 *   - drop `d.offlinePolicy === 'static_dictionary'` → "only a static_dictionary
 *     surface" red.
 *   - drop the personalization / live / memory / AI checks (each) → "anything
 *     personalised or time-varying" red.
 *   - drop the `raw.length < 2` refusal → "one character asks the server" red.
 *   - drop the rewritten-token refusal → "a word the server rewrites asks the
 *     server" red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  localAnswerSuffices,
  sufficientLocalRows,
  type LocalSufficiencyFacts,
  type LocalDictionaryPolicy,
} from '../localDictionary.ts';

// The registry's real shape for `language` (policyRegistry.ts, after the parity raise).
const GRANTED: LocalSufficiencyFacts = {
  context: 'language',
  localSufficient: true,
  authoritative: true,
  offlinePolicy: 'static_dictionary',
  privacyClass: 'viewer_scoped',
  allowPersonalization: false,
  allowLiveContext: false,
  allowMemoryContext: false,
  allowAI: false,
};

const LANGUAGE: LocalDictionaryPolicy = {
  context: 'language',
  offlinePolicy: 'static_dictionary',
  privacyClass: 'viewer_scoped',
  entityTypes: ['language'],
  allowedSuggestionTypes: ['entity'],
  maxSuggestions: 8,
};

test('intended: the sanctioned language field is sufficient, and so is interest', () => {
  assert.equal(localAnswerSuffices(GRANTED), true);
  assert.equal(localAnswerSuffices({ ...GRANTED, context: 'interest' }), true);
  assert.equal(localAnswerSuffices({ ...GRANTED, privacyClass: 'public' }), true);
});

test('only language and interest, whatever the server says', () => {
  for (const context of ['country_picker', 'city_picker', 'global_search', 'telegraph_recipient', 'trip_title', null] as const) {
    assert.equal(localAnswerSuffices({ ...GRANTED, context }), false, String(context));
  }
});

test('PRIVACY: never owner_only, sensitive or a private message — even for the two contexts', () => {
  for (const privacyClass of ['owner_only', 'sensitive_location', 'private_message', null] as const) {
    assert.equal(localAnswerSuffices({ ...GRANTED, privacyClass }), false, String(privacyClass));
  }
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

test('anything personalised or time-varying keeps the round trip', () => {
  assert.equal(localAnswerSuffices({ ...GRANTED, allowPersonalization: true }), false);
  assert.equal(localAnswerSuffices({ ...GRANTED, allowLiveContext: true }), false);
  assert.equal(localAnswerSuffices({ ...GRANTED, allowMemoryContext: true }), false);
  assert.equal(localAnswerSuffices({ ...GRANTED, allowAI: true }), false);
});

test('intended: a hit is answered with the server\'s own row — identity, action, route — marked local', () => {
  const [row] = sufficientLocalRows(LANGUAGE, GRANTED, 'span');
  assert.ok(row);
  assert.equal(row.label, 'Spanish');
  assert.equal(row.entityId, 'languages:spanish');
  assert.deepEqual(row.action, { type: 'open_entity', entityType: 'language', entityId: 'languages:spanish' });
  assert.equal(row.canonicalUri, 'portava:/language/spanish');
  assert.equal(row.source, 'local');
});

test('one character asks the server (the gateway dispatches entities only at two)', () => {
  assert.deepEqual(sufficientLocalRows(LANGUAGE, GRANTED, 's'), []);
});

test('a word the server rewrites asks the server', () => {
  // "nightlif" is searched as "nightlife" by the server's alias table.
  assert.deepEqual(sufficientLocalRows({ ...LANGUAGE, context: 'interest', entityTypes: ['interest'] }, { ...GRANTED, context: 'interest' }, 'nightlif'), []);
  assert.ok(sufficientLocalRows({ ...LANGUAGE, context: 'interest', entityTypes: ['interest'] }, { ...GRANTED, context: 'interest' }, 'nightlife').length > 0);
});

test('no hit, a non-ASCII query, or doubled spaces ask the server', () => {
  assert.deepEqual(sufficientLocalRows(LANGUAGE, GRANTED, 'klingonese'), []);
  assert.deepEqual(sufficientLocalRows(LANGUAGE, GRANTED, 'españ'), []);
  assert.deepEqual(sufficientLocalRows(LANGUAGE, GRANTED, 'sp  an'), []);
  assert.deepEqual(sufficientLocalRows(LANGUAGE, GRANTED, '   '), []);
  assert.deepEqual(sufficientLocalRows(null, GRANTED, 'span'), []);
  assert.deepEqual(sufficientLocalRows(LANGUAGE, { ...GRANTED, localSufficient: false }, 'span'), []);
});

test('verifier D1: only at the server\'s own cap — a field with any other maxSuggestions asks the server', () => {
  // Both sides slice hits before ranking, so a smaller device cap would lose a
  // higher-tier hit the server keeps. MUTATION-PROOF: drop the
  // `maxSuggestions !== SERVER_STATIC_MAX` refusal → the max-3 case answers → red.
  assert.ok(sufficientLocalRows(LANGUAGE, GRANTED, 'in').length > 0, 'control: the server cap answers');
  for (const maxSuggestions of [1, 3, 7, 9, 12]) {
    assert.deepEqual(sufficientLocalRows({ ...LANGUAGE, maxSuggestions }, GRANTED, 'in'), [], `max ${maxSuggestions}`);
  }
});
