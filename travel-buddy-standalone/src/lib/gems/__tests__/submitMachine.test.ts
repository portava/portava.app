/**
 * Tests for the gem submission wizard's pure logic:
 * step gating (canNext) and submit payload building (buildSubmitPayload).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canNext,
  buildSubmitPayload,
  WIZARD_STEP_COUNT,
  type WizardFormState,
} from '../submitMachine.ts';

function makeForm(overrides: Partial<WizardFormState> = {}): WizardFormState {
  return {
    name: '',
    category: '',
    city: '',
    country: '',
    neighborhood: '',
    description: '',
    gpsLat: undefined,
    gpsLng: undefined,
    gpsLabel: undefined,
    vibeTags: '',
    priceRange: '',
    safetyNotes: '',
    bestTimeToGo: '',
    layoverSafe: false,
    minimumLayoverMinutes: '',
    sensitivityLevel: 'public',
    imageUrl: undefined,
    ...overrides,
  };
}

test('WIZARD_STEP_COUNT is 5', () => {
  assert.equal(WIZARD_STEP_COUNT, 5);
});

// ── canNext ──────────────────────────────────────────────────────────────────

test('step 0 requires a non-blank city', () => {
  assert.equal(canNext(0, makeForm()), false);
  assert.equal(canNext(0, makeForm({ city: '   ' })), false);
  assert.equal(canNext(0, makeForm({ city: 'Lisbon' })), true);
});

test('step 0: GPS alone is not enough without a city', () => {
  assert.equal(canNext(0, makeForm({ gpsLat: 38.7, gpsLng: -9.1 })), false);
});

test('step 1 requires both name and category', () => {
  assert.equal(canNext(1, makeForm()), false);
  assert.equal(canNext(1, makeForm({ name: 'Tiny Bar' })), false);
  assert.equal(canNext(1, makeForm({ category: 'food' as any })), false);
  assert.equal(canNext(1, makeForm({ name: '   ' , category: 'food' as any })), false);
  assert.equal(canNext(1, makeForm({ name: 'Tiny Bar', category: 'food' as any })), true);
});

test('steps 2, 3 and 4 are always passable', () => {
  assert.equal(canNext(2, makeForm()), true);
  assert.equal(canNext(3, makeForm()), true);
  assert.equal(canNext(4, makeForm()), true);
});

// ── buildSubmitPayload ───────────────────────────────────────────────────────

function validForm(overrides: Partial<WizardFormState> = {}): WizardFormState {
  return makeForm({
    name: '  Tiny Bar  ',
    category: 'food' as any,
    city: ' Lisbon ',
    ...overrides,
  });
}

test('returns null when any required field is missing', () => {
  assert.equal(buildSubmitPayload(makeForm()), null);
  assert.equal(buildSubmitPayload(validForm({ name: '   ' })), null);
  assert.equal(buildSubmitPayload(validForm({ category: '' })), null);
  assert.equal(buildSubmitPayload(validForm({ city: '  ' })), null);
});

test('builds a payload with trimmed required fields', () => {
  const payload = buildSubmitPayload(validForm());
  assert.ok(payload);
  assert.equal(payload.name, 'Tiny Bar');
  assert.equal(payload.category, 'food');
  assert.equal(payload.city, 'Lisbon');
});

test('blank optional strings become undefined; non-blank are trimmed', () => {
  const empty = buildSubmitPayload(validForm());
  assert.ok(empty);
  assert.equal(empty.country, undefined);
  assert.equal(empty.neighborhood, undefined);
  assert.equal(empty.description, undefined);
  assert.equal(empty.priceRange, undefined);
  assert.equal(empty.safetyNotes, undefined);
  assert.equal(empty.bestTimeToGo, undefined);

  const filled = buildSubmitPayload(
    validForm({
      country: ' Portugal ',
      neighborhood: ' Alfama ',
      description: ' Great views ',
      priceRange: '$$',
      safetyNotes: ' Fine at night ',
      bestTimeToGo: ' Sunset ',
    }),
  );
  assert.ok(filled);
  assert.equal(filled.country, 'Portugal');
  assert.equal(filled.neighborhood, 'Alfama');
  assert.equal(filled.description, 'Great views');
  assert.equal(filled.priceRange, '$$');
  assert.equal(filled.safetyNotes, 'Fine at night');
  assert.equal(filled.bestTimeToGo, 'Sunset');
});

test('GPS coordinates pass through as latitude/longitude', () => {
  const payload = buildSubmitPayload(validForm({ gpsLat: 38.71, gpsLng: -9.14 }));
  assert.ok(payload);
  assert.equal(payload.latitude, 38.71);
  assert.equal(payload.longitude, -9.14);

  const none = buildSubmitPayload(validForm());
  assert.ok(none);
  assert.equal(none.latitude, undefined);
  assert.equal(none.longitude, undefined);
});

test('vibe tags split on commas, trim, and drop empties', () => {
  const payload = buildSubmitPayload(
    validForm({ vibeTags: ' cozy , , romantic,hidden ,, ' }),
  );
  assert.ok(payload);
  assert.deepEqual(payload.vibeTags, ['cozy', 'romantic', 'hidden']);
});

test('empty or whitespace-only vibe tags become undefined', () => {
  const empty = buildSubmitPayload(validForm({ vibeTags: '' }));
  assert.ok(empty);
  assert.equal(empty.vibeTags, undefined);

  const blank = buildSubmitPayload(validForm({ vibeTags: ' , ,, ' }));
  assert.ok(blank);
  assert.equal(blank.vibeTags, undefined);
});

test('minimumLayoverMinutes parses to an integer, empty stays undefined', () => {
  const parsed = buildSubmitPayload(validForm({ minimumLayoverMinutes: '90' }));
  assert.ok(parsed);
  assert.equal(parsed.minimumLayoverMinutes, 90);

  const truncated = buildSubmitPayload(validForm({ minimumLayoverMinutes: '45.9' }));
  assert.ok(truncated);
  assert.equal(truncated.minimumLayoverMinutes, 45);

  const empty = buildSubmitPayload(validForm({ minimumLayoverMinutes: '' }));
  assert.ok(empty);
  assert.equal(empty.minimumLayoverMinutes, undefined);
});

test('layoverSafe and sensitivityLevel pass through', () => {
  const payload = buildSubmitPayload(
    validForm({ layoverSafe: true, sensitivityLevel: 'protected' }),
  );
  assert.ok(payload);
  assert.equal(payload.layoverSafe, true);
  assert.equal(payload.sensitivityLevel, 'protected');
});
