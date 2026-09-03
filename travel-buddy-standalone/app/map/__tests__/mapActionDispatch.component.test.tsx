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
