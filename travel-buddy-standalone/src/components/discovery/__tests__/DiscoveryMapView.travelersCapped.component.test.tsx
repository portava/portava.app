/**
 * census-discovery §113 (DV-83 round 16, lane W11-X2, D-W11X2-129): the Discovery map never says "No travelers
 * sharing here yet", and never shows a bare count, over a travelers layer the server cut (the round-15 verifier's B1).
 *
 *   TV3  a cut read with nobody in it → "Couldn't check every traveler here", never the empty hint (toggled or not)
 *   TV4  a cut read with rows → the count says only some are shown
 *   TV5  a cut read whose refresh failed → both are said beside the kept count
 *   TVc2 CONTROL: a whole read → the count alone, and the empty hint once toggled on over a whole empty read
 *
 * The mocks are DiscoveryMapView.travelersFailedRead's, with `truncated` added to the hook's answer.
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

describe('DiscoveryMapView — the travelers layer over a cut scan (§113, D-W11X2-129)', () => {
  it("TV3 a cut read with nobody in it → never \"No travelers sharing here yet\"", async () => {
    mockTravelers.mockReturnValue({ travelers: [], loading: false, error: null, truncated: true, refresh: noop });
    await render(view());
    expect(screen.getByText("Couldn't check every traveler here")).toBeTruthy();
    await toggleOn();
    expect(screen.queryByText('No travelers sharing here yet')).toBeNull();
    expect(screen.getByText("Couldn't check every traveler here")).toBeTruthy();
  });
  it('TV4 a cut read with rows → the count says only some are shown', async () => {
    mockTravelers.mockReturnValue({ travelers: [T('a'), T('b')], loading: false, error: null, truncated: true, refresh: noop });
    await render(view());
    expect(screen.getByText('2 travelers · showing some')).toBeTruthy();
  });
  it('TV5 a cut read whose refresh failed → both are said', async () => {
    mockTravelers.mockReturnValue({ travelers: [T('a')], loading: false, error: 'offline', truncated: true, refresh: noop });
    await render(view());
    expect(screen.getByText(/1 traveler · showing some.*couldn.t refresh/)).toBeTruthy();
  });
  it('TVc2 CONTROL: a whole read → the count alone; a whole empty read, toggled on → the empty hint', async () => {
    mockTravelers.mockReturnValue({ travelers: [T('a'), T('b')], loading: false, error: null, truncated: false, refresh: noop });
    await render(view());
    expect(screen.getByText('2 travelers')).toBeTruthy();
    mockTravelers.mockReturnValue({ travelers: [], loading: false, error: null, truncated: false, refresh: noop });
    await render(view());
    expect(screen.queryByText("Couldn't check every traveler here")).toBeNull();
    await toggleOn();
    expect(screen.getByText('No travelers sharing here yet')).toBeTruthy();
  });
});
