/**
 * FullScreenMapScreen — back-navigation state restoration tests.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 *
 * ## What's covered
 *
 * 1. When the screen re-focuses with a stored selectedEntityId, the carousel
 *    ref's scrollToIndex is called with the correct stored carouselIndex and
 *    animated:false (instant snap, no spring).
 *
 * 2. The previewDetent from the store is respected — setPreviewDetent is NOT
 *    called with the default 'medium' value during the restoration path.
 *
 * 3. On first mount with an empty store (no selectedEntityId), the restoration
 *    path is skipped — scrollToIndex is not called with animated:false.
 *
 * 4. The entities effect, when selectedEntityId matches an entity in the list,
 *    selects that entity's index — setCarouselIndex is called with the matched
 *    index, not 0 (the default proximity fallback).
 *
 * ## Mock strategy
 *
 * MapCarousel is replaced with a spy-aware stand-in that exposes a
 * __scrollToIndex jest.fn() via jest.requireMock, wired to the forwarded ref
 * so tests can assert on scrollToIndex calls.
 *
 * useMapStore is replaced with a controllable factory backed by module-level
 * state that tests mutate in beforeEach — avoiding a real MapStoreProvider
 * while still exercising the restoration logic in FullScreenMapScreen.
 *
 * All heavy native dependencies (MapLibre, AskCompassBar, MapTopControls,
 * DiscoveryMapView) are stubbed so only the restoration flow is tested.
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import FullScreenMapScreen from '../index.tsx';

// ── expo-router ───────────────────────────────────────────────────────────────
// useFocusEffect fires synchronously (like useEffect) so we can assert on the
// restoration call without async timers.
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
// Exposes __scrollToIndex (a jest.fn()) via the mock module so tests can reach
// it through jest.requireMock. The forwarded ref is wired to the same fn so
// calls from useFocusEffect and the entities effect are captured.
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
// Module-level state that tests mutate in beforeEach. The factory reads state
// at call time (every render), so mutations between tests are always visible.
// MapStoreProvider is a transparent pass-through (FullScreenMapScreen wraps
// its children in it, but our controlled useMapStore bypasses the real store).
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
    overlays: [],
    camera: 'FOLLOW_USER',
    cameraTargetId: null,
    selection: null,
    navigation: null,
    timeOffsetMinutes: 0,
    capabilities: {
      CROWD_FLOW: false,
      LOCATE_FRIENDS: false,
      TIME_MACHINE: false,
    },
  },
  intent: null,
  timeOffset: { kind: 'now' },
};

jest.mock('../../../src/stores/mapStore', () => {
  const React = require('react');
  return {
    // Spread first so pure exports the screen imports (deriveMapCapabilities,
    // sameMapCapabilities) keep working; the provider/hook below still win.
    ...jest.requireActual('../../../src/stores/mapStore'),
    // Pass-through provider — the controlled useMapStore below drives the state.
    MapStoreProvider: ({ children }: { children: React.ReactNode }) => children,
    useMapStore: () => {
      // Inline require resolves the test-module variables at call time, not at
      // jest.mock hoist time, so mutations in beforeEach are always visible.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('./backNavRestoration.component.test.tsx') as {
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

// Export so the inline require() inside the mapStore mock can reach them.
export { storeSnapshot, storeSetters };

// ── helpers ───────────────────────────────────────────────────────────────────

function resetAll() {
  jest.clearAllMocks();
  // Reset the scrollToIndex spy (it's inside the mock module).
  const { __scrollToIndex } = jest.requireMock('../../../src/components/map/MapCarousel') as {
    __scrollToIndex: jest.Mock;
  };
  __scrollToIndex.mockClear();
  // Reset store state to defaults.
  storeSnapshot.selectedEntityId = null;
  storeSnapshot.previewDetent    = 'medium';
  storeSnapshot.cameraCenter     = null;
  storeSnapshot.cameraZoom       = null;
  storeSnapshot.enabledLayers    = ['places', 'events'];
  storeSnapshot.carouselIndex    = 0;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FullScreenMapScreen — back-navigation state restoration', () => {
  beforeEach(resetAll);

  // ── Test 1: focus with stored selectedEntityId → scrollToIndex called ────────
  it('snaps carousel to the stored carouselIndex without animation on re-focus', async () => {
    storeSnapshot.selectedEntityId = 'event:bbb';
    storeSnapshot.carouselIndex    = 1;
    storeSnapshot.previewDetent    = 'full';

    const { __scrollToIndex } = jest.requireMock('../../../src/components/map/MapCarousel') as {
      __scrollToIndex: jest.Mock;
    };

    await render(<FullScreenMapScreen />);

    // useFocusEffect fires on mount (via useEffect in the test mock).
    // Must call scrollToIndex(1, false) — correct index, no animation.
    await waitFor(() => {
      expect(__scrollToIndex).toHaveBeenCalledWith(1, false);
    });
  });

  // ── Test 2: previewDetent is not reset to default during restoration ──────────
  it('does not call setPreviewDetent with the default medium value during restoration', async () => {
    storeSnapshot.selectedEntityId = 'event:ccc';
    storeSnapshot.carouselIndex    = 2;
    storeSnapshot.previewDetent    = 'full';

    await render(<FullScreenMapScreen />);

    // Allow effects to settle.
    await waitFor(() => {
      expect(storeSetters.setSelectedEntityId).toBeDefined(); // sanity
    });

    // No effect or initialization path must reset detent to the default 'medium'.
    const resetCalls = storeSetters.setPreviewDetent.mock.calls.filter(
      ([d]: [string]) => d === 'medium',
    );
    expect(resetCalls).toHaveLength(0);
  });

  // ── Test 3: first mount with empty store → no restoration scroll ─────────────
  it('does not call scrollToIndex with animated:false on first mount when selectedEntityId is null', async () => {
    storeSnapshot.selectedEntityId = null;
    storeSnapshot.carouselIndex    = 0;

    const { __scrollToIndex } = jest.requireMock('../../../src/components/map/MapCarousel') as {
      __scrollToIndex: jest.Mock;
    };

    await render(<FullScreenMapScreen />);

    await waitFor(() => {
      // Give time for effects to settle.
      expect(storeSetters.setCarouselIndex).toBeDefined(); // sanity
    });

    // scrollToIndex may be called from the entities effect (proximity path) but
    // must NOT be called with animated:false (the restoration-only signal).
    const noAnimCalls = __scrollToIndex.mock.calls.filter(
      ([_idx, animated]: [number, boolean | undefined]) => animated === false,
    );
    expect(noAnimCalls).toHaveLength(0);
  });

  // ── Test 4: entities effect uses stored entity index when selectedEntityId set
  it('sets carousel to the stored entity index (not 0) when selectedEntityId matches an entity', async () => {
    // selectedEntityId matches MOCK_ENTITIES[2] (index 2).
    storeSnapshot.selectedEntityId = 'event:ccc';
    storeSnapshot.carouselIndex    = 2;
    storeSnapshot.previewDetent    = 'medium';

    await render(<FullScreenMapScreen />);

    await waitFor(() => {
      // setCarouselIndex must have been called with 2 at some point (restoration).
      const restoredCalls = storeSetters.setCarouselIndex.mock.calls.filter(
        ([i]: [number]) => i === 2,
      );
      expect(restoredCalls.length).toBeGreaterThan(0);
    });

    // Must NOT have been called with 0 (the default proximity fallback), as that
    // would flash a wrong card before the restored entity appears.
    const resetCalls = storeSetters.setCarouselIndex.mock.calls.filter(
      ([i]: [number]) => i === 0,
    );
    expect(resetCalls).toHaveLength(0);
  });
});
