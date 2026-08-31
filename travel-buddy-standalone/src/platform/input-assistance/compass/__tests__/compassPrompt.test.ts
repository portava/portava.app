/**
 * Phase 7 (Compass + AI) — deterministic compass-prompt starters (§56, §14).
 *
 * Pure logic — runs under node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPASS_STARTERS,
  buildCompassStarters,
  isCompassPromptContext,
} from '../compassPrompt.ts';

test('compass_prompt returns deterministic starters (non-empty, well-formed prompts)', () => {
  const starters = buildCompassStarters();
  assert.ok(starters.length > 0, 'there should be starters');
  // Every starter carries a full, non-empty prompt (§56 "suggested prompts").
  for (const s of starters) {
    assert.ok(s.id && s.label && s.prompt, 'starter fields present');
    assert.ok(s.prompt.trim().length > 0);
  }
  // The base curated set is present when no scoped options are given.
  assert.deepEqual(
    starters.map((s) => s.id),
    COMPASS_STARTERS.map((s) => s.id),
  );
});

test('starters are DETERMINISTIC and flag-independent (same options ⇒ identical output)', () => {
  // The builder takes NO ai-flag and no randomness — its output is a pure
  // function of its options, so it is the same whether or not AI writing is on.
  const a = buildCompassStarters({ surface: 'compass', cityName: 'Da Nang' });
  const b = buildCompassStarters({ surface: 'compass', cityName: 'Da Nang' });
  assert.deepEqual(a, b);

  const c = buildCompassStarters();
  const d = buildCompassStarters();
  assert.deepEqual(c, d);
});

test('a cityName prepends a city-scoped starter without dropping the base set', () => {
  const starters = buildCompassStarters({ cityName: 'Bangkok', limit: 20 });
  const inCity = starters.find((s) => s.id === 'in_city');
  assert.ok(inCity, 'a city-scoped starter is added');
  assert.match(inCity!.prompt, /Bangkok/);
  // The curated intents still appear after it.
  assert.ok(starters.some((s) => s.id === 'right_now'));
  assert.ok(starters.some((s) => s.id === 'tonight'));
});

test('a trip signal adds a trip-scoped starter and supersedes the generic my_trip', () => {
  const starters = buildCompassStarters({ hasTrip: true, limit: 20 });
  assert.ok(starters.some((s) => s.id === 'trip_next'), 'trip-scoped starter added');
  assert.equal(starters.some((s) => s.id === 'my_trip'), false, 'generic my_trip superseded');

  const byTripId = buildCompassStarters({ tripId: 't_123', limit: 20 });
  assert.ok(byTripId.some((s) => s.id === 'trip_next'));
});

test('limit caps the number of starters', () => {
  const starters = buildCompassStarters({ cityName: 'Tokyo', hasTrip: true, limit: 3 });
  assert.equal(starters.length, 3);
  // The scoped starters take priority (added first).
  assert.equal(starters[0].id, 'in_city');
  assert.equal(starters[1].id, 'trip_next');
});

test('isCompassPromptContext', () => {
  assert.equal(isCompassPromptContext('compass_prompt'), true);
  assert.equal(isCompassPromptContext('caption'), false);
});
