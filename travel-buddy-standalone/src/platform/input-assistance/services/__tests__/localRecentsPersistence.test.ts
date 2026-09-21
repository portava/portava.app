/**
 * §32 G199 / §34 G213 — DEVICE-LOCAL recent selections, pure half.
 *
 * WHAT THIS IS FOR. §32 says recents should be device-local where allowed, so a
 * cold start offline still has a useful zero-state. G216 built the in-SESSION
 * half: accepted rows are replayed from a process-memory ring buffer, gated by
 * the field's `privacyClass`. The census recorded what that leaves: "an app
 * restart still has nothing local, which is G199."
 *
 * These prove the durable half — what may be written to the device, what may be
 * read back from it, and what the read-back is still not allowed to do.
 *
 * THE POINT OF FAILURE THIS GUARDS. A store on disk outlives the policy that
 * licensed it and outlives the SESSION that wrote it. So there are two gates,
 * not one: the write gate (already `mayRetainLocally`, unchanged) and the read
 * gate, which is applied against the LIVE policy every time, so a field the
 * authority has since reclassified serves nothing however warm the disk is.
 * A blob is also refused wholesale when it is too old, malformed, or carries a
 * row this build cannot name.
 *
 * MUTATION LOG — see the bottom of this file.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  localZeroState,
  recordLocalSelection,
  clearLocalZeroState,
  attachLocalRecents,
  detachLocalRecents,
  flushLocalRecents,
  type LocalZeroStatePolicy,
} from '../localZeroState.ts';
import {
  LOCAL_RECENTS_STORAGE_KEY,
  LOCAL_RECENTS_MAX_AGE_MS,
  decodeLocalRecents,
  encodeLocalRecents,
  type LocalRecentsStorage,
} from '../localRecentsStore.ts';
import { applyAccountChange } from '../policySync.ts';
import { clearRecentSelections } from '../suggestionHistory.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';
import type { InputContext } from '../../types/inputContext.ts';

const PUBLIC_POLICY: LocalZeroStatePolicy = {
  context: 'city_picker',
  privacyClass: 'public',
  maxSuggestions: 5,
};
const VIEWER_SCOPED: LocalZeroStatePolicy = {
  context: 'telegraph_recipient',
  privacyClass: 'viewer_scoped',
  maxSuggestions: 5,
};

/** An in-memory stand-in for AsyncStorage. Synchronous under the covers so the
 *  tests never race, async at the surface so the port is the real one. */
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    writes: 0,
    removes: 0,
    async getItem(k: string) { return map.get(k) ?? null; },
    async setItem(k: string, v: string) { this.writes++; map.set(k, v); },
    async removeItem(k: string) { this.removes++; map.delete(k); },
  } satisfies LocalRecentsStorage & { map: Map<string, string>; writes: number; removes: number };
}

function city(label: string, id: string, context: InputContext = 'city_picker'): InputSuggestion {
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

beforeEach(async () => {
  detachLocalRecents();
  clearLocalZeroState();
  clearRecentSelections();
});

test('G199: an accepted row is WRITTEN to the device', async () => {
  const storage = fakeStorage();
  await attachLocalRecents(storage);

  recordLocalSelection(PUBLIC_POLICY, city('Bangkok', 'c1'));
  await flushLocalRecents();

  const raw = storage.map.get(LOCAL_RECENTS_STORAGE_KEY);
  assert.ok(raw, 'nothing was written to the device');
  const decoded = decodeLocalRecents(raw, Date.now());
  assert.deepEqual(decoded.get('city_picker')?.map((s) => s.label), ['Bangkok']);
});

test('G199: it SURVIVES a restart — a cold process reads it back', async () => {
  const storage = fakeStorage();
  await attachLocalRecents(storage);
  recordLocalSelection(PUBLIC_POLICY, city('Bangkok', 'c1'));
  recordLocalSelection(PUBLIC_POLICY, city('Da Nang', 'c2'));
  await flushLocalRecents();

  // The restart: the process-memory buffer is gone, the device is not.
  detachLocalRecents();
  clearLocalZeroState();
  assert.deepEqual(localZeroState(PUBLIC_POLICY), [], 'premise: memory is empty');

  await attachLocalRecents(storage);
  assert.deepEqual(
    localZeroState(PUBLIC_POLICY).map((s) => s.label),
    ['Da Nang', 'Bangkok'],
  );
  // Still replayed as `recent`, exactly as the in-session tier does.
  assert.deepEqual(localZeroState(PUBLIC_POLICY).map((s) => s.type), ['recent', 'recent']);
});

test('§29 WRITE gate: a viewer-scoped field puts nothing on the device', async () => {
  const storage = fakeStorage();
  await attachLocalRecents(storage);

  recordLocalSelection(VIEWER_SCOPED, city('Alice', 'u1', 'telegraph_recipient'));
  await flushLocalRecents();

  const raw = storage.map.get(LOCAL_RECENTS_STORAGE_KEY);
  // Either nothing was written at all, or what was written holds no row for it.
  if (raw) {
    assert.equal(decodeLocalRecents(raw, Date.now()).has('telegraph_recipient'), false);
  }
});

test('§29 READ gate: a field RECLASSIFIED since the write serves nothing', async () => {
  // The case a disk creates and a session cannot: the rows were written when
  // the authority called this field public, and the authority now calls it
  // viewer-scoped. The read gate is evaluated against the LIVE policy, so the
  // warm disk buys the reclassified field nothing.
  const storage = fakeStorage({
    [LOCAL_RECENTS_STORAGE_KEY]: encodeLocalRecents(
      new Map([['telegraph_recipient', [city('Alice', 'u1', 'telegraph_recipient')]]]),
      Date.now(),
    ),
  });
  await attachLocalRecents(storage);

  assert.deepEqual(localZeroState(VIEWER_SCOPED), []);
});

test('G13: a blob older than the retention window is not restored', async () => {
  const stale = Date.now() - LOCAL_RECENTS_MAX_AGE_MS - 1;
  const storage = fakeStorage({
    [LOCAL_RECENTS_STORAGE_KEY]: encodeLocalRecents(
      new Map([['city_picker', [city('Bangkok', 'c1')]]]),
      stale,
    ),
  });
  await attachLocalRecents(storage);

  assert.deepEqual(localZeroState(PUBLIC_POLICY), []);
});

test('a blob written in the FUTURE is refused too — a clock that moved is not a licence', () => {
  const future = Date.now() + 60 * 60 * 1000;
  const decoded = decodeLocalRecents(
    encodeLocalRecents(new Map([['city_picker', [city('Bangkok', 'c1')]]]), future),
    Date.now(),
  );
  assert.equal(decoded.size, 0);
});

test('malformed storage restores nothing and never throws', async () => {
  for (const junk of ['', 'not json', '{}', '[]', 'null', '{"v":99,"contexts":{}}']) {
    const decoded = decodeLocalRecents(junk, Date.now());
    assert.equal(decoded.size, 0, `junk survived: ${junk}`);
  }
  const storage = fakeStorage({ [LOCAL_RECENTS_STORAGE_KEY]: 'not json' });
  await attachLocalRecents(storage);
  assert.deepEqual(localZeroState(PUBLIC_POLICY), []);
});

test('a row this build cannot name is DROPPED, not repaired', () => {
  const now = Date.now();
  const good = city('Bangkok', 'c1');
  const payload = JSON.stringify({
    v: 1,
    savedAt: now,
    contexts: {
      city_picker: [
        good,
        { ...good, id: 's:x', label: 'Ghost', type: 'completion' }, // not replayable
        { ...good, id: 's:y', label: 'NoLabel', label2: 'x', ...{ label: '' } }, // empty label
        { ...good, id: 's:z', label: 'BadAction', action: { type: 'launch_missiles' } },
        { ...good, id: 's:w', label: 'BadSource', source: 'somewhere_else' },
      ],
      not_a_context: [good],
    },
  });
  const decoded = decodeLocalRecents(payload, now);
  assert.deepEqual(decoded.get('city_picker')?.map((s) => s.label), ['Bangkok']);
  assert.equal(decoded.has('not_a_context' as InputContext), false);
});

test('§29 sign-out: an account CHANGE wipes the device-local recents', () => {
  const store = {
    account: 'user-a' as string | null,
    activeAccount() { return this.account; },
    setActiveAccount(id: string | null) { this.account = id; },
  };
  const cache = { cleared: 0, clear() { this.cleared++; } };
  const recents = { cleared: 0, clear() { this.cleared++; } };

  // Same account reported again (a token refresh) — nothing is thrown away.
  applyAccountChange('user-a', store as never, cache, recents);
  assert.equal(recents.cleared, 0);
  assert.equal(cache.cleared, 0);

  // A real switch — both the process cache AND the device store go.
  applyAccountChange('user-b', store as never, cache, recents);
  assert.equal(recents.cleared, 1);
  assert.equal(cache.cleared, 1);

  // And sign-out.
  applyAccountChange(null, store as never, cache, recents);
  assert.equal(recents.cleared, 2);
});

test('an unattached process behaves exactly as it did before persistence existed', () => {
  // No port bound: recording still works, reading still works, and nothing
  // throws. The whole durable half is additive.
  recordLocalSelection(PUBLIC_POLICY, city('Bangkok', 'c1'));
  assert.deepEqual(localZeroState(PUBLIC_POLICY).map((s) => s.label), ['Bangkok']);
});

test('a storage backend that THROWS costs the user nothing', async () => {
  const broken: LocalRecentsStorage = {
    async getItem() { throw new Error('no disk'); },
    async setItem() { throw new Error('no disk'); },
    async removeItem() { throw new Error('no disk'); },
  };
  await attachLocalRecents(broken); // must not reject
  recordLocalSelection(PUBLIC_POLICY, city('Bangkok', 'c1'));
  await flushLocalRecents(); // must not reject
  assert.deepEqual(localZeroState(PUBLIC_POLICY).map((s) => s.label), ['Bangkok']);
});

test('the SESSION wins over the disk for a context it already has', async () => {
  const storage = fakeStorage({
    [LOCAL_RECENTS_STORAGE_KEY]: encodeLocalRecents(
      new Map([['city_picker', [city('Hanoi', 'c9')]]]),
      Date.now(),
    ),
  });
  // Something was accepted in this process BEFORE the disk was read.
  recordLocalSelection(PUBLIC_POLICY, city('Bangkok', 'c1'));
  await attachLocalRecents(storage);

  // Hydration must not reorder or displace what this session already knows.
  assert.equal(localZeroState(PUBLIC_POLICY)[0]?.label, 'Bangkok');
});

/*
 * MUTATION LOG — each applied to the shipped module, run, watched, reverted.
 * Baseline: 12/12 here, 21/21 with localZeroState.test.ts alongside it.
 *
 *  P1. localZeroState.ts: `attachLocalRecents` binds the port but does not
 *      hydrate → 11/12. "it SURVIVES a restart" goes red.
 *  P2. localZeroState.ts: `schedulePersist` returns immediately → 10/12. Both
 *      "an accepted row is WRITTEN" and "it SURVIVES a restart" go red.
 *  P3. localZeroState.ts: drop `if (rowStore.has(context)) continue;` so the
 *      disk overwrites the session → 11/12. "the SESSION wins over the disk"
 *      goes red. (This is the race a late hydration creates, and it is the one
 *      an in-memory-only store could not have.)
 *  P4. localRecentsStore.ts: drop the `savedAt` window → 10/12. Both the
 *      expired-blob and the future-clock cases go red.
 *  P5. localRecentsStore.ts: `decodeLocalRecents` stops running
 *      `isRestorableRow` → 11/12. "a row this build cannot name is DROPPED"
 *      goes red.
 *  P6. policySync.ts: `applyAccountChange` stops calling `recents.clear()`
 *      → 11/12. The sign-out case goes red.
 *  P7. localZeroState.ts: `mayRetainLocally` → `return true` → 15/21 across
 *      both files. BOTH new §29 cases here go red — the WRITE gate (nothing
 *      viewer-scoped reaches the device) and, more importantly, the READ gate
 *      (a field reclassified since the write serves nothing). That second one
 *      is the assertion a disk makes necessary and a session never could.
 */
