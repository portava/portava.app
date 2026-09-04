/**
 * Component tests for DestinationsTab — camera-position memory across mode switches.
 *
 * Verifies that switching Map → List → Map restores the last known camera
 * center/zoom (via easeTo) instead of re-running the initial fitBounds.
 *
 * Strategy:
 *   1. Render with one geocoded city so the initial fitBounds fires.
 *   2. Simulate a user pan by firing onRegionDidChange on the MapView mock.
 *   3. Switch to List mode, then back to Map mode.
 *   4. Assert Camera.easeTo is called with the saved center+zoom, not with the
 *      original fitBounds coordinates.
 *
 * NOTE: render() must be awaited in this env (RNTL 14 + React 19 + jest-expo)
 * or screen stays unbound and every query throws "render not called".
 */

import React from 'react';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react-native';
import { DestinationsTab } from '../DestinationsTab';
import type { TripRow } from '../../../services/trips.ts';

// ── MapLibre mock ──────────────────────────────────────────────────────────────
// Captures the onRegionDidChange prop so tests can simulate user pan/zoom.
// Camera mock uses useImperativeHandle to attach easeTo/fitBounds spies to the
// forwarded ref — this mirrors what the real Camera does.

type RegionChangeEvent = { nativeEvent: { center: [number, number]; zoom: number } };

let fireRegionChange: ((e: RegionChangeEvent) => void) | null = null;
const mockEaseTo = jest.fn();
const mockFitBounds = jest.fn();

jest.mock('@maplibre/maplibre-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');

  const MapView = ({
    children,
    onRegionDidChange,
  }: {
    children?: React.ReactNode;
    onRegionDidChange?: (e: RegionChangeEvent) => void;
    [key: string]: unknown;
  }) => {
    // Expose the current handler so tests can simulate region changes.
    fireRegionChange = onRegionDidChange ?? null;
    return React.createElement(View, { testID: 'map-view' }, children);
  };

  const Camera = React.forwardRef((_props: unknown, ref: React.Ref<unknown>) => {
    // Attach spies to the ref that the component holds (cameraRef.current).
    React.useImperativeHandle(ref, () => ({
      easeTo: mockEaseTo,
      fitBounds: mockFitBounds,
    }));
    return React.createElement(View, { testID: 'map-camera' });
  });
  Camera.displayName = 'Camera';

  const Marker = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(View, { testID: 'map-marker' }, children);

  return { __esModule: true, Map: MapView, Camera, Marker };
});

// ── Map style constant ─────────────────────────────────────────────────────────

// NOTE: exhaustive stub — the module only exports MAP_STYLE_URL; keeping it
// minimal avoids pulling in native map dependencies unavailable in jest-expo.
jest.mock('../../../constants/mapStyle', () => ({
  MAP_STYLE_URL: 'https://example.com/style.json',
}));

// ── Geocoding — returns real coords so the initial camera fit actually runs ────
// Rome → [41.9, 12.5] (lat, lng)  →  Camera.easeTo receives center [12.5, 41.9]

// NOTE: exhaustive stub — batchGeocodeCities makes live Supabase + external
// geocoding network calls that cannot run in the jest-expo JSDOM env. We
// resolve to a known coordinate so the camera fit effect actually fires.
jest.mock('../../../services/cityGeocode', () => ({
  preloadGeocodeCache: jest.fn().mockResolvedValue(undefined),
  batchGeocodeCities: jest.fn().mockResolvedValue(
    new Map([['rome|italy', [41.9, 12.5]]]),
  ),
}));

// ── expo-router stub ───────────────────────────────────────────────────────────

// NOTE: exhaustive stub — expo-router requires Expo native navigation modules
// unavailable in the jest-expo JSDOM env; only router.push is exercised here.
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeTrip(id: string, city: string, country: string): TripRow {
  return {
    id,
    ownerId: 'user-1',
    title: `Trip to ${city}`,
    destinationCity: city,
    destinationCountry: country,
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

const trips = [makeTrip('t1', 'Rome', 'Italy')];

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('DestinationsTab — camera position memory across Map / List switches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fireRegionChange = null;
  });

  /**
   * Core scenario: the camera's last known position is restored when the user
   * returns to Map mode after visiting List mode.
   *
   * Flow:
   *   1. Open Map mode  → geocoding resolves → easeTo fires (single pin)
   *   2. Simulate user pan to [5.0, 48.0] at zoom 7
   *   3. Switch to List
   *   4. Switch back to Map  → easeTo must be called with [5.0, 48.0] / zoom 7
   *      (NOT a new fitBounds call)
   */
  it('restores saved center+zoom via easeTo when returning from List to Map', async () => {
    await render(
      <DestinationsTab
        memories={[]}
        stamps={[]}
        postcards={[]}
        trips={trips}
      />,
    );

    // Switch to Map mode — findByText waits for the toggle header to appear
    // (FlatList ListHeaderComponent may not be in the tree before first flush).
    fireEvent.press(await screen.findByText('Map'));

    // Wait for geocoding to resolve and initial camera fit to fire.
    await waitFor(() => expect(mockEaseTo).toHaveBeenCalledTimes(1));

    const savedCenter: [number, number] = [5.0, 48.0];
    const savedZoom = 7;

    // Simulate the user panning/zooming: MapView fires onRegionDidChange.
    await act(async () => {
      fireRegionChange?.({
        nativeEvent: { center: savedCenter, zoom: savedZoom },
      });
    });

    // NOTE: Each press is wrapped in act() so React flushes the useEffect for
    // that viewMode change before the next press fires.  Without the flush,
    // React 18 batches both presses and prevViewModeRef never transitions
    // through 'list', so wasInList is always false and the restore is skipped.

    // Switch to List mode (camera unmounts) — flush effects.
    await act(async () => { fireEvent.press(screen.getByText('List')); });

    // Switch back to Map mode — flush effects.
    await act(async () => { fireEvent.press(screen.getByText('Map')); });

    // The component must restore via easeTo with the saved position.
    await waitFor(() => {
      const calls = mockEaseTo.mock.calls;
      const restoreCall = calls.find(
        ([args]) =>
          Array.isArray(args.center) &&
          args.center[0] === savedCenter[0] &&
          args.center[1] === savedCenter[1] &&
          args.zoom === savedZoom &&
          args.duration === 300,
      );
      expect(restoreCall).toBeDefined();
    });

    // fitBounds must not have been called — restoration uses easeTo, not fitBounds.
    expect(mockFitBounds).not.toHaveBeenCalled();
  });

  /**
   * Sanity check: without a prior region change the camera position ref is null,
   * so switching Map → List → Map falls through to the normal fit path (easeTo
   * for a single pin) — not a restore.
   *
   * This confirms the guard only fires when the user has actually panned.
   */
  it('runs the normal camera fit (not a restore) when the user never panned', async () => {
    await render(
      <DestinationsTab
        memories={[]}
        stamps={[]}
        postcards={[]}
        trips={trips}
      />,
    );

    // Map mode — geocoding resolves — single-pin easeTo fires.
    // findByText waits for the toggle header (inside FlatList ListHeaderComponent)
    // to appear in the tree after the initial render flush.
    fireEvent.press(await screen.findByText('Map'));
    await waitFor(() => expect(mockEaseTo).toHaveBeenCalledTimes(1));

    const firstCallArgs = mockEaseTo.mock.calls[0][0];
    mockEaseTo.mockClear();

    // Switch to List and back without any onRegionDidChange in between.
    // Each press is wrapped in act() to flush useEffect between mode changes
    // so prevViewModeRef correctly tracks the 'list' intermediate state.
    await act(async () => { fireEvent.press(screen.getByText('List')); });
    await act(async () => { fireEvent.press(screen.getByText('Map')); });

    // The normal fit runs again (no saved camera)
    await waitFor(() => expect(mockEaseTo).toHaveBeenCalledTimes(1));
    // And it used the geocoded coords, not a duration=300 restore
    expect(mockEaseTo.mock.calls[0][0]).toMatchObject({
      center: firstCallArgs.center,
      zoom: firstCallArgs.zoom,
    });
    expect(mockEaseTo.mock.calls[0][0].duration).not.toBe(300);
  });
});
