/**
 * DiscoveryHub — the plan picker is opened WITH the served rank surface.
 *
 * THE DEFECT THIS IS WRITTEN AGAINST
 * ----------------------------------
 * PlanPickerController reports the `trip_add` rung of the Discovery funnel
 * (migration 2894), but it can only do so against the surface the item's
 * IMPRESSION was written under, and it refuses to guess: a source with no
 * rankSurface hands useRankOutcome a null surface and every report is a no-op.
 *
 * This screen serves its places under surface='discovery' — the same value it
 * already hands PlaceDetailSheet and PlaceCard for tap/save. If its
 * openPlanPicker() call omits that value the whole chain still "works": the add
 * succeeds, the toast shows, no error is raised anywhere, and not one trip_add
 * row is ever written. That silence is what this pins.
 *
 * Run with:  pnpm test:component
 */

import React from 'react';
import { act, render } from '@testing-library/react-native';
import DiscoveryHub from '../discovery.tsx';
import type { DiscoveryPlace } from '../../../src/services/discovery';

// ── react-native Proxy mock ───────────────────────────────────────────────────
// DiscoveryHub mounts a raw <Modal> (age-filter picker). Its animation lifecycle
// leaves a floating async act() scope that corrupts act depth for later renders.
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
  // 'places' so DiscoveryCategoryTab renders — it is what carries onAddToPlan.
  useLocalSearchParams: () => ({ category: 'places' }),
  usePathname:          () => '/',
  useSegments:          () => [],
  useFocusEffect: (cb: () => (() => void) | void) => {
    const R = require('react');
    R.useEffect(() => {
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

// NOTE: intentional stub — insets are irrelevant here.
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

const mockLocationState = {
  place:  { city: 'Tokyo', country: 'Japan' },
  coords: { lat: 35.6762, lng: 139.6503 },
};
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState:    mockLocationState,
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

// ── The subject: what this screen hands the picker ────────────────────────────
const mockOpen = jest.fn();
// NOTE: intentionally exhaustive — the real controller renders the whole picker
// tree; only the descriptor it is opened with is under test.
jest.mock('../../../src/components/PlanPickerController', () => ({
  usePlanPicker: () => ({ open: mockOpen, isAdded: () => false }),
}));

// ── Prop-capture stubs ────────────────────────────────────────────────────────
let capturedOnAddToPlan: ((place: DiscoveryPlace) => void) | null = null;
// NOTE: captures onAddToPlan; no other prop matters here.
jest.mock('../../../src/components/discovery/DiscoveryCategoryTab', () => ({
  DiscoveryCategoryTab: (props: {
    onAddToPlan?: (p: DiscoveryPlace) => void;
    listHeaderComponent?: React.ReactElement | null;
  }) => {
    capturedOnAddToPlan = props.onAddToPlan ?? null;
    return props.listHeaderComponent ?? null;
  },
}));

let capturedSheetSurface: unknown;
// NOTE: captures rankSurface so the two sites can be compared, not just asserted.
jest.mock('../../../src/components/discovery/PlaceDetailSheet', () => ({
  PlaceDetailSheet: (props: { rankSurface?: unknown }) => {
    capturedSheetSurface = props.rankSurface;
    return null;
  },
}));

const Null = () => null;
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet',    () => ({ LayoverModeSheet:         Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/ForYouTab',         () => ({ ForYouTab:                Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/DestinationBar',    () => ({ DestinationBar:           Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassBuddyRow',     () => ({ CompassBuddyRow:          Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CityConfidenceBadge', () => ({ CityConfidenceBadge:      Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ManualCityPicker',            () => ({ ManualCityPicker:         Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/FollowingHighlightsStrip',    () => ({ FollowingHighlightsStrip: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/RouteBuilderSheet',           () => ({ RouteBuilderSheet:        Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SubmitPlaceSheet',  () => ({ SubmitPlaceSheet:         Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SectionErrorBoundary', () => ({
  SectionErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

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

// ── Test ──────────────────────────────────────────────────────────────────────

describe('DiscoveryHub — trip_add attribution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnAddToPlan  = null;
    capturedSheetSurface = undefined;
  });

  // No fireEvent.press: the captured prop IS the function a press eventually
  // calls, so the state transition is honest and the React 19 + RNTL press
  // budget is left alone.
  it("opens the plan picker with rankSurface 'discovery' — the same surface its outcomes report under", async () => {
    await render(<DiscoveryHub />);
    await act(async () => {});

    expect(typeof capturedOnAddToPlan).toBe('function');
    await act(async () => { capturedOnAddToPlan!(FAKE_PLACE); });

    expect(mockOpen).toHaveBeenCalledTimes(1);
    const descriptor = mockOpen.mock.calls[0][0] as Record<string, unknown>;
    expect(descriptor.id).toBe('place-test-1');
    expect(descriptor.rankSurface).toBe('discovery');
    // The value is not a coincidence: it is the SAME surface this screen already
    // hands PlaceDetailSheet for tap/save, which is what makes the trip_add land
    // on the impression row those outcomes upgrade.
    expect(descriptor.rankSurface).toBe(capturedSheetSurface);
  });
});
