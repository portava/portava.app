/**
 * §34 "prefer local: immediate zero-state" — the pure half (census G216).
 *
 * These prove the RULES: what may be retained, what may be replayed, and what
 * an empty field is offered when nothing was accepted. That the HOOK consults
 * them is a separate, wiring assertion and lives in
 * hooks/__tests__/useInputAssistance.zeroState.component.test.tsx — "the logic
 * is right and nothing reaches it" is the failure mode this pair exists to
 * close, and one test cannot see both halves.
 *
 * MUTATION LOG (each applied, watched go red, reverted, `cmp` byte-identical):
 *   - localZeroState.ts: `mayRetainLocally` → `return true` → "a personal field
 *     retains nothing" and "…reads nothing back" both go red.
 *   - localZeroState.ts: drop the `REPLAYABLE_TYPES` guard in
 *     `recordLocalSelection` → "a row that is not an ANSWER…" goes red on the
 *     RETENTION assertion. (Asserting only the replay left this mutation alive:
 *     the read-side guard caught the row a second time. Recorded because that
 *     is the weak-test failure mode this census exists to catch.)
 *   - localZeroState.ts: drop the `type: 'recent'` re-label → "a replayed row is
 *     a recent row" goes red.
 *   - localZeroState.ts: `Math.max(0, p.maxSuggestions)` → ignore the cap → "the
 *     field's cap is honoured" goes red.
 *   - localZeroState.ts: drop the dedupe `filter` in `recordLocalSelection` →
 *     "re-accepting a row moves it to the front rather than duplicating it"
 *     goes red.
 *   - (retired 2026-10-07, census G261) the `recordSelection(...)` forward
 *     into `suggestionHistory`'s own Map no longer exists: that module is a
 *     read view over this store now, proven in suggestionHistory.test.ts.
 *     The `REPLAYABLE_TYPES` record-guard mutation above is now observed on
 *     the DEVICE write (the second buffer bypassed the read filter; the device
 *     blob is the one store now).
 *   - (verifier V2) localZeroState.ts replay without `stripPositionalClaims`,
 *     localRecentsStore.ts encode keeping `distanceBand`, decode without the
 *     strip → "a distance band … is never replayed" red (each alone).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  localZeroState,
  recordLocalSelection,
  mayRetainLocally,
  clearLocalZeroState,
  attachLocalRecents,
  detachLocalRecents,
  flushLocalRecents,
  type LocalZeroStatePolicy,
} from '../localZeroState.ts';
import { getRecentSelections, clearRecentSelections } from '../suggestionHistory.ts';
import type { LocalRecentsStorage } from '../localRecentsStore.ts';
import { encodeLocalRecents, decodeLocalRecents } from '../localRecentsStore.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

const PUBLIC_POLICY: LocalZeroStatePolicy = {
  context: 'trip_destination',
  privacyClass: 'public',
  maxSuggestions: 3,
};
// `viewer_scoped` is the real `PrivacyClass` member for "this list is the
// viewer's". This fixture said `'personal'`, which is not a member of that
// union at all — and the gate it exercises answered CACHEABLE for it, which is
// how the denylist-vs-allowlist defect in `suggestionCache.ts` was found. The
// name is kept for the test titles; the value is now one the code recognises.
const PERSONAL_POLICY: LocalZeroStatePolicy = {
  context: 'telegraph_recipient',
  privacyClass: 'viewer_scoped',
  maxSuggestions: 3,
};

function city(label: string, id: string): InputSuggestion {
  return {
    id: `s:${id}`,
    type: 'entity',
    context: 'trip_destination',
    label,
    entityType: 'city',
    entityId: id,
    source: 'canonical',
    policyVersion: 'input-2026-08',
  };
}

beforeEach(() => {
  detachLocalRecents();
  clearLocalZeroState();
  clearRecentSelections();
});

test('an accepted row is offered back to the EMPTY field, with no network', () => {
  assert.deepEqual(localZeroState(PUBLIC_POLICY), [], 'nothing accepted yet ⇒ nothing local');
  recordLocalSelection(PUBLIC_POLICY, city('Bangkok', 'c1'));
  const rows = localZeroState(PUBLIC_POLICY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.label, 'Bangkok');
});

test('a replayed row is a RECENT row, and keeps the action the server gave it', () => {
  const accepted: InputSuggestion = {
    ...city('Da Nang', 'c2'),
    action: { type: 'open_entity', entityType: 'city', entityId: 'c2' },
  };
  recordLocalSelection(PUBLIC_POLICY, accepted);
  const [replayed] = localZeroState(PUBLIC_POLICY);
  assert.equal(replayed?.type, 'recent', 'served out of selection memory ⇒ a recent row');
  assert.deepEqual(
    replayed?.action,
    { type: 'open_entity', entityType: 'city', entityId: 'c2' },
    'the action is the server’s own, never one the client invented',
  );
  assert.equal(replayed?.entityId, 'c2');
});

test('most recent first, and re-accepting a row moves it to the front rather than duplicating it', () => {
  recordLocalSelection(PUBLIC_POLICY, city('Bangkok', 'c1'));
  recordLocalSelection(PUBLIC_POLICY, city('Da Nang', 'c2'));
  recordLocalSelection(PUBLIC_POLICY, city('Bangkok', 'c1'));
  assert.deepEqual(
    localZeroState(PUBLIC_POLICY).map((s) => s.label),
    ['Bangkok', 'Da Nang'],
  );
});

test('the field’s cap is honoured', () => {
  const capped: LocalZeroStatePolicy = { ...PUBLIC_POLICY, maxSuggestions: 2 };
  recordLocalSelection(capped, city('A', 'c1'));
  recordLocalSelection(capped, city('B', 'c2'));
  recordLocalSelection(capped, city('C', 'c3'));
  assert.deepEqual(localZeroState(capped).map((s) => s.label), ['C', 'B']);
  assert.deepEqual(localZeroState({ ...capped, maxSuggestions: 0 }), []);
});

test('the §35 history reads the SAME store the explicit accept wrote — one store, not two (G261)', () => {
  // `suggestionHistory` used to keep a second in-memory Map fed by this tier.
  // It is a read view over this store now (census G261), so what it reports is
  // exactly what this tier retained, and nothing else.
  recordLocalSelection(PUBLIC_POLICY, city('Bangkok', 'c1'));
  assert.deepEqual(
    getRecentSelections(PUBLIC_POLICY).map((r) => [r.value, r.label]),
    [['c1', 'Bangkok']],
  );
  // And it is gated by the SAME predicate: a personal field is never retained
  // and never read.
  recordLocalSelection(PERSONAL_POLICY, {
    ...city('Alice', 'u1'),
    context: 'telegraph_recipient',
    entityType: 'user',
  });
  assert.deepEqual(getRecentSelections(PERSONAL_POLICY), []);
});

test('§29: a PERSONAL field retains nothing and reads nothing back', () => {
  assert.equal(mayRetainLocally(PERSONAL_POLICY), false);
  recordLocalSelection(PERSONAL_POLICY, {
    ...city('Alice', 'u1'),
    context: 'telegraph_recipient',
    entityType: 'user',
  });
  assert.deepEqual(
    localZeroState(PERSONAL_POLICY),
    [],
    'a viewer-scoped list must never be re-published from device memory',
  );
  // And the read side refuses independently of the write side: even if a row
  // had been retained, this policy may not read one back.
  recordLocalSelection(PUBLIC_POLICY, city('Bangkok', 'c1'));
  assert.deepEqual(localZeroState(PERSONAL_POLICY), [], 'contexts do not share memory either');
});

test('fail-closed: an unresolvable policy retains nothing and offers nothing', () => {
  assert.equal(mayRetainLocally(null), false);
  assert.equal(mayRetainLocally({ ...PUBLIC_POLICY, privacyClass: null }), false);
  recordLocalSelection(null, city('Bangkok', 'c1'));
  assert.deepEqual(localZeroState(null), []);
  assert.deepEqual(localZeroState({ ...PUBLIC_POLICY, privacyClass: null }), []);
});

test('fail-closed: a privacy class this BUILD does not recognise is refused', () => {
  // §48's whole premise is that client and server versions skew. A server that
  // classifies a field with a class newer than this build would hand us a
  // string that is not in the union. The gate must refuse it, not admit it:
  // a denylist answers "cacheable" for everything it has not heard of, which
  // is the leaking direction and is exactly what this used to do.
  //
  // The cast is the POINT of the test — it reproduces what crosses the wire,
  // which the compile-time type cannot police. Removing it would delete the
  // only assertion that covers the skew case.
  const unknown = { ...PUBLIC_POLICY, privacyClass: 'crew_scoped' as LocalZeroStatePolicy['privacyClass'] };

  assert.equal(mayRetainLocally(unknown), false, 'an unrecognised class must not be retainable');
  recordLocalSelection(unknown, city('Bangkok', 'c1'));
  assert.deepEqual(localZeroState(unknown), [], 'and must read nothing back');

  // MUTATION-PROOF, and it is the mutation that matters: restore the denylist
  // (`return !UNCACHEABLE_PRIVACY_CLASSES.has(privacyClass)`) in
  // services/suggestionCache.ts and both assertions above go RED, because an
  // unknown class is absent from any deny set and therefore "cacheable".
  //
  // The control: explicitly public data is STILL cached. An allowlist that
  // refused everything would pass the two assertions above and would have
  // silently disabled the cache for the one class it exists to serve.
  assert.equal(mayRetainLocally(PUBLIC_POLICY), true, 'public data is still cacheable');
});

test('a row that is not an ANSWER is never replayed into an empty field', async () => {
  // A completion carries the text of a search that was submitted once; a
  // correction judged a string; an action was resolved from a parse. None of
  // them is an answer to an empty field.
  const writes: string[] = [];
  const storage: LocalRecentsStorage = {
    async getItem() { return null; },
    async setItem(_k: string, v: string) { writes.push(v); },
    async removeItem() {},
  };
  await attachLocalRecents(storage);
  for (const type of ['completion', 'correction', 'validation', 'action', 'ai_suggestion'] as const) {
    clearLocalZeroState();
    recordLocalSelection(PUBLIC_POLICY, {
      ...city('search for bangkok', 'q1'),
      type,
      action: { type: 'submit_search', query: 'bangkok' },
    });
    assert.deepEqual(localZeroState(PUBLIC_POLICY), [], `${type} must not be replayed`);
    // And it must not be RETAINED either. Asserting only the read above left
    // the record-side guard unproven — deleting it kept every assertion green,
    // because the read guard caught the row a second time. A row that is never
    // stored cannot leak from a later bug, so the storage is what is asserted:
    // nothing is written to the device for it (census G261: the device blob is
    // the one store; the second in-memory buffer this used to observe is gone).
    await flushLocalRecents();
    assert.deepEqual(writes, [], `${type} must not be retained at all`);
  }
});

test('G176 (verifier V2): a distance band — like a live label — is never replayed, from memory or from the device', async () => {
  // The band was measured from where the person stood when the row was served.
  // Replayed next week in another city it would claim a distance nobody measured.
  const served: InputSuggestion = {
    ...city('Lantern Cafe', 'p1'),
    entityType: 'place',
    distanceBand: '<0.5km',
    freshness: { state: 'fresh', updatedAtLabel: 'Updated 2m ago', label: 'Getting busier' },
  };
  recordLocalSelection(PUBLIC_POLICY, served);
  const [replayed] = localZeroState(PUBLIC_POLICY);
  assert.ok(replayed, 'premise: the accept is replayed');
  assert.equal(replayed.distanceBand, undefined, 'no band from memory');
  assert.equal(replayed.freshness, undefined, 'no live label from memory');
  assert.equal(replayed.label, 'Lantern Cafe');

  // The device blob never carries it …
  const blob = encodeLocalRecents(new Map([['trip_destination', [served]]]), Date.now(), 'user-a');
  assert.ok(!blob.includes('distanceBand'), 'the encoder drops the band');
  // … and a blob from a build that did write one is restored without it.
  const legacyBlob = JSON.stringify({
    v: 1, savedAt: Date.now(), owner: 'user-a',
    contexts: { trip_destination: [{ ...city('Lantern Cafe', 'p1'), distanceBand: '<0.5km' }] },
  });
  const restored = decodeLocalRecents(legacyBlob, Date.now()).get('trip_destination') ?? [];
  assert.equal(restored.length, 1, 'the row itself is kept');
  assert.equal(restored[0]!.distanceBand, undefined, 'the decoder drops the band');
});
