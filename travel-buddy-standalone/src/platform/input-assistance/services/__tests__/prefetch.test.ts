/**
 * §33/§53 census G209 — the prefetch's own contract (the end-to-end proof is
 * app/gems/__tests__/submit.locationFields.component.test.tsx: the Neighbourhood
 * field's first open after a canonical location pick is a cache hit with no
 * request).
 *
 * MUTATION LOG (applied alone, watched go red, restored):
 *   - an outage answer (`refusal`) cached → "an outage answer is never cached" red.
 *   - the privacy-class gate removed → "a field kept out of the shared cache is never asked" red.
 *   - the zero-state gate removed → "a field with no zero-state is never asked" red.
 *   - the already-warm check removed → "an already-warm field is not asked again" red.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prefetchZeroState, prefetchDependentFields, zeroStateCacheKey, FIELD_DEPENDENTS, type PrefetchRequest } from '../prefetch.ts';
import { sharedSuggestionCache } from '../suggestionCache.ts';
import { SDK_CAPABILITIES } from '../../contexts/clientCapabilities.ts';
import { INPUT_CONTEXTS } from '../../types/inputContext.ts';
import { _seedPolicyForTests } from '../policyStore.ts';
import type { InputSuggestion, SuggestRequest } from '../../types/inputSuggestion.ts';

_seedPolicyForTests(INPUT_CONTEXTS, {
  neighborhood_picker: { privacyClass: 'public', zeroStateAssistance: true, offlinePolicy: 'cached_local' },
  telegraph_recipient: { privacyClass: 'viewer_scoped', zeroStateAssistance: true },
  username: { privacyClass: 'public', zeroStateAssistance: false },
});

const HOOD = { fieldId: 'geo.neighborhood', context: 'neighborhood_picker' as const, capabilities: SDK_CAPABILITIES };
const ROW = { id: 'r1', type: 'recent', context: 'neighborhood_picker', label: 'Bangkok', source: 'recent', policyVersion: 'v', action: { type: 'replace_text', text: 'Bangkok' } } as InputSuggestion;

function recorder(answer: Record<string, unknown> = { ok: true, requestId: 'q', policyVersion: 'v', suggestions: [ROW] }) {
  const calls: SuggestRequest[] = [];
  const request: PrefetchRequest = async (req) => { calls.push(req); return answer as any; };
  return { calls, request };
}

beforeEach(() => sharedSuggestionCache.clear());

test('warms the field’s empty-text answer under the key its hook reads', async () => {
  const { calls, request } = recorder();
  assert.equal(await prefetchZeroState(HOOD, request), 'warmed');
  assert.equal(calls.length, 1);
  assert.deepEqual({ context: calls[0]!.context, fieldId: calls[0]!.fieldId, text: calls[0]!.text }, { context: 'neighborhood_picker', fieldId: 'geo.neighborhood', text: '' });
  assert.deepEqual(sharedSuggestionCache.get(zeroStateCacheKey(HOOD))?.map((s) => s.label), ['Bangkok']);
  assert.ok(zeroStateCacheKey(HOOD).includes('::cap:'), 'a SmartInput declares the overlay’s capabilities, so its key carries them');
});

test('an already-warm field is not asked again', async () => {
  const { calls, request } = recorder();
  await prefetchZeroState(HOOD, request);
  assert.equal(await prefetchZeroState(HOOD, request), 'cached');
  assert.equal(calls.length, 1);
});

test('an outage answer is never cached (the hook never caches one either)', async () => {
  const { request } = recorder({ ok: true, requestId: 'q', policyVersion: 'v', suggestions: [], refusal: { class: 'transient_db', code: 'x', route: 'r', coverage: 'partial', failedSources: ['saved'] } });
  assert.equal(await prefetchZeroState(HOOD, request), 'failed');
  assert.equal(sharedSuggestionCache.get(zeroStateCacheKey(HOOD)), null);
  const { request: down } = recorder({ ok: false, aborted: false, unavailable: true, error: 'offline' });
  assert.equal(await prefetchZeroState(HOOD, down), 'failed');
});

test('a field kept out of the shared cache is never asked (viewer-scoped)', async () => {
  const { calls, request } = recorder();
  assert.equal(await prefetchZeroState({ fieldId: 'telegraph.recipient', context: 'telegraph_recipient' }, request), 'skipped');
  assert.equal(calls.length, 0);
});

test('a field with no zero-state is never asked', async () => {
  const { calls, request } = recorder();
  assert.equal(await prefetchZeroState({ fieldId: 'profile.username', context: 'username' }, request), 'skipped');
  assert.equal(calls.length, 0);
});

test('only declared next fields are warmed: the Gem location → Neighbourhood; anything else → nothing', async () => {
  assert.deepEqual(FIELD_DEPENDENTS['gem.location']?.map((d) => d.fieldId), ['geo.neighborhood']);
  const { calls, request } = recorder();
  assert.deepEqual(await prefetchDependentFields('gem.location', request), ['warmed']);
  assert.deepEqual(await prefetchDependentFields('trip.destination', request), []);
  assert.deepEqual(await prefetchDependentFields(null, request), []);
  assert.equal(calls.length, 1);
});
