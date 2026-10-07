/**
 * census G261 — `services/suggestionHistory.ts` is the READ path of the
 * device-local recents, not a second store the privacy controls cannot see.
 *
 * THE DEFECT THIS PINS. `suggestionHistory` kept its own in-memory Map, fed by
 * every explicit accept, and the account-change erase (`applyAccountChange` →
 * `clearLocalRecents`) never touched it. After a sign-out or an account switch
 * the previous person's picks were still behind the exported
 * `getRecentSelections`. These tests drive the REAL account-change function, not
 * a stand-in for it.
 *
 * MUTATION LOG (each applied, watched go red, reverted, `git diff` clean):
 *   - suggestionHistory.ts: reinstate a private Map written by an exported
 *     `recordSelection`, forwarded from `recordLocalSelection`, and read by
 *     `getRecentSelections` → "an ACCOUNT CHANGE leaves no history behind" goes
 *     red (the previous account's pick is still readable).
 *   - suggestionHistory.ts: drop the `if (!policy) return []` guard and read
 *     with a public default → "fail-closed: no policy reads nothing" goes red.
 *   - localZeroState.ts: `forgetLocalRecents` without `schedulePersist()` →
 *     "a per-field clear survives a restart" goes red (the blob hydrates the
 *     cleared field back).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  recordLocalSelection,
  clearLocalZeroState,
  attachLocalRecents,
  detachLocalRecents,
  flushLocalRecents,
  localZeroState,
  clearLocalRecents,
  type LocalZeroStatePolicy,
} from '../localZeroState.ts';
import { getRecentSelections, clearRecentSelections } from '../suggestionHistory.ts';
import { applyAccountChange } from '../policySync.ts';
import { PolicyStore } from '../policyStore.ts';
import { SuggestionCache } from '../suggestionCache.ts';
import type { LocalRecentsStorage } from '../localRecentsStore.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';
import type { InputContext } from '../../types/inputContext.ts';

const CITY: LocalZeroStatePolicy = { context: 'city_picker', privacyClass: 'public', maxSuggestions: 5 };
const TRIP: LocalZeroStatePolicy = { context: 'trip_destination', privacyClass: 'public', maxSuggestions: 5 };
const RECIPIENT: LocalZeroStatePolicy = {
  context: 'telegraph_recipient',
  privacyClass: 'viewer_scoped',
  maxSuggestions: 5,
};

function row(label: string, id: string, context: InputContext): InputSuggestion {
  return {
    id: `s:${id}`,
    type: 'entity',
    context,
    label,
    entityType: 'city',
    entityId: id,
    action: { type: 'open_entity', entityType: 'city', entityId: id },
    source: 'canonical',
    policyVersion: 'input-2026-08',
  };
}

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    async getItem(k: string) { return map.get(k) ?? null; },
    async setItem(k: string, v: string) { map.set(k, v); },
    async removeItem(k: string) { map.delete(k); },
  } satisfies LocalRecentsStorage & { map: Map<string, string> };
}

beforeEach(() => {
  detachLocalRecents();
  clearLocalZeroState();
});

test('intended: an explicit accept is readable as history, most recent first', () => {
  recordLocalSelection(CITY, row('Bangkok', 'c1', 'city_picker'));
  recordLocalSelection(CITY, row('Da Nang', 'c2', 'city_picker'));
  assert.deepEqual(getRecentSelections(CITY), [
    { value: 'c2', label: 'Da Nang' },
    { value: 'c1', label: 'Bangkok' },
  ]);
  assert.deepEqual(getRecentSelections(CITY, 1), [{ value: 'c2', label: 'Da Nang' }], 'limit honoured');
});

test('intended: history read after a COLD START comes off the device (it is the read path of the device recents)', async () => {
  const storage = fakeStorage();
  await attachLocalRecents(storage);
  recordLocalSelection(CITY, row('Bangkok', 'c1', 'city_picker'));
  await flushLocalRecents();

  detachLocalRecents();
  clearLocalZeroState();
  assert.deepEqual(getRecentSelections(CITY), [], 'premise: process memory is empty');

  await attachLocalRecents(storage);
  assert.deepEqual(getRecentSelections(CITY), [{ value: 'c1', label: 'Bangkok' }]);
});

test('PRIVACY: an ACCOUNT CHANGE leaves no history behind — in memory or on the device', async () => {
  const storage = fakeStorage();
  await attachLocalRecents(storage);
  recordLocalSelection(CITY, row('Bangkok', 'c1', 'city_picker'));
  recordLocalSelection(TRIP, row('Da Nang', 'c2', 'trip_destination'));
  await flushLocalRecents();
  assert.equal(getRecentSelections(CITY).length, 1, 'premise: history exists for account A');

  // The real account-change path the app runs on sign-out / switch.
  const store = new PolicyStore();
  store.setActiveAccount('account-a');
  const changed = applyAccountChange('account-b', store, new SuggestionCache(), { clear: clearLocalRecents });
  assert.equal(changed, true, 'premise: this IS an account change');
  await flushLocalRecents();

  assert.deepEqual(getRecentSelections(CITY), [], 'account A’s city pick must not be readable by account B');
  assert.deepEqual(getRecentSelections(TRIP), [], 'nor its Trip destination');

  // And a cold start for account B does not hydrate it back.
  detachLocalRecents();
  clearLocalZeroState();
  await attachLocalRecents(storage);
  assert.deepEqual(getRecentSelections(CITY), [], 'the device copy was erased too');
});

test('PRIVACY: a viewer-scoped field is never retained, so it has no history', () => {
  recordLocalSelection(RECIPIENT, row('Alice', 'u1', 'telegraph_recipient'));
  assert.deepEqual(getRecentSelections(RECIPIENT), []);
});

test('PRIVACY: a field RECLASSIFIED since the write reads nothing, however warm the store is', () => {
  recordLocalSelection(CITY, row('Bangkok', 'c1', 'city_picker'));
  assert.deepEqual(getRecentSelections({ ...CITY, privacyClass: 'viewer_scoped' }), []);
  assert.deepEqual(getRecentSelections({ ...CITY, privacyClass: null }), []);
});

test('fail-closed: no policy reads nothing', () => {
  recordLocalSelection(CITY, row('Bangkok', 'c1', 'city_picker'));
  assert.deepEqual(getRecentSelections(null), []);
  assert.deepEqual(getRecentSelections(undefined), []);
});

test('PRIVACY: a per-field clear survives a restart — the blob does not hydrate it back', async () => {
  const storage = fakeStorage();
  await attachLocalRecents(storage);
  recordLocalSelection(CITY, row('Bangkok', 'c1', 'city_picker'));
  recordLocalSelection(TRIP, row('Da Nang', 'c2', 'trip_destination'));
  await flushLocalRecents();

  clearRecentSelections('city_picker');
  await flushLocalRecents();
  assert.deepEqual(getRecentSelections(CITY), [], 'cleared in this process');
  assert.deepEqual(getRecentSelections(TRIP), [{ value: 'c2', label: 'Da Nang' }], 'other fields untouched');

  detachLocalRecents();
  clearLocalZeroState();
  await attachLocalRecents(storage);
  assert.deepEqual(localZeroState(CITY), [], 'the cleared field stays cleared after a cold start');
  assert.deepEqual(getRecentSelections(TRIP), [{ value: 'c2', label: 'Da Nang' }]);
});

test('clearRecentSelections() with no context is the account-change erase', async () => {
  const storage = fakeStorage();
  await attachLocalRecents(storage);
  recordLocalSelection(CITY, row('Bangkok', 'c1', 'city_picker'));
  await flushLocalRecents();
  clearRecentSelections();
  await flushLocalRecents();
  assert.deepEqual(getRecentSelections(CITY), []);
  assert.equal(storage.map.size, 0, 'the device blob is removed');
});
