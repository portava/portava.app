/**
 * census G200/G201 — the server's saved-place and Trip-destination zero-state
 * rows, kept on the device (lead ruling 2026-10-07): "keep saved-place and
 * trip-destination zero-state rows in the existing account-tagged device store,
 * erased on account change, used only by offline-allowed fields, with no
 * position stored."
 *
 * Each clause of the ruling has its own refusal below, next to the intended case.
 *
 * MUTATION LOG (each applied with scratchpad mutate.py, watched go red, restored
 * byte-identically):
 *   - `isRetainableZeroStateRow` returns true for every row → "only saved and
 *     Trip rows are kept" red.
 *   - `stripRetainedPosition` keeps scalar coordinates → "no position" red.
 *   - `zeroStateAllowed` skips `offlineSurfaceAllowed` → "a server_required field
 *     retains nothing" red.
 *   - `clearLocalRecents` stops clearing the zero-state store → "an account
 *     change erases them" red.
 *   - `offlineZeroStateRows` drops the owner check → "the READ is owner-gated
 *     too" red.
 *   - `decodeLocalZeroState` ignores the copy's own age → "a copy older than 7
 *     days is not restored" red.
 *   - `bindLocalRecentsAccount`'s in-flight-read branch stops clearing the
 *     zero-state store → "another account signing in WHILE a re-attach is
 *     reading" red.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearLocalZeroState,
  attachLocalRecents,
  detachLocalRecents,
  flushLocalRecents,
  bindLocalRecentsAccount,
  retainZeroStateRows,
  offlineZeroStateRows,
  _resetLocalRecentsAccountForTests,
  _forceRowsOwnerForTests,
} from '../localZeroState.ts';
import {
  LOCAL_RECENTS_STORAGE_KEY,
  LOCAL_ZERO_STATE_MAX_AGE_MS,
  decodeLocalZeroState,
  type LocalRecentsStorage,
} from '../localRecentsStore.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';
import type { InputContext, OfflineInputPolicy, PrivacyClass } from '../../types/inputContext.ts';

type Policy = { context: InputContext; privacyClass: PrivacyClass; maxSuggestions: number; offlinePolicy: OfflineInputPolicy };

// The server's own registry values for these fields (policyRegistry.ts).
const SEARCH: Policy = { context: 'global_search', privacyClass: 'public', maxSuggestions: 8, offlinePolicy: 'cached_local' };
const TRIP_DEST: Policy = { context: 'trip_destination', privacyClass: 'public', maxSuggestions: 8, offlinePolicy: 'cached_local' };
const PLACE: Policy = { context: 'place_picker', privacyClass: 'public', maxSuggestions: 8, offlinePolicy: 'server_required' };
const HOMEBASE: Policy = { context: 'passport_homebase', privacyClass: 'viewer_scoped', maxSuggestions: 8, offlinePolicy: 'cached_local' };

const DEST_LAT = 13.7563;
const DEST_LNG = 100.5018;

/** `savedEntities.ts#projectSavedPlace`, field for field. */
function savedRow(context: InputContext, id: string, label: string): InputSuggestion {
  return {
    id: `${context}:saved:place:${id}`, type: 'recent', context, label, entityType: 'place', entityId: id,
    action: { type: 'open_entity', entityType: 'place', entityId: id }, confidence: 0.8, source: 'memory',
    reason: 'Saved', destination: { route: `/place/${id}`, entityType: 'place', entityId: id },
    canonicalUri: `portava:/place/${id}`, policyVersion: 'input-2026-08', subtitle: 'Bangkok · cafe',
  };
}

/** `projection.ts#projectGeoDefault` for a geoResolver Trip default, field for field. */
function tripRow(context: InputContext, kind: 'active_trip' | 'upcoming_trip' | 'current', index: number): InputSuggestion {
  const binding = {
    entityType: 'city', cityId: '', city: 'Bangkok', country: 'Thailand', countryCode: null,
    lat: DEST_LAT, lng: DEST_LNG, timezone: 'Asia/Bangkok',
  };
  return {
    id: `${context}:default:${kind}:${index}`, type: 'recent', context, label: 'Bangkok',
    action: { type: 'set_structured_value', value: binding }, confidence: 0.7,
    source: kind === 'current' ? 'local' : 'recent',
    reason: kind === 'active_trip' ? 'Current Trip' : kind === 'upcoming_trip' ? 'Upcoming Trip' : 'Current location',
    policyVersion: 'input-2026-08', subtitle: 'Thailand', structuredValue: binding, entityType: 'city',
    destination: { route: '/city/bangkok', entityType: 'city' },
  };
}

/** A §35 recent the server holds itself — re-asked online, never kept here. */
function serverRecent(context: InputContext): InputSuggestion {
  return {
    id: `${context}:recent:city:c-1`, type: 'recent', context, label: 'Lisbon', entityType: 'city', entityId: 'c-1',
    action: { type: 'open_entity', entityType: 'city', entityId: 'c-1' }, source: 'memory', policyVersion: 'input-2026-08',
  };
}

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    async getItem(k: string) { return map.get(k) ?? null; },
    async setItem(k: string, v: string) { map.set(k, v); },
    async removeItem(k: string) { map.delete(k); },
  } satisfies LocalRecentsStorage & { map: Map<string, string> };
}

function ids(rows: readonly InputSuggestion[]): string[] {
  return rows.map((r) => r.id);
}

beforeEach(() => {
  detachLocalRecents();
  clearLocalZeroState();
  _resetLocalRecentsAccountForTests();
});

test('G200: an empty field keeps the SAVED place it was served, and offers it with no network', () => {
  bindLocalRecentsAccount('user-a');
  retainZeroStateRows(SEARCH, [serverRecent('global_search'), savedRow('global_search', 'p-1', 'Roast Lab')]);
  assert.deepEqual(ids(offlineZeroStateRows(SEARCH)), ['global_search:saved:place:p-1']);
});

test('G200: only saved and Trip rows are kept — not the current location, not the server\'s own recents', () => {
  bindLocalRecentsAccount('user-a');
  retainZeroStateRows(TRIP_DEST, [
    tripRow('trip_destination', 'current', 0),
    tripRow('trip_destination', 'active_trip', 1),
    tripRow('trip_destination', 'upcoming_trip', 2),
    serverRecent('trip_destination'),
  ]);
  assert.deepEqual(ids(offlineZeroStateRows(TRIP_DEST)), [
    'trip_destination:default:active_trip:1',
    'trip_destination:default:upcoming_trip:2',
  ]);
});

test('G200: no position — a Trip binding keeps its city, country and timezone, and its coordinates are null', async () => {
  const storage = fakeStorage();
  await attachLocalRecents(storage);
  bindLocalRecentsAccount('user-a');
  retainZeroStateRows(TRIP_DEST, [tripRow('trip_destination', 'active_trip', 0)]);
  await flushLocalRecents();

  const [row] = offlineZeroStateRows(TRIP_DEST);
  const sv = row.structuredValue as Record<string, unknown>;
  assert.equal(sv.city, 'Bangkok');
  assert.equal(sv.timezone, 'Asia/Bangkok');
  assert.equal(sv.lat, null);
  assert.equal(sv.lng, null);
  const value = (row.action as { value: Record<string, unknown> }).value;
  assert.equal(value.lat, null);
  assert.equal(value.lng, null);

  // And the DEVICE never holds them: not one digit of the destination's position.
  const blob = storage.map.get(LOCAL_RECENTS_STORAGE_KEY) ?? '';
  assert.ok(blob.includes('"zeroState"'), 'the copy was written');
  assert.ok(!blob.includes(String(DEST_LAT)) && !blob.includes(String(DEST_LNG)), 'no coordinate on the device');
});

test('G200: a server_required field retains nothing, and neither does a viewer_scoped one', async () => {
  const storage = fakeStorage();
  await attachLocalRecents(storage);
  bindLocalRecentsAccount('user-a');
  retainZeroStateRows(PLACE, [savedRow('place_picker', 'p-1', 'Roast Lab')]);
  retainZeroStateRows(HOMEBASE, [tripRow('passport_homebase', 'active_trip', 0)]);
  await flushLocalRecents();
  assert.deepEqual(offlineZeroStateRows(PLACE), []);
  assert.deepEqual(offlineZeroStateRows(HOMEBASE), []);
  assert.ok(!(storage.map.get(LOCAL_RECENTS_STORAGE_KEY) ?? '').includes('"zeroState"'), 'nothing written for either');
});

test('G200: nothing is kept while no account is bound', () => {
  retainZeroStateRows(SEARCH, [savedRow('global_search', 'p-1', 'Roast Lab')]);
  bindLocalRecentsAccount('user-a');
  assert.deepEqual(offlineZeroStateRows(SEARCH), []);
});

test('G200: each answer REPLACES the copy — an unsaved place is gone from the next one', () => {
  bindLocalRecentsAccount('user-a');
  retainZeroStateRows(SEARCH, [savedRow('global_search', 'p-1', 'Roast Lab'), savedRow('global_search', 'p-2', 'Wat Arun')]);
  retainZeroStateRows(SEARCH, [savedRow('global_search', 'p-2', 'Wat Arun')]);
  assert.deepEqual(ids(offlineZeroStateRows(SEARCH)), ['global_search:saved:place:p-2']);
  retainZeroStateRows(SEARCH, []);
  assert.deepEqual(offlineZeroStateRows(SEARCH), []);
});

test('G200: the copy survives a restart of the same person', async () => {
  const storage = fakeStorage();
  await attachLocalRecents(storage);
  bindLocalRecentsAccount('user-a');
  retainZeroStateRows(SEARCH, [savedRow('global_search', 'p-1', 'Roast Lab')]);
  await flushLocalRecents();

  // Cold start.
  detachLocalRecents();
  clearLocalZeroState();
  _resetLocalRecentsAccountForTests();
  await attachLocalRecents(storage);
  assert.deepEqual(offlineZeroStateRows(SEARCH), [], 'not served before the app says who is signed in');
  bindLocalRecentsAccount('user-a');
  assert.deepEqual(ids(offlineZeroStateRows(SEARCH)), ['global_search:saved:place:p-1']);
});

test('G200: an account change erases them, from memory and from the device', async () => {
  const storage = fakeStorage();
  await attachLocalRecents(storage);
  bindLocalRecentsAccount('user-a');
  retainZeroStateRows(SEARCH, [savedRow('global_search', 'p-1', 'Roast Lab')]);
  await flushLocalRecents();

  bindLocalRecentsAccount('user-b');
  await flushLocalRecents();
  assert.deepEqual(offlineZeroStateRows(SEARCH), []);
  assert.equal(storage.map.has(LOCAL_RECENTS_STORAGE_KEY), false);
});

test('G200: signing out erases them', async () => {
  const storage = fakeStorage();
  await attachLocalRecents(storage);
  bindLocalRecentsAccount('user-a');
  retainZeroStateRows(SEARCH, [savedRow('global_search', 'p-1', 'Roast Lab')]);
  await flushLocalRecents();
  bindLocalRecentsAccount(null);
  await flushLocalRecents();
  assert.deepEqual(offlineZeroStateRows(SEARCH), []);
  assert.equal(storage.map.has(LOCAL_RECENTS_STORAGE_KEY), false);
});

test('G200: rows of another account are never served — a blob written for B, read with A signed in', async () => {
  const storage = fakeStorage();
  await attachLocalRecents(storage);
  bindLocalRecentsAccount('user-b');
  retainZeroStateRows(SEARCH, [savedRow('global_search', 'p-9', 'B\'s place')]);
  await flushLocalRecents();

  detachLocalRecents();
  clearLocalZeroState();
  _resetLocalRecentsAccountForTests();
  bindLocalRecentsAccount('user-a'); // ACCOUNT FIRST
  await attachLocalRecents(storage);
  await flushLocalRecents();
  assert.deepEqual(offlineZeroStateRows(SEARCH), []);
  assert.equal(storage.map.has(LOCAL_RECENTS_STORAGE_KEY), false, 'B\'s blob is erased, not kept');
});

test('G200: the READ is owner-gated too — rows held for another account are not served (verifier V5\'s rule)', () => {
  bindLocalRecentsAccount('user-a');
  retainZeroStateRows(SEARCH, [savedRow('global_search', 'p-1', 'Roast Lab')]);
  assert.equal(offlineZeroStateRows(SEARCH).length, 1);
  _forceRowsOwnerForTests('user-b');
  assert.deepEqual(offlineZeroStateRows(SEARCH), []);
});

test('G200: another account signing in WHILE a re-attach is reading does not inherit the restored copy', async () => {
  // A's device copy, restored by a first attach before anyone is known to be signed in.
  const now = Date.now();
  const blobA = JSON.stringify({
    v: 1, savedAt: now, owner: 'user-a', contexts: {},
    zeroState: { global_search: { at: now, rows: [savedRow('global_search', 'p-1', 'Roast Lab')] } },
  });
  await attachLocalRecents(fakeStorage({ [LOCAL_RECENTS_STORAGE_KEY]: blobA }));

  // A second attach (a remount) whose read has not landed yet …
  let release: (v: string | null) => void = () => {};
  const slow: LocalRecentsStorage = {
    getItem: () => new Promise<string | null>((r) => { release = r; }),
    async setItem() {},
    async removeItem() {},
  };
  const pending = attachLocalRecents(slow);
  // … and B signs in during it.
  bindLocalRecentsAccount('user-b');
  release(null);
  await pending;
  assert.deepEqual(offlineZeroStateRows(SEARCH), [], 'A\'s restored copy is not B\'s');
});

test('G200: a LEGACY blob with no owner restores nothing', async () => {
  const now = Date.now();
  const legacy = JSON.stringify({
    v: 1, savedAt: now, contexts: {},
    zeroState: { global_search: { at: now, rows: [savedRow('global_search', 'p-1', 'Roast Lab')] } },
  });
  const storage = fakeStorage({ [LOCAL_RECENTS_STORAGE_KEY]: legacy });
  await attachLocalRecents(storage);
  bindLocalRecentsAccount('user-a');
  await flushLocalRecents();
  assert.deepEqual(offlineZeroStateRows(SEARCH), []);
});

test('G200: a copy older than 7 days is not restored, on its own clock and not the blob\'s', () => {
  const now = Date.now();
  const stale = now - LOCAL_ZERO_STATE_MAX_AGE_MS - 1;
  const raw = JSON.stringify({
    v: 1, savedAt: now, owner: 'user-a', contexts: {},
    zeroState: {
      global_search: { at: stale, rows: [savedRow('global_search', 'p-1', 'Roast Lab')] },
      trip_destination: { at: now, rows: [tripRow('trip_destination', 'active_trip', 0)] },
    },
  });
  const decoded = decodeLocalZeroState(raw, now);
  assert.equal(decoded.has('global_search'), false);
  assert.deepEqual(ids(decoded.get('trip_destination')?.rows ?? []), ['trip_destination:default:active_trip:0']);
});

test('G200: a stored copy with a coordinate in it is scrubbed on the way in, and a foreign row is refused', () => {
  const now = Date.now();
  const raw = JSON.stringify({
    v: 1, savedAt: now, owner: 'user-a', contexts: {},
    zeroState: {
      trip_destination: { at: now, rows: [tripRow('trip_destination', 'active_trip', 0), serverRecent('trip_destination')] },
    },
  });
  const rows = decodeLocalZeroState(raw, now).get('trip_destination')?.rows ?? [];
  assert.deepEqual(ids(rows), ['trip_destination:default:active_trip:0']);
  assert.equal((rows[0].structuredValue as Record<string, unknown>).lat, null);
});
