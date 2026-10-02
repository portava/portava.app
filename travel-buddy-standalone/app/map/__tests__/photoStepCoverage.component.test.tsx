/**
 * FullScreenMapScreen — the §22 photo step is offered only when the server says
 * a photo would be KEPT for this account (census-map §45.12).
 *
 * ## The defect
 *
 * Gate 2b (artifacts/api-server/src/lib/intelEvidenceCapture.ts) keeps a map
 * photo only under a recorded consent whose words name photos, and none in
 * force does, so every attach is refused with 409
 * `consent_does_not_cover_photos`. The sheet offered the photo step anyway and
 * uploaded the bytes first (POST /api/media/upload), leaving an object nothing
 * references, which account deletion never finds.
 *
 * ## What this file pins
 *
 *   1. With capture on and the server answering `coversPhotoEvidence: true`,
 *      the sheet is handed a media picker (anti-vacuity for everything below).
 *   2. `false` (every account today), an absent field (an older server), a
 *      failed read (`null`) and a rejected read all hand it NONE.
 *   3. With capture off, the consent is not even read.
 *
 * WATCHED IT FAIL: with `requestContributionMedia = pickContributionMedia` (the
 * unconditional picker), the four case-2 tests go red; with the hook's early
 * return removed, so the effect reads while capture is off, case 3 goes red.
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

// The contribution sheet, stubbed to say ONE thing: whether the screen handed it
// a media picker. No picker means no photo step and no upload (the real sheet's
// own suite pins that half).
jest.mock('../../../src/components/map/MapContributionSheet', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  return {
    MapContributionSheet: (props: { visible: boolean; onRequestMedia?: unknown }) =>
      props.visible ? (
        <View testID="contribution-sheet">
          <Text testID="photo-step">{typeof props.onRequestMedia === 'function' ? 'offered' : 'withheld'}</Text>
        </View>
      ) : null,
  };
});

// The consent read, under this file's control. Everything else in the module
// stays real; only the one call the coverage hook makes is a double.
const mockGetIntelConsent = jest.fn();
jest.mock('../../../src/services/intelConsent', () => ({
  ...jest.requireActual('../../../src/services/intelConsent'),
  getIntelConsent: (...args: unknown[]) => mockGetIntelConsent(...args),
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

const GRANT = {
  enabled: true,
  consentVersion: 'intel_contributions_v1',
  consentedAt: '2026-09-01T00:00:00.000Z',
  withdrawnAt: null,
  currentDisclosureVersion: 'intel_contributions_v1',
};

/** Open the contribution sheet on the contributable gem, capture on. */
async function openSheet() {
  captureOn();
  const onAction = await selectAndGetAction('event:e1');
  await act(async () => { onAction('report', GEM); });
  await waitFor(() => expect(screen.getByTestId('contribution-sheet')).toBeTruthy());
  await waitFor(() => expect(mockGetIntelConsent).toHaveBeenCalled());
  // Let the read settle before reading the answer it produced.
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  mockGetIntelConsent.mockReset();
});

describe('FullScreenMapScreen — the photo step follows the server\'s coverage answer', () => {
  it('is offered when the server says a photo would be kept', async () => {
    mockGetIntelConsent.mockResolvedValue({ ...GRANT, coversPhotoEvidence: true });
    await openSheet();
    await waitFor(() => expect(screen.getByTestId('photo-step').props.children).toBe('offered'));
  });

  it('is withheld when the server says it would not (every account today)', async () => {
    mockGetIntelConsent.mockResolvedValue({ ...GRANT, coversPhotoEvidence: false });
    await openSheet();
    expect(screen.getByTestId('photo-step').props.children).toBe('withheld');
  });

  it('is withheld when the server does not say (an older server)', async () => {
    mockGetIntelConsent.mockResolvedValue({ ...GRANT });
    await openSheet();
    expect(screen.getByTestId('photo-step').props.children).toBe('withheld');
  });

  it('is withheld when the consent cannot be read', async () => {
    mockGetIntelConsent.mockResolvedValue(null);
    await openSheet();
    expect(screen.getByTestId('photo-step').props.children).toBe('withheld');
  });

  it('is withheld when the read throws', async () => {
    mockGetIntelConsent.mockRejectedValue(new Error('network'));
    await openSheet();
    expect(screen.getByTestId('photo-step').props.children).toBe('withheld');
  });

  it('does not read the consent at all while capture is off', async () => {
    mockGetIntelConsent.mockResolvedValue({ ...GRANT, coversPhotoEvidence: true });
    await selectAndGetAction('event:e1');
    await act(async () => { await Promise.resolve(); });
    expect(mockGetIntelConsent).not.toHaveBeenCalled();
  });
});
