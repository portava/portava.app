/**
 * Unit tests for the gem submission wizard logic.
 *
 * Covers:
 *  canNext() — step gating:
 *  • Step 0 (Location): city required; GPS state does NOT affect the gate
 *  • Step 1 (Details): name AND category both required
 *  • Step 2 (Privacy): always passes (has a sensible default)
 *  • Step 3 (Review): always passes (final guard is in buildSubmitPayload)
 *
 *  buildSubmitPayload() — submit payload shape:
 *  • Returns null when required fields are missing (guard for the Alert path)
 *  • latitude / longitude are numbers (not strings) when GPS was captured
 *  • latitude / longitude are undefined (not null) when GPS was skipped
 *  • minimumLayoverMinutes is parsed to an integer, not left as a string
 *  • vibeTags are split, trimmed, and filtered into a string array
 *  • Optional string fields become undefined (not empty string) when blank
 *
 * Run with:  pnpm test   (discovered by scripts/run-node-tests.mjs)
 *
 * submitMachine.ts (the module actually used by app/gems/submit.tsx) has zero
 * React-Native / Expo imports so it is imported directly without any mocking.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  canNext,
  buildSubmitPayload,
  type WizardFormState,
} from '../../lib/gems/submitMachine.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

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
    ...overrides,
  };
}

// ── canNext() tests ─────────────────────────────────────────────────────────────

describe('canNext() — step 0 (Location)', () => {
  it('returns false when city is empty, even with GPS captured', () => {
    const form = makeForm({ city: '', gpsLat: 35.6762, gpsLng: 139.6503, gpsLabel: 'Tokyo, Japan' });
    assert.equal(canNext(0, form), false);
  });

  it('returns false when city is whitespace only, even with GPS captured', () => {
    const form = makeForm({ city: '   ', gpsLat: 35.6762, gpsLng: 139.6503 });
    assert.equal(canNext(0, form), false);
  });

  it('returns true when city has content and GPS is also present', () => {
    const form = makeForm({ city: 'Tokyo', gpsLat: 35.6762, gpsLng: 139.6503 });
    assert.equal(canNext(0, form), true);
  });

  it('returns true when city has content and GPS is absent (GPS is optional)', () => {
    const form = makeForm({ city: 'Paris' });
    assert.equal(canNext(0, form), true);
  });

  it('returns false when city is empty and GPS is absent', () => {
    const form = makeForm();
    assert.equal(canNext(0, form), false);
  });

  it('ignores GPS state entirely — city is the only gate at step 0', () => {
    const withGps    = makeForm({ city: '',      gpsLat: 1.0, gpsLng: 1.0 });
    const withoutGps = makeForm({ city: '',      gpsLat: undefined, gpsLng: undefined });
    const cityOnly   = makeForm({ city: 'Seoul', gpsLat: undefined });
    const both       = makeForm({ city: 'Seoul', gpsLat: 37.5665, gpsLng: 126.9780 });

    assert.equal(canNext(0, withGps), false);
    assert.equal(canNext(0, withoutGps), false);
    assert.equal(canNext(0, cityOnly), true);
    assert.equal(canNext(0, both), true);
  });
});

describe('canNext() — step 1 (Details)', () => {
  it('returns false when both name and category are empty', () => {
    assert.equal(canNext(1, makeForm()), false);
  });

  it('returns false when name is present but category is empty', () => {
    assert.equal(canNext(1, makeForm({ name: 'My Gem', category: '' })), false);
  });

  it('returns false when category is present but name is empty', () => {
    assert.equal(canNext(1, makeForm({ name: '', category: 'food' })), false);
  });

  it('returns false when name is whitespace only', () => {
    assert.equal(canNext(1, makeForm({ name: '   ', category: 'food' })), false);
  });

  it('returns true when both name and category are provided', () => {
    assert.equal(canNext(1, makeForm({ name: 'Hidden ramen spot', category: 'food' })), true);
  });

  it('accepts every valid category value at step 1', () => {
    const categories = [
      'food', 'drink', 'nature', 'culture', 'adventure',
      'nightlife', 'wellness', 'local_secret', 'market', 'viewpoint',
      'transport', 'other',
    ] as const;
    for (const category of categories) {
      assert.equal(canNext(1, makeForm({ name: 'Gem', category })), true);
    }
  });
});

describe('canNext() — step 2 (Privacy)', () => {
  it('returns true regardless of form state (privacy has a default)', () => {
    assert.equal(canNext(2, makeForm()), true);
    assert.equal(canNext(2, makeForm({ sensitivityLevel: 'protected' })), true);
  });
});

describe('canNext() — step 3 (Review)', () => {
  it('returns true regardless of form state (final guard is in buildSubmitPayload)', () => {
    assert.equal(canNext(3, makeForm()), true);
    assert.equal(canNext(3, makeForm({ name: 'Gem', category: 'food', city: 'Tokyo' })), true);
  });
});

// ── buildSubmitPayload() tests ─────────────────────────────────────────────────

describe('buildSubmitPayload() — required-field guard', () => {
  it('returns null when all required fields are missing', () => {
    assert.equal(buildSubmitPayload(makeForm()), null);
  });

  it('returns null when only name is missing', () => {
    assert.equal(buildSubmitPayload(makeForm({ category: 'food', city: 'Tokyo' })), null);
  });

  it('returns null when only category is missing', () => {
    assert.equal(buildSubmitPayload(makeForm({ name: 'Gem', city: 'Tokyo' })), null);
  });

  it('returns null when only city is missing', () => {
    assert.equal(buildSubmitPayload(makeForm({ name: 'Gem', category: 'food' })), null);
  });

  it('returns null when city is whitespace only', () => {
    assert.equal(buildSubmitPayload(makeForm({ name: 'Gem', category: 'food', city: '   ' })), null);
  });

  it('returns a payload when name, category, and city are all present', () => {
    const result = buildSubmitPayload(makeForm({ name: 'Gem', category: 'food', city: 'Tokyo' }));
    assert.notEqual(result, null);
  });
});

describe('buildSubmitPayload() — GPS coordinate types', () => {
  const BASE = { name: 'Gem', category: 'food' as const, city: 'Tokyo' };

  it('latitude and longitude are numbers when GPS was captured', () => {
    const form = makeForm({ ...BASE, gpsLat: 35.6762, gpsLng: 139.6503 });
    const payload = buildSubmitPayload(form);

    assert.notEqual(payload, null);
    assert.equal(typeof payload!.latitude, 'number');
    assert.equal(typeof payload!.longitude, 'number');
    assert.equal(payload!.latitude, 35.6762);
    assert.equal(payload!.longitude, 139.6503);
  });

  it('latitude and longitude are NOT strings even when GPS is captured', () => {
    const form = makeForm({ ...BASE, gpsLat: 48.8584, gpsLng: 2.2945 });
    const payload = buildSubmitPayload(form)!;

    assert.notEqual(typeof payload.latitude, 'string');
    assert.notEqual(typeof payload.longitude, 'string');
  });

  it('latitude and longitude are undefined (not null) when GPS was skipped', () => {
    const form = makeForm({ ...BASE, gpsLat: undefined, gpsLng: undefined });
    const payload = buildSubmitPayload(form)!;

    assert.equal(payload.latitude, undefined);
    assert.equal(payload.longitude, undefined);
    assert.notEqual(payload.latitude, null);
    assert.notEqual(payload.longitude, null);
  });

  it('preserves negative coordinates for southern / western hemisphere', () => {
    const form = makeForm({ ...BASE, city: 'Sydney', gpsLat: -33.8688, gpsLng: 151.2093 });
    const payload = buildSubmitPayload(form)!;

    assert.equal(payload.latitude, -33.8688);
    assert.equal(payload.longitude, 151.2093);
    assert.equal(typeof payload.latitude, 'number');
    assert.equal(typeof payload.longitude, 'number');
  });
});

describe('buildSubmitPayload() — optional field coercion', () => {
  const BASE = { name: 'Gem', category: 'food' as const, city: 'Tokyo' };

  it('trimmed required fields are included in the payload', () => {
    const form = makeForm({ ...BASE, name: '  Ramen Den  ', city: '  Tokyo  ' });
    const payload = buildSubmitPayload(form)!;

    assert.equal(payload.name, 'Ramen Den');
    assert.equal(payload.city, 'Tokyo');
  });

  it('country becomes undefined when blank', () => {
    const payload = buildSubmitPayload(makeForm({ ...BASE, country: '' }))!;
    assert.equal(payload.country, undefined);
  });

  it('country is included when provided', () => {
    const payload = buildSubmitPayload(makeForm({ ...BASE, country: 'Japan' }))!;
    assert.equal(payload.country, 'Japan');
  });

  it('description becomes undefined when blank', () => {
    const payload = buildSubmitPayload(makeForm({ ...BASE, description: '' }))!;
    assert.equal(payload.description, undefined);
  });

  it('minimumLayoverMinutes is parsed to an integer (not left as a string)', () => {
    const form = makeForm({ ...BASE, layoverSafe: true, minimumLayoverMinutes: '90' });
    const payload = buildSubmitPayload(form)!;

    assert.equal(typeof payload.minimumLayoverMinutes, 'number');
    assert.equal(payload.minimumLayoverMinutes, 90);
  });

  it('minimumLayoverMinutes is undefined when blank', () => {
    const payload = buildSubmitPayload(makeForm({ ...BASE, minimumLayoverMinutes: '' }))!;
    assert.equal(payload.minimumLayoverMinutes, undefined);
  });

  it('vibeTags are split, trimmed, and filtered from a comma-separated string', () => {
    const form = makeForm({ ...BASE, vibeTags: 'chill, hidden , locals-only,' });
    const payload = buildSubmitPayload(form)!;

    assert.deepEqual(payload.vibeTags, ['chill', 'hidden', 'locals-only']);
  });

  it('vibeTags is undefined when the string is empty', () => {
    const payload = buildSubmitPayload(makeForm({ ...BASE, vibeTags: '' }))!;
    assert.equal(payload.vibeTags, undefined);
  });

  it('sensitivityLevel is forwarded as-is', () => {
    const payload = buildSubmitPayload(makeForm({ ...BASE, sensitivityLevel: 'protected' }))!;
    assert.equal(payload.sensitivityLevel, 'protected');
  });

  it('layoverSafe defaults to false and is included in the payload', () => {
    const payload = buildSubmitPayload(makeForm({ ...BASE }))!;
    assert.equal(payload.layoverSafe, false);
  });
});
