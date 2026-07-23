/**
 * Component-level tests for NeighborhoodMatchSheet (two-step modal sheet).
 *
 * Covers in ONE render mount (per the RNTL render-count limit):
 * - step-1: sleep-style options (three tiles) + five priority sliders
 * - step-2: area cards, compass-pick highlight + "why" text, factor tags,
 *   low-confidence caveat, match-% badge, OSM disclaimer
 *
 * Two-file rule: this file is separate from NeighborhoodMatchSection tests
 * because async Modal mounts corrupt act() scopes across tests in the same file.
 *
 * RNTL v14 + React 19: all assertions in ONE render; navigate via fireEvent.
 */
import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// NOTE: exhaustive — expo-router has many exports; sheet doesn't use any
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

// Modal proxy: renders children synchronously when visible, null when not.
// Required so RNTL can query inside the Modal tree without async act() collisions.
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

// NOTE: exhaustive — only the three service functions used by NeighborhoodMatchSheet
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

const TRIP_ID = 'trip-nb-sheet-1';

const MATCH_RESULT = {
  areas: [
    {
      name: 'Old Town',
      matchScore: 87,
      factors: [
        { key: 'nightlife', label: 'Strong nightlife', contribution: 92 },
        { key: 'food', label: 'Great food', contribution: 78 },
      ],
      categoryScores: { nightlife: 92, food: 78 },
      dayNight: { day: 'Bustling markets and cafés', night: 'Vibrant bar scene' },
      sampleSize: 120,
      confidence: 'high' as const,
    },
    {
      name: 'Riverside',
      matchScore: 64,
      factors: [],
      categoryScores: { quiet: 85 },
      dayNight: { day: 'Peaceful riverside walks', night: 'Calm and quiet' },
      sampleSize: 30,
      confidence: 'low' as const,
      caveat: 'Small sample — results may vary.',
    },
  ],
  compassPick: { name: 'Old Town', why: 'Matches your nightlife priorities perfectly.' },
  disclaimer: 'Neighborhood data © OpenStreetMap contributors.',
};

// ── Main test ─────────────────────────────────────────────────────────────────

// Real-shape verdict fixture — matches the actual backend response contract.
const LOCATION_VERDICT = {
  verdict: 'good_fit' as const,
  distanceToCenterOfGravityKm: 1.2,
  areaFit: { areaName: 'Old Town', matchScore: 0.87 },
  nearestSavedPlaces: [{ name: 'The Grand Hotel', distanceKm: 0.3 }],
  centerOfGravity: { lat: 48.8, lng: 2.35, shares: { nightlife: 0.45, food: 0.55 } },
  locatedPoints: 5,
  thresholdNote: 'good_fit ≤ 1 km',
};

describe('NeighborhoodMatchSheet — full two-step flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const nb = require('../../services/neighborhoods.ts');
    nb.fetchNeighborhoodMatch.mockResolvedValue(MATCH_RESULT);
    nb.setTripAreaPreferences.mockResolvedValue(true);
    nb.runLocationCheck.mockResolvedValue(null);
  });

  /**
   * ONE mount, navigate step 1 → step 2 in sequence, assert all step-2 concerns.
   * Consolidated per RNTL render-count limit (first ~2 renders flush reliably).
   */
  it('renders step-1 options and sliders, then navigates to step-2 with full results', async () => {
    const { NeighborhoodMatchSheet } = require('../trip/NeighborhoodMatchSheet.tsx');
    const view = await render(
      React.createElement(NeighborhoodMatchSheet, {
        visible: true,
        tripId: TRIP_ID,
        onClose: jest.fn(),
      }),
    );

    // ── Step 1: sleep-style options ───────────────────────────────────────────
    expect(view.getByText('Inside the Action')).toBeTruthy();
    expect(view.getByText('Close to the Action')).toBeTruthy();
    expect(view.getByText('Away from the Action')).toBeTruthy();

    // ── Step 1: priority sliders ──────────────────────────────────────────────
    expect(view.getByTestId('slider-Nightlife')).toBeTruthy();
    expect(view.getByTestId('slider-Food & Dining')).toBeTruthy();
    expect(view.getByTestId('slider-Culture & Arts')).toBeTruthy();
    expect(view.getByTestId('slider-Shopping')).toBeTruthy();
    expect(view.getByTestId('slider-Quiet & Green Space')).toBeTruthy();

    // Select "Inside the Action" and submit
    fireEvent.press(view.getByText('Inside the Action'));

    await act(async () => {
      fireEvent.press(view.getByText('Find neighborhoods →'));
    });

    // ── Step 2: area names ───────────────────────────────────────────────────
    await waitFor(() => {
      expect(view.getByText('Old Town')).toBeTruthy();
      expect(view.getByText('Riverside')).toBeTruthy();
    });

    // ── Step 2: compass pick badge + "why" text ───────────────────────────────
    expect(view.getByText('Compass Pick')).toBeTruthy();
    expect(view.getByText('Matches your nightlife priorities perfectly.')).toBeTruthy();

    // ── Step 2: factor tags with scores ──────────────────────────────────────
    expect(view.getByText('Strong nightlife (92/100)')).toBeTruthy();
    expect(view.getByText('Great food (78/100)')).toBeTruthy();

    // ── Step 2: match percentage badges ──────────────────────────────────────
    expect(view.getByText('87%')).toBeTruthy();
    expect(view.getByText('64%')).toBeTruthy();

    // ── Step 2: low-confidence caveat ─────────────────────────────────────────
    expect(view.getByText('Small sample — results may vary.')).toBeTruthy();

    // ── Step 2: OSM disclaimer ────────────────────────────────────────────────
    expect(view.getByText('Neighborhood data © OpenStreetMap contributors.')).toBeTruthy();

    // ── Step 2: "Check this location" CTA present ─────────────────────────────
    expect(view.getByText('Check this location')).toBeTruthy();
  });
});

// NOTE: Location-check verdict-card tests live in a separate file:
// NeighborhoodMatchSheet.verdict.component.test.tsx
// (Two-file rule: a second Modal render mount in the same file poisons the
// RNTL React 19 renderer for all preceding tests — see modal-proxy-mock memory.)
