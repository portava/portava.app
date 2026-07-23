/**
 * Verdict-card tests for the LocationCheckSheet sub-component.
 *
 * Kept in a separate file from NeighborhoodMatchSheet.component.test.tsx per
 * the two-file rule: a second async Modal mount in the same file poisons the
 * RNTL React 19 renderer act() scope for all preceding tests.
 *
 * LocationCheckSheet is exported from NeighborhoodMatchSheet.tsx so it can be
 * rendered in isolation here — avoiding the full two-step navigation chain.
 *
 * Covers:
 *   - Successful location check renders real API verdict fields
 *     (verdict label, distance, area fit with match score, nearest saved places,
 *      center-of-gravity shares, "Check another" CTA)
 */
import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// NOTE: exhaustive — LocationCheckSheet doesn't use expo-router
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

// NOTE: exhaustive — LocationCheckSheet only uses useSafeAreaInsets
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// NOTE: exhaustive — only the three service functions used by NeighborhoodMatchSheet
jest.mock('../../services/neighborhoods.ts', () => ({
  fetchNeighborhoodMatch: jest.fn(),
  setTripAreaPreferences: jest.fn(),
  runLocationCheck: jest.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TRIP_ID = 'trip-nb-verdict-1';

// Real backend response shape for POST /api/trips/:id/location-check
const LOCATION_VERDICT = {
  verdict: 'good_fit' as const,
  distanceToCenterOfGravityKm: 1.2,
  areaFit: { areaName: 'Old Town', matchScore: 0.87 },
  nearestSavedPlaces: [{ name: 'The Grand Hotel', distanceKm: 0.3 }],
  centerOfGravity: { lat: 48.8, lng: 2.35, shares: { nightlife: 0.45, food: 0.55 } },
  locatedPoints: 5,
  thresholdNote: 'good_fit ≤ 1 km',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LocationCheckSheet — verdict card rendering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const nb = require('../../services/neighborhoods.ts');
    nb.runLocationCheck.mockResolvedValue(LOCATION_VERDICT);
  });

  it('shows real API verdict fields after a successful location check', async () => {
    // Render LocationCheckSheet directly — avoids the two-step navigation
    // flow and its React 19 renderer budget limits.
    const { LocationCheckSheet } = require('../trip/NeighborhoodMatchSheet.tsx');
    const view = await render(
      React.createElement(LocationCheckSheet, {
        tripId: TRIP_ID,
        onClose: jest.fn(),
      }),
    );

    // Coordinate inputs must be present
    expect(view.getByLabelText('Latitude')).toBeTruthy();
    expect(view.getByLabelText('Longitude')).toBeTruthy();

    // Commit lat/lng state before pressing — ensures handleCheck's closure
    // captures the updated values, not the initial empty strings.
    await act(async () => {
      fireEvent.changeText(view.getByLabelText('Latitude'), '48.8');
      fireEvent.changeText(view.getByLabelText('Longitude'), '2.35');
    });

    // Submit — lat/lng now committed; waitFor drains the async runLocationCheck.
    fireEvent.press(view.getByText('Check location'));
    await waitFor(() => expect(view.getByTestId('verdict-label')).toBeTruthy());

    // Verdict string
    expect(view.getByText(/Good fit/)).toBeTruthy();

    // Distance to center of gravity
    expect(view.getByText(/1\.2 km/)).toBeTruthy();

    // Area fit name and match score
    expect(view.getByText(/Old Town/)).toBeTruthy();
    expect(view.getByText(/87% match/)).toBeTruthy();

    // Nearest saved place
    expect(view.getByText('The Grand Hotel')).toBeTruthy();

    // Center-of-gravity shares
    expect(view.getByText(/nightlife/)).toBeTruthy();
    expect(view.getByText(/45%/)).toBeTruthy();

    // "Check another" resets the form
    expect(view.getByText('Check another')).toBeTruthy();
  });
});
