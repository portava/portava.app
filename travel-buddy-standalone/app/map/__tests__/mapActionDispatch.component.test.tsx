/**
 * FullScreenMapScreen — §25 `save`, `share` and `join` actually do something.
 *
 * ## The defect
 *
 * `handleMapAction` handled navigate, contribute, ask_compass, view, meet_here
 * and add_to_trip, and let everything else fall through `default: return`. But
 * `save` and `share` are OFFERED — `livePlaceModel`'s §8 action order lists
 * both, and `clientProjection` puts them on the interaction config of places
 * and gems — and `join` is offered on events. So the §8 sheet and the §25 rail
 * rendered buttons that returned silently when pressed.
 *
 * ## Why these assertions and not a spy on handleMapAction
 *
 * A spy on the dispatcher would have passed against the broken screen: the
 * dispatcher was always called, it just did nothing at the end. So each test
 * asserts the REAL work at the far end — the wishlist picker opening with a
 * payload, the platform share sheet receiving a message, the RSVP endpoint
 * being called with the bare event id.
 *
 * `save` and `share` reuse the flows `MapEntityActionRow` already owns
 * (TripWishlistPicker, and the same canonicalUrl-built message) rather than a
 * third copy, so the assertions here are about the same shapes that file
 * produces.
 */
import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react-native';
import { Share, Alert } from 'react-native';
import FullScreenMapScreen from '../index.tsx';
import { point, MAP_ACTIONS, type MapObject } from '../../../src/types/mapObjects.ts';
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

/** An approximate object: §23 says its exact point must not travel onward. */
const ZONE: MapObject = {
  id: 'buddy:b1',
  kind: 'buddy_zone',
  geometry: point(14.7, 121.1),
  title: 'Buddies around Poblacion',
  privacyClass: 'approximate',
  renderingPriority: 20,
  interaction: { actions: ['view', 'save', 'share'], detailRoute: '/buddy/b1' },
};

/**
 * A circle member — §25's four person actions and nothing else. Every one of
 * them was inert before this: opening this object's sheet drew four buttons,
 * all four of which returned silently.
 */
const CREW: MapObject = {
  id: 'crew:u9',
  kind: 'crew_member',
  geometry: point(14.61, 120.99),
  title: 'Ana',
  privacyClass: 'approximate',
  renderingPriority: 40,
  interaction: { actions: ['message', 'follow', 'report', 'block'], opensSheet: true },
  payload: { userId: 'u9', name: 'Ana' },
};

/** A buddy pin. A LISTING — a report about it is not a report about a user. */
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

/** A contributable gem: here `report` means "report what is here", not moderation. */
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

// §22 capture flags. This file is about WHERE `report` is ROUTED, and routing
// is only about anything while capture is switched on: with the flags off the
// map screen now offers no §22 entry point at all, which is the subject of
// app/map/__tests__/contributionGating.component.test.tsx. Only the two capture
// flags are switched on — every other flag stays false, exactly as it was when
// this file had no flags mock at all.
// NOTE: intentionally exhaustive — the real provider fetches
// /api/feature-flags over the network at mount.
jest.mock('../../../src/context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({
    isEnabled: (flag: string) =>
      flag === 'map_contributions_enabled' || flag === 'intel_capture_quick_signal',
    isLivePlacesEnabled: () => false,
    loading: false,
  }),
  FeatureFlagsProvider: ({ children }: { children: unknown }) => children,
}));

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

// ── Helpers ───────────────────────────────────────────────────────────────────

let shareSpy: jest.SpyInstance;
let alertSpy: jest.SpyInstance;

function rsvp() {
  return jest.requireMock('../../../src/services/events').rsvpEvent as jest.Mock;
}

function openThread() {
  return jest.requireMock('../../../src/services/messaging').openDirectThread as jest.Mock;
}

function follow() {
  return jest.requireMock('../../../src/services/follows').followUser as jest.Mock;
}

function block() {
  return jest.requireMock('../../../src/services/blocks').blockUser as jest.Mock;
}

function push() {
  return jest.requireMock('expo-router').router.push as jest.Mock;
}

function emitSpy() {
  return jest.requireMock('../../../src/features/map/telemetry/mapTelemetry')
    .emitMapEvent as jest.Mock;
}

/** Payloads emitted for one §35 event name, in order. */
function emitted(name: string): Record<string, unknown>[] {
  return emitSpy().mock.calls
    .filter((c: unknown[]) => c[0] === name)
    .map((c: unknown[]) => c[1] as Record<string, unknown>);
}

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

beforeEach(() => {
  shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  rsvp().mockClear();
  emitSpy().mockClear();
  openThread().mockClear();
  follow().mockClear();
  block().mockClear();
  push().mockClear();
});

afterEach(() => {
  shareSpy.mockRestore();
  alertSpy.mockRestore();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FullScreenMapScreen — §25 save', () => {
  it('opens the wishlist picker with the object as its subject', async () => {
    // Pre-fix: `save` hit `default: return` and the button did nothing at all.
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('save', EVENT); });

    await waitFor(() => expect(screen.getByTestId('wishlist-picker')).toBeTruthy());
    const payload = JSON.parse(screen.getByTestId('wishlist-payload').props.children as string);
    // The BARE id — every projector prefixes with its own slug, and the save
    // path wants the canonical row id, not `event:e1`.
    expect(payload.id).toBe('e1');
    expect(payload.name).toBe('Rooftop set');
    expect(payload.lat).toBeCloseTo(14.5);
    expect(payload.lng).toBeCloseTo(120.9);
  });

  it('withholds coordinates for an approximate object', async () => {
    // TripWishlistPicker's contract: "callers MUST set lat/lng to null for any
    // source whose coordinates are protected or approximate". A buddy_zone is
    // deliberately imprecise (§23), so saving it must not persist a point
    // nobody published.
    const onAction = await selectAndGetAction('buddy:b1');

    await act(async () => { onAction('save', ZONE); });

    await waitFor(() => expect(screen.getByTestId('wishlist-picker')).toBeTruthy());
    const payload = JSON.parse(screen.getByTestId('wishlist-payload').props.children as string);
    expect(payload.id).toBe('b1');
    expect(payload.lat).toBeNull();
    expect(payload.lng).toBeNull();
  });

  it('keeps the picker closed until save is pressed', async () => {
    await selectAndGetAction('event:e1');

    expect(screen.queryByTestId('wishlist-picker')).toBeNull();
  });
});

describe('FullScreenMapScreen — §25 share', () => {
  it('opens the platform share sheet with the object title and canonical link', async () => {
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('share', EVENT); });

    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    const message = (shareSpy.mock.calls[0][0] as { message: string }).message;
    expect(message).toContain('Rooftop set');
    // The link is built from the object's own detail route through
    // canonicalUrl — the same origin helper MapEntityActionRow uses.
    expect(message).toContain('/event/e1');
    expect(message).not.toContain('undefined');
  });
});

describe('FullScreenMapScreen — §25 join', () => {
  it('RSVPs to the event with its bare id', async () => {
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('join', EVENT); });

    await waitFor(() => expect(rsvp()).toHaveBeenCalledWith('e1', 'going'));
    expect(alertSpy).toHaveBeenCalled();
  });

  it('does nothing for a kind that cannot be joined', async () => {
    // `join` means an event RSVP and nothing else. Reporting success against a
    // buddy zone would be worse than the button being inert.
    const onAction = await selectAndGetAction('buddy:b1');

    await act(async () => { onAction('join', ZONE); });

    expect(rsvp()).not.toHaveBeenCalled();
  });

  it('emits §35 plan_joined on the confirmed branch', async () => {
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('join', EVENT); });

    await waitFor(() => expect(emitted('plan_joined').length).toBe(1));
    const payload = emitted('plan_joined')[0];
    expect(payload.planKind).toBe('event');
    // 'map' rather than 'compass' — no Compass query is active in this test.
    expect(payload.discovery).toBe('map');
  });

  it('reports a waitlist placement rather than claiming a confirmed join', async () => {
    rsvp().mockResolvedValueOnce({ ok: true, data: { status: 'waitlisted', position: 4 } });
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('join', EVENT); });

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    const [title, body] = alertSpy.mock.calls[0] as [string, string];
    expect(title).toContain('waitlist');
    expect(body).toContain('#4');
    // A waitlist placement is NOT a join. Emitting here would inflate the §35
    // funnel with people who never got in.
    expect(emitted('plan_joined')).toHaveLength(0);
  });

  it('surfaces a failed RSVP instead of failing silently', async () => {
    rsvp().mockResolvedValueOnce({ ok: false, message: 'Event is closed' });
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('join', EVENT); });

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(alertSpy.mock.calls[0][1]).toBe('Event is closed');
  });
});


// ── §25 dispatch completeness ─────────────────────────────────────────────────

describe('FullScreenMapScreen — §25 dispatch completeness', () => {
  /**
   * The rail draws four FIXED slots, but the §8 Live Place sheet renders
   * `orderedActions(obj)` — whatever the projection declared. So an action the
   * union offers and `handleMapAction` omits is not inert-but-invisible: it is
   * a rendered, labelled button that does nothing when pressed. That was true
   * of six actions at once, and of `join` before them.
   *
   * Reads the SOURCE rather than driving all fifteen: a behavioural test can
   * only cover the actions someone remembered to write a case for, which is
   * exactly the thing being guarded against.
   */
  it('handles every action in MAP_ACTIONS — none may fall through `default`', () => {
    const { readFileSync } = require('node:fs');
    const { resolve } = require('node:path');
    const src: string = readFileSync(resolve(__dirname, '..', 'index.tsx'), 'utf8');

    const start = src.indexOf('const handleMapAction = useCallback');
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf('/** Called when the user taps a marker', start);
    expect(end).toBeGreaterThan(start);

    const handled = new Set(
      [...src.slice(start, end).matchAll(/case '([a-z_]+)'/g)].map((m) => m[1]),
    );
    const missing = MAP_ACTIONS.filter((a) => !handled.has(a));

    expect(missing).toEqual([]);
  });
});

// ── §25 person-subject actions ────────────────────────────────────────────────

describe('FullScreenMapScreen — §25 message', () => {
  it('opens the direct thread and navigates to it', async () => {
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('message', CREW); });

    await waitFor(() => expect(openThread()).toHaveBeenCalledWith('u9'));
    // The SAME route and params MapEntityActionRow pushes — one thread screen,
    // not two that drift.
    const route = push().mock.calls.at(-1)?.[0] as string;
    expect(route).toContain('/messages/t1');
    expect(route).toContain('threadType=direct');
    expect(route).toContain('otherUserId=u9');
  });

  it('surfaces a failed thread open instead of navigating nowhere', async () => {
    openThread().mockResolvedValueOnce({ ok: false, data: null });
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('message', CREW); });

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(alertSpy.mock.calls[0][0]).toContain('Could not open conversation');
    expect(push()).not.toHaveBeenCalled();
  });

  it('does nothing for an object that is not a person', async () => {
    // A place has no user behind it. Falling back to the object id would open a
    // thread against a row that is not a user.
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('message', GEM); });

    expect(openThread()).not.toHaveBeenCalled();
  });
});

describe('FullScreenMapScreen — §25 follow', () => {
  it('follows the user behind the object', async () => {
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('follow', CREW); });

    await waitFor(() => expect(follow()).toHaveBeenCalledWith('u9'));
  });

  it('says "Request sent" when the account is private', async () => {
    // A private account answers a follow with a REQUEST. Reporting that as
    // "Following" would claim access the user does not have.
    follow().mockResolvedValueOnce({ ok: true, data: { following: false } });
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('follow', CREW); });

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(alertSpy.mock.calls[0][0]).toBe('Request sent');
  });

  it('does nothing for an object that is not a person', async () => {
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('follow', GEM); });

    expect(follow()).not.toHaveBeenCalled();
  });
});

describe('FullScreenMapScreen — §25 block', () => {
  it('confirms before blocking, and blocks on confirm', async () => {
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('block', CREW); });

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    // Nothing has happened yet — the prompt is the whole action so far.
    expect(block()).not.toHaveBeenCalled();

    const buttons = alertSpy.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    const confirm = buttons.find((b) => b.text === 'Block');
    expect(confirm).toBeTruthy();

    await act(async () => { confirm!.onPress?.(); });

    await waitFor(() => expect(block()).toHaveBeenCalledWith('u9'));
  });

  it('does not block when the confirmation is cancelled', async () => {
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('block', CREW); });

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    const buttons = alertSpy.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    const cancel = buttons.find((b) => b.text === 'Cancel');

    await act(async () => { cancel!.onPress?.(); });

    expect(block()).not.toHaveBeenCalled();
  });

  it('does nothing for an object that is not a person', async () => {
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('block', GEM); });

    expect(alertSpy).not.toHaveBeenCalled();
    expect(block()).not.toHaveBeenCalled();
  });
});

describe('FullScreenMapScreen — §25 book', () => {
  it('navigates to the buddy booking surface', async () => {
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('book', BUDDY); });

    await waitFor(() => expect(push()).toHaveBeenCalledWith('/(rent-a-buddy)/buddy/b7'));
  });
});

// ── §25 report — two meanings, two destinations ───────────────────────────────

describe('FullScreenMapScreen — §25 report', () => {
  it('files a circle member as a USER report', async () => {
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('report', CREW); });

    await waitFor(() => expect(screen.getByTestId('report-sheet')).toBeTruthy());
    const subject = JSON.parse(screen.getByTestId('report-subject').props.children as string);
    expect(subject.type).toBe('user');
    expect(subject.userId).toBe('u9');
    // The BARE id — the moderation queue wants the row id, not `crew:u9`.
    expect(subject.id).toBe('u9');
  });

  it('files a buddy pin as a LISTING, not as a user', async () => {
    // Same button, different queue. Filing a marketplace complaint as a user
    // report — or a harassment report as a listing complaint — sends it to the
    // wrong team.
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('report', BUDDY); });

    await waitFor(() => expect(screen.getByTestId('report-sheet')).toBeTruthy());
    const subject = JSON.parse(screen.getByTestId('report-subject').props.children as string);
    expect(subject.type).toBe('buddy_listing');
    expect(subject.id).toBe('b7');
  });

  it('sends a contributable object to the contribution sheet instead', async () => {
    // On a gem, "Report" means "report what is here" — an observation about a
    // place, which is what the long-press menu has always routed it to. A
    // moderation sheet here would ask the user to accuse a viewpoint of abuse.
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('report', GEM); });

    await waitFor(() => expect(screen.getByTestId('contribution-sheet')).toBeTruthy());
    expect(screen.queryByTestId('report-sheet')).toBeNull();
  });

  it('keeps both sheets closed until report is pressed', async () => {
    await selectAndGetAction('event:e1');

    expect(screen.queryByTestId('report-sheet')).toBeNull();
    expect(screen.queryByTestId('contribution-sheet')).toBeNull();
  });
});

describe('FullScreenMapScreen — §25 create_checkpoint', () => {
  it('explains itself when no group map is active rather than failing silently', async () => {
    // §12: a checkpoint is a position report INTO a group map. With no session
    // there is nobody to tell. The long-press menu disables the row with this
    // reason; the sheet has no disabled state, so it must be said out loud.
    const onAction = await selectAndGetAction('event:e1');

    await act(async () => { onAction('create_checkpoint', EVENT); });

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(alertSpy.mock.calls[0][0]).toBe('No group map active');
  });
});
