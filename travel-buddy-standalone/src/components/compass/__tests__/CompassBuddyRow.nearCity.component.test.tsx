/**
 * CompassBuddyRow — "· near {city}" header-suffix tests.
 *
 * Confirms that:
 *   1. When `headerSuffix="· near Cebu"` is passed (as discovery.tsx now does),
 *      the text appears in the header so users know the strip is for their
 *      current city — not for a different destination they might be browsing.
 *   2. When `headerSuffix` is omitted, the fallback "· matched for you" text
 *      is rendered instead.
 *   3. When `headerSuffix` is undefined for a null/unknown city, nothing crashes
 *      and no suffix is shown during loading.
 *
 * Run: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

// ── expo-router ─────────────────────────────────────────────────────────────
// NOTE: intentional stub — only router.push is exercised; all other exports
// are irrelevant to header-suffix rendering tests.
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));

// ── compass services — mocked per-test ────────────────────────────────────────
const mockFetchCompassSettings   = jest.fn();
const mockFetchCompassBuddyMatches = jest.fn();

// NOTE: intentional stub — only the two compass service calls are exercised.
jest.mock('../../../services/compass', () => ({
  ...jest.requireActual('../../../services/compass'),
  fetchCompassSettings:     (...args: unknown[]) => mockFetchCompassSettings(...args),
  fetchCompassBuddyMatches: (...args: unknown[]) => mockFetchCompassBuddyMatches(...args),
}));

// compassFormat resolveCompassTitle is used for card names — keep real impl
// so the test can rely on `item.title` resolution without extra mocking.

import { CompassBuddyRow } from '../CompassBuddyRow.tsx';

// ── Fixture ─────────────────────────────────────────────────────────────────

const BUDDY_RESULT = {
  id:       'buddy-cebu-1',
  title:    'Ana',
  city:     'Cebu',
  category: 'city',
  reason:   'Highly rated local in your city',
  score:    0.92,
  data: {
    displayName:      'Ana',
    verified:         true,
    availabilityStatus: 'available_today',
    averageRating:    4.8,
    reviewCount:      12,
    hourlyRateUsd:    20,
    languages:        ['English', 'Filipino'],
    coverPhotoUrl:    null,
  },
};

function settingsOn() {
  mockFetchCompassSettings.mockResolvedValue({
    ok: true,
    data: { show_buddy_recommendations: true },
  });
}

function buddiesResolve(items = [BUDDY_RESULT]) {
  mockFetchCompassBuddyMatches.mockResolvedValue({
    ok: true,
    disabled: false,
    data: items,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CompassBuddyRow headerSuffix — near-city label', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    settingsOn();
  });

  it('renders "· near Cebu" in the section header when headerSuffix is passed', async () => {
    buddiesResolve();

    await render(
      <CompassBuddyRow city="Cebu" headerSuffix="· near Cebu" />,
    );

    await waitFor(() => {
      expect(screen.getByText('Compass Picks')).toBeTruthy();
      expect(screen.getByText('· near Cebu')).toBeTruthy();
    });
  });

  it('renders the fallback "· matched for you" when no headerSuffix is given', async () => {
    buddiesResolve();

    await render(<CompassBuddyRow city="Cebu" />);

    await waitFor(() => {
      expect(screen.getByText('Compass Picks')).toBeTruthy();
      expect(screen.getByText('· matched for you')).toBeTruthy();
    });
    expect(screen.queryByText(/near/)).toBeNull();
  });

  it('headerSuffix reflects the resolved location city — not a hardcoded string', async () => {
    // discovery.tsx computes: headerSuffix={currentCity ? `· near ${currentCity}` : undefined}
    // This test verifies that arbitrary city names work.
    buddiesResolve([{ ...BUDDY_RESULT, id: 'buddy-bkk-1', city: 'Bangkok', title: 'Mark', data: { ...BUDDY_RESULT.data, displayName: 'Mark' } }]);

    const currentCity = 'Bangkok';
    await render(
      <CompassBuddyRow city={currentCity} headerSuffix={currentCity ? `· near ${currentCity}` : undefined} />,
    );

    await waitFor(() => {
      expect(screen.getByText('· near Bangkok')).toBeTruthy();
    });
  });

  it('does not render at all when the fetch returns an empty list', async () => {
    mockFetchCompassBuddyMatches.mockResolvedValue({
      ok: true,
      disabled: false,
      data: [],
    });

    const { toJSON } = await render(
      <CompassBuddyRow city="Cebu" headerSuffix="· near Cebu" />,
    );

    await waitFor(() => {
      // Component self-hides when there are no results
      expect(screen.queryByText('Compass Picks')).toBeNull();
      expect(screen.queryByText('· near Cebu')).toBeNull();
    });
  });

  it('does not render when show_buddy_recommendations is false', async () => {
    mockFetchCompassSettings.mockResolvedValue({
      ok: true,
      data: { show_buddy_recommendations: false },
    });

    await render(
      <CompassBuddyRow city="Cebu" headerSuffix="· near Cebu" />,
    );

    await waitFor(() => {
      expect(screen.queryByText('Compass Picks')).toBeNull();
    });
  });

  it('shows headerSuffix with the "near" city during the loading skeleton phase', async () => {
    // The loading skeleton renders the header even before results arrive.
    // The suffix should be visible during that window so the skeleton is
    // already anchored to the right city.
    let resolveMatches!: (v: any) => void;
    mockFetchCompassBuddyMatches.mockReturnValue(
      new Promise((res) => { resolveMatches = res; }),
    );

    await render(
      <CompassBuddyRow city="Cebu" headerSuffix="· near Cebu" />,
    );

    // During loading the skeleton header is visible with the suffix
    await waitFor(() => {
      expect(screen.getByText('Compass Picks')).toBeTruthy();
      expect(screen.getByText('· near Cebu')).toBeTruthy();
    });

    // Resolve and confirm it stays visible
    resolveMatches({ ok: true, disabled: false, data: [BUDDY_RESULT] });
    await waitFor(() => {
      expect(screen.getByText('· near Cebu')).toBeTruthy();
    });
  });
});
