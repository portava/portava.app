/**
 * DiscoveryHub — Featured by Portava banner
 *
 * Confirms:
 *   1. The "Featured by Portava" banner is rendered on the Discover tab.
 *   2. Pressing the banner fires router.push('/featured').
 *   3. The banner is present in both authenticated and unauthenticated states.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import DiscoveryHub from '../discovery.tsx';

// ── react-native Proxy mock ───────────────────────────────────────────────────
// DiscoveryHub mounts a raw <Modal> (age filter). Modal's animation lifecycle
// leaves a floating async act() scope inside RNTL's render() promise; the next
// act() collides with it, corrupting the act-scope depth so every later render
// in this file commits an EMPTY tree.  Stubbing Modal as a plain conditional
// View keeps the lifecycle synchronous.  ActivityIndicator must be stubbed too:
// through the Proxy its getter re-enters with `this === Proxy` and can hit
// uninitialised native-module stubs.
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
// IMPORTANT: jest.mock factories are hoisted to the top of the file by Babel,
// BEFORE any const/let/var declarations run.  Any module-level variable
// referenced inside the factory is `undefined` at hoist time (temporal dead
// zone for const/let).  Use jest.fn() directly inside the factory and access
// the mock reference via require('expo-router').router inside the test body.
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
  usePlainBottomInset:        () => 130,
  PlainBottomFiller:          () => null,
  BOTTOM_BREATHING_ROOM:      24,
  useStickyBarInset:          () => ({ inset: 130, onBarLayout: () => {} }),
  useKeyboardVisible:         () => false,
  useBottomInset:             () => 130,
  useLayoverAwareBottomInset: () => 130,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useCollapsingHeader', () => ({
  useCollapsingHeader: () => ({
    largeHeaderStyle:      {},
    compactBarStyle:       {},
    compactBarInteractive: true,
  }),
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
// Mutable — flipped between the two render scenarios below.
let mockIsAuthed = false;

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: mockIsAuthed ? 'user-1' : null, isAuthed: mockIsAuthed }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState: {
      place:  { city: 'Paris', country: 'France' },
      coords: { lat: 48.86, lng: 2.35 },
    },
    resolvedLocation: {
      place:     { city: 'Paris', country: 'France' },
      coords:    { lat: 48.86, lng: 2.35 },
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

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: () => false }),
}));

// ── PlanPickerController ──────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PlanPickerController', () => ({
  usePlanPicker: () => ({ open: jest.fn() }),
}));

// ── Heavy sub-components ──────────────────────────────────────────────────────
const Null = () => null;

// The tabs receive discoveryHeader as listHeaderComponent and render it inside
// their FlatList.  Rendering it from the stub keeps the header UI (including
// the Featured banner) accessible without pulling in the tabs' native deps.
const HeaderOnly = ({ listHeaderComponent }: { listHeaderComponent?: React.ReactElement | null }) =>
  listHeaderComponent ?? null;

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet',         () => ({ LayoverModeSheet:         Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/DiscoveryCategoryTab',   () => ({ DiscoveryCategoryTab:     HeaderOnly }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/PlaceDetailSheet',       () => ({ PlaceDetailSheet:         Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/ForYouTab',              () => ({ ForYouTab:                HeaderOnly }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/DestinationBar',         () => ({ DestinationBar:           Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassBuddyRow',          () => ({ CompassBuddyRow:          Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CityConfidenceBadge',      () => ({ CityConfidenceBadge:      Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ManualCityPicker',                 () => ({ ManualCityPicker:         Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/FollowingHighlightsStrip',         () => ({ FollowingHighlightsStrip: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/RouteBuilderSheet',                () => ({ RouteBuilderSheet:        Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SubmitPlaceSheet',       () => ({ SubmitPlaceSheet:         Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/DiscoveryEventPostCard', () => ({ DiscoveryEventPostCard:   Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/BuddyCard',                        () => ({ BuddyCardSkeleton:        Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/loading/PlaceCardSkeleton',        () => ({ PlaceCardSkeleton:        Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/loading/EventCardSkeleton',        () => ({ EventCardSkeleton:        Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui/AppHeader',                     () => ({ AppHeader:                Null }));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SectionErrorBoundary', () => ({
  SectionErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/discoveryLocalCache', () => ({
  loadCachedCounts: jest.fn().mockResolvedValue(null),
  saveCachedCounts: jest.fn().mockResolvedValue(undefined),
}));

// ── Constant ──────────────────────────────────────────────────────────────────
const BANNER_A11Y_LABEL = "Featured by Portava — see this week's top picks";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryHub — Featured by Portava banner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAuthed = false;
  });

  // RENDERER CONSTRAINTS (React 19 + RNTL v14):
  // Only the first render's presses reliably commit state changes; later
  // renders degrade.  All assertions are therefore consolidated into one test:
  // unauthenticated render (banner present + press confirmed), then rerender as
  // authenticated (banner still present — no press needed, no budget wasted).
  //
  // router.push is accessed via require('expo-router').router.push inside the
  // test body (not captured at module scope) because jest.mock factories are
  // hoisted above const declarations — a module-level variable would be
  // undefined inside the factory and therefore undefined at call time too.

  it('renders the banner and navigates to /featured when pressed — in both auth states', async () => {
    // ── Unauthenticated ──────────────────────────────────────────────────────
    mockIsAuthed = false;
    const view = await render(<DiscoveryHub key="unauthed" />);
    await act(async () => {});

    // Banner is visible for unauthenticated users.
    expect(view.getByLabelText(BANNER_A11Y_LABEL)).toBeTruthy();
    expect(view.getByText('Featured by Portava 🏆')).toBeTruthy();

    // Pressing the banner routes to /featured.
    // Access router.push via require so we get the live jest.fn() reference
    // that was registered by the factory (not a hoisted-undefined variable).
    const { router } = require('expo-router') as { router: { push: jest.Mock } };
    fireEvent.press(view.getByLabelText(BANNER_A11Y_LABEL));
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith('/featured');

    // Flush post-press state updates.
    await act(async () => {});

    // ── Authenticated ────────────────────────────────────────────────────────
    // Rerender as a new instance (key change) so the authenticated session
    // context takes effect; no press needed — banner presence is what matters.
    mockIsAuthed = true;
    view.rerender(<DiscoveryHub key="authed" />);
    await act(async () => {});

    // Banner must be present regardless of auth state — it is not gated.
    expect(view.getByLabelText(BANNER_A11Y_LABEL)).toBeTruthy();
    expect(view.getByText('Featured by Portava 🏆')).toBeTruthy();
  });
});
