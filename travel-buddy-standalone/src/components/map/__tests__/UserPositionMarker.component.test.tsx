/**
 * §6 "blue dot = current user" — the marker itself (census-map M43).
 *
 * ## What M43 asks for
 *
 * "A component test mounts the real map canvas with a viewer position and finds
 * a user-position node in the tree." That is TWO claims, and they fail for
 * different reasons, so they are proved in two files:
 *
 *   - THIS file proves the node exists and draws the right thing for the right
 *     inputs — including that it is NOT gated on anything but the position.
 *   - `DiscoveryMapView.userPosition.component.test.tsx` proves the canvas
 *     mounts it, including with `entities.length === 0`.
 *
 * ## Anti-vacuity
 *
 * "Finds a user-position node" is satisfiable by a component that renders a
 * `<View>` for every input, so every positive assertion here is paired with the
 * input that must NOT draw: no position, the null island, an out-of-range
 * coordinate, `visible={false}`. A marker that always draws fails those.
 *
 * ## Why the props are recorded rather than trusted
 *
 * The shared jest stub for `@maplibre/maplibre-react-native` renders
 * `Marker` as a childless `<View />`, so a testID INSIDE a Marker is invisible
 * to `screen` under the global mock and every assertion below would pass
 * vacuously — against nothing. The local mock passes children through and
 * records the coordinate each Marker was handed, which is the part that has to
 * be right: a dot in the wrong hemisphere is worse than no dot.
 *
 * Run: pnpm --filter travel-buddy-standalone test:component
 *   or: npx jest --forceExit src/components/map/__tests__/UserPositionMarker.component.test.tsx
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import {
  UserPositionMarker,
  USER_POSITION_COLOR,
  USER_POSITION_DOT_TEST_ID,
  USER_POSITION_TEST_ID,
  hasViewerPosition,
} from '../UserPositionMarker.tsx';

type MarkerRender = { lngLat: unknown };
const markers: MarkerRender[] = [];
const pucks: { visible: unknown }[] = [];

// NOTE: intentional stub — @maplibre/maplibre-react-native needs native GL
// modules jest-expo does not provide, so requireActual crashes the suite. This
// factory is exhaustive on purpose and differs from the shared stub in the one
// way that matters here: it RENDERS Marker's children and RECORDS the
// coordinate, which is the measurement. The shared stub drops both, so every
// assertion in this file would pass against an empty tree.
jest.mock('@maplibre/maplibre-react-native', () => {
  const RN = jest.requireActual('react-native');
  const React_ = jest.requireActual('react');
  return {
    Marker: (props: { lngLat: unknown; children?: unknown }) => {
      markers.push({ lngLat: props.lngLat });
      return React_.createElement(RN.View, { testID: 'maplibre-marker' }, props.children);
    },
    UserLocation: (props: { visible?: unknown; testID?: string }) => {
      pucks.push({ visible: props.visible });
      return React_.createElement(RN.View, { testID: props.testID ?? 'maplibre-user-location' });
    },
  };
});

/** Da Nang — the fixture city used across the map suites. */
const LAT = 16.0544;
const LNG = 108.2022;

beforeEach(() => {
  markers.length = 0;
  pucks.length = 0;
});

describe('§6 blue dot — the node is present', () => {
  it('draws a user-position node when the viewer position is known', async () => {
    await render(<UserPositionMarker lat={LAT} lng={LNG} />);
    expect(screen.getByTestId(USER_POSITION_TEST_ID)).toBeTruthy();
  });

  it('places it at the viewer coordinate, in [lng, lat] order', async () => {
    // The ordering is the bug this assertion exists for: MapLibre takes
    // [lng, lat] and every human-facing surface in this app says "lat, lng".
    // Swapping them puts Da Nang in Kazakhstan and still renders a blue dot.
    await render(<UserPositionMarker lat={LAT} lng={LNG} />);
    expect(markers).toHaveLength(1);
    expect(markers[0].lngLat).toEqual([LNG, LAT]);
  });

  it('draws the §6 blue, from the one exported source', async () => {
    await render(<UserPositionMarker lat={LAT} lng={LNG} />);
    // The inner dot is the blue; the wrapper is the halo.
    const dot = screen.getByTestId(USER_POSITION_DOT_TEST_ID);
    const raw: unknown = dot.props.style;
    const style: unknown[] = Array.isArray(raw) ? raw : [raw];
    const flat: Record<string, unknown> = Object.assign(
      {},
      ...style.map((x) => (x && typeof x === 'object' ? x : {})),
    );
    expect(flat.backgroundColor).toBe(USER_POSITION_COLOR);
  });

  it('is announced to assistive technology', async () => {
    await render(<UserPositionMarker lat={LAT} lng={LNG} />);
    expect(screen.getByLabelText('Your position')).toBeTruthy();
  });
});

describe('§6 blue dot — the inputs that must NOT draw', () => {
  it('renders nothing with no position at all', async () => {
    await render(<UserPositionMarker />);
    expect(screen.queryByTestId(USER_POSITION_TEST_ID)).toBeNull();
    expect(markers).toHaveLength(0);
  });

  it('renders nothing for a null position', async () => {
    await render(<UserPositionMarker lat={null} lng={null} />);
    expect(screen.queryByTestId(USER_POSITION_TEST_ID)).toBeNull();
  });

  it('refuses the null island rather than drawing the viewer off Ghana', async () => {
    // 0,0 is what a missing fix degrades to in every numeric path in this app,
    // and it is also a real coordinate. Drawing it is a confident lie.
    await render(<UserPositionMarker lat={0} lng={0} />);
    expect(screen.queryByTestId(USER_POSITION_TEST_ID)).toBeNull();
  });

  it('refuses an out-of-range coordinate', async () => {
    await render(<UserPositionMarker lat={91} lng={LNG} />);
    expect(screen.queryByTestId(USER_POSITION_TEST_ID)).toBeNull();
    await render(<UserPositionMarker lat={LAT} lng={181} />);
    expect(screen.queryByTestId(USER_POSITION_TEST_ID)).toBeNull();
  });

  it('refuses NaN, which is what a failed parse produces', async () => {
    await render(<UserPositionMarker lat={Number.NaN} lng={LNG} />);
    expect(screen.queryByTestId(USER_POSITION_TEST_ID)).toBeNull();
  });

  it('honours visible={false}', async () => {
    await render(<UserPositionMarker lat={LAT} lng={LNG} visible={false} />);
    expect(screen.queryByTestId(USER_POSITION_TEST_ID)).toBeNull();
  });
});

describe('§6 blue dot — the SDK puck arm', () => {
  it('uses the SDK user-location puck when the platform owns the fix', async () => {
    await render(<UserPositionMarker followDeviceFix />);
    expect(pucks).toHaveLength(1);
    expect(screen.getByTestId(USER_POSITION_TEST_ID)).toBeTruthy();
  });

  it('never draws the puck AND a static dot — two blue dots read as two people', async () => {
    await render(<UserPositionMarker lat={LAT} lng={LNG} followDeviceFix />);
    expect(pucks).toHaveLength(1);
    expect(markers).toHaveLength(0);
  });

  it('draws the static dot, not the puck, when the screen supplied the fix', async () => {
    // The default matters: the puck draws where the PLATFORM thinks the device
    // is. A screen reasoning about a cached or fallback position must see THAT
    // point, or the dot and the camera disagree.
    await render(<UserPositionMarker lat={LAT} lng={LNG} />);
    expect(pucks).toHaveLength(0);
    expect(markers).toHaveLength(1);
  });
});

describe('hasViewerPosition — the gate, directly', () => {
  it('accepts a real coordinate and rejects every degenerate one', async () => {
    expect(hasViewerPosition(LAT, LNG)).toBe(true);
    expect(hasViewerPosition(-33.86, 151.21)).toBe(true);
    expect(hasViewerPosition(0, 0)).toBe(false);
    expect(hasViewerPosition(null, null)).toBe(false);
    expect(hasViewerPosition(undefined, undefined)).toBe(false);
    expect(hasViewerPosition(Number.NaN, 1)).toBe(false);
    expect(hasViewerPosition(Number.POSITIVE_INFINITY, 1)).toBe(false);
    expect(hasViewerPosition(-91, 0)).toBe(false);
    expect(hasViewerPosition(0, 181)).toBe(false);
    // A zero on ONE axis is legitimate — the equator and the prime meridian
    // are real lines. Only the intersection is the sentinel.
    expect(hasViewerPosition(0, LNG)).toBe(true);
    expect(hasViewerPosition(LAT, 0)).toBe(true);
  });
});
