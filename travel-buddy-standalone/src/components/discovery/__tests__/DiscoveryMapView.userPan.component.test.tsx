/**
 * DiscoveryMapView — a USER gesture reports onUserPan; a programmatic move does not.
 *
 * ## Why this gate matters (spec §30, machine D4)
 *
 * onUserPan is how the shell learns to hand the camera to the state machine
 * (FREE_EXPLORE). onRegionDidChange fires for BOTH a user drag and every
 * programmatic camera move the shell makes — Recenter's easeTo, a carousel
 * swipe, a FOCUS_OBJECT snap. If a programmatic move reported a pan, the camera
 * would drop to FREE_EXPLORE the instant the shell tried to frame something,
 * yanking the viewport back out from under it. So onUserPan is gated on the
 * SDK's `userInteraction` flag, and this suite pins both halves of that gate.
 *
 * The Map mock parks onRegionDidChange in a holder so the handler can be fired
 * with a MapLibre-shaped event directly — the same pattern as
 * DiscoveryMapView.camera.component.test.tsx.
 */
import React from 'react';
import { render, screen, act } from '@testing-library/react-native';

// MapLibre native modules are unavailable under jest. `Map` parks its props so
// onRegionDidChange can be fired directly.
jest.mock('@maplibre/maplibre-react-native', () => {
  const RN = jest.requireActual('react-native');
  const holder: { onRegionDidChange?: (e: unknown) => void } = {};
  const Map = (props: { children?: React.ReactNode; onRegionDidChange?: (e: unknown) => void }) => {
    holder.onRegionDidChange = props.onRegionDidChange;
    return <RN.View testID="map-container">{props.children}</RN.View>;
  };
  const Camera = (_props: unknown) => <RN.View testID="map-camera" />;
  const Marker = ({ children }: { children?: React.ReactNode }) => (
    <RN.View testID="map-marker">{children}</RN.View>
  );
  return { Map, Camera, Marker, __holder: holder };
});

// NOTE: intentionally exhaustive — the real hook pulls Supabase and geolocation
// native modules unavailable under jest; a requireActual spread would crash
// before any test runs.
jest.mock('../../../hooks/useMapTravelers', () => ({
  useMapTravelers: () => ({ travelers: [], loading: false }),
}));
// NOTE: intentionally exhaustive — TravelerClusterMarkers depends on native
// MapLibre marker internals unavailable in the jest-expo runner.
jest.mock('../TravelerMapLayer', () => ({ TravelerClusterMarkers: () => null }));
// NOTE: intentionally exhaustive — TravelerPreviewCard imports native components
// not safe under jest.
jest.mock('../TravelerPreviewCard', () => ({ TravelerPreviewCard: () => null }));
// NOTE: intentionally exhaustive — discoverMapFilterStorage's module-level cache
// mutates across tests; controlled returns avoid ordering dependencies.
jest.mock('../discoverMapFilterStorage', () => ({
  loadMapFilter: jest.fn().mockResolvedValue('all'),
  saveMapFilter: jest.fn(),
  removeMapFilter: jest.fn(),
  getCachedFilter: jest.fn().mockReturnValue(null),
  FILTER_STORAGE_KEY: 'discovery_map_filter',
}));

import { DiscoveryMapView } from '../DiscoveryMapView';

const noop = () => {};
const AT: [number, number] = [14.5995, 120.9842];

function renderMap(onUserPan?: () => void) {
  return render(
    <DiscoveryMapView
      places={[]}
      onSelectPlace={noop}
      fallbackLat={AT[0]}
      fallbackLng={AT[1]}
      fallbackZoom={11}
      onUserPan={onUserPan}
    />,
  );
}

function fireRegion(event: Record<string, unknown>) {
  const { __holder } = jest.requireMock('@maplibre/maplibre-react-native') as {
    __holder: { onRegionDidChange?: (e: unknown) => void };
  };
  expect(typeof __holder.onRegionDidChange).toBe('function');
  return act(async () => {
    __holder.onRegionDidChange!({ nativeEvent: event });
  });
}

afterEach(() => jest.restoreAllMocks());

describe('DiscoveryMapView — onUserPan', () => {
  it('reports a pan when the region change was a user gesture', async () => {
    const pans: number[] = [];
    await renderMap(() => pans.push(1));
    expect(screen.getByTestId('map-container')).toBeTruthy();

    await fireRegion({ zoom: 15, center: [120.99, 14.6], userInteraction: true });

    expect(pans).toHaveLength(1);
  });

  it('does NOT report a pan for a programmatic (non-gesture) region change', async () => {
    // A Recenter / carousel / FOCUS_OBJECT easeTo also fires onRegionDidChange,
    // with userInteraction:false. Reporting it would fight the very framing the
    // shell just performed.
    const pans: number[] = [];
    await renderMap(() => pans.push(1));

    await fireRegion({ zoom: 15, center: [120.99, 14.6], userInteraction: false });

    expect(pans).toHaveLength(0);
  });

  it('treats a missing userInteraction flag as not-a-gesture (fail closed)', async () => {
    // MapLibre's payload is untyped at this boundary. Absent the flag, the safe
    // reading is "not a gesture": under-reporting a pan only costs a stale
    // FREE_EXPLORE hand-off, while over-reporting fights programmatic framing.
    const pans: number[] = [];
    await renderMap(() => pans.push(1));

    await fireRegion({ zoom: 15, center: [120.99, 14.6] });

    expect(pans).toHaveLength(0);
  });

  it('does not throw when no onUserPan is given', async () => {
    // ForYouTab / DiscoveryCategoryTab / LayoverMapCard pass none — the prop is
    // optional and those surfaces have no state machine.
    await renderMap();
    await fireRegion({ zoom: 15, center: [120.99, 14.6], userInteraction: true });
    expect(screen.getByTestId('map-container')).toBeTruthy();
  });
});
