/**
 * FullScreenMapScreen — the §30 camera axis is driven by REAL shell wiring.
 *
 * ## What this suite exists to catch
 *
 * The map state machine (src/features/map/state/mapMachine.ts) models a camera
 * axis — USER_PANNED, RECENTER, FOCUS_OBJECT, START_NAVIGATION, END_NAVIGATION
 * — and its transitions are exhaustively unit-tested. But every one of those
 * events was dispatched ONLY from the machine's own tests: nothing in the shell
 * ever sent them, so FREE_EXPLORE and FOCUS_ROUTE were unreachable in the
 * running app. A user drag never freed the camera; Recenter moved the camera
 * without telling the machine control had returned; tapping Navigate never gave
 * the destination §5 precedence.
 *
 * ## Why a reducer spy, not a state read
 *
 * The shell does not expose the machine, so this suite wraps the REAL
 * `mapMachineReducer` and asserts the events the shell actually feeds it. The
 * reducer keeps its real behaviour (requireActual), so this proves both that
 * the event is dispatched AND that it is a well-formed event the machine acts
 * on rather than no-ops.
 */
import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import FullScreenMapScreen from '../index.tsx';
import { point, type MapObject } from '../../../src/types/mapObjects.ts';
import { mapObjectsToEntities } from '../../../src/types/mapTypes.ts';
import type { MapMachineEvent } from '../../../src/features/map/state/mapMachine.ts';

const EVENT: MapObject = {
  id: 'event:e1',
  kind: 'event',
  geometry: point(14.6, 120.98),
  title: 'Rooftop set',
  privacyClass: 'place_level',
  renderingPriority: 60,
  interaction: { actions: ['view', 'navigate', 'save'], detailRoute: '/event/e1', opensSheet: true },
};

const mockObjects = [EVENT];
const mockEntities = mapObjectsToEntities(mockObjects);

// Configurable route params so one test can drive the focusId snap.
const mockParams: { current: Record<string, string> } = { current: {} };

jest.mock('expo-router', () => {
  const React = require('react');
  return {
    router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), navigate: jest.fn(), dismiss: jest.fn() },
    useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => mockParams.current,
    usePathname: () => '/',
    useSegments: () => [],
    useFocusEffect: (cb: () => (() => void) | void) => {
      React.useEffect(() => {
        const cleanup = cb();
        return typeof cleanup === 'function' ? cleanup : undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
    },
    useNavigation: () => ({
      navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn(),
      addListener: () => () => {},
    }),
    Link: ({ children }: { children: React.ReactNode }) => children as any,
    Redirect: () => null,
    Stack: { Screen: () => null },
    Tabs: { Screen: () => null },
  };
});

// NOTE: intentional stub — not under test here.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// The REAL reducer, wrapped in a spy so the events the shell feeds the machine
// can be read. requireActual keeps every other export (createInitialMapMachineState,
// withCapabilities, resolveBack, DEFAULT_MAP_CAPABILITIES, …) real.
jest.mock('../../../src/features/map/state/mapMachine.ts', () => {
  const actual = jest.requireActual('../../../src/features/map/state/mapMachine.ts');
  return { ...actual, mapMachineReducer: jest.fn(actual.mapMachineReducer) };
});

// NOTE: intentional stub — network service, not under test here.
jest.mock('../../../src/services/passportStamps', () => ({
  getPassportMap: jest.fn().mockResolvedValue({ ok: false }),
  _setTestAuthToken: jest.fn(),
}));
// NOTE: intentional stub — network service, not under test here.
jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryPlaces: jest.fn().mockResolvedValue({ ok: false }),
}));
// NOTE: intentional stub — network service, not under test here.
jest.mock('../../../src/services/livePulse', () => ({
  getLivePulseItems: jest.fn().mockResolvedValue({ ok: true, items: [] }),
}));

// NOTE: exhaustive — the far end of `navigate`; requireActual would open a URL.
jest.mock('../../../src/lib/openInMaps', () => ({ openInMaps: jest.fn() }));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState: { coords: { lat: 14.6, lng: 120.98 }, place: null, permissionStatus: 'granted' },
    resolvedLocation: { place: null, coords: { lat: 14.6, lng: 120.98 }, source: 'home', freshness: 'live' },
    requireLocation: jest.fn(),
  }),
}));

// NOTE: intentional stub — sheet reads AsyncStorage at import; not under test.
jest.mock('../../../src/components/map/MapFilterSheet', () => ({
  MapFilterSheet: () => null,
  loadEnabledLayers: jest.fn().mockResolvedValue(['events']),
}));
// NOTE: intentional stub — sheet reads AsyncStorage at import; not under test.
jest.mock('../../../src/components/map/LayersSheet', () => ({
  LayersSheet: () => null,
  loadLayerPreferences: jest.fn().mockResolvedValue({}),
}));
// NOTE: intentional stub — bar not under test here.
jest.mock('../../../src/components/map/AskCompassBar', () => ({ AskCompassBar: () => null }));
// NOTE: intentional stub — sheet not under test here.
jest.mock('../../../src/components/map/LivePlaceSheet', () => ({ LivePlaceSheet: () => null }));
// NOTE: intentional stub — sheet not under test here.
jest.mock('../../../src/components/map/MapContributionSheet', () => ({ MapContributionSheet: () => null }));
// NOTE: intentional stub — sheet not under test here.
jest.mock('../../../src/components/ReportSheet', () => ({ ReportSheet: () => null }));
// NOTE: intentional stub — a static data table; not under test here.
jest.mock('../../../src/lib/countryCentroids', () => ({ COUNTRY_CENTROIDS: {} }));
// NOTE: intentional stub — picker not under test here.
jest.mock('../../../src/components/discovery/TripWishlistPicker', () => ({ TripWishlistPicker: () => null }));

// MapTopControls — exposes onRecenter so the Recenter dispatch can be delivered.
jest.mock('../../../src/components/map/MapTopControls', () => {
  const React = require('react');
  const { View } = require('react-native');
  const holder: { onRecenter?: () => void } = {};
  return {
    __holder: holder,
    MapTopControls: (props: { onRecenter?: () => void }) => {
      holder.onRecenter = props.onRecenter;
      return <View testID="map-top-controls" />;
    },
  };
});

// The §25 rail — exposes onAction so `navigate` can be delivered.
jest.mock('../../../src/components/map/MapBottomActions', () => {
  const React = require('react');
  const { View } = require('react-native');
  const actual = jest.requireActual('../../../src/components/map/MapBottomActions');
  const holder: { onAction?: (a: string, o: unknown) => void } = {};
  return {
    ...actual,
    __holder: holder,
    MapBottomActions: (props: { onAction?: (a: string, o: unknown) => void }) => {
      holder.onAction = props.onAction;
      return <View testID="map-bottom-actions" />;
    },
  };
});

// DiscoveryMapView — exposes onUserPan (pan dispatch) and onSelectEntity (to
// establish the selection the rail acts on).
jest.mock('../../../src/components/discovery/DiscoveryMapView', () => {
  const React = require('react');
  const { View } = require('react-native');
  const holder: { onUserPan?: () => void; onSelectEntity?: (e: unknown) => void } = {};
  return {
    __holder: holder,
    DiscoveryMapView: (props: { onUserPan?: () => void; onSelectEntity?: (e: unknown) => void }) => {
      holder.onUserPan = props.onUserPan;
      holder.onSelectEntity = props.onSelectEntity;
      return <View testID="map-view" />;
    },
  };
});

jest.mock('../../../src/components/map/MapCarousel', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MapCarousel = React.forwardRef((_p: unknown, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({ scrollToIndex: jest.fn() }));
    return <View testID="map-carousel" />;
  });
  MapCarousel.displayName = 'MapCarousel';
  return { MapCarousel };
});

// NOTE: exhaustive — the hook is the entity SOURCE; requireActual would fetch.
jest.mock('../../../src/hooks/useMapEntities', () => ({
  useMapEntities: () => ({
    entities: mockEntities, objects: mockObjects, liveEnrichment: null,
    loading: false, error: null, refresh: () => {}, source: 'gateway',
    stage: 'canonical', staleness: null,
  }),
}));

jest.mock('../../../src/features/map/telemetry/mapTelemetry', () => ({
  ...jest.requireActual('../../../src/features/map/telemetry/mapTelemetry'),
  emitMapEvent: jest.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function reducer() {
  return jest.requireMock('../../../src/features/map/state/mapMachine.ts').mapMachineReducer as jest.Mock;
}

/** Every machine event the shell has fed the reducer, in order. */
function events(): MapMachineEvent[] {
  return reducer().mock.calls.map((c: unknown[]) => c[1] as MapMachineEvent);
}

function sawEvent(type: string): MapMachineEvent[] {
  return events().filter((e) => e && e.type === type);
}

function mapMock() {
  return jest.requireMock('../../../src/components/discovery/DiscoveryMapView') as {
    __holder: { onUserPan?: () => void; onSelectEntity?: (e: unknown) => void };
  };
}
function topControlsMock() {
  return jest.requireMock('../../../src/components/map/MapTopControls') as {
    __holder: { onRecenter?: () => void };
  };
}
function bottomActionsMock() {
  return jest.requireMock('../../../src/components/map/MapBottomActions') as {
    __holder: { onAction?: (a: string, o: unknown) => void };
  };
}

async function mountScreen() {
  await render(<FullScreenMapScreen />);
  await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());
}

// Captured AppState 'change' listeners. AppState.addEventListener is mocked for
// the whole file (below) so it always returns a valid `{ remove }` subscription
// — jest-expo's own auto-mock returns undefined, which crashes the mount
// effect's cleanup (`sub.remove()`) — and so the navigation effect's listener
// can be invoked directly to simulate a return to the foreground.
const appStateChangeListeners: ((s: string) => void)[] = [];

beforeEach(() => {
  mockParams.current = {};
  reducer().mockClear();
  appStateChangeListeners.length = 0;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((type: string, cb: (s: string) => void) => {
    if (type === 'change') appStateChangeListeners.push(cb);
    return { remove: () => {} };
  }) as unknown as typeof AppState.addEventListener);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FullScreenMapScreen — §30 camera axis dispatch', () => {
  it('a user pan dispatches USER_PANNED', async () => {
    await mountScreen();
    await act(async () => { mapMock().__holder.onUserPan!(); });

    expect(sawEvent('USER_PANNED')).toHaveLength(1);
  });

  it('Recenter dispatches RECENTER', async () => {
    await mountScreen();
    await act(async () => { topControlsMock().__holder.onRecenter!(); });

    expect(sawEvent('RECENTER')).toHaveLength(1);
  });

  it('Navigate dispatches START_NAVIGATION targeting the object', async () => {
    await mountScreen();
    // Establish a selection so the rail has a subject, then invoke navigate.
    await act(async () => { mapMock().__holder.onSelectEntity!(mockEntities[0]); });
    await waitFor(() => expect(screen.getByTestId('map-bottom-actions')).toBeTruthy());
    await act(async () => { bottomActionsMock().__holder.onAction!('navigate', EVENT); });

    const started = sawEvent('START_NAVIGATION');
    expect(started).toHaveLength(1);
    expect((started[0] as { destinationObjectId?: string }).destinationObjectId).toBe('event:e1');
    // The device maps app was actually invoked (the routing itself).
    expect(jest.requireMock('../../../src/lib/openInMaps').openInMaps).toHaveBeenCalled();
  });

  it('returning to the foreground while navigating dispatches END_NAVIGATION', async () => {
    await mountScreen();

    await act(async () => { mapMock().__holder.onSelectEntity!(mockEntities[0]); });
    await waitFor(() => expect(screen.getByTestId('map-bottom-actions')).toBeTruthy());
    await act(async () => { bottomActionsMock().__holder.onAction!('navigate', EVENT); });
    expect(sawEvent('START_NAVIGATION')).toHaveLength(1);

    // Fire every registered AppState 'change' listener with 'active' — the one
    // the navigation effect added (only present while navigating) translates
    // that into END_NAVIGATION.
    await act(async () => { appStateChangeListeners.forEach((cb) => cb('active')); });

    expect(sawEvent('END_NAVIGATION')).toHaveLength(1);
  });

  it('a focusId deep link dispatches FOCUS_OBJECT for that object', async () => {
    mockParams.current = { focusId: 'e1' };
    await mountScreen();

    await waitFor(() => {
      const focused = sawEvent('FOCUS_OBJECT');
      expect(focused).toHaveLength(1);
      expect((focused[0] as { objectId?: string }).objectId).toBe('event:e1');
    });
  });
});
