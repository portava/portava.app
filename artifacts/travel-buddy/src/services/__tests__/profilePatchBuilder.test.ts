/**
 * Unit tests for buildOnboardingPatch() and buildPassportSettingsPatch()
 * in profilePatchBuilder.ts.
 *
 * Specifically verifies the round-trip: GPS-detected homeCity / homeCountry
 * that reach these builders are faithfully included in the PATCH object sent
 * to the server, and that empty / whitespace-only values are excluded so the
 * API never overwrites existing values with blank strings.
 *
 * Run with:
 *   node --import tsx/esm --test src/services/__tests__/profilePatchBuilder.test.ts
 *
 * Pure TypeScript — no React, no native modules, no network calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOnboardingPatch,
  buildPassportSettingsPatch,
  type OnboardingFormState,
  type PassportSettingsFormState,
} from '../profilePatchBuilder.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeOnboardingState(overrides: Partial<OnboardingFormState> = {}): OnboardingFormState {
  return {
    displayName: 'Test User',
    handle:      'testuser',
    homeCity:    '',
    homeCountry: '',
    travelStyle: 'explorer',
    interests:   ['hiking'],
    ...overrides,
  };
}

function makePassportState(overrides: Partial<PassportSettingsFormState> = {}): PassportSettingsFormState {
  return {
    displayName:      'Test User',
    bio:              '',
    homeCity:         '',
    homeCountry:      '',
    passportPublic:   true,
    interests:        [],
    spokenLanguages:  [],
    defaultLanguage:  '',
    travelStyles:     [],
    travelPace:       null,
    budgetStyle:      null,
    travelGroupStyle: [],
    lookingFor:       [],
    comfortLevel:     null,
    availabilityTags: [],
    planningStyle:    null,
    currentUsername:  'testuser',
    newUsername:      '',
    usernameStatus:   'available',
    ...overrides,
  };
}

// ── buildOnboardingPatch ──────────────────────────────────────────────────────

describe('buildOnboardingPatch — homeCity / homeCountry round-trip', () => {
  it('includes homeCity in patch when GPS-detected city is provided', () => {
    const patch = buildOnboardingPatch(makeOnboardingState({ homeCity: 'Paris' }));
    assert.equal(patch.homeCity, 'Paris', 'homeCity must be in the patch when non-empty');
  });

  it('includes homeCountry in patch when GPS-detected country is provided', () => {
    const patch = buildOnboardingPatch(makeOnboardingState({ homeCountry: 'France' }));
    assert.equal(patch.homeCountry, 'France', 'homeCountry must be in the patch when non-empty');
  });

  it('includes both homeCity and homeCountry when both are GPS-detected', () => {
    const patch = buildOnboardingPatch(makeOnboardingState({
      homeCity:    'Tokyo',
      homeCountry: 'Japan',
    }));
    assert.equal(patch.homeCity,    'Tokyo', 'homeCity must be in patch');
    assert.equal(patch.homeCountry, 'Japan', 'homeCountry must be in patch');
  });

  it('excludes homeCity from patch when empty — no accidental overwrite', () => {
    const patch = buildOnboardingPatch(makeOnboardingState({ homeCity: '' }));
    assert.equal(
      Object.prototype.hasOwnProperty.call(patch, 'homeCity'),
      false,
      'homeCity must not appear in patch when empty string',
    );
  });

  it('excludes homeCountry from patch when empty — no accidental overwrite', () => {
    const patch = buildOnboardingPatch(makeOnboardingState({ homeCountry: '' }));
    assert.equal(
      Object.prototype.hasOwnProperty.call(patch, 'homeCountry'),
      false,
      'homeCountry must not appear in patch when empty string',
    );
  });

  it('excludes homeCity from patch when whitespace-only', () => {
    const patch = buildOnboardingPatch(makeOnboardingState({ homeCity: '   ' }));
    assert.equal(
      Object.prototype.hasOwnProperty.call(patch, 'homeCity'),
      false,
      'whitespace-only homeCity must be treated as empty and excluded',
    );
  });

  it('excludes homeCountry from patch when whitespace-only', () => {
    const patch = buildOnboardingPatch(makeOnboardingState({ homeCountry: '  ' }));
    assert.equal(
      Object.prototype.hasOwnProperty.call(patch, 'homeCountry'),
      false,
      'whitespace-only homeCountry must be treated as empty and excluded',
    );
  });

  it('trims leading/trailing whitespace from GPS-detected homeCity', () => {
    const patch = buildOnboardingPatch(makeOnboardingState({ homeCity: '  Manila  ' }));
    assert.equal(patch.homeCity, 'Manila', 'homeCity must be trimmed');
  });
});

// ── buildPassportSettingsPatch ────────────────────────────────────────────────

describe('buildPassportSettingsPatch — homeCity / homeCountry round-trip', () => {
  it('includes homeCity in patch when GPS-detected city is provided', () => {
    const patch = buildPassportSettingsPatch(makePassportState({ homeCity: 'Cebu City' }));
    assert.equal(patch['homeCity'], 'Cebu City', 'homeCity must be in the patch when non-empty');
  });

  it('includes homeCountry in patch when GPS-detected country is provided', () => {
    const patch = buildPassportSettingsPatch(makePassportState({ homeCountry: 'Philippines' }));
    assert.equal(patch['homeCountry'], 'Philippines', 'homeCountry must be in the patch when non-empty');
  });

  it('includes both homeCity and homeCountry when both are GPS-detected', () => {
    const patch = buildPassportSettingsPatch(makePassportState({
      homeCity:    'Barcelona',
      homeCountry: 'Spain',
    }));
    assert.equal(patch['homeCity'],    'Barcelona', 'homeCity must be in patch');
    assert.equal(patch['homeCountry'], 'Spain',     'homeCountry must be in patch');
  });

  it('excludes homeCity from patch when empty — no accidental overwrite', () => {
    const patch = buildPassportSettingsPatch(makePassportState({ homeCity: '' }));
    assert.equal(
      patch['homeCity'],
      undefined,
      'homeCity must be undefined in patch when empty string',
    );
  });

  it('excludes homeCountry from patch when empty — no accidental overwrite', () => {
    const patch = buildPassportSettingsPatch(makePassportState({ homeCountry: '' }));
    assert.equal(
      patch['homeCountry'],
      undefined,
      'homeCountry must be undefined in patch when empty string',
    );
  });

  it('excludes homeCity from patch when whitespace-only', () => {
    const patch = buildPassportSettingsPatch(makePassportState({ homeCity: '   ' }));
    assert.equal(
      patch['homeCity'],
      undefined,
      'whitespace-only homeCity must be treated as empty and excluded',
    );
  });

  it('excludes homeCountry from patch when whitespace-only', () => {
    const patch = buildPassportSettingsPatch(makePassportState({ homeCountry: '  ' }));
    assert.equal(
      patch['homeCountry'],
      undefined,
      'whitespace-only homeCountry must be treated as empty and excluded',
    );
  });

  it('trims leading/trailing whitespace from GPS-detected homeCity', () => {
    const patch = buildPassportSettingsPatch(makePassportState({ homeCity: '  Davao City  ' }));
    assert.equal(patch['homeCity'], 'Davao City', 'homeCity must be trimmed');
  });
});
