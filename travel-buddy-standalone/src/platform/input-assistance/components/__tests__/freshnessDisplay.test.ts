/**
 * Phase 9 (Live Intelligence) — client freshness rendering (spec §31/§8/§28).
 *
 * The SDK entity row is a PURE RENDERER of the server-attached `freshness`
 * (`InputSuggestion.freshness`, populated only by the gated P9
 * LiveSuggestionService). These pure-logic tests pin the two invariants:
 *   (a) a suggestion WITH freshness renders the SERVER's label + age, verbatim;
 *   (b) NO freshness (the common case) and `unavailable`/`stale` never produce a
 *       fabricated live label — the client synthesizes nothing.
 *
 * Runs under node:test (no react-native import — the pure helper is separate
 * from EntitySuggestionRow.tsx precisely so it is testable here).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshnessDisplay } from '../freshnessDisplay.ts';
import type { FreshnessState } from '../../types/inputContext.ts';

test('a fresh claim renders the server label · age (§31 "Getting busier · Updated 4m ago")', () => {
  const f: FreshnessState = { state: 'fresh', label: 'Getting busier', updatedAtLabel: 'Updated 4m ago' };
  const out = freshnessDisplay(f);
  assert.equal(out.label, 'Getting busier');
  assert.equal(out.age, 'Updated 4m ago');
  assert.equal(out.text, 'Getting busier · Updated 4m ago');
});

test('recently_confirmed renders the server label · age verbatim', () => {
  const f: FreshnessState = { state: 'recently_confirmed', label: 'Recently confirmed', updatedAtLabel: 'Updated 2h ago' };
  assert.equal(freshnessDisplay(f).text, 'Recently confirmed · Updated 2h ago');
});

test('ABSENT freshness renders NO badge — the common, pre-launch case', () => {
  // The gateway attaches nothing when live is off/stale/unavailable/unpromoted.
  assert.equal(freshnessDisplay(undefined).text, null);
  assert.equal(freshnessDisplay(null).text, null);
  assert.equal(freshnessDisplay(undefined).label, null);
});

test('NO fabrication: a state with no server label/age produces NO label (mutation-proof)', () => {
  // If the renderer ever synthesized a default label from `state`, THIS goes RED.
  const bare: FreshnessState = { state: 'fresh' }; // no label, no age
  const out = freshnessDisplay(bare);
  assert.equal(out.label, null, 'must not invent a label the server did not send');
  assert.equal(out.age, null);
  assert.equal(out.text, null, 'no server strings ⇒ no chip (never a manufactured "busy now"/"Live")');
});

test('§31 unavailable ⇒ the live label is REMOVED entirely (never shown as live)', () => {
  const f: FreshnessState = { state: 'unavailable', label: 'Busy now', updatedAtLabel: 'Updated 1m ago' };
  const out = freshnessDisplay(f);
  assert.equal(out.text, null, 'unavailable never presents any label, even if one is carried');
  assert.equal(out.label, null);
});

test('§31 stale ⇒ drop the state label, show ONLY the last-updated age', () => {
  const f: FreshnessState = { state: 'stale', label: 'Getting busier', updatedAtLabel: 'Updated 3h ago' };
  const out = freshnessDisplay(f);
  assert.equal(out.label, null, 'a stale claim never presents its "busy now"-style label');
  assert.equal(out.age, 'Updated 3h ago');
  assert.equal(out.text, 'Updated 3h ago');
});

test('§31 stale with no age ⇒ nothing to show (degrade, never throw)', () => {
  assert.equal(freshnessDisplay({ state: 'stale' }).text, null);
});

test('label-only (age omitted) renders just the label; age-only renders just the age', () => {
  assert.equal(freshnessDisplay({ state: 'fresh', label: 'At its busiest' }).text, 'At its busiest');
  assert.equal(freshnessDisplay({ state: 'fresh', updatedAtLabel: 'Updated just now' }).text, 'Updated just now');
});

test('empty/blank server strings are treated as absent (no empty chip)', () => {
  assert.equal(freshnessDisplay({ state: 'fresh', label: '', updatedAtLabel: '   ' }).text, null);
});
