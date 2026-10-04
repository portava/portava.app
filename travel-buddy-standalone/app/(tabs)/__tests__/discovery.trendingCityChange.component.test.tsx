/**
 * census-discovery §104 (DV-83, D-W11X2-57). V7-H1 is the §103.11 verifier's probe, copied in
 * unchanged (red at 67d900e55); H2–H4 pin the failed state (an ok:false answer, a rejected read) and its control.
 *
 * v7 verifier probe (DV-83 clause c, wrong rows): the Discover screen's trending-hashtag chips.
 * Paris's chips are on screen; the city becomes Rome and Rome's trending read FAILS.
 * Paris's chips must not stay on screen as Rome's (no notice, no remount).
 * Harness copied from discovery.featuredBanner.component.test.tsx.
 *
 * (original header:) DiscoveryHub — Featured by Portava banner
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
// NOTE: a stand-in on purpose — the probe fixes each city's trending answer: Paris reads, Rome fails.
jest.mock('../../../src/services/hashtag', () => ({
  getTrendingHashtags: jest.fn(async (_scope: string, city: string | null) => (city === 'Paris'
    ? { ok: true, data: { trending: [{ id: 'h1', slug: 'parisbistro', usageCount: 5 }], scope: 'city', city: 'Paris' } }
    : { ok: false, error: 'http_503' })),
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


// §104's own pins run first: the probe's bare rerender (kept verbatim) leaves the act scope
// in the state the harness header describes, so a render after it commits an empty tree.
describe('§104 DiscoveryHub — the trending chips say a failed read', () => {
  it('H2 the city\'s trending read fails → the failed line, not an absent chip bar', async () => {
    mockIsAuthed = true; mockCity = 'Rome';
    const view = await render(<DiscoveryHub key="h2" />);
    await act(async () => {}); await act(async () => {});
    expect(view.queryByText(/load trending tags/)).not.toBeNull();
  });

  it('H3 CONTROL the city\'s read answers → its chips, no failed line; a later failed city drops them and says so', async () => {
    mockIsAuthed = true; mockCity = 'Paris';
    const view = await render(<DiscoveryHub key="h3" />);
    await act(async () => {}); await act(async () => {});
    expect(view.queryByText('parisbistro')).not.toBeNull();
    expect(view.queryByText(/load trending tags/)).toBeNull();
    mockCity = 'Rome';
    await act(async () => { view.rerender(<DiscoveryHub key="h3" />); });
    await act(async () => {}); await act(async () => {});
    expect(view.queryByText('parisbistro')).toBeNull();
    expect(view.queryByText(/load trending tags/)).not.toBeNull();
  });

  it('H4 the trending read REJECTS (thrown, not an ok:false answer) → the failed line too', async () => {
    mockIsAuthed = true; mockCity = 'Paris';
    const { getTrendingHashtags } = require('../../../src/services/hashtag') as { getTrendingHashtags: jest.Mock };
    getTrendingHashtags.mockImplementationOnce(async () => { throw new Error('socket hang up'); });
    const view = await render(<DiscoveryHub key="h4" />);
    await act(async () => {}); await act(async () => {});
    expect(view.queryByText('parisbistro')).toBeNull();
    expect(view.queryByText(/load trending tags/)).not.toBeNull();
  });
});

describe('§103.11 verifier probe: DiscoveryHub — trending hashtags across a city change', () => {
  it('V7-H1 Paris chips, then Rome read fails → Paris chips are not drawn as Rome\'s', async () => {
    mockIsAuthed = true; mockCity = 'Paris';
    const view = await render(<DiscoveryHub key="k" />);
    await act(async () => {}); await act(async () => {});
    const parisShown = view.queryByText('parisbistro') !== null;
    mockCity = 'Rome';
    view.rerender(<DiscoveryHub key="k" />);
    await act(async () => {}); await act(async () => {});
    const { getTrendingHashtags } = require('../../../src/services/hashtag') as { getTrendingHashtags: jest.Mock };
    const askedRome = getTrendingHashtags.mock.calls.some((c) => c[1] === 'Rome');
    expect({ parisShown, askedRome, parisChipUnderRome: view.queryByText('parisbistro') !== null }).toEqual({ parisShown: true, askedRome: true, parisChipUnderRome: false });
  });
});
