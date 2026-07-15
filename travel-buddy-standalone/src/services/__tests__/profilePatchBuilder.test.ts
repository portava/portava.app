/**
 * Unit tests for buildOnboardingPatch()
 * in profilePatchBuilder.ts.
 *
 * Specifically verifies the round-trip: GPS-detected homeCity / homeCountry
 * that reach this builder is faithfully included in the PATCH object sent
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
  type OnboardingFormState,
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
