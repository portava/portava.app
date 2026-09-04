/**
 * MapTab — sentinel / graceful-state component tests.
 *
 * Verifies that when a `sentinel` prop is provided, MapTab renders the
 * appropriate message and does NOT render the map.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react-native';

// ── Service mocks ─────────────────────────────────────────────────────────────

// NOTE: intentional exhaustive stub — MapTab only uses getPassportMap from
// passportStamps; the sentinel path short-circuits before the call fires, but
// the mock prevents any real network request from escaping into the test runner.
jest.mock('../../services/passportStamps.ts', () => ({
  getPassportMap: jest.fn(() => new Promise(() => {})), // never-resolving stub
}));

// NOTE: intentional exhaustive stub — MapTab only uses listNearbyUsers from
// map.ts; the sentinel path skips the nearby-users effect entirely, but
// mocking avoids real network calls if the effect ever does run.
jest.mock('../../services/map.ts', () => ({
  listNearbyUsers: jest.fn(() => Promise.resolve([])),
}));

// NOTE: intentional exhaustive stub — useHighlightRingState is only called
// inside NearbyUserChip, which is never rendered when nearbyUsers is empty
// (the sentinel path returns before the nearby strip renders).
jest.mock('../../hooks/useHighlightRingState.ts', () => ({
  useHighlightRingState: jest.fn(() => null),
}));

// ── Component under test ──────────────────────────────────────────────────────

import { MapTab } from '../MapTab';
import type { MapTabProps } from '../MapTab';

// ── Shared props ──────────────────────────────────────────────────────────────

// Typed rather than `as const`: `as const` made `postcards` a `readonly []`,
// which is not assignable to MapTabProps' `PassportPostcard[]`.
const BASE_PROPS: Omit<MapTabProps, 'sentinel'> = {
  postcards: [],
  currentCity: null,
  currentUserId: null,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MapTab sentinel states', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── private ─────────────────────────────────────────────────────────────────

  describe('sentinel="private"', () => {
    it('shows the "Private passport" title', async () => {
      await act(async () => {
        render(<MapTab {...BASE_PROPS} sentinel="private" />);
      });
      expect(screen.getByText('Private passport')).toBeTruthy();
    });

    it('shows the private body copy', async () => {
      await act(async () => {
        render(<MapTab {...BASE_PROPS} sentinel="private" />);
      });
      expect(
        screen.getByText(
          'This passport is private. Follow this traveler to see their travel map.',
        ),
      ).toBeTruthy();
    });

    it('does NOT render the map', async () => {
      await act(async () => {
        render(<MapTab {...BASE_PROPS} sentinel="private" />);
      });
      expect(screen.queryByTestId('maplibre-map')).toBeNull();
    });
  });

  // ── blocked ──────────────────────────────────────────────────────────────────

  describe('sentinel="blocked"', () => {
    it('shows the "Map unavailable" title', async () => {
      await act(async () => {
        render(<MapTab {...BASE_PROPS} sentinel="blocked" />);
      });
      expect(screen.getByText('Map unavailable')).toBeTruthy();
    });

    it('shows the blocked body copy', async () => {
      await act(async () => {
        render(<MapTab {...BASE_PROPS} sentinel="blocked" />);
      });
      expect(screen.getByText('Travel map content is not available.')).toBeTruthy();
    });

    it('does NOT render the map', async () => {
      await act(async () => {
        render(<MapTab {...BASE_PROPS} sentinel="blocked" />);
      });
      expect(screen.queryByTestId('maplibre-map')).toBeNull();
    });
  });

  // ── unavailable ───────────────────────────────────────────────────────────────

  describe('sentinel="unavailable"', () => {
    it('shows the "Account unavailable" title', async () => {
      await act(async () => {
        render(<MapTab {...BASE_PROPS} sentinel="unavailable" />);
      });
      expect(screen.getByText('Account unavailable')).toBeTruthy();
    });

    it('shows the unavailable body copy', async () => {
      await act(async () => {
        render(<MapTab {...BASE_PROPS} sentinel="unavailable" />);
      });
      expect(screen.getByText('This account is no longer available.')).toBeTruthy();
    });

    it('does NOT render the map', async () => {
      await act(async () => {
        render(<MapTab {...BASE_PROPS} sentinel="unavailable" />);
      });
      expect(screen.queryByTestId('maplibre-map')).toBeNull();
    });
  });

  // ── no sentinel — sanity check ────────────────────────────────────────────────

  it('renders the map (not a sentinel view) when no sentinel prop is given', async () => {
    await act(async () => {
      render(<MapTab {...BASE_PROPS} />);
    });
    // The maplibre Map stub renders testID="maplibre-map" when the map branch runs.
    expect(screen.getByTestId('maplibre-map')).toBeTruthy();
    // None of the sentinel titles should be present.
    expect(screen.queryByText('Private passport')).toBeNull();
    expect(screen.queryByText('Map unavailable')).toBeNull();
    expect(screen.queryByText('Account unavailable')).toBeNull();
  });
});
