/**
 * Component tests for DestinationsTab — filter persistence across List/Map mode.
 *
 * Strategy: the active filter affects what destinations are visible.  We use two
 * fixture cities that each belong to only ONE content type:
 *   • Berlin  — trips only
 *   • Paris   — memories only
 *
 * With both cities present "All" mode shows 2 destinations.
 * "Trips" filter shows only Berlin (1/2 destination).
 * "Memories" filter shows only Paris (1/2 destination).
 *
 * Assertions target:
 *   1. The "N/total destination(s)" count text — it reads "1/2 destination" when
 *      a non-all filter is active and "2 destinations" when reset to all.
 *   2. City card / city name text — present for the filtered city, absent for the
 *      other.
 *   3. The map empty-overlay message — "No trips pins to show" vs
 *      "Couldn't place any pins" lets us distinguish 'trips' from 'all'.
 *
 * These signals would all fail if activeFilter reverted to 'all' on a mode switch.
 *
 * NOTE: render() must be awaited in this env (RNTL 14 + React 19 + jest-expo)
 * or screen stays unbound and every query throws "render not called".
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { DestinationsTab } from '../DestinationsTab';
import type { TripRow } from '../../../services/trips.ts';
import type { PassportMemory } from '../../../services/passportStamps.ts';

// ── MapLibre stub ──────────────────────────────────────────────────────────────
// Native map SDK — not available in the jest-expo JSDOM env.

jest.mock('@maplibre/maplibre-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MapView = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(View, { testID: 'map-view' }, children);
  const Camera = React.forwardRef((_props: unknown, _ref: unknown) =>
    React.createElement(View, { testID: 'map-camera' }),
  );
  Camera.displayName = 'Camera';
  const Marker = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(View, { testID: 'map-marker' }, children);
  return { __esModule: true, Map: MapView, Camera, Marker };
});

// ── Map style constant ─────────────────────────────────────────────────────────

jest.mock('../../../constants/mapStyle', () => ({
  ...jest.requireActual('../../../constants/mapStyle'),
  MAP_STYLE_URL: 'https://example.com/style.json',
}));

// NOTE: batchGeocodeCities makes live Supabase + external geocoding network
// calls that cannot run in the jest-expo JSDOM env — exhaustive stub required.
// Resolves to an empty Map so no pins are placed; this lets us assert on the
// map empty-overlay text which differs by active filter.
jest.mock('../../../services/cityGeocode', () => ({
  preloadGeocodeCache: jest.fn().mockResolvedValue(undefined),
  batchGeocodeCities: jest.fn().mockResolvedValue(new Map()),
}));

// NOTE: expo-router requires Expo native navigation modules unavailable in the
// jest-expo JSDOM env — exhaustive stub required.
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));

// ── Fixtures ───────────────────────────────────────────────────────────────────
// Berlin has only trips; Paris has only memories.
// "All" → 2 destinations | "Trips" → 1 (Berlin) | "Memories" → 1 (Paris).

function makeTrip(id: string, city: string): TripRow {
  return {
    id,
    ownerId: 'user-1',
    title: `Trip to ${city}`,
    destinationCity: city,
    destinationCountry: null,
    neighborhoods: [],
    startDate: '2024-03-01',
    endDate: '2024-03-07',
    status: 'planning',
    visibility: 'public',
    travelStyle: null,
    openToMeet: false,
    coverUrl: null,
    coverMediaType: null,
    progress: 0,
    tripType: null,
    timezone: null,
    destinationLat: null,
    destinationLng: null,
    destinationPlaceId: null,
    tripNotes: null,
    showOnProfile: true,
    showInDiscovery: true,
    allowFriendSuggestions: false,
    allowTripCrewInvites: false,
    allowJoinRequests: false,
    showExactDates: false,
    showDestinationCity: true,
    delayedPostingDefault: false,
    preciseLocationVisible: false,
    planEditPermission: null,
    // Required by TripRow. It was missing, and the redundant `as TripRow` on a
    // value already annotated `: TripRow` suppressed the missing-property error.
    showHeaderPublicly: false,
  };
}

function makeMemory(id: string, city: string): PassportMemory {
  return {
    id,
    userId: 'user-1',
    city,
    country: null,
    title: `Memory in ${city}`,
    description: null,
    mediaUrl: null,
    mediaType: null,
    visitedAt: '2024-01-15',
    createdAt: '2024-01-15T00:00:00Z',
  } as unknown as PassportMemory;
}

const trips = [makeTrip('t1', 'Berlin')];
const memories = [makeMemory('m1', 'Paris')];
const stamps: never[] = [];
const postcards: never[] = [];

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('DestinationsTab — filter persistence across List/Map mode switches', () => {
  /**
   * List → Map: selecting "Trips" before switching must keep Berlin visible
   * and the count at "1/2 destination" in Map mode (not "2 destinations").
   * The map empty overlay must also say "No trips pins to show" — not the
   * generic "Couldn't place any pins" that appears when filter is 'all'.
   */
  it('keeps the Trips filter active (count + empty overlay) when switching List → Map', async () => {
    await render(
      <DestinationsTab
        memories={memories}
        stamps={stamps}
        postcards={postcards}
        trips={trips}
      />,
    );

    // ── List mode, "All" selected — expect 2 destinations ──────────────────
    await waitFor(() => expect(screen.getByText('2 destinations')).toBeTruthy());
    expect(screen.getByText('Berlin')).toBeTruthy();
    expect(screen.getByText('Paris')).toBeTruthy();

    // ── Select "Trips" filter — count drops to 1/2, Paris disappears ───────
    const tripsChip = await waitFor(() => screen.getByText(/^Trips/));
    fireEvent.press(tripsChip);
    await waitFor(() => expect(screen.getByText('1/2 destination')).toBeTruthy());
    expect(screen.getByText('Berlin')).toBeTruthy();
    expect(screen.queryByText('Paris')).toBeNull();

    // ── Switch to Map mode ─────────────────────────────────────────────────
    fireEvent.press(screen.getByText('Map'));

    // Count must still be "1/2 destination" — not "2 destinations" (reset)
    await waitFor(() => expect(screen.getByText('1/2 destination')).toBeTruthy());

    // Empty overlay text must be filter-specific, not the generic "all" message.
    // batchGeocodeCities resolves to empty so no pins are placed.
    await waitFor(() =>
      expect(screen.getByText(/No trips pins to show/i)).toBeTruthy(),
    );
    expect(screen.queryByText(/Couldn't place any pins/i)).toBeNull();
  });

  /**
   * Map → List: selecting "Memories" while in Map mode must keep the filter
   * when switching back to List.  Paris must appear and Berlin must not.
   * The count must remain "1/2 destination" — not reset to "2 destinations".
   */
  it('keeps the Memories filter active (count + card visibility) when switching Map → List', async () => {
    await render(
      <DestinationsTab
        memories={memories}
        stamps={stamps}
        postcards={postcards}
        trips={trips}
      />,
    );

    // ── Switch to Map mode first ───────────────────────────────────────────
    fireEvent.press(screen.getByText('Map'));
    await waitFor(() => expect(screen.getByText('2 destinations')).toBeTruthy());

    // ── Select "Memories" filter in Map mode ───────────────────────────────
    const memoriesChip = await waitFor(() => screen.getByText(/^Memories/));
    fireEvent.press(memoriesChip);
    await waitFor(() => expect(screen.getByText('1/2 destination')).toBeTruthy());

    // Map shows "No memories pins to show" — proves filter is 'memories' not 'all'
    await waitFor(() =>
      expect(screen.getByText(/No memories pins to show/i)).toBeTruthy(),
    );

    // ── Switch back to List mode ───────────────────────────────────────────
    fireEvent.press(screen.getByText('List'));

    // Filter must NOT have reset: count stays at 1/2, Paris visible, Berlin gone
    await waitFor(() => expect(screen.getByText('1/2 destination')).toBeTruthy());
    expect(screen.getByText('Paris')).toBeTruthy();
    expect(screen.queryByText('Berlin')).toBeNull();
  });

  /**
   * Filter-chip reset: if "Trips" is the active filter and all trips are
   * removed, the Trips chip disappears (count=0) and the filter must fall
   * back to 'all' — not stay stuck on the now-hidden chip.
   *
   * Confirms:
   *   • The 'All' chip shows as active after the re-render.
   *   • The total destination count reflects all remaining destinations.
   *   • No ghost filter-empty state appears due to a stale filter value.
   */
  it('resets activeFilter to All when the selected chip becomes hidden after data removal', async () => {
    const { rerender } = await render(
      <DestinationsTab
        memories={memories}
        stamps={stamps}
        postcards={postcards}
        trips={trips}
      />,
    );

    // ── Select "Trips" — Berlin visible, 1/2 destination ───────────────────
    const tripsChip = await waitFor(() => screen.getByText(/^Trips/));
    fireEvent.press(tripsChip);
    await waitFor(() => expect(screen.getByText('1/2 destination')).toBeTruthy());
    expect(screen.getByText('Berlin')).toBeTruthy();
    expect(screen.queryByText('Paris')).toBeNull();

    // ── Remove all trips — Trips chip should vanish, filter resets to 'all' ─
    await rerender(
      <DestinationsTab
        memories={memories}
        stamps={stamps}
        postcards={postcards}
        trips={[]}
      />,
    );

    // Only Paris (memory) remains; count is "1 destination" (no filter suffix)
    await waitFor(() => expect(screen.getByText('1 destination')).toBeTruthy());

    // Paris is visible — not filtered out by a stale 'trips' value
    expect(screen.getByText('Paris')).toBeTruthy();

    // The Trips chip must be gone (count=0 → hidden)
    expect(screen.queryByText(/^Trips/)).toBeNull();

    // No ghost filter-empty message — 'all' is active so the list shows Paris
    expect(screen.queryByText(/No destinations with trips yet/i)).toBeNull();
  });

  /**
   * Full round-trip: List → Map → List.  Switching modes twice must not
   * accumulate resets — the filter stays at "Trips" across both switches.
   */
  it('keeps the Trips filter intact across a full List → Map → List round-trip', async () => {
    await render(
      <DestinationsTab
        memories={memories}
        stamps={stamps}
        postcards={postcards}
        trips={trips}
      />,
    );

    // Select "Trips" in List mode
    const tripsChip = await waitFor(() => screen.getByText(/^Trips/));
    fireEvent.press(tripsChip);
    await waitFor(() => expect(screen.getByText('1/2 destination')).toBeTruthy());

    // List → Map
    fireEvent.press(screen.getByText('Map'));
    await waitFor(() => expect(screen.getByText('1/2 destination')).toBeTruthy());

    // Map → List
    fireEvent.press(screen.getByText('List'));
    await waitFor(() => expect(screen.getByText('1/2 destination')).toBeTruthy());

    // Final assertion: only Berlin (trips) in the list, Paris excluded
    expect(screen.getByText('Berlin')).toBeTruthy();
    expect(screen.queryByText('Paris')).toBeNull();
  });
});
