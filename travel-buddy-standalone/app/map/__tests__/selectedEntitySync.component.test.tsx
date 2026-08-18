/**
 * FullScreenMapScreen — the selected entity that reaches the map.
 *
 * ## What this covers that the component tests cannot
 *
 * DiscoveryMapView.selectedEntity.component.test.tsx proves a selected pin
 * renders differently once the id arrives. This file proves the id ARRIVES, and
 * that it tracks the card the user is actually looking at.
 *
 * mapStore is deliberately NOT mocked here — the real MapStoreProvider drives
 * it, so setSelectedEntityId genuinely updates state and flows back down. A
 * spy on the setter would pass against the unfixed screen: the setter already
 * fired on marker taps before this change, and the value still reached nothing.
 * What was missing is the value arriving at the map, so the assertion reads
 * what DiscoveryMapView actually receives and renders.
 *
 * ## Covered
 *
 *  1. The map opens with nothing selected — proximity selection moves the
 *     carousel but must not light up a pin.
 *  2. A carousel swipe updates the selected entity the map is given. Before
 *     this change only marker taps set it, so after a swipe the highlight
 *     stayed on the previously tapped pin while the card and camera moved on.
 *  3. Swiping again moves it, rather than latching on the first value.
 */
import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react-native';
import FullScreenMapScreen from '../index.tsx';

// ── expo-router ───────────────────────────────────────────────────────────────
// useFocusEffect fires synchronously (like useEffect) so mount settles without
// async timers.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router:               { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismiss: jest.fn() },
  useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
  usePathname:          () => '/',
  useSegments:          () => [],
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
  useNavigation: () => ({
    navigate:    jest.fn(),
    goBack:      jest.fn(),
    setOptions:  jest.fn(),
    addListener: (_e: unknown, _cb: unknown) => () => {},
  }),
  Link:     ({ children }: { children: React.ReactNode }) => children,
  Redirect: () => null,
  Stack:    { Screen: () => null },
  Tabs:     { Screen: () => null },
}));

// ── react-native-safe-area-context ────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/passportStamps', () => ({
  getPassportMap:    jest.fn().mockResolvedValue({ ok: false }),
  _setTestAuthToken: jest.fn(),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryPlaces: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState: {
      coords:           { lat: 14.5995, lng: 120.9842 },
      place:            { city: 'Manila', country: 'Philippines' },
      permissionStatus: 'granted',
    },
    resolvedLocation: {
      place:     { city: 'Manila', country: 'Philippines' },
      coords:    { lat: 14.5995, lng: 120.9842 },
      source:    'home',
      freshness: 'live',
    },
    requireLocation: jest.fn(),
  }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/map/MapFilterSheet', () => ({
  MapFilterSheet:    () => null,
  loadEnabledLayers: jest.fn().mockResolvedValue([]),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/map/MapTopControls', () => ({
  MapTopControls: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/map/AskCompassBar', () => ({
  AskCompassBar: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/countryCentroids', () => ({
  COUNTRY_CENTROIDS: {},
}));

// ── DiscoveryMapView — renders the selectedEntityId it is given ───────────────
// The real component pulls native MapLibre. This stand-in is NOT a spy: it
// writes the received prop into the tree, so the assertions below read rendered
// output rather than recorded call arguments. Pre-fix the prop did not exist
// and this would render 'none' forever.
jest.mock('../../../src/components/discovery/DiscoveryMapView', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  return {
    DiscoveryMapView: (props: { selectedEntityId?: string | null }) => (
      <View testID="map-view">
        <Text testID="map-selected-entity">{props.selectedEntityId ?? 'none'}</Text>
      </View>
    ),
  };
});

// ── MapCarousel — exposes onIndexChange so a swipe can be simulated ───────────
// The real carousel calls onIndexChange from onMomentumScrollEnd. Reaching that
// through a FlatList scroll event under jest would test react-native's scroll
// maths, not this screen's wiring, so the handler is invoked directly.
jest.mock('../../../src/components/map/MapCarousel', () => {
  const React = require('react');
  const { View } = require('react-native');
  const holder: { onIndexChange?: (i: number) => void } = {};

  const MapCarousel = React.forwardRef(
    (props: { onIndexChange?: (i: number) => void }, ref: React.Ref<unknown>) => {
      holder.onIndexChange = props.onIndexChange;
      React.useImperativeHandle(ref, () => ({ scrollToIndex: jest.fn() }));
      return <View testID="map-carousel" />;
    },
  );
  MapCarousel.displayName = 'MapCarousel';
  return { MapCarousel, __holder: holder };
});

// NOTE: intentional stub — supplies a fixed entity list so index → id is known.
jest.mock('../../../src/hooks/useMapEntities', () => ({
  useMapEntities: () => ({ entities: MOCK_ENTITIES }),
}));

// ── Shared test data ──────────────────────────────────────────────────────────

const MOCK_ENTITIES = [
  { id: 'event:aaa', type: 'events', lat: 14.5, lng: 120.9, payload: {} },
  { id: 'gem:bbb',   type: 'gems',   lat: 14.6, lng: 121.0, payload: {} },
  { id: 'trip:ccc',  type: 'trips',  lat: 14.7, lng: 121.1, payload: {} },
];

/** Invokes the carousel's real onIndexChange, as a settled swipe would. */
async function swipeTo(index: number) {
  const { __holder } = jest.requireMock('../../../src/components/map/MapCarousel') as {
    __holder: { onIndexChange?: (i: number) => void };
  };
  expect(typeof __holder.onIndexChange).toBe('function');
  await act(async () => {
    __holder.onIndexChange!(index);
  });
}

function selectedOnMap(): string {
  return screen.getByTestId('map-selected-entity').props.children as string;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FullScreenMapScreen — selectedEntityId reaches the map', () => {
  it('passes the prop to DiscoveryMapView at all', async () => {
    // Pre-fix the screen passed no selectedEntityId and the map had no such
    // prop, so nothing on the map could know what was selected.
    await render(<FullScreenMapScreen />);
    await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());

    expect(screen.getByTestId('map-selected-entity')).toBeTruthy();
  });

  it('opens with nothing selected', async () => {
    // The entities effect picks a proximity-nearest carousel index on mount,
    // but that is not a user selection — the map must open with no lit pin.
    // This is the state the tab-switch handler restores when it clears the id.
    await render(<FullScreenMapScreen />);
    await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());

    expect(selectedOnMap()).toBe('none');
  });
});

describe('FullScreenMapScreen — a carousel swipe moves the selection', () => {
  it('gives the map the entity whose card the user swiped to', async () => {
    // The companion defect: only marker taps set selectedEntityId, so after a
    // swipe the highlight stayed on the previously TAPPED pin while the card
    // and camera moved on. mapStore documents the field as "which entity
    // marker / carousel card is active" — a swipe is a card becoming active.
    await render(<FullScreenMapScreen />);
    await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());

    await swipeTo(1);

    expect(selectedOnMap()).toBe('gem:bbb');
  });

  it('moves the selection again on a second swipe rather than latching', async () => {
    await render(<FullScreenMapScreen />);
    await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());

    await swipeTo(1);
    expect(selectedOnMap()).toBe('gem:bbb');

    await swipeTo(2);
    expect(selectedOnMap()).toBe('trip:ccc');
  });

  it('leaves the selection alone when the swipe index has no entity', async () => {
    // handleCarouselIndexChange returns early on a missing entity; it must not
    // write undefined into the store and blank a valid highlight.
    await render(<FullScreenMapScreen />);
    await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());

    await swipeTo(1);
    expect(selectedOnMap()).toBe('gem:bbb');

    await swipeTo(99); // out of range
    expect(selectedOnMap()).toBe('gem:bbb');
  });
});
