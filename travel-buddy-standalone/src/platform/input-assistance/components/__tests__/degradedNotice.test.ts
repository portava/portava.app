/**
 * §32/§27/§38 — the DEGRADED sentence, as a pure decision (census G13, G350).
 *
 * These assertions are about the three-way split §27 asks for and the surface
 * did not have: loading, no-match and degraded were one shape, and a
 * `server_required` field offline got the §37 no-match copy for a search that
 * was never performed.
 *
 * WHAT IS DELIBERATELY ASSERTED ON THE COPY ITSELF. Several of these read the
 * strings, which is normally a brittle test. They are here because the
 * REQUIREMENT is about what the sentence says: G13 forbids presenting local
 * data as live, so the `rows` sentence has to carry the disclaimer, and the
 * `unassisted` sentence must not claim a retry the layer does not perform
 * (§30.7 — there is no retry schedule). A test that only checked `kind` would
 * stay green while the copy said "reconnecting…".
 *
 * Runs under node:test — the decision is a pure module precisely so it needs
 * no renderer. The RENDERED surface is asserted in
 * `degradedSurface.component.test.tsx`.
 *
 * MUTATION LOG: see the bottom of this file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { degradedNotice } from '../degradedNotice.ts';

test('not degraded → no notice, so loading and no-match keep the surface', () => {
  assert.equal(degradedNotice({ unavailable: false, offlineSurface: false, rowCount: 0 }), null);
  assert.equal(degradedNotice({ unavailable: false, offlineSurface: true, rowCount: 0 }), null);
  assert.equal(degradedNotice({ unavailable: false, offlineSurface: true, rowCount: 3 }), null);
});

test('§32: a field with NO offline surface is told the field is online-only, not that nothing matched', () => {
  const n = degradedNotice({ unavailable: true, offlineSurface: false, rowCount: 0 });
  assert.equal(n?.kind, 'unassisted');
  // The whole defect: this state used to be indistinguishable from "we asked
  // and nothing matched".
  assert.ok(n!.detail.includes('only assisted online'), n!.detail);
  assert.ok(!/match/i.test(n!.detail), n!.detail);
});

test('§30.7: the online-only sentence promises no retry — there is no retry schedule to promise', () => {
  const n = degradedNotice({ unavailable: true, offlineSurface: false, rowCount: 0 });
  assert.ok(!/try again|retry|reconnect|refresh/i.test(`${n!.title} ${n!.detail}`), n!.detail);
});

test('§32: a LICENSED field with nothing on the device says so, and it is a different sentence', () => {
  const unassisted = degradedNotice({ unavailable: true, offlineSurface: false, rowCount: 0 });
  const empty = degradedNotice({ unavailable: true, offlineSurface: true, rowCount: 0 });
  assert.equal(empty?.kind, 'empty');
  assert.notEqual(empty!.detail, unassisted!.detail);
  assert.notEqual(empty!.a11y, unassisted!.a11y);
});

test('G13: with rows on screen the sentence says they are device-local and NOT current', () => {
  const n = degradedNotice({ unavailable: true, offlineSurface: true, rowCount: 2 });
  assert.equal(n?.kind, 'rows');
  assert.ok(n!.detail.includes('saved on this device'), n!.detail);
  assert.ok(/checked just now/i.test(n!.detail), n!.detail);
});

test('the notice never contradicts the screen: rows present outrank a false licence claim', () => {
  // A caller that failed to declare the licence must not produce copy saying
  // "nothing is suggested" over a list of suggestions.
  const n = degradedNotice({ unavailable: true, offlineSurface: false, rowCount: 2 });
  assert.equal(n?.kind, 'rows');
});

test('§46: all three degraded announcements differ from each other', () => {
  const a = degradedNotice({ unavailable: true, offlineSurface: false, rowCount: 0 })?.a11y;
  const b = degradedNotice({ unavailable: true, offlineSurface: true, rowCount: 0 })?.a11y;
  const c = degradedNotice({ unavailable: true, offlineSurface: true, rowCount: 1 })?.a11y;
  assert.equal(new Set([a, b, c]).size, 3);
});

/*
 * MUTATION LOG — applied to degradedNotice.ts, run, watched, reverted,
 * `cmp`-verified. Baseline: 7/7.
 *
 * FAILING-FIRST, FIRST. Before the module existed these cases were run against
 * a stub that returned ONE notice for every input — which is what the surface
 * actually did: `{unavailable ? 'Suggestions are unavailable right now.' :
 * 'No matches yet.'}`. 6 of 7 failed. The seventh (§30.7, no retry promised)
 * passed against the stub, because the stub's copy happened to contain no
 * retry word; it is kept because the property it pins is about the copy that
 * shipped, not about the stub.
 *
 *   - `if (!params.unavailable) return null` deleted → 6/7. "Not degraded → no
 *     notice" goes RED.
 *   - the `rowCount > 0` branch moved BELOW the `offlineSurface` branch → 5/7.
 *     "The notice never contradicts the screen" goes RED, and so does the
 *     `rows` case.
 *   - `UNASSISTED.detail` replaced with 'No matches yet.' → 6/7. "A field with
 *     NO offline surface is told the field is online-only" goes RED.
 *   - `ROWS.detail` loses its second sentence ('Nothing here has been checked
 *     just now.') → 6/7. The G13 case goes RED.
 *   - `EMPTY` replaced by `UNASSISTED` (one sentence for two states) → 5/7.
 *     "A LICENSED field with nothing on the device says so" and "all three
 *     degraded announcements differ" both go RED.
 *
 * ONE MUTATION THAT DID **NOT** LAND, recorded rather than hidden: adding
 * 'Refresh when you are back online.' to `EMPTY.detail` leaves 7/7 green,
 * because the no-retry case reads the `unassisted` notice only. The inputs were
 * re-checked before concluding anything, and the narrowness is deliberate
 * rather than an omission: the online-only branch is the one a reader is most
 * tempted to soften with "we'll try again", because it is the only branch where
 * the user can do nothing about it. Widening the assertion to all three would
 * make it a copy ratchet over sentences the requirement does not constrain —
 * a licensed field CAN usefully be told to come back, and §30.7 forbids only
 * the claim that this layer will retry by itself.
 */
