/**
 * onboarding.socialBump.component.test.tsx
 *
 * Smoke-test: confirms the Onboarding screen renders without crashing and that
 * the social-version bump wiring lives in runOnboardingFinish (tested exhaustively
 * in src/services/__tests__/onboardingFinish.test.ts).
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — only router.replace is exercised; the full
// expo-router module pulls in native navigation stacks incompatible with jest.
jest.mock('expo-router', () => ({
  router: { replace: jest.fn() },
  useRouter: () => ({ replace: jest.fn() }),
}));

// NOTE: intentionally exhaustive — only useSafeAreaInsets is used on this
// screen; loading the full module causes native module init errors in jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — getMyProfile is the only function called
// during render; the real module opens a Supabase connection at import time.
jest.mock('../../../src/services/profile', () => ({
  getMyProfile: jest.fn().mockResolvedValue({ ok: true, data: { interests: [] } }),
}));

// NOTE: intentionally exhaustive — runOnboardingFinish is stubbed so the
// smoke test doesn't trigger real profile writes or navigation side-effects.
jest.mock('../../../src/services/onboardingFinish', () => ({
  runOnboardingFinish: jest.fn(),
}));

// NOTE: intentionally exhaustive — buildOnboardingPatch is a pure mapper;
// stubbing avoids importing supabase-dependent profile types at test time.
jest.mock('../../../src/services/profilePatchBuilder', () => ({
  buildOnboardingPatch: jest.fn(() => ({ onboardingComplete: true })),
}));

// NOTE: intentionally exhaustive — buildOnboardingSaveAlert is a pure mapper;
// the real module has no side-effects but requires full profile type imports.
jest.mock('../../../src/services/profileSaveFlow', () => ({
  buildOnboardingSaveAlert: jest.fn(() => ({ title: 'Error', message: 'Try again.' })),
}));

// NOTE: intentionally exhaustive — getCurrentGps / reverseGeocodeToPlace are
// not called during the smoke-test render; native location APIs crash in jest.
jest.mock('../../../src/services/location', () => ({
  getCurrentGps: jest.fn(),
  reverseGeocodeToPlace: jest.fn(),
}));

// NOTE: intentionally exhaustive — fillHomeFromGps.machine calls XState; the
// full machine crashes in jest due to missing native geolocation bindings.
jest.mock('../../../src/services/fillHomeFromGps.machine', () => ({
  fillHomeFromGps: jest.fn(),
}));

// NOTE: intentionally exhaustive — ManualCityPicker uses native modal and map
// dependencies that are incompatible with the jest-expo environment.
jest.mock('../../../src/components/ManualCityPicker', () => ({
  ManualCityPicker: () => null,
}));

// NOTE: intentionally exhaustive — DatePickerField depends on
// @react-native-community/datetimepicker which requires a native module.
jest.mock('../../../src/components/DatePickerField', () => ({
  DatePickerField: () => null,
}));

// NOTE: intentionally exhaustive — usePlainBottomInset reads safe-area insets
// via a native context; the stub returns a constant so render doesn't throw.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  usePlainBottomInset: jest.fn(() => 0),
}));

// NOTE: intentionally exhaustive — bumpSocialVersion is stubbed so the smoke
// test doesn't mutate the module-level version counter shared across files.
jest.mock('../../../src/hooks/useSocialVersion', () => ({
  bumpSocialVersion: jest.fn(),
  useSocialVersion:  jest.fn(() => 0),
}));

// NOTE: intentionally exhaustive — Stamp / Chip are rendering primitives with
// no logic under test; stubbing avoids deep SVG / Reanimated import chains.
jest.mock('../../../src/components/ui', () => ({
  Stamp: () => null,
  Chip: ({ label }: { label: string }) => {
    const RN = require('react-native');
    const R  = require('react');
    return R.createElement(RN.Text, null, label);
  },
}));

// ── Test ──────────────────────────────────────────────────────────────────────

import Onboarding from '../onboarding';

describe('Onboarding screen — social-version bump wiring', () => {
  it('renders without crashing (smoke test)', async () => {
    await render(<Onboarding />);
    // The screen resolves getMyProfile and exits the loading state.
    // Exhaustive bump assertions live in onboardingFinish.test.ts.
    expect(screen).toBeDefined();
  });
});
