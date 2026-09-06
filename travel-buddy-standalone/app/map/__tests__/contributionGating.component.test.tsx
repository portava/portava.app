/**
 * FullScreenMapScreen — §22 map contributions are not offered while capture is OFF.
 *
 * ## The defect
 *
 * The §22 capture flow had FOUR client entry points on this screen and not one
 * of them read a flag. `map_contributions_enabled` did not appear anywhere in
 * `travel-buddy-standalone/` at all. It is seeded OFF
 * (2216_map_observations.sql), and capture additionally requires
 * `intel_capture_quick_signal` — with either off, `POST /api/map/observations`
 * answers HTTP 200 `{ ok: true, accepted: 0, enabled: false }` and the client
 * prints "Reporting is not switched on here yet, so Your report was not
 * recorded." AFTER the user has already answered the prompt.
 *
 * ## What this file pins
 *
 *   1. `report` on a CONTRIBUTABLE object opens nothing while capture is off —
 *      and, critically, does NOT fall back to the moderation sheet. A place
 *      observation must never be filed into the human-abuse queue.
 *   2. With capture on, the same tap still opens the contribution sheet. This
 *      case is not decoration: without it, case 1 is satisfiable by deleting the
 *      flow outright.
 *   3. `report` on a NON-contributable object still opens the moderation sheet,
 *      flag or no flag. Moderation is behind no gate.
 *   4. The §38 arrival prompt — the one entry point that needs no user gesture —
 *      does not open the sheet while capture is off, AND does not consume the
 *      pick while doing so. The second half is what pins the guard's POSITION:
 *      placed after `arrivalPromptedIdsRef.current.add(pick.id)` the sheet would
 *      correctly stay shut, but the pick would be burned for the session and
 *      would never prompt again once the flag is turned on. A silent under-count
 *      is exactly the failure shape this gate exists to avoid.
 *
 * ## Why every flag reads false without a mock
 *
 * Measured, not assumed: `mapActionDispatch.component.test.tsx` has no
 * FeatureFlagsContext mock and passed 25/25 before this change — with every flag
 * false. That is the proof this whole defect class is invisible to the existing
 * suite, and the reason this file controls the flags explicitly.
 */
import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react-native';
import { Share, Alert } from 'react-native';
import FullScreenMapScreen from '../index.tsx';
import { point, type MapObject } from '../../../src/types/mapObjects.ts';
import { mapObjectsToEntities } from '../../../src/types/mapTypes.ts';

const EVENT: MapObject = {
  id: 'event:e1',
  kind: 'event',
  geometry: point(14.5, 120.9),
  title: 'Rooftop set',
  privacyClass: 'place_level',
  renderingPriority: 60,
  interaction: {
    actions: ['view', 'join', 'share', 'navigate', 'add_to_trip'],
    detailRoute: '/event/e1',
  },
};

const ZONE: MapObject = {
  id: 'buddy:b1',
  kind: 'buddy_zone',
  geometry: point(14.7, 121.1),
  title: 'Buddies around Poblacion',
  privacyClass: 'approximate',
  renderingPriority: 20,
  interaction: { actions: ['view', 'save', 'share'], detailRoute: '/buddy/b1' },
};

/** A buddy pin. A LISTING — `report` here is MODERATION, behind no flag. */
const BUDDY: MapObject = {
  id: 'buddy:b7',
  kind: 'buddy_zone',
  geometry: point(14.55, 120.95),
  title: 'Marco',
  privacyClass: 'approximate',
  renderingPriority: 30,
  interaction: {
    actions: ['view', 'book', 'message', 'report'],
    detailRoute: '/(rent-a-buddy)/buddy/b7',
    opensSheet: true,
  },
  payload: { userId: 'u7', id: 'b7' },
};

/** A contributable gem: `report` means "report what is here" — §22 capture. */
const GEM: MapObject = {
  id: 'gem:g3',
  kind: 'hidden_gem',
  geometry: point(14.58, 120.97),
  title: 'Rooftop garden',
  privacyClass: 'place_level',
  renderingPriority: 50,
  interaction: {
    actions: ['view', 'report'],
    detailRoute: '/gems/g3',
    opensSheet: true,
    contributable: true,
  },
};

/** The §38 pick the user "arrives at". Contributable, like every real pick. */
const ARRIVAL_PICK: MapObject = {
  id: 'place:arrival-1',
  kind: 'place',
  geometry: point(14.6, 120.98),
  title: 'Cong Caphe',
  privacyClass: 'place_level',
  renderingPriority: 55,
  interaction: { actions: ['view', 'report'], opensSheet: true, contributable: true },
};

const mockObjects = [EVENT, ZONE];
const mockEntities = mapObjectsToEntities(mockObjects);

jest.mock('expo-router', () => {
  const React = require('react');
  return {
    router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), navigate: jest.fn(), dismiss: jest.fn() },
    useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => ({}),
    usePathname:          () => '/',
    useSegments:          () => [],
    useFocusEffect: (cb: () => (() => void) | void) => {
      React.useEffect(() => {
        const cleanup = cb();
        return typeof cleanup === 'function' ? cleanup : undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
    },
    useNavigation: () => ({
      navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn(),
      addListener: (_e: unknown, _cb: unknown) => () => {},
    }),
    Link:     ({ children }: { children: React.ReactNode }) => children as any,
    Redirect: () => null,
    Stack:    { Screen: () => null },
    Tabs:     { Screen: () => null },
  };
});

// NOTE: intentional stub — not under test here.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentional stubs — not under test here.
jest.mock('../../../src/services/passportStamps', () => ({
  getPassportMap: jest.fn().mockResolvedValue({ ok: false }),
  _setTestAuthToken: jest.fn(),
}));
// NOTE: intentionally exhaustive — network service, not under test here.
jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryPlaces: jest.fn().mockResolvedValue({ ok: false }),
}));
// NOTE: intentionally exhaustive — network service, not under test here.
jest.mock('../../../src/services/livePulse', () => ({
  getLivePulseItems: jest.fn().mockResolvedValue({ ok: true, items: [] }),
}));

// §25 `join` resolves to an event RSVP — the implementation that already
// existed and was simply not reachable from the map's own action dispatch.
// NOTE: intentionally exhaustive — rsvpEvent is the far end of `join`, and
// requireActual would issue a real POST.
jest.mock('../../../src/services/events', () => ({
  rsvpEvent: jest.fn(() => Promise.resolve({ ok: true, data: { status: 'going', eventId: 'e1' } })),
}));

// §25 person-subject actions — the far end of `message`, `follow` and `block`.
// Spread requireActual so the rest of each service stays real; only the one
// call each action makes is a double.
jest.mock('../../../src/services/messaging', () => ({
  ...jest.requireActual('../../../src/services/messaging'),
  openDirectThread: jest.fn(() =>
    Promise.resolve({ ok: true, data: { threadId: 't1', created: false } }),
  ),
}));
jest.mock('../../../src/services/follows', () => ({
  ...jest.requireActual('../../../src/services/follows'),
  followUser: jest.fn(() => Promise.resolve({ ok: true, data: { following: true } })),
}));
jest.mock('../../../src/services/blocks', () => ({
  ...jest.requireActual('../../../src/services/blocks'),
  blockUser: jest.fn(() => Promise.resolve({ ok: true })),
}));

// The moderation sheet. Renders its subject so the test can read WHICH queue a
// report was filed into, rather than only that something opened.
jest.mock('../../../src/components/ReportSheet', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  return {
    ReportSheet: (props: {
      visible: boolean;
      subjectType: string;
      subjectId: string;
      subjectUserId?: string | null;
      subjectName?: string | null;
    }) =>
      props.visible ? (
        <View testID="report-sheet">
          <Text testID="report-subject">
            {JSON.stringify({
              type: props.subjectType,
              id: props.subjectId,
              userId: props.subjectUserId ?? null,
              name: props.subjectName ?? null,
            })}
          </Text>
        </View>
      ) : null,
  };
});

// The contribution sheet — the OTHER thing `report` can mean. Stubbed so the
// two destinations can be told apart.
jest.mock('../../../src/components/map/MapContributionSheet', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    MapContributionSheet: (props: { visible: boolean }) =>
      props.visible ? <View testID="contribution-sheet" /> : null,
  };
});

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState: { coords: { lat: 14.6, lng: 120.98 }, place: null, permissionStatus: 'granted' },
    resolvedLocation: { place: null, coords: { lat: 14.6, lng: 120.98 }, source: 'home', freshness: 'live' },
    requireLocation: jest.fn(),
  }),
}));

// NOTE: intentional stubs — not under test here.
jest.mock('../../../src/components/map/MapFilterSheet', () => ({
  MapFilterSheet: () => null,
  loadEnabledLayers: jest.fn().mockResolvedValue(['buddies', 'events', 'gems', 'trips', 'friends']),
}));
// NOTE: intentionally exhaustive — reads AsyncStorage at import.
jest.mock('../../../src/components/map/LayersSheet', () => ({
  LayersSheet: () => null,
  loadLayerPreferences: jest.fn().mockResolvedValue({}),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/map/MapTopControls', () => ({ MapTopControls: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/map/AskCompassBar', () => ({ AskCompassBar: () => null }));
// NOTE: intentional stub — the rail is the dispatch surface under test.
jest.mock('../../../src/components/map/LivePlaceSheet', () => ({ LivePlaceSheet: () => null }));
// NOTE: intentional stub — passport mode is not exercised here.
jest.mock('../../../src/lib/countryCentroids', () => ({ COUNTRY_CENTROIDS: {} }));

// The wishlist picker `save` must open. Renders what it was handed so the
// payload can be read out of the tree rather than off a call record.
jest.mock('../../../src/components/discovery/TripWishlistPicker', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  return {
    TripWishlistPicker: (props: { visible: boolean; place: unknown }) =>
      props.visible ? (
        <View testID="wishlist-picker">
          <Text testID="wishlist-payload">{JSON.stringify(props.place)}</Text>
        </View>
      ) : null,
  };
});

// The §25 rail — exposes onAction so a button press can be delivered without
// reimplementing the rail's own availability rules here.
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

// DiscoveryMapView — exposes onSelectEntity so a marker tap can establish the
// selection the rail acts on.
jest.mock('../../../src/components/discovery/DiscoveryMapView', () => {
  const React = require('react');
  const { View } = require('react-native');
  const holder: { onSelectEntity?: (e: unknown) => void } = {};
  return {
    __holder: holder,
    DiscoveryMapView: (props: { onSelectEntity?: (e: unknown) => void }) => {
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

// NOTE: intentionally exhaustive — the hook is the object/entity SOURCE under
// test here; requireActual would fetch over the network.
jest.mock('../../../src/hooks/useMapEntities', () => ({
  useMapEntities: () => ({
    entities: mockEntities, objects: mockObjects, liveEnrichment: null,
    loading: false, error: null, refresh: () => {}, source: 'gateway',
  }),
}));

// §35 emits. Everything else in the module (describeMapObject, countBucket, the
// transport installers) is kept real, so only the recording point is a double.
jest.mock('../../../src/features/map/telemetry/mapTelemetry', () => ({
  ...jest.requireActual('../../../src/features/map/telemetry/mapTelemetry'),
  emitMapEvent: jest.fn(),
}));

// ── The flags, under this file's control ─────────────────────────────────────
// The `mock` prefix is mandatory: jest hoists the factory above every
// declaration in the file and rejects a reference to any other out-of-scope
// binding.
const mockFlags: Record<string, boolean> = {};

// NOTE: intentionally exhaustive — the real provider fetches /api/feature-flags
// over the network at mount. `flags[key] === true` mirrors the real
// `isEnabled`, including its fail-closed answer for a key nobody has set.
jest.mock('../../../src/context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({
    isEnabled: (flag: string) => mockFlags[flag] === true,
    isLivePlacesEnabled: (flag: string) => mockFlags[flag] === true,
    loading: false,
  }),
  FeatureFlagsProvider: ({ children }: { children: unknown }) => children,
}));

/**
 * The pick §38 "arrives at", or `null` for the tests that are not about
 * arrival — off by default so an arrival-opened sheet can never be mistaken for
 * a tap-opened one in the report cases above.
 */
let mockArrivalPick: MapObject | null = null;

// §38 arrival detection. The real function is pure and geometric; substituting
// it lets the test place the user "at" a pick without hand-fitting coordinates
// to the 120 m radius. It HONOURS `promptedIds` exactly as the real one does —
// that faithfulness is the whole reason the guard-position case below can fail.
jest.mock('../../../src/features/map/arrival/arrivalPromptModel', () => ({
  ...jest.requireActual('../../../src/features/map/arrival/arrivalPromptModel'),
  detectArrivalPick: (_pos: unknown, _picks: unknown, promptedIds: ReadonlySet<string>) => {
    if (!mockArrivalPick) return null;
    return promptedIds.has(mockArrivalPick.id) ? null : mockArrivalPick;
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

let shareSpy: jest.SpyInstance;
let alertSpy: jest.SpyInstance;

/** Tap a marker so the rail has a subject, then hand back its onAction. */
async function selectAndGetAction(entityId: string) {
  await render(<FullScreenMapScreen />);
  await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());

  const mapMock = jest.requireMock('../../../src/components/discovery/DiscoveryMapView') as {
    __holder: { onSelectEntity?: (e: unknown) => void };
  };
  const entity = mockEntities.find((e) => e.id === entityId)!;
  await act(async () => { mapMock.__holder.onSelectEntity!(entity); });

  await waitFor(() => expect(screen.getByTestId('map-bottom-actions')).toBeTruthy());
  const railMock = jest.requireMock('../../../src/components/map/MapBottomActions') as {
    __holder: { onAction?: (a: string, o: unknown) => void };
  };
  return railMock.__holder.onAction!;
}

/** Switch §22 capture on. BOTH flags — either one off is the same dead end. */
function captureOn() {
  mockFlags.map_contributions_enabled = true;
  mockFlags.intel_capture_quick_signal = true;
}

beforeEach(() => {
  for (const key of Object.keys(mockFlags)) delete mockFlags[key];
  mockArrivalPick = null;
  shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  shareSpy.mockRestore();
  alertSpy.mockRestore();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FullScreenMapScreen — §22 report on a contributable object', () => {
  it('opens NOTHING while capture is off', async () => {
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('report', GEM); });

    // Not the contribution sheet: it would ask a question the server has
    // already decided to discard.
    expect(screen.queryByTestId('contribution-sheet')).toBeNull();
    // And not the moderation sheet either: "at least the button does
    // something" would file a place observation as an abuse report.
    expect(screen.queryByTestId('report-sheet')).toBeNull();
  });

  it('opens the contribution sheet once capture is on', async () => {
    // Anti-vacuity for the case above — without this, deleting §22 entirely
    // would satisfy it.
    captureOn();
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('report', GEM); });

    await waitFor(() => expect(screen.getByTestId('contribution-sheet')).toBeTruthy());
    expect(screen.queryByTestId('report-sheet')).toBeNull();
  });

  it('needs BOTH capture flags, not just the map one', async () => {
    // `map_contributions_enabled` opens the MAP door; capture itself still runs
    // behind `intel_capture_quick_signal`, and with that off the route produces
    // the byte-identical 200/accepted:0 dead end.
    mockFlags.map_contributions_enabled = true;
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('report', GEM); });

    expect(screen.queryByTestId('contribution-sheet')).toBeNull();
    expect(screen.queryByTestId('report-sheet')).toBeNull();
  });

  it('leaves MODERATION reporting alone, flag or no flag', async () => {
    // A buddy listing is not contributable. Its Report is the abuse queue,
    // which this gate must never touch.
    captureOn();
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('report', BUDDY); });

    await waitFor(() => expect(screen.getByTestId('report-sheet')).toBeTruthy());
    expect(screen.queryByTestId('contribution-sheet')).toBeNull();
  });

  it('still files a moderation report while capture is off', async () => {
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('report', BUDDY); });

    await waitFor(() => expect(screen.getByTestId('report-sheet')).toBeTruthy());
    expect(screen.queryByTestId('contribution-sheet')).toBeNull();
  });
});

describe('FullScreenMapScreen — §38 arrival prompt', () => {
  it('does not open the sheet unbidden while capture is off, and does not burn the pick', async () => {
    mockArrivalPick = ARRIVAL_PICK;
    const view = await render(<FullScreenMapScreen />);
    await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());

    // Half one: no gesture was made, and no sheet may appear.
    expect(screen.queryByTestId('contribution-sheet')).toBeNull();

    // Half two — the one that pins WHERE the guard sits. Same mount, same
    // pick: flip the flags on and the prompt must still be available. A guard
    // placed after `arrivalPromptedIdsRef.current.add(pick.id)` would have
    // recorded this pick as already-prompted while the flag was off, and it
    // would never prompt again for the life of the session.
    captureOn();
    await act(async () => { await view.rerender(<FullScreenMapScreen />); });

    await waitFor(() => expect(screen.getByTestId('contribution-sheet')).toBeTruthy());
  });

  it('opens the sheet on arrival when capture is on', async () => {
    captureOn();
    mockArrivalPick = ARRIVAL_PICK;
    await render(<FullScreenMapScreen />);

    await waitFor(() => expect(screen.getByTestId('contribution-sheet')).toBeTruthy());
  });
});
