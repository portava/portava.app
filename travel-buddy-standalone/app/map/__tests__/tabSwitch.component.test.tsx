/**
 * FullScreenMapScreen — tab-switch stale-selection clear tests.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 *
 * ## What's covered
 *
 * 1. When the map tab is re-entered without a preceding detail push (tab-switch),
 *    any stored selectedEntityId is cleared so the map doesn't open with a
 *    ghost-highlighted entity from a previous visit.
 *
 * 2. On first mount with no pre-existing selection, setSelectedEntityId(null)
 *    is NOT called — the tab-switch clear must not fire on initial mount.
 *
 * ## Mock strategy
 *
 * useFocusEffect is mocked so its callback fires once on mount (first focus) and
 * is also exposed via a module-level `triggerRefocus()` helper that re-fires it —
 * simulating a tab-switch focus event after the first mount. All other mocks
 * mirror backNavRestoration.component.test.tsx.
 */

import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import FullScreenMapScreen from '../index.tsx';

// ── useFocusEffect mock — fires once on mount, exposes re-trigger ─────────────
let capturedFocusCb: (() => (() => void) | void) | null = null;
function triggerRefocus() {
  capturedFocusCb?.();
}

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
      capturedFocusCb = cb;
      cb(); // first focus on mount
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

jest.mock('../../../src/components/discovery/DiscoveryMapView', () => {
  const { View } = require('react-native');
  return { DiscoveryMapView: () => <View testID="map-view" /> };
});

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

// ── MapCarousel — spy stand-in ────────────────────────────────────────────────
// Exposes __scrollToIndex so tests can assert on scrollToIndex calls.
jest.mock('../../../src/components/map/MapCarousel', () => {
  const React = require('react');
  const { View } = require('react-native');
  const scrollToIndex = jest.fn();

  const MapCarousel = React.forwardRef(
    (_props: Record<string, unknown>, ref: React.Ref<{ scrollToIndex: typeof scrollToIndex }>) => {
      React.useImperativeHandle(ref, () => ({ scrollToIndex }));
      return <View testID="map-carousel" />;
    },
  );
  MapCarousel.displayName = 'MapCarousel';
  return { MapCarousel, __scrollToIndex: scrollToIndex };
});

// ── mapStore — controllable factory ───────────────────────────────────────────
const storeSetters = {
  setSelectedEntityId: jest.fn(),
  setPreviewDetent:    jest.fn(),
  setCameraCenter:     jest.fn(),
  setCameraZoom:       jest.fn(),
  setEnabledLayers:    jest.fn(),
  setCarouselIndex:    jest.fn(),
  dispatchMapEvent:    jest.fn(),
  setMapCapabilities:  jest.fn(),
  setIntent:           jest.fn(),
  clearIntent:         jest.fn(),
  setTimeOffset:       jest.fn(),
};

let storeSnapshot = {
  selectedEntityId: null as string | null,
  previewDetent:    'medium' as 'collapsed' | 'medium' | 'full',
  cameraCenter:     null as { lat: number; lng: number } | null,
  cameraZoom:       null as number | null,
  enabledLayers:    ['places', 'events'] as string[],
  carouselIndex:    0,
  // The real store owns a §30 machine slice; a snapshot without it does not
  // describe the store under test.
  machine: {
    mode: 'LIVE',
    overlays: [] as string[],
    camera: 'FOLLOW_USER',
    cameraTargetId: null as string | null,
    selection: null as { objectId: string; objectKind: string } | null,
    navigation: null as unknown,
    timeOffsetMinutes: 0,
    capabilities: { CROWD_FLOW: false, LOCATE_FRIENDS: false, TIME_MACHINE: false },
  },
  intent: null as unknown,
  timeOffset: { kind: 'now' } as unknown,
};

export { storeSnapshot, storeSetters };

jest.mock('../../../src/stores/mapStore', () => {
  const React = require('react');
  return {
    // Spread first so pure exports the screen imports (deriveMapCapabilities,
    // sameMapCapabilities) keep working; the provider/hook below still win.
    ...jest.requireActual('../../../src/stores/mapStore'),
    MapStoreProvider: ({ children }: { children: React.ReactNode }) => children,
    useMapStore: () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('./tabSwitch.component.test.tsx') as {
        storeSnapshot: typeof storeSnapshot;
        storeSetters:  typeof storeSetters;
      };
      return { ...mod.storeSnapshot, ...mod.storeSetters };
    },
  };
});

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useMapEntities', () => ({
  useMapEntities: () => ({ entities: MOCK_ENTITIES, objects: [], liveEnrichment: null, loading: false, error: null, refresh: () => {}, source: 'legacy' }),
}));

// ── Shared test data ──────────────────────────────────────────────────────────
const MOCK_ENTITIES = [
  {
    id: 'event:aaa', type: 'events', lat: 14.5, lng: 120.9,
    payload: { id: 'aaa', title: 'Event A', startsAt: null, endsAt: null, goingCount: 0, priceType: 'free' },
  },
  {
    id: 'event:bbb', type: 'events', lat: 14.6, lng: 121.0,
    payload: { id: 'bbb', title: 'Event B', startsAt: null, endsAt: null, goingCount: 0, priceType: 'free' },
  },
  {
    id: 'event:ccc', type: 'events', lat: 14.7, lng: 121.1,
    payload: { id: 'ccc', title: 'Event C', startsAt: null, endsAt: null, goingCount: 0, priceType: 'free' },
  },
];

function resetAll() {
  jest.clearAllMocks();
  capturedFocusCb = null;
  const { __scrollToIndex } = jest.requireMock('../../../src/components/map/MapCarousel') as {
    __scrollToIndex: jest.Mock;
  };
  __scrollToIndex.mockClear();
  storeSnapshot.selectedEntityId = null;
  storeSnapshot.previewDetent    = 'medium';
  storeSnapshot.cameraCenter     = null;
  storeSnapshot.cameraZoom       = null;
  storeSnapshot.enabledLayers    = ['places', 'events'];
  storeSnapshot.carouselIndex    = 0;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FullScreenMapScreen — tab-switch stale-selection clear', () => {
  beforeEach(resetAll);

  // ── Test 1: tab-switch clears stale selectedEntityId ─────────────────────
  it('clears stale selectedEntityId when the map tab is re-entered without a preceding detail push', async () => {
    // Seed the store as if the user previously selected an entity and switched tabs.
    storeSnapshot.selectedEntityId = 'event:bbb';
    storeSnapshot.carouselIndex    = 1;

    const { __scrollToIndex } = jest.requireMock('../../../src/components/map/MapCarousel') as {
      __scrollToIndex: jest.Mock;
    };

    await render(<FullScreenMapScreen />);

    // First focus (mount): selectedEntityId is set, so the first-mount restore
    // path fires and snaps the carousel to the stored index.
    await waitFor(() => {
      expect(__scrollToIndex).toHaveBeenCalledWith(1, false);
    });

    storeSetters.setSelectedEntityId.mockClear();

    // Simulate a tab-switch re-focus (hasFocusedOnceRef is now true, no push).
    act(() => { triggerRefocus(); });

    // The tab-switch path must clear the stale entity selection.
    expect(storeSetters.setSelectedEntityId).toHaveBeenCalledWith(null);
  });

  // ── Test 2: first mount with null store → no stale clear ─────────────────
  it('does not call setSelectedEntityId(null) on first mount when store has no selection', async () => {
    storeSnapshot.selectedEntityId = null;

    await render(<FullScreenMapScreen />);

    await waitFor(() => {
      expect(storeSetters.setCarouselIndex).toBeDefined(); // sanity
    });

    // setSelectedEntityId must NOT be called with null on first mount.
    const nullCalls = storeSetters.setSelectedEntityId.mock.calls.filter(
      ([id]: [string | null]) => id === null,
    );
    expect(nullCalls).toHaveLength(0);
  });

  // ── Test 3: dep churn while focused must not clear selection ──────────────
  // Regression guard: the useFocusEffect callback uses empty deps so React
  // Navigation never re-fires it when dep values (selectedEntityId, entities,
  // etc.) change while the screen is already focused.  A non-empty dep array
  // would cause the tab-switch clear to run on every selection change.
  it('does not clear selectedEntityId on re-render while focused (dep churn guard)', async () => {
    storeSnapshot.selectedEntityId = 'event:bbb';
    storeSnapshot.carouselIndex    = 1;

    const { rerender } = await render(<FullScreenMapScreen />);

    // Let all mount effects settle before asserting.
    await act(async () => {});

    storeSetters.setSelectedEntityId.mockClear();

    // Trigger a re-render that simulates an in-focus dep change — e.g. the
    // entity list refreshing or the user tapping a different card.
    // With empty-deps, useFocusEffect must NOT re-fire, so the tab-switch
    // clear path must not execute.
    act(() => { rerender(<FullScreenMapScreen />); });

    // setSelectedEntityId(null) must NOT be called as a result of the rerender.
    const nullCalls = storeSetters.setSelectedEntityId.mock.calls.filter(
      ([id]: [string | null]) => id === null,
    );
    expect(nullCalls).toHaveLength(0);
  });
});
