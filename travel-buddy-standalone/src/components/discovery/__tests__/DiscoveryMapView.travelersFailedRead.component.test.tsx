/**
 * census-discovery §112 (DV-83 round 15, lane W11-X2, D-W11X2-127): the Discovery map never says "No travelers
 * sharing here yet" over a failed travelers read, and never shows kept travelers as fresh after a failed refresh.
 *
 *   TV1  a failed read, layer on → "Couldn't load travelers", never "No travelers sharing here yet" (toggled or not)
 *   TV2  a failed refresh with rows kept → the count says the refresh failed
 *   TVc  CONTROL: a healthy empty read, layer toggled on → "No travelers sharing here yet"; healthy rows → the count alone
 *
 * The mocks are DiscoveryMapView.emptyState's, with the travelers hook made controllable.
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

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
const mockTravelers = jest.fn();
jest.mock('../../../hooks/useMapTravelers', () => ({
  useMapTravelers: () => mockTravelers(),
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

const noop = () => {};
const T = (id: string) => ({ id, lat: 48.85, lng: 2.35, displayName: id, avatarUrl: null });
const view = () => <DiscoveryMapView places={[]} onSelectPlace={noop} fallbackLat={48.8566} fallbackLng={2.3522} fallbackZoom={11} />;
const toggleOn = async () => {
  await act(async () => { fireEvent.press(screen.getByLabelText('Hide travelers on map')); });
  await act(async () => { fireEvent.press(screen.getByLabelText('Show travelers on map')); });
};

describe('DiscoveryMapView — the travelers layer over a failed read (§112, D-W11X2-127)', () => {
  it("TV1 a failed read → \"Couldn't load travelers\", never \"No travelers sharing here yet\"", async () => {
    mockTravelers.mockReturnValue({ travelers: [], loading: false, error: 'Request failed (503)', refresh: noop });
    await render(view());
    expect(screen.getByText("Couldn't load travelers")).toBeTruthy();
    await toggleOn();
    expect(screen.queryByText('No travelers sharing here yet')).toBeNull();
    expect(screen.getByText("Couldn't load travelers")).toBeTruthy();
  });
  it('TV2 a failed refresh with rows kept → the count says the refresh failed', async () => {
    mockTravelers.mockReturnValue({ travelers: [T('a'), T('b')], loading: false, error: 'offline', refresh: noop });
    await render(view());
    expect(screen.getByText(/2 travelers.*couldn.t refresh/)).toBeTruthy();
  });
  it('TVc CONTROL: a healthy empty read says "No travelers sharing here yet" once toggled on; healthy rows show the count alone', async () => {
    mockTravelers.mockReturnValue({ travelers: [], loading: false, error: null, refresh: noop });
    await render(view());
    expect(screen.queryByText("Couldn't load travelers")).toBeNull();
    await toggleOn();
    expect(screen.getByText('No travelers sharing here yet')).toBeTruthy();
    mockTravelers.mockReturnValue({ travelers: [T('a')], loading: false, error: null, refresh: noop });
    await render(view());
    expect(screen.getByText('1 traveler')).toBeTruthy();
  });
});
