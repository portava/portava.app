/**
 * app/trails/new — says "not available yet" up front while a Trail cannot be started.
 *
 * With `trail_creation_enabled` OFF (production, 2026-10-22) the screen opened the full form; the traveller typed a
 * name, a city and a description, pressed Start, and only then got "Starting a Trail is not available yet." from
 * the server (feature_disabled). Now:
 *   N1  flag off → the notice, and no form at all;
 *   N2  flag on → the form, opened on the city it was given;
 *   N3  flags still loading → neither the form nor a premature "not available".
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

import NewTrailScreen from '../new.tsx';

const mockFlags = { on: new Set<string>(), loading: false };
// NOTE: intentionally exhaustive — the screen reads one flag through the context; the provider fetches over HTTP.
jest.mock('../../../src/context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (k: string) => mockFlags.on.has(k), loading: mockFlags.loading }),
}));

// NOTE: intentionally exhaustive — expo-router's navigation internals need a NavigationContainer; the screen uses
// `router` and `useLocalSearchParams` only.
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => ({ destination: 'Kyoto' }),
}));

// NOTE: intentional stub — AppHeader chrome is not under test.
jest.mock('../../../src/components/ui/AppHeader', () => ({ AppHeader: () => null }));

beforeEach(() => { mockFlags.on.clear(); mockFlags.loading = false; });

describe('Start a Trail screen — trail_creation_enabled gate', () => {
  it('N1: flag off → "not available yet" up front, and no form', async () => {
    await render(<NewTrailScreen />);
    expect(screen.getByTestId('trail-create-off')).toBeTruthy();
    expect(screen.getByText("Starting a Trail isn't available yet.")).toBeTruthy();
    expect(screen.queryByTestId('trail-create')).toBeNull();
    expect(screen.queryByTestId('trail-create-submit')).toBeNull();
  });

  it('N2: flag on → the form, opened on the city it was given', async () => {
    mockFlags.on.add('trail_creation_enabled');
    await render(<NewTrailScreen />);
    expect(screen.getByTestId('trail-create')).toBeTruthy();
    expect(screen.getByTestId('trail-create-destination').props.value).toBe('Kyoto');
    expect(screen.queryByTestId('trail-create-off')).toBeNull();
  });

  it('N3: flags still loading → neither the form nor a premature "not available"', async () => {
    mockFlags.loading = true;
    await render(<NewTrailScreen />);
    expect(screen.queryByTestId('trail-create')).toBeNull();
    expect(screen.queryByTestId('trail-create-off')).toBeNull();
  });
});
