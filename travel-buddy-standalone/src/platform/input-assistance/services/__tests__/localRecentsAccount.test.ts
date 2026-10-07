/**
 * census G199 — verifier finding F6 (2026-10-07): a COLD START of the same
 * person is not an account change.
 *
 * THE DEFECT. `PolicyStore` does not persist its active account, so the first
 * sign-in of every launch reads as `null → A` and `applyAccountChange` called the
 * recents erase. `app/_layout.tsx` installs policy sync before `LocalRecentsSetup`,
 * and `attachLocalRecents` binds the store synchronously before it awaits the
 * read. So, depending on which of `getSessionUserId()` and `AsyncStorage.getItem`
 * resolved first, the person's own device recents were wiped on launch (read
 * first) or the blob was removed while being read (account first) — G199's
 * "survives a restart" did not hold for the app the way it is mounted.
 *
 * Every test below drives the REAL `applyAccountChange` with the port the app's
 * installer now passes (`{ clear, bindAccount }`), in BOTH orders.
 *
 * MUTATION LOG (each applied, watched go red, reverted, `git diff` clean):
 *   - `bindLocalRecentsAccount` always erases (the old rule) → both "same person,
 *     cold start" tests red.
 *   - `attachLocalRecents` without the owner check → "another account's blob is
 *     never restored, and is erased" red (account-first order).
 *   - `bindLocalRecentsAccount` keeps rows whose owner is unknown → "a LEGACY blob
 *     with no owner is erased once" red.
 *   - `applyAccountChange` ignores `bindAccount` (clear on change) → "through the
 *     real applyAccountChange" red.
 *   - `bindLocalRecentsAccount` without the `hydrating` deferral → "the account
 *     lands WHILE the device read is in flight" red (the blob is erased mid-read).
 *   - (verifier V4) attach's owner check weakened to `blobOwner !== null &&
 *     blobOwner !== boundAccount` → "ACCOUNT FIRST, then a legacy ownerless blob" red.
 *   - (verifier V5) drop the `hydratedUnconfirmed` read gate → "rows restored
 *     before the app says who is signed in" red; drop the `rowsOwner !==
 *     boundAccount` read gate → "rows of another account are never served" red.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  recordLocalSelection,
  clearLocalZeroState,
  clearLocalRecents,
  attachLocalRecents,
  detachLocalRecents,
  flushLocalRecents,
  localZeroState,
  bindLocalRecentsAccount,
  _resetLocalRecentsAccountForTests,
  _forceRowsOwnerForTests,
  type LocalZeroStatePolicy,
} from '../localZeroState.ts';
import { LOCAL_RECENTS_STORAGE_KEY, encodeLocalRecents, decodeLocalRecentsOwner, type LocalRecentsStorage } from '../localRecentsStore.ts';
import { applyAccountChange } from '../policySync.ts';
import { PolicyStore } from '../policyStore.ts';
import { SuggestionCache } from '../suggestionCache.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

const CITY: LocalZeroStatePolicy = { context: 'city_picker', privacyClass: 'public', maxSuggestions: 5 };
const PORT = { clear: clearLocalRecents, bindAccount: bindLocalRecentsAccount };

function city(label: string, id: string): InputSuggestion {
  return {
    id: `s:${id}`, type: 'entity', context: 'city_picker', label, entityType: 'city', entityId: id,
    action: { type: 'open_entity', entityType: 'city', entityId: id }, source: 'canonical', policyVersion: 'input-2026-08',
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

/** A device that A used yesterday: their Bangkok pick, written under their account. */
async function deviceUsedBy(owner: string) {
  const storage = fakeStorage();
  await attachLocalRecents(storage);
  bindLocalRecentsAccount(owner);
  recordLocalSelection(CITY, city('Bangkok', 'c-bkk'));
  await flushLocalRecents();
  assert.equal(decodeLocalRecentsOwner(storage.map.get(LOCAL_RECENTS_STORAGE_KEY)), owner, 'premise: the blob names its owner');
  // The app is killed: process memory goes, the device stays.
  detachLocalRecents();
  clearLocalZeroState();
  _resetLocalRecentsAccountForTests();
  return storage;
}

/** A fresh launch's policy store: no active account, as the real one starts. */
const coldStore = () => new PolicyStore();

beforeEach(() => {
  detachLocalRecents();
  clearLocalZeroState();
  _resetLocalRecentsAccountForTests();
});

test('same person, cold start, the DEVICE READ lands first: their recents survive', async () => {
  const storage = await deviceUsedBy('user-a');
  await attachLocalRecents(storage); // hydration first …
  applyAccountChange('user-a', coldStore(), new SuggestionCache(), PORT); // … then null → A
  await flushLocalRecents();
  assert.deepEqual(localZeroState(CITY).map((s) => s.label), ['Bangkok']);
  assert.ok(storage.map.has(LOCAL_RECENTS_STORAGE_KEY), 'and the device copy is kept');
});

test('same person, cold start, the ACCOUNT lands first: their recents are restored', async () => {
  const storage = await deviceUsedBy('user-a');
  applyAccountChange('user-a', coldStore(), new SuggestionCache(), PORT); // null → A first …
  await attachLocalRecents(storage); // … then the read
  await flushLocalRecents();
  assert.deepEqual(localZeroState(CITY).map((s) => s.label), ['Bangkok']);
  assert.ok(storage.map.has(LOCAL_RECENTS_STORAGE_KEY));
});

/** A device whose read the test releases by hand — the app's real interleaving. */
function slowStorage(from: { map: Map<string, string> }) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  return {
    release: () => release(),
    async getItem(k: string) { await gate; return from.map.get(k) ?? null; },
    async setItem(k: string, v: string) { from.map.set(k, v); },
    async removeItem(k: string) { from.map.delete(k); },
  };
}

test('same person, cold start, the account lands WHILE the device read is in flight: nothing is erased', async () => {
  // The order app/_layout.tsx produces: LocalRecentsSetup binds the store and
  // starts the read; getSessionUserId() resolves before the read returns.
  const device = await deviceUsedBy('user-a');
  const slow = slowStorage(device);
  const hydration = attachLocalRecents(slow);
  applyAccountChange('user-a', coldStore(), new SuggestionCache(), PORT);
  await flushLocalRecents();
  assert.ok(device.map.has(LOCAL_RECENTS_STORAGE_KEY), 'the blob must not be erased mid-read');
  slow.release();
  await hydration;
  await flushLocalRecents();
  assert.deepEqual(localZeroState(CITY).map((s) => s.label), ['Bangkok']);
  assert.ok(device.map.has(LOCAL_RECENTS_STORAGE_KEY));
});

test('PRIVACY: in that same interleaving, ANOTHER account’s blob is still refused and erased', async () => {
  const device = await deviceUsedBy('user-a');
  const slow = slowStorage(device);
  const hydration = attachLocalRecents(slow);
  applyAccountChange('user-b', coldStore(), new SuggestionCache(), PORT);
  slow.release();
  await hydration;
  await flushLocalRecents();
  assert.deepEqual(localZeroState(CITY), []);
  assert.equal(device.map.has(LOCAL_RECENTS_STORAGE_KEY), false);
});

test('PRIVACY: another account’s blob is never restored, and is erased — in either order', async () => {
  // Read first, then B signs in.
  let storage = await deviceUsedBy('user-a');
  await attachLocalRecents(storage);
  applyAccountChange('user-b', coldStore(), new SuggestionCache(), PORT);
  await flushLocalRecents();
  assert.deepEqual(localZeroState(CITY), [], 'B must not see A’s pick');
  assert.equal(storage.map.has(LOCAL_RECENTS_STORAGE_KEY), false, 'A’s blob is erased');

  // Account first, then the read.
  detachLocalRecents(); clearLocalZeroState(); _resetLocalRecentsAccountForTests();
  storage = await deviceUsedBy('user-a');
  applyAccountChange('user-b', coldStore(), new SuggestionCache(), PORT);
  await attachLocalRecents(storage);
  await flushLocalRecents();
  assert.deepEqual(localZeroState(CITY), []);
  assert.equal(storage.map.has(LOCAL_RECENTS_STORAGE_KEY), false);
});

test('PRIVACY: a LEGACY blob with no owner is erased once (unknown fails closed)', async () => {
  const legacy = encodeLocalRecents(new Map([['city_picker', [city('Bangkok', 'c-bkk')]]]), Date.now());
  assert.equal(decodeLocalRecentsOwner(legacy), null, 'premise: no owner in it');
  const storage = fakeStorage({ [LOCAL_RECENTS_STORAGE_KEY]: legacy });
  await attachLocalRecents(storage);
  applyAccountChange('user-a', coldStore(), new SuggestionCache(), PORT);
  await flushLocalRecents();
  assert.deepEqual(localZeroState(CITY), []);
  assert.equal(storage.map.has(LOCAL_RECENTS_STORAGE_KEY), false);
});

test('PRIVACY: signing OUT erases everything; an in-session switch A → B erases too', async () => {
  const storage = fakeStorage();
  await attachLocalRecents(storage);
  const store = coldStore();
  applyAccountChange('user-a', store, new SuggestionCache(), PORT);
  recordLocalSelection(CITY, city('Bangkok', 'c-bkk'));
  await flushLocalRecents();
  applyAccountChange(null, store, new SuggestionCache(), PORT);
  await flushLocalRecents();
  assert.deepEqual(localZeroState(CITY), []);
  assert.equal(storage.map.has(LOCAL_RECENTS_STORAGE_KEY), false);

  applyAccountChange('user-a', store, new SuggestionCache(), PORT);
  recordLocalSelection(CITY, city('Hue', 'c-hue'));
  await flushLocalRecents();
  applyAccountChange('user-b', store, new SuggestionCache(), PORT);
  await flushLocalRecents();
  assert.deepEqual(localZeroState(CITY), []);
  assert.equal(storage.map.has(LOCAL_RECENTS_STORAGE_KEY), false);
});

test('through the real applyAccountChange: the bindAccount port is what decides, not "did the variable change"', async () => {
  const storage = await deviceUsedBy('user-a');
  await attachLocalRecents(storage);
  const changed = applyAccountChange('user-a', coldStore(), new SuggestionCache(), PORT);
  assert.equal(changed, true, 'premise: the policy store DOES see null → A as a change');
  await flushLocalRecents();
  assert.equal(localZeroState(CITY).length, 1, '… and the recents survive it anyway');
});

test('PRIVACY (verifier V4): ACCOUNT FIRST, then a legacy ownerless blob — never restored, and erased', async () => {
  const legacy = encodeLocalRecents(new Map([['city_picker', [city('Bangkok', 'c-bkk')]]]), Date.now());
  assert.equal(decodeLocalRecentsOwner(legacy), null, 'premise: no owner in it');
  const storage = fakeStorage({ [LOCAL_RECENTS_STORAGE_KEY]: legacy });
  applyAccountChange('user-a', coldStore(), new SuggestionCache(), PORT); // the account lands first …
  await attachLocalRecents(storage);                                     // … then the read
  await flushLocalRecents();
  assert.deepEqual(localZeroState(CITY), []);
  assert.equal(storage.map.has(LOCAL_RECENTS_STORAGE_KEY), false);
});

test('PRIVACY (verifier V5): rows restored before the app says who is signed in are not served until it does', async () => {
  const storage = await deviceUsedBy('user-a');
  await attachLocalRecents(storage); // hydrated: A's Bangkok is in memory …
  assert.deepEqual(localZeroState(CITY), [], '… and is served to nobody yet');
  bindLocalRecentsAccount('user-a');
  assert.deepEqual(localZeroState(CITY).map((s) => s.label), ['Bangkok'], 'its owner gets it once known');
});

test('PRIVACY (verifier V5): rows of another account are never served, even if the store still holds them', async () => {
  bindLocalRecentsAccount('user-a');
  recordLocalSelection(CITY, city('Bangkok', 'c-bkk'));
  assert.equal(localZeroState(CITY).length, 1, 'premise: A sees their own pick');
  // A bound account that is not the rows' owner (forced, as a later bug could leave it).
  _forceRowsOwnerForTests('user-b');
  assert.deepEqual(localZeroState(CITY), []);
});
