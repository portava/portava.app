/**
 * DiscoveryHub — Layover FAB visibility lifecycle
 *
 * Confirms the full show/hide/show cycle for the Layover Mode FAB:
 *   1. FAB is visible when no sheet is open.
 *   2. FAB disappears when the place detail sheet opens (detailVisible=true).
 *   3. FAB reappears after the sheet is closed (detailVisible=false).
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */

import React from 'react';
import { act, render } from '@testing-library/react-native';
import DiscoveryHub from '../discovery.tsx';
import type { DiscoveryPlace } from '../../../src/services/discovery';

// ── react-native Proxy mock ───────────────────────────────────────────────────
// DiscoveryHub mounts a raw <Modal> (age-filter picker). The Modal animation
// lifecycle leaves a floating async act() scope; the next act() collides with
// it, corrupting the act-scope depth so every later render commits an empty
// tree. Stubbing Modal as a plain conditional View keeps the lifecycle
// synchronous. ActivityIndicator must also be stubbed — through the Proxy its
// getter can hit uninitialised native-module stubs.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  const MockActivityIndicator = () => null;
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'ActivityIndicator') return MockActivityIndicator;
      return Reflect.get(target, prop, receiver);
    },
  });
});

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: {
    push:     jest.fn(),
    replace:  jest.fn(),
    back:     jest.fn(),
    navigate: jest.fn(),
    dismiss:  jest.fn(),
  },
  useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
  // Start on the 'places' tab so DiscoveryCategoryTab (not ForYouTab) renders —
  // DiscoveryCategoryTab receives the onSelectPlace prop we need to capture.
  useLocalSearchParams: () => ({ category: 'places' }),
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

// ── Services ──────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/hashtag', () => ({
  getTrendingHashtags: jest.fn().mockResolvedValue({ ok: true, data: { trending: [] } }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryCategoryCounts:      jest.fn().mockResolvedValue({}),
  getDiscoveryCategoryCountsBatch: jest.fn().mockResolvedValue({}),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/trips', () => ({
  listMyTrips: jest.fn().mockResolvedValue([]),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/rentABuddy', () => ({
  getAvailableNow: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/discoveryLocalCache', () => ({
  loadCachedCounts: jest.fn().mockResolvedValue(null),
  saveCachedCounts: jest.fn().mockResolvedValue(undefined),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/apiToken', () => ({
  freshToken: jest.fn().mockResolvedValue(null),
}));

// ── Hooks ─────────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  navBarProgress:         { value: 0 },
  NAV_BAR_FILLER_HEIGHT:  96,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  usePlainBottomInset:   () => 130,
  PlainBottomFiller:     () => null,
  BOTTOM_BREATHING_ROOM: 24,
  useStickyBarInset:     () => ({ inset: 130, onBarLayout: () => {} }),
  useKeyboardVisible:    () => false,
  useBottomInset:        () => 130,
  useLayoverAwareBottomInset: () => 130,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useFollowingHighlights', () => ({
  useFollowingHighlights: () => ({
    users:             [],
    sessionViewedIds:  new Set<string>(),
    markSessionViewed: jest.fn(),
  }),
}));

// ── Contexts ──────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: 'user-test-1', isAuthed: true }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: () => false, loading: false }),
}));

// Fixed location with a destination city so the FAB condition can be met.
const mockLocationState = {
  place:  { city: 'Tokyo', country: 'Japan' },
  coords: { lat: 35.6762, lng: 139.6503 },
};

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState:        mockLocationState,
    resolvedLocation: {
      place:     mockLocationState.place,
      coords:    mockLocationState.coords,
      source:    'gps',
      freshness: 'fresh',
    },
    showCityPicker:       false,
    openCityPicker:       jest.fn(),
    closeCityPicker:      jest.fn(),
    setManualCity:        jest.fn().mockResolvedValue(undefined),
    setSessionLocation:   jest.fn(),
    clearSessionLocation: jest.fn(),
    isLoading:            false,
  }),
}));

// ── PlanPickerController ──────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PlanPickerController', () => ({
  usePlanPicker: () => ({ open: jest.fn() }),
}));

// ── Prop-capture stubs ────────────────────────────────────────────────────────
// Capture onSelectPlace from DiscoveryCategoryTab so the test can trigger
// detailVisible=true without a fireEvent.press (avoiding the React 19 + RNTL
// press-budget constraint that limits reliable presses to one per file).
let capturedOnSelectPlace: ((place: DiscoveryPlace) => void) | null = null;

// NOTE: captures onSelectPlace prop; all other props are irrelevant here.
jest.mock('../../../src/components/discovery/DiscoveryCategoryTab', () => ({
  DiscoveryCategoryTab: (props: { onSelectPlace?: (p: DiscoveryPlace) => void; listHeaderComponent?: React.ReactElement | null }) => {
    capturedOnSelectPlace = props.onSelectPlace ?? null;
    return props.listHeaderComponent ?? null;
  },
}));

// Capture onClose from PlaceDetailSheet so the test can trigger
// detailVisible=false without a press.
let capturedOnClose: (() => void) | null = null;

// NOTE: captures onClose prop; visible state is not rendered (sheet is native).
jest.mock('../../../src/components/discovery/PlaceDetailSheet', () => ({
  PlaceDetailSheet: (props: { visible?: boolean; onClose?: () => void }) => {
    capturedOnClose = props.onClose ?? null;
    return null;
  },
}));

// ── Remaining heavy sub-components ───────────────────────────────────────────
const Null = () => null;

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet',       () => ({ LayoverModeSheet:        Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/ForYouTab',            () => ({ ForYouTab:               Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/DestinationBar',       () => ({ DestinationBar:          Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassBuddyRow',        () => ({ CompassBuddyRow:         Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CityConfidenceBadge',    () => ({ CityConfidenceBadge:     Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ManualCityPicker',               () => ({ ManualCityPicker:        Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/FollowingHighlightsStrip',       () => ({ FollowingHighlightsStrip: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/RouteBuilderSheet',              () => ({ RouteBuilderSheet:       Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SubmitPlaceSheet',     () => ({ SubmitPlaceSheet:        Null }));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SectionErrorBoundary', () => ({
  SectionErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

// ── Fake place ────────────────────────────────────────────────────────────────
const FAKE_PLACE: DiscoveryPlace = {
  id:           'place-test-1',
  name:         'Test Ramen Shop',
  category:     'food',
  type:         null,
  description:  null,
  distanceKm:   null,
  lat:          35.68,
  lng:          139.69,
  tags:         [],
  address:      '1-1 Test St, Tokyo',
  website:      null,
  phone:        null,
  openingHours: null,
  rating:       null,
  isOpenNow:    null,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryHub — Layover FAB lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnSelectPlace = null;
    capturedOnClose       = null;
  });

  // React 19 + RNTL v14 note: fireEvent.press budget is limited. This test
  // avoids it entirely by calling the captured prop callbacks directly inside
  // act() — they are the same functions that a press would eventually invoke,
  // so the detailVisible state transitions are honest and not mocked.
  it('FAB visible → sheet opens → FAB hidden → sheet closes → FAB visible', async () => {
    const view = await render(<DiscoveryHub />);
    await act(async () => {});

    // ── 1. Initial state: no sheet open → FAB must be present ──
    expect(view.queryByText('Layover Mode')).not.toBeNull();

    // Sanity: prop-capture hooks must have fired during render.
    expect(typeof capturedOnSelectPlace).toBe('function');
    expect(typeof capturedOnClose).toBe('function');

    // ── 2. Open the place detail sheet → FAB must disappear ──
    await act(async () => {
      capturedOnSelectPlace!(FAKE_PLACE);
    });
    expect(view.queryByText('Layover Mode')).toBeNull();

    // ── 3. Close the place detail sheet → FAB must reappear ──
    await act(async () => {
      capturedOnClose!();
    });
    expect(view.queryByText('Layover Mode')).not.toBeNull();
  });
});
