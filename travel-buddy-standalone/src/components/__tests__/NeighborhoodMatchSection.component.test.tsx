/**
 * Component-level tests for NeighborhoodMatchSection (entry-point banner only).
 *
 * Covers:
 * - null return from fetchNeighborhoodMatch → renders nothing
 * - non-null return → "Where should I stay?" banner is shown
 *
 * Sheet tests live in NeighborhoodMatchSheet.component.test.tsx (separate file
 * per the two-file rule for async Modal tests).
 *
 * RNTL v14: always await render().
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// NOTE: exhaustive — expo-router has many exports; component only uses router
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => {
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    useSafeAreaInsets: () => insets,
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});

// Modal proxy: makes Modal(visible=false) return null so the sheet doesn't render
// during section tests; Modal(visible=true) passes children through.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: { children: React.ReactNode; visible?: boolean }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  const MockActivityIndicator = () => null;
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'ActivityIndicator') return MockActivityIndicator;
      return Reflect.get(target, prop, receiver);
    },
  });
});

// NOTE: exhaustive — only the two service functions used by NeighborhoodMatchSection
jest.mock('../../services/neighborhoods.ts', () => ({
  fetchNeighborhoodMatch: jest.fn(),
  setTripAreaPreferences: jest.fn(),
  runLocationCheck: jest.fn(),
}));

// Slider mock — plain View (no native deps)
jest.mock('@react-native-community/slider', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockSlider = (props: { accessibilityLabel?: string }) =>
    React.createElement(View, { testID: `slider-${props.accessibilityLabel ?? 'unknown'}` });
  MockSlider.displayName = 'MockSlider';
  return MockSlider;
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TRIP_ID = 'trip-nb-section-1';

const MATCH_RESULT = {
  areas: [],
  compassPick: null,
  disclaimer: undefined,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function mountSection(tripId = TRIP_ID) {
  const { NeighborhoodMatchSection } = require('../trip/NeighborhoodMatchSection.tsx');
  return render(React.createElement(NeighborhoodMatchSection, { tripId }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('NeighborhoodMatchSection — entry-point banner', () => {
  let fetchNeighborhoodMatch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const nb = require('../../services/neighborhoods.ts');
    fetchNeighborhoodMatch = nb.fetchNeighborhoodMatch;
  });

  it('renders nothing when fetchNeighborhoodMatch returns null', async () => {
    fetchNeighborhoodMatch.mockResolvedValue(null);

    const { queryByText } = await mountSection();

    await waitFor(() => {
      expect(fetchNeighborhoodMatch).toHaveBeenCalledWith(TRIP_ID);
    });

    expect(queryByText(/Where should I stay/)).toBeNull();
  });

  it('shows the banner when fetchNeighborhoodMatch returns a result', async () => {
    fetchNeighborhoodMatch.mockResolvedValue(MATCH_RESULT);

    const { findByText } = await mountSection();

    const banner = await findByText('Where should I stay?');
    expect(banner).toBeTruthy();
  });
});
