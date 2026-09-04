/**
 * FullScreenMapScreen — the §25 long-press menu's four dead rows.
 *
 * ## The defect
 *
 * `MapLongPressMenu`'s `onSelect` handled `report`, `meet_here` and
 * `ask_compass`, and let the other four §25 actions fall out of the handler.
 * They were not inert in the MENU: `resolveLongPressActions` returned an
 * enabled entry for `save` and `add_to_trip` at any place-level-or-better
 * target and an enabled `share` carrying a §37 bound on its second line, so
 * three rows rendered bright, tappable, and did nothing at all.
 *
 * ## What is asserted, and why each is the interesting assertion
 *
 * As in `mapActionDispatch.component.test.tsx`, a spy on the handler would have
 * passed against the broken screen — the handler ran, it just ended. So every
 * test below asserts the REAL far end: the picker mounting with a payload, the
 * detail route being pushed, the position endpoint being called.
 *
 * The `share` test asserts an ABSENCE, and it is the most important one here.
 * §25's `share` is "Share permitted location" — a §23-bounded share of the
 * pressed point that expires. §8's `share`, which this screen does own, sends a
 * permanent link to a place. They collide on one slug, so the cheap "fix" is to
 * route this row to `shareMapObject` and answer a bounded location share with a
 * permanent link. Nothing may reach `Share.share` from this menu.
 */
import React from 'react';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react-native';
import { Share, Alert } from 'react-native';
import FullScreenMapScreen from '../index.tsx';
import { point, type MapObject } from '../../../src/types/mapObjects.ts';
import { mapObjectsToEntities } from '../../../src/types/mapTypes.ts';
import {
  coordinateTarget,
  objectTarget,
  type LongPressContext,
  type LongPressTarget,
} from '../../../src/features/map/interaction/longPress.ts';
import type { MapAction } from '../../../src/types/mapObjects.ts';

/** A place-level event with its own page — everything §25 can offer is legal. */
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

const mockObjects = [EVENT];
const mockEntities = mapObjectsToEntities(mockObjects);

const OBJECT_TARGET: LongPressTarget = objectTarget(EVENT);
const COORD_TARGET: LongPressTarget = coordinateTarget(14.55, 120.95);

jest.mock('expo-router', () => {
  const React = require('react');
  return {
    router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), navigate: jest.fn(), dismiss: jest.fn() },
    useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
    // §12 is group-scoped and the only scope this screen can name is the trip
    // it was opened for — without it Locate My Friends cannot be entered, and
    // the checkpoint row has no session to drop into.
    useLocalSearchParams: () => ({ tripId: 'trip-1' }),
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

// NOTE: intentionally exhaustive — the screen reads only `isEnabled` from this
// context, and §30 LOCATE_FRIENDS opens on flag + group scope + viewer identity.
// Only that one flag is on: turning them all on would mount unrelated surfaces.
jest.mock('../../../src/context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({
    isEnabled: (flag: string) => flag === 'locate_friends_enabled',
    isLivePlacesEnabled: () => false,
    loading: false,
  }),
}));

// NOTE: intentional stub — a signed-in viewer is the third LOCATE_FRIENDS input.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({
    userId: 'viewer-1', isAuthed: true, loading: false, configured: true,
    signOut: async () => {}, role: null, roleLoaded: true,
    accountStatus: null, accountStatusLoaded: true, deletionScheduledAt: null,
    refreshAccountStatus: async () => {},
  }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/passportStamps', () => ({
  getPassportMap: jest.fn().mockResolvedValue({ ok: false }),
  _setTestAuthToken: jest.fn(),
}));
// NOTE: intentionally exhaustive — network service, not under test here.
jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryPlaces: jest.fn().mockResolvedValue({ ok: false }),
}));
// NOTE: intentionally exhaustive — network service, not under test here. One
// item, so the Live Pulse card mounts and its deep link can enter a mode.
jest.mock('../../../src/services/livePulse', () => ({
  getLivePulseItems: jest.fn().mockResolvedValue({
    ok: true,
    items: [{ id: 'p1', item_type: 'event', title: 'Something is happening' }],
  }),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/events', () => ({ rsvpEvent: jest.fn() }));

// The §12 client. `requireActual` keeps the interval constants the screen
// imports; only the two calls this test drives are replaced, so no socket opens.
jest.mock('../../../src/services/locateFriends', () => ({
  ...jest.requireActual('../../../src/services/locateFriends'),
  startLocateFriendsSession: jest.fn(() =>
    Promise.resolve({
      ok: true,
      data: {
        session: { id: 'session-1', groupScopeKind: 'trip', groupScopeId: 'trip-1' },
        requestedClass: 'approximate',
      },
    }),
  ),
  publishManualCheckpoint: jest.fn(() =>
    Promise.resolve({ ok: true, data: { enabled: true, stored: true } }),
  ),
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
// NOTE: intentional stub — the long-press menu is the dispatch surface here.
jest.mock('../../../src/components/map/LivePlaceSheet', () => ({ LivePlaceSheet: () => null }));
// NOTE: intentional stub — the panel owns read/publish polls of its own.
jest.mock('../../../src/components/map/LocateFriendsPanel', () => ({ LocateFriendsPanel: () => null }));
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

// The §25 menu — exposes onSelect and the context it was given, so a row press
// can be delivered without reimplementing the menu's own availability rules,
// plus the target/visibility the screen handed it so the GESTURE that opens it
// can be asserted from the far end rather than off a setState spy.
//
// The probe View renders unconditionally (the real menu returns null until
// visible); `__holder.visible` is what says whether the menu is actually open.
jest.mock('../../../src/components/map/MapLongPressMenu', () => {
  const React = require('react');
  const { View } = require('react-native');
  const holder: {
    onSelect?: (a: string, t: unknown) => void;
    onClose?: () => void;
    context?: unknown;
    visible?: boolean;
    target?: unknown;
    anchor?: unknown;
  } = {};
  return {
    __holder: holder,
    MapLongPressMenu: (props: {
      onSelect?: (a: string, t: unknown) => void;
      onClose?: () => void;
      context?: unknown;
      visible?: boolean;
      target?: unknown;
      anchor?: unknown;
    }) => {
      holder.onSelect = props.onSelect;
      holder.onClose = props.onClose;
      holder.context = props.context;
      holder.visible = props.visible;
      holder.target = props.target;
      holder.anchor = props.anchor;
      return <View testID="map-long-press-menu" />;
    },
  };
});

// The Live Pulse card — its deep link is the one route into a §30 mode that
// does not require driving the real top controls.
jest.mock('../../../src/components/map/LivePulseCard', () => {
  const React = require('react');
  const { View } = require('react-native');
  const holder: { onDeepLink?: (d: unknown) => void } = {};
  return {
    __holder: holder,
    LivePulseCard: (props: { onDeepLink?: (d: unknown) => void }) => {
      holder.onDeepLink = props.onDeepLink;
      return <View testID="live-pulse-card" />;
    },
  };
});

// The map — exposes onLongPressMap so the §25 gesture can be delivered. The
// real component reads it off MapLibre's own press event (covered in
// DiscoveryMapView.longPress.component.test.tsx); here it is the entry point.
jest.mock('../../../src/components/discovery/DiscoveryMapView', () => {
  const React = require('react');
  const { View } = require('react-native');
  const holder: { onLongPressMap?: (p: unknown) => void } = {};
  return {
    __holder: holder,
    DiscoveryMapView: (props: { onLongPressMap?: (p: unknown) => void }) => {
      holder.onLongPressMap = props.onLongPressMap;
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

// NOTE: intentionally exhaustive — the hook is the object SOURCE under test
// here; requireActual would fetch over the network.
jest.mock('../../../src/hooks/useMapEntities', () => ({
  useMapEntities: () => ({
    entities: mockEntities, objects: mockObjects, liveEnrichment: null,
    loading: false, error: null, refresh: () => {}, source: 'gateway',
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

let shareSpy: jest.SpyInstance;
let alertSpy: jest.SpyInstance;

function menuMock() {
  return jest.requireMock('../../../src/components/map/MapLongPressMenu') as {
    __holder: {
      onSelect?: (a: string, t: unknown) => void;
      onClose?: () => void;
      context?: LongPressContext;
      visible?: boolean;
      target?: LongPressTarget | null;
      anchor?: { x: number; y: number } | null;
    };
  };
}

function mapMock() {
  return jest.requireMock('../../../src/components/discovery/DiscoveryMapView') as {
    __holder: {
      onLongPressMap?: (p: {
        lat: number;
        lng: number;
        screenX: number;
        screenY: number;
      }) => void;
    };
  };
}

function pulseMock() {
  return jest.requireMock('../../../src/components/map/LivePulseCard') as {
    __holder: { onDeepLink?: (d: unknown) => void };
  };
}

function locateMock() {
  return jest.requireMock('../../../src/services/locateFriends') as {
    startLocateFriendsSession: jest.Mock;
    publishManualCheckpoint: jest.Mock;
  };
}

function pushMock() {
  return (jest.requireMock('expo-router') as { router: { push: jest.Mock } }).router.push;
}

/** Mount the screen and hand back the menu's `onSelect`. */
async function mountAndGetSelect() {
  await render(<FullScreenMapScreen />);
  await waitFor(() => expect(screen.getByTestId('map-long-press-menu')).toBeTruthy());
  return menuMock().__holder.onSelect!;
}

async function select(action: MapAction, target: LongPressTarget) {
  const onSelect = await mountAndGetSelect();
  await act(async () => { onSelect(action, target); });
}

/**
 * Enter §12 and start a session, so the checkpoint row has a group to drop
 * into. This is the same path the user takes: a Live Pulse deep link into
 * LOCATE_FRIENDS, then the start chip the mode renders.
 */
async function startGroupSession() {
  await render(<FullScreenMapScreen />);
  await waitFor(() => expect(screen.getByTestId('live-pulse-card')).toBeTruthy());
  await act(async () => { pulseMock().__holder.onDeepLink!({ mode: 'LOCATE_FRIENDS' }); });

  const chip = await screen.findByLabelText('Start locating friends for two hours');
  await act(async () => { await fireEvent.press(chip); });
  await waitFor(() => expect(locateMock().startLocateFriendsSession).toHaveBeenCalled());
  return menuMock().__holder.onSelect!;
}

beforeEach(() => {
  shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  locateMock().startLocateFriendsSession.mockClear();
  locateMock().publishManualCheckpoint.mockClear();
  pushMock().mockClear();
});

afterEach(() => {
  shareSpy.mockRestore();
  alertSpy.mockRestore();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('§25 long-press — the gesture that opens the menu', () => {
  /** Long-press the map at a point, the way DiscoveryMapView reports one. */
  async function pressAt(lat: number, lng: number, screenX = 180, screenY = 402) {
    await render(<FullScreenMapScreen />);
    await waitFor(() => expect(mapMock().__holder.onLongPressMap).toBeDefined());
    await act(async () => {
      mapMock().__holder.onLongPressMap!({ lat, lng, screenX, screenY });
    });
  }

  it('is closed until something presses the map', async () => {
    await render(<FullScreenMapScreen />);
    await waitFor(() => expect(screen.getByTestId('map-long-press-menu')).toBeTruthy());
    // The defect this whole file exists for: before the gesture was wired the
    // menu could never leave this state, whatever the user did.
    expect(menuMock().__holder.visible).toBe(false);
    expect(menuMock().__holder.target).toBeNull();
  });

  it('opens on a press over empty map, with that exact coordinate', async () => {
    await pressAt(14.7, 121.1);
    expect(menuMock().__holder.visible).toBe(true);
    const target = menuMock().__holder.target;
    expect(target?.kind).toBe('coordinate');
    if (target?.kind !== 'coordinate') return;
    expect(target.lat).toBeCloseTo(14.7, 6);
    expect(target.lng).toBeCloseTo(121.1, 6);
  });

  it('anchors the menu at the press so it opens under the finger', async () => {
    await pressAt(14.7, 121.1, 88, 640);
    expect(menuMock().__holder.anchor).toEqual({ x: 88, y: 640 });
  });

  it('opens on the OBJECT when the press lands on a drawn marker', async () => {
    // EVENT is at exactly this point, so this is a hit at any zoom — what is
    // under a press is decided by pressTarget.ts, which has its own suite for
    // the radius.
    await pressAt(14.5, 120.9);
    const target = menuMock().__holder.target;
    expect(target?.kind).toBe('object');
    if (target?.kind !== 'object') return;
    expect(target.object.id).toBe('event:e1');
  });

  it('closes again when the menu asks to close', async () => {
    await pressAt(14.7, 121.1);
    expect(menuMock().__holder.visible).toBe(true);
    await act(async () => { menuMock().__holder.onClose!(); });
    expect(menuMock().__holder.visible).toBe(false);
  });

  it('closes when a row is selected, so the menu cannot outlive its target', async () => {
    await pressAt(14.5, 120.9);
    await act(async () => { menuMock().__holder.onSelect!('save', OBJECT_TARGET); });
    expect(menuMock().__holder.visible).toBe(false);
  });
});

describe('§25 long-press — save', () => {
  it('opens the wishlist picker with the pressed object as its subject', async () => {
    await select('save', OBJECT_TARGET);
    await waitFor(() => expect(screen.getByTestId('wishlist-picker')).toBeTruthy());
    const payload = JSON.parse(screen.getByTestId('wishlist-payload').props.children);
    // The bare row id, as MapEntityActionRow and the rail both build it.
    expect(payload.id).toBe('e1');
    expect(payload.name).toBe('Rooftop set');
  });

  it('stays closed until a row is pressed', async () => {
    await mountAndGetSelect();
    expect(screen.queryByTestId('wishlist-picker')).toBeNull();
  });
});

describe('§25 long-press — add to trip', () => {
  it('hands off to the object own detail surface, where the plan picker lives', async () => {
    await select('add_to_trip', OBJECT_TARGET);
    expect(pushMock()).toHaveBeenCalledWith('/event/e1');
  });
});

describe('§25 long-press — share', () => {
  it('never falls through to §8 permanent link share', async () => {
    // The menu refuses this row (longPress.ts BOUNDED_SHARE_CHANNEL_EXISTS), so
    // in practice nothing arrives. This asserts the screen would not answer it
    // with the wrong action even if something did.
    await select('share', OBJECT_TARGET);
    expect(shareSpy).not.toHaveBeenCalled();
    expect(pushMock()).not.toHaveBeenCalled();
  });
});

describe('§25 long-press — create checkpoint', () => {
  it('has no group scope to offer until a session is live', async () => {
    await render(<FullScreenMapScreen />);
    await waitFor(() => expect(screen.getByTestId('map-long-press-menu')).toBeTruthy());
    // The menu turns this into "Join a group or event map to drop a checkpoint"
    // rather than an enabled row, which is the honest state with no session.
    expect(menuMock().__holder.context?.checkpointScopeId).toBeNull();
  });

  it('names the live session as the scope once one is started', async () => {
    await startGroupSession();
    await waitFor(() =>
      expect(menuMock().__holder.context?.checkpointScopeId).toBe('session-1'),
    );
  });

  it('publishes the pressed spot name into that session', async () => {
    const onSelect = await startGroupSession();
    await act(async () => { onSelect('create_checkpoint', OBJECT_TARGET); });
    await waitFor(() => expect(locateMock().publishManualCheckpoint).toHaveBeenCalled());
    expect(locateMock().publishManualCheckpoint).toHaveBeenCalledWith({
      sessionId: 'session-1',
      // The name the menu showed in its own header, so the group reads the
      // same words the user pressed.
      label: 'Rooftop set',
    });
  });

  it('carries the coarsened label for a press on bare map, and no coordinate', async () => {
    const onSelect = await startGroupSession();
    await act(async () => { onSelect('create_checkpoint', COORD_TARGET); });
    await waitFor(() => expect(locateMock().publishManualCheckpoint).toHaveBeenCalled());
    const arg = locateMock().publishManualCheckpoint.mock.calls[0][0];
    expect(arg.sessionId).toBe('session-1');
    expect(arg.label).toMatch(/^Near /);
    // A checkpoint is a declaration, not a fix: the pressed point never travels
    // as this device's position.
    expect(arg).not.toHaveProperty('position');
  });

  it('says so when the group never received it', async () => {
    locateMock().publishManualCheckpoint.mockResolvedValueOnce({
      ok: true,
      data: { enabled: true, stored: false },
    });
    const onSelect = await startGroupSession();
    await act(async () => { onSelect('create_checkpoint', OBJECT_TARGET); });
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(String(alertSpy.mock.calls[0][0])).toMatch(/could not/i);
  });
});
