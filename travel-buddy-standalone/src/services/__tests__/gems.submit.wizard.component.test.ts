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
 * Run with:  pnpm test:component
 *
 * submit.machine.ts has zero React-Native / Expo imports so it is imported
 * directly without any mocking needed.
 */

import {
  canNext,
  buildSubmitPayload,
  type WizardFormState,
} from '../../../app/gems/submit.machine';

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
    expect(canNext(0, form)).toBe(false);
  });

  it('returns false when city is whitespace only, even with GPS captured', () => {
    const form = makeForm({ city: '   ', gpsLat: 35.6762, gpsLng: 139.6503 });
    expect(canNext(0, form)).toBe(false);
  });

  it('returns true when city has content and GPS is also present', () => {
    const form = makeForm({ city: 'Tokyo', gpsLat: 35.6762, gpsLng: 139.6503 });
    expect(canNext(0, form)).toBe(true);
  });

  it('returns true when city has content and GPS is absent (GPS is optional)', () => {
    const form = makeForm({ city: 'Paris' });
    expect(canNext(0, form)).toBe(true);
  });

  it('returns false when city is empty and GPS is absent', () => {
    const form = makeForm();
    expect(canNext(0, form)).toBe(false);
  });

  it('ignores GPS state entirely — city is the only gate at step 0', () => {
    const withGps    = makeForm({ city: '',      gpsLat: 1.0, gpsLng: 1.0 });
    const withoutGps = makeForm({ city: '',      gpsLat: undefined, gpsLng: undefined });
    const cityOnly   = makeForm({ city: 'Seoul', gpsLat: undefined });
    const both       = makeForm({ city: 'Seoul', gpsLat: 37.5665, gpsLng: 126.9780 });

    expect(canNext(0, withGps)).toBe(false);
    expect(canNext(0, withoutGps)).toBe(false);
    expect(canNext(0, cityOnly)).toBe(true);
    expect(canNext(0, both)).toBe(true);
  });
});

describe('canNext() — step 1 (Details)', () => {
  it('returns false when both name and category are empty', () => {
    expect(canNext(1, makeForm())).toBe(false);
  });

  it('returns false when name is present but category is empty', () => {
    expect(canNext(1, makeForm({ name: 'My Gem', category: '' }))).toBe(false);
  });

  it('returns false when category is present but name is empty', () => {
    expect(canNext(1, makeForm({ name: '', category: 'food' }))).toBe(false);
  });

  it('returns false when name is whitespace only', () => {
    expect(canNext(1, makeForm({ name: '   ', category: 'food' }))).toBe(false);
  });

  it('returns true when both name and category are provided', () => {
    expect(canNext(1, makeForm({ name: 'Hidden ramen spot', category: 'food' }))).toBe(true);
  });

  it('accepts every valid category value at step 1', () => {
    const categories = [
      'food', 'drink', 'nature', 'culture', 'adventure',
      'nightlife', 'wellness', 'local_secret', 'market', 'viewpoint',
      'transport', 'other',
    ] as const;
    for (const category of categories) {
      expect(canNext(1, makeForm({ name: 'Gem', category }))).toBe(true);
    }
  });
});

describe('canNext() — step 2 (Privacy)', () => {
  it('returns true regardless of form state (privacy has a default)', () => {
    expect(canNext(2, makeForm())).toBe(true);
    expect(canNext(2, makeForm({ sensitivityLevel: 'protected' }))).toBe(true);
  });
});

describe('canNext() — step 3 (Review)', () => {
  it('returns true regardless of form state (final guard is in buildSubmitPayload)', () => {
    expect(canNext(3, makeForm())).toBe(true);
    expect(canNext(3, makeForm({ name: 'Gem', category: 'food', city: 'Tokyo' }))).toBe(true);
  });
});

// ── buildSubmitPayload() tests ─────────────────────────────────────────────────

describe('buildSubmitPayload() — required-field guard', () => {
  it('returns null when all required fields are missing', () => {
    expect(buildSubmitPayload(makeForm())).toBeNull();
  });

  it('returns null when only name is missing', () => {
    expect(buildSubmitPayload(makeForm({ category: 'food', city: 'Tokyo' }))).toBeNull();
  });

  it('returns null when only category is missing', () => {
    expect(buildSubmitPayload(makeForm({ name: 'Gem', city: 'Tokyo' }))).toBeNull();
  });

  it('returns null when only city is missing', () => {
    expect(buildSubmitPayload(makeForm({ name: 'Gem', category: 'food' }))).toBeNull();
  });

  it('returns null when city is whitespace only', () => {
    expect(buildSubmitPayload(makeForm({ name: 'Gem', category: 'food', city: '   ' }))).toBeNull();
  });

  it('returns a payload when name, category, and city are all present', () => {
    const result = buildSubmitPayload(makeForm({ name: 'Gem', category: 'food', city: 'Tokyo' }));
    expect(result).not.toBeNull();
  });
});

describe('buildSubmitPayload() — GPS coordinate types', () => {
  const BASE = { name: 'Gem', category: 'food' as const, city: 'Tokyo' };

  it('latitude and longitude are numbers when GPS was captured', () => {
    const form = makeForm({ ...BASE, gpsLat: 35.6762, gpsLng: 139.6503 });
    const payload = buildSubmitPayload(form);

    expect(payload).not.toBeNull();
    expect(typeof payload!.latitude).toBe('number');
    expect(typeof payload!.longitude).toBe('number');
    expect(payload!.latitude).toBe(35.6762);
    expect(payload!.longitude).toBe(139.6503);
  });

  it('latitude and longitude are NOT strings even when GPS is captured', () => {
    const form = makeForm({ ...BASE, gpsLat: 48.8584, gpsLng: 2.2945 });
    const payload = buildSubmitPayload(form)!;

    expect(typeof payload.latitude).not.toBe('string');
    expect(typeof payload.longitude).not.toBe('string');
  });

  it('latitude and longitude are undefined (not null) when GPS was skipped', () => {
    const form = makeForm({ ...BASE, gpsLat: undefined, gpsLng: undefined });
    const payload = buildSubmitPayload(form)!;

    expect(payload.latitude).toBeUndefined();
    expect(payload.longitude).toBeUndefined();
    expect(payload.latitude).not.toBeNull();
    expect(payload.longitude).not.toBeNull();
  });

  it('preserves negative coordinates for southern / western hemisphere', () => {
    const form = makeForm({ ...BASE, city: 'Sydney', gpsLat: -33.8688, gpsLng: 151.2093 });
    const payload = buildSubmitPayload(form)!;

    expect(payload.latitude).toBe(-33.8688);
    expect(payload.longitude).toBe(151.2093);
    expect(typeof payload.latitude).toBe('number');
    expect(typeof payload.longitude).toBe('number');
  });
});

describe('buildSubmitPayload() — optional field coercion', () => {
  const BASE = { name: 'Gem', category: 'food' as const, city: 'Tokyo' };

  it('trimmed required fields are included in the payload', () => {
    const form = makeForm({ ...BASE, name: '  Ramen Den  ', city: '  Tokyo  ' });
    const payload = buildSubmitPayload(form)!;

    expect(payload.name).toBe('Ramen Den');
    expect(payload.city).toBe('Tokyo');
  });

  it('country becomes undefined when blank', () => {
    const payload = buildSubmitPayload(makeForm({ ...BASE, country: '' }))!;
    expect(payload.country).toBeUndefined();
  });

  it('country is included when provided', () => {
    const payload = buildSubmitPayload(makeForm({ ...BASE, country: 'Japan' }))!;
    expect(payload.country).toBe('Japan');
  });

  it('description becomes undefined when blank', () => {
    const payload = buildSubmitPayload(makeForm({ ...BASE, description: '' }))!;
    expect(payload.description).toBeUndefined();
  });

  it('minimumLayoverMinutes is parsed to an integer (not left as a string)', () => {
    const form = makeForm({ ...BASE, layoverSafe: true, minimumLayoverMinutes: '90' });
    const payload = buildSubmitPayload(form)!;

    expect(typeof payload.minimumLayoverMinutes).toBe('number');
    expect(payload.minimumLayoverMinutes).toBe(90);
  });

  it('minimumLayoverMinutes is undefined when blank', () => {
    const payload = buildSubmitPayload(makeForm({ ...BASE, minimumLayoverMinutes: '' }))!;
    expect(payload.minimumLayoverMinutes).toBeUndefined();
  });

  it('vibeTags are split, trimmed, and filtered from a comma-separated string', () => {
    const form = makeForm({ ...BASE, vibeTags: 'chill, hidden , locals-only,' });
    const payload = buildSubmitPayload(form)!;

    expect(payload.vibeTags).toEqual(['chill', 'hidden', 'locals-only']);
  });

  it('vibeTags is undefined when the string is empty', () => {
    const payload = buildSubmitPayload(makeForm({ ...BASE, vibeTags: '' }))!;
    expect(payload.vibeTags).toBeUndefined();
  });

  it('sensitivityLevel is forwarded as-is', () => {
    const payload = buildSubmitPayload(makeForm({ ...BASE, sensitivityLevel: 'protected' }))!;
    expect(payload.sensitivityLevel).toBe('protected');
  });

  it('layoverSafe defaults to false and is included in the payload', () => {
    const payload = buildSubmitPayload(makeForm({ ...BASE }))!;
    expect(payload.layoverSafe).toBe(false);
  });
});
