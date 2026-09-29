/**
 * census-discovery §108 (DV-83 round 11, D-W11X2-79). GET /hashtags/trending now reads its 48 h window
 * to the end; a window it cannot read completely is served with the Discovery refusal envelope,
 * coverage `partial`, beside the chips it could rank. The Discover screen branched on `ok` alone, so a
 * partial ranking would have been drawn as the complete trending list, and a `nothing` refusal as
 * "nothing trending". It now branches on the refusal's coverage: `partial` keeps the chips under a
 * "may be incomplete" line; anything else is the failed line.
 *
 *   TP1  a `partial` refusal beside chips → the chips AND the incomplete line
 *   TP2  a `nothing` refusal → the failed line, never an absent chip bar
 *   TP3  a refusal with an unknown coverage beside chips → the failed line, never a complete list
 *   TPc  CONTROL: a healthy read → the chips, no incomplete line, no failed line
 *
 * Harness copied from discovery.trendingCityChange.component.test.tsx (itself from discovery.featuredBanner).
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
// NOTE: a stand-in on purpose — each case fixes the city's trending answer: a partial refusal beside chips (Lisbon), a `nothing` refusal (Oslo), an unknown coverage (Kyiv), a healthy read (Paris).
jest.mock('../../../src/services/hashtag', () => {
  const refusal = (coverage: unknown) => ({ class: 'transient_db', code: 'trending_window_incomplete', route: 'GET /hashtags/trending', coverage, failedSources: ['hashtag_usage'] });
  return {
    getTrendingHashtags: jest.fn(async (_scope: string, city: string | null) => {
      if (city === 'Lisbon') return { ok: true, data: { trending: [{ id: 'h2', slug: 'lisbontram', usageCount: 9 }], scope: 'city', city: 'Lisbon', refusal: refusal('partial') } };
      if (city === 'Oslo') return { ok: true, data: { trending: [], scope: 'city', city: 'Oslo', refusal: refusal('nothing') } };
      if (city === 'Kyiv') return { ok: true, data: { trending: [{ id: 'h3', slug: 'kyivcafe', usageCount: 4 }], scope: 'city', city: 'Kyiv', refusal: refusal('some_future_value') } };
      return { ok: true, data: { trending: [{ id: 'h1', slug: 'parisbistro', usageCount: 5 }], scope: 'city', city: 'Paris' } };
    }),
  };
});

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
let mockIsAuthed = false; let mockCity = 'Paris';

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: mockIsAuthed ? 'user-1' : null, isAuthed: mockIsAuthed }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState: {
      place:  { city: mockCity, country: 'France' },
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


describe('§108 DiscoveryHub — the trending chips branch on the refusal\'s coverage', () => {
  it('TP1 a `partial` refusal beside chips → the chips and the incomplete line', async () => {
    mockIsAuthed = true; mockCity = 'Lisbon';
    const view = await render(<DiscoveryHub key="tp1" />);
    await act(async () => {}); await act(async () => {});
    expect(view.queryByText('lisbontram')).not.toBeNull();
    expect(view.queryByText(/may be incomplete/)).not.toBeNull();
    expect(view.queryByText(/load trending tags/)).toBeNull();
  });

  it('TP2 a `nothing` refusal → the failed line', async () => {
    mockIsAuthed = true; mockCity = 'Oslo';
    const view = await render(<DiscoveryHub key="tp2" />);
    await act(async () => {}); await act(async () => {});
    expect(view.queryByText(/load trending tags/)).not.toBeNull();
  });

  it('TP3 an unknown coverage beside chips → the failed line, never the chips as a complete list', async () => {
    mockIsAuthed = true; mockCity = 'Kyiv';
    const view = await render(<DiscoveryHub key="tp3" />);
    await act(async () => {}); await act(async () => {});
    expect(view.queryByText('kyivcafe')).toBeNull();
    expect(view.queryByText(/load trending tags/)).not.toBeNull();
  });

  it('TPc CONTROL: a healthy read → the chips, no incomplete line, no failed line', async () => {
    mockIsAuthed = true; mockCity = 'Paris';
    const view = await render(<DiscoveryHub key="tpc" />);
    await act(async () => {}); await act(async () => {});
    expect(view.queryByText('parisbistro')).not.toBeNull();
    expect(view.queryByText(/may be incomplete/)).toBeNull();
    expect(view.queryByText(/load trending tags/)).toBeNull();
  });
});
