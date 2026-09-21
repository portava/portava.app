/**
 * Phase 6 (Semantic Intent) — §21 smart-action lane.
 *
 * Pure logic — no React/network — runs under the node:test runner. Asserts a
 * gateway `add_to_trip` row is lifted into a dispatchable ACTION chip (never a
 * search submit / entity row), and that an unknown / actionless row is dropped
 * so it can never become a dead chip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isDispatchableActionSuggestion,
  extractActionSuggestions,
  getAddToTripTarget,
  getOpenCompassTarget,
  DISPATCHABLE_ACTION_TYPES,
} from '../smartActions.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';
import type { SuggestionAction } from '../../types/suggestionAction.ts';

function sug(over: Partial<InputSuggestion> = {}): InputSuggestion {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    type: over.type ?? 'action',
    context: over.context ?? 'global_search',
    label: over.label ?? 'Add Bangkok to your trip',
    source: over.source ?? 'canonical',
    policyVersion: over.policyVersion ?? 'input-2026-08',
    ...over,
  };
}

function addToTrip(entityId = 'city_bkk'): SuggestionAction {
  return { type: 'add_to_trip', entityId };
}

// ── extraction: a smart action becomes a dispatchable chip ────────────────────

test('an add_to_trip row is a dispatchable action chip (not a search/entity row)', () => {
  const s = sug({
    id: 'a1',
    entityType: 'city',
    entityId: 'city_bkk',
    subtitle: 'Thailand',
    action: addToTrip('city_bkk'),
    structuredValue: { kind: 'add_to_trip', entityId: 'city_bkk', city: 'Bangkok' },
  });
  assert.equal(isDispatchableActionSuggestion(s), true);
  assert.deepEqual(extractActionSuggestions([s]).map((x) => x.id), ['a1']);
});

test('extraction preserves order and lifts only dispatchable actions', () => {
  const rows = [
    sug({ id: 'e1', type: 'entity', label: 'Bangkok', entityType: 'city', entityId: 'c1' }),
    sug({ id: 'a1', label: 'Add Bangkok to your trip', action: addToTrip('c1') }),
    sug({ id: 'q1', type: 'completion', label: 'bangkok nightlife', action: { type: 'submit_search', query: 'bangkok nightlife' } }),
    sug({ id: 'a2', label: 'Add Hue to your trip', action: addToTrip('c2') }),
  ];
  assert.deepEqual(extractActionSuggestions(rows).map((x) => x.id), ['a1', 'a2']);
});

test('non-dispatchable actions and actionless rows are NOT chips (no dead chip)', () => {
  const rows = [
    sug({ id: 'x1', type: 'entity', label: 'Bangkok', action: { type: 'open_entity', entityType: 'city', entityId: 'c1' } }),
    sug({ id: 'x2', type: 'completion', label: 'sky bars', action: { type: 'submit_search', query: 'sky bars' } }),
    sug({ id: 'x3', label: 'Drop a pin', action: { type: 'drop_pin' } }),
    sug({ id: 'x4', label: 'Share this', action: { type: 'share_entity', entityType: 'city', entityId: 'c1' } }),
    sug({ id: 'x5', type: 'entity', label: 'No action at all' }),
  ];
  for (const r of rows) assert.equal(isDispatchableActionSuggestion(r), false, r.id);
  assert.deepEqual(extractActionSuggestions(rows), []);
});

// The ratchet, not a description: this set is CLOSED and each member has to
// arrive with the screen dispatcher that handles it (see the module header).
// `open_compass` joined it together with `app/search.tsx`'s Compass handoff
// (census G305); everything else in §43's union is still refused below, which
// is what keeps an unhandled action from becoming a dead chip.
test('the dispatchable set is deliberately narrow (each member has a screen dispatcher)', () => {
  assert.deepEqual([...DISPATCHABLE_ACTION_TYPES].sort(), ['add_to_trip', 'open_compass']);
});

test('extraction tolerates a nullish list (never throws)', () => {
  assert.deepEqual(extractActionSuggestions(undefined), []);
  assert.deepEqual(extractActionSuggestions(null), []);
  assert.deepEqual(extractActionSuggestions([]), []);
});

// ── getAddToTripTarget: resolve the canonical target for dispatch ─────────────

test('resolves entityId + clean city name (structuredValue) + country (subtitle)', () => {
  const s = sug({
    action: addToTrip('city_bkk'),
    subtitle: 'Thailand',
    structuredValue: { kind: 'add_to_trip', entityId: 'city_bkk', city: 'Bangkok' },
  });
  assert.deepEqual(getAddToTripTarget(s), { entityId: 'city_bkk', city: 'Bangkok', country: 'Thailand' });
});

test('falls back to the action entityId and the row label when structuredValue is absent', () => {
  const s = sug({ label: 'Add Hue to your trip', action: addToTrip('city_hue'), structuredValue: undefined, subtitle: undefined });
  assert.deepEqual(getAddToTripTarget(s), { entityId: 'city_hue', city: 'Add Hue to your trip', country: null });
});

test('returns null for a non-add_to_trip suggestion or one lacking an entity id', () => {
  assert.equal(getAddToTripTarget(sug({ action: { type: 'submit_search', query: 'x' } })), null);
  assert.equal(getAddToTripTarget(sug({ action: { type: 'drop_pin' } })), null);
  assert.equal(getAddToTripTarget(sug({ action: undefined })), null);
  // add_to_trip with an empty entityId (and no fallback) is not dispatchable.
  assert.equal(getAddToTripTarget(sug({ action: { type: 'add_to_trip', entityId: '' }, entityId: undefined, structuredValue: undefined })), null);
});

// ── §43 open_compass: produced by the server, now dispatched (census G305) ────
//
// The row's complaint, verbatim: "Produced (`semanticIntent.ts:259`) and then
// dropped by every client surface: `search/smartActions.ts:35-43` excludes it
// from DISPATCHABLE_ACTION_TYPES because it has 'no dispatch target in the
// global search bar today', and the grouped-row bridge skips it too. A
// server-emitted action that no client can act on."
//
// The bridge half is asserted in globalSearch.test.ts (a dispatchable row is
// skipped from the groups so it lands in exactly one lane); the SCREEN half is
// asserted in app/__tests__/search.openCompassDispatch.component.test.tsx.
//
// MUTATION-PROOFS (each applied, watched go red, reverted):
//   - remove 'open_compass' from DISPATCHABLE_ACTION_TYPES → the lift test and
//     the screen dispatch test both go red.
//   - getOpenCompassTarget: return the label instead of replacementText → "the
//     prompt is the user's own words" goes red.
//   - getOpenCompassTarget: drop the empty-prompt guard → "a row with nothing
//     to ask is not dispatched" goes red.

function openCompass(context: unknown = { category: 'bars' }): SuggestionAction {
  return { type: 'open_compass', context } as SuggestionAction;
}

test('an open_compass row is lifted into the dispatchable action lane', () => {
  const s = sug({
    id: 'c1',
    type: 'ai_suggestion',
    label: 'rooftop bars · near your hotel · tonight',
    replacementText: 'rooftop bars near my hotel tonight',
    action: openCompass(),
  });
  assert.equal(isDispatchableActionSuggestion(s), true);
  assert.deepEqual(extractActionSuggestions([s]).map((x) => x.id), ['c1']);
});

test("the Compass prompt is the user's OWN words, not the structured restatement", () => {
  const s = sug({
    type: 'ai_suggestion',
    label: 'rooftop bars · near your hotel · tonight',
    replacementText: 'rooftop bars near my hotel tonight',
    action: openCompass({ category: 'bars' }),
  });
  const target = getOpenCompassTarget(s);
  assert.equal(target?.prompt, 'rooftop bars near my hotel tonight');
  assert.deepEqual(target?.structuredContext, { category: 'bars' });
});

test('a row with nothing to ask is not dispatched (no empty Compass chat)', () => {
  const s = sug({ type: 'ai_suggestion', label: '   ', replacementText: '  ', action: openCompass() });
  assert.equal(getOpenCompassTarget(s), null);
});

test('getOpenCompassTarget refuses every OTHER action type', () => {
  assert.equal(getOpenCompassTarget(sug({ action: addToTrip() })), null);
  assert.equal(getOpenCompassTarget(sug({ action: { type: 'drop_pin' } })), null);
  assert.equal(getOpenCompassTarget(sug({})), null);
});

test('share_entity and drop_pin are STILL not dispatchable (no dead chips)', () => {
  assert.equal(DISPATCHABLE_ACTION_TYPES.has('share_entity' as any), false);
  assert.equal(DISPATCHABLE_ACTION_TYPES.has('drop_pin' as any), false);
});
