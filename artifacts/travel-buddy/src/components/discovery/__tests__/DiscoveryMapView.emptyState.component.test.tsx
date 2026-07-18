/**
 * DiscoveryMapView — empty-state component tests.
 *
 * Covered:
 *  (a) places=[] with no fallback coords → shows "No location set" / "Pick a
 *      city" empty-state UI without crashing.
 *  (b) places=[] with valid fallbackLat/fallbackLng → Map stub renders without
 *      throwing (no non-finite coordinates reach the map layer).
 *
 * Heavy native dependencies (MapLibre, AsyncStorage, hooks) are stubbed so the
 * test exercises only the component's branching logic, not platform internals.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

// ── Module mocks (must be declared before any import that pulls the real module) ─

// MapLibre native modules are unavailable under jest; stub the whole package.
jest.mock('@maplibre/maplibre-react-native', () => {
  const RN = jest.requireActual('react-native');
  const Map = ({ children }: { children?: React.ReactNode }) => (
    <RN.View testID="map-container">{children}</RN.View>
  );
  const Camera = (_props: unknown) => <RN.View testID="map-camera" />;
  const Marker = ({ children }: { children?: React.ReactNode }) => (
    <RN.View testID="map-marker">{children}</RN.View>
  );
  return { Map, Camera, Marker };
});

// NOTE: intentionally exhaustive — the real hook pulls Supabase and geolocation
// native modules that are unavailable under jest; a requireActual spread would
// crash before any test runs.
jest.mock('../../../hooks/useMapTravelers', () => ({
  useMapTravelers: () => ({ travelers: [], loading: false }),
}));

// NOTE: intentionally exhaustive — TravelerClusterMarkers depends on native
// MapLibre marker internals; spreading requireActual would import native modules
// that are unavailable in the jest-expo JSDOM runner.
jest.mock('../TravelerMapLayer', () => ({
  TravelerClusterMarkers: () => null,
}));

// NOTE: intentionally exhaustive — TravelerPreviewCard imports native
// components that are not safe under jest; null stub keeps the test focused on
// the empty-state branching logic.
jest.mock('../TravelerPreviewCard', () => ({
  TravelerPreviewCard: () => null,
}));

// SectionErrorBoundary: transparent passthrough so children render normally.
jest.mock('../SectionErrorBoundary', () => {
  const RN = jest.requireActual('react-native');
  return {
    SectionErrorBoundary: ({ children }: { children?: React.ReactNode }) => (
      <RN.View>{children}</RN.View>
    ),
  };
});

// NOTE: intentionally exhaustive — discoverMapFilterStorage is a thin
// persistence module with no native deps, but its module-level memory cache
// mutates across tests; a full stub with controlled return values avoids
// ordering dependencies between test cases.
jest.mock('../discoverMapFilterStorage', () => ({
  loadMapFilter: jest.fn().mockResolvedValue('all'),
  saveMapFilter: jest.fn(),
  removeMapFilter: jest.fn(),
  getCachedFilter: jest.fn().mockReturnValue(null),
  FILTER_STORAGE_KEY: 'discovery_map_filter',
}));

// ── Import under test (after mocks) ──────────────────────────────────────────

import { DiscoveryMapView } from '../DiscoveryMapView';
import type { DiscoveryPlace } from '../../../services/discovery.ts';

// ── Shared test helpers ───────────────────────────────────────────────────────

const noop = () => {};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryMapView — empty-state rendering', () => {
  it('(a) shows the empty-state UI when places is empty and no fallback coords are provided', async () => {
    await render(
      <DiscoveryMapView
        places={[]}
        onSelectPlace={noop}
        // No userLat/userLng, no fallbackLat/fallbackLng → vp is null
      />,
    );

    // "No location set" heading must be visible.
    expect(screen.getByText('No location set')).toBeTruthy();

    // "Pick a city" body copy must be visible.
    expect(screen.getByText('Pick a city to see it on the map.')).toBeTruthy();

    // The live map container must NOT be rendered.
    expect(screen.queryByTestId('map-container')).toBeNull();
  });

  it('(b) renders the Map stub (not the empty state) when fallbackLat/fallbackLng are provided with an empty places list', async () => {
    await render(
      <DiscoveryMapView
        places={[]}
        onSelectPlace={noop}
        fallbackLat={48.8566}
        fallbackLng={2.3522}
        fallbackZoom={11}
      />,
    );

    // The live map container must be present — fallback coords supplied a
    // valid viewport so the empty-state branch was skipped.
    expect(screen.getByTestId('map-container')).toBeTruthy();

    // Empty-state text must NOT appear.
    expect(screen.queryByText('No location set')).toBeNull();
    expect(screen.queryByText('Pick a city to see it on the map.')).toBeNull();
  });

  it('(a-extra) empty-state also shows when places have no finite coordinates and no fallback', async () => {
    const badPlaces: DiscoveryPlace[] = [
      // lat/lng are null — these are not mappable
      { id: 'osm/1', name: 'Ghost Café', category: 'food', lat: null, lng: null } as unknown as DiscoveryPlace,
    ];

    await render(
      <DiscoveryMapView
        places={badPlaces}
        onSelectPlace={noop}
      />,
    );

    expect(screen.getByText('No location set')).toBeTruthy();
    expect(screen.getByText('Pick a city to see it on the map.')).toBeTruthy();
    expect(screen.queryByTestId('map-container')).toBeNull();
  });
});
