/**
 * Discovery (app/(tabs)/discovery.tsx) — header/tab architecture regression test.
 *
 * DIVERGENCE FROM THE MOBILE TREE (rule 13 rewrite):
 * The mobile Discovery screen passes its header (title + search + filters) INTO
 * ForYouTab as a `listHeaderComponent` prop so the header scrolls with the list.
 * The STANDALONE fork does NOT do this — app/(tabs)/discovery.tsx renders a
 * fixed chrome layout: a search entry bar, a header row (Compass icon +
 * "Discover" title + DestinationBar), then a content area containing the active
 * tab (ForYouTab / DiscoveryCategoryTab) with floating chrome (tab bar + filter
 * panel) overlaid on top. ForYouTab receives NO `listHeaderComponent` prop.
 *
 * This test pins the standalone's ACTUAL contract:
 *   1. ForYouTab renders (the default active tab) and receives NO
 *      listHeaderComponent prop (the header is fixed chrome, not in-list).
 *   2. The "Discover" title renders in the tree as fixed header chrome.
 *   3. The tab content area is a distinct sibling below the header chrome.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';

// ── Safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── Reanimated ────────────────────────────────────────────────────────────────
jest.mock('react-native-reanimated', () => {
  const RN = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: { View: RN.View, ScrollView: RN.ScrollView },
    useAnimatedStyle: () => ({}),
    interpolate: (_v: number, _in: number[], out: number[]) => out[0],
    useSharedValue: (v: number) => ({ value: v }),
    withSpring: (v: number) => v,
    withTiming: (v: number) => v,
  };
});

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({}),
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
}));

// NOTE: all src/ modules are 3 directories up from app/(tabs)/__tests__/.
// Path: __tests__ → (tabs) → app → package-root → src/

// ── Nav-bar collapse + bottom inset ───────────────────────────────────────────
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller: () => null,
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  usePlainBottomInset: () => 130,
  PlainBottomFiller: () => null,
  BOTTOM_BREATHING_ROOM: 24,
  useStickyBarInset: () => ({ inset: 130, onBarLayout: () => {} }),
  useKeyboardVisible: () => false,
  useBottomInset: () => 130,
  useLayoverAwareBottomInset: () => 130,
}));

// ── Session + location ────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ configured: true, isAuthed: true, userId: 'u1' }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    // resolvedLocation is the unified source of truth after Task #1534 merge.
    resolvedLocation: {
      place: { city: 'Barcelona' },
      coords: { lat: 41.38, lng: 2.17 },
      source: 'gps',
      freshness: 'live',
    },
    locationState: {
      ok: true,
      permissionStatus: 'granted',
      place: { city: 'Barcelona' },
      coords: { lat: 41.38, lng: 2.17 },
    },
    showCityPicker: false,
    openCityPicker: jest.fn(),
    closeCityPicker: jest.fn(),
    isLoading: false,
    setSessionLocation: jest.fn(),
    clearSessionLocation: jest.fn(),
  }),
}));

// ── Hooks ─────────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useRentABuddyFlag', () => ({
  useRentABuddyFlag: () => ({ enabled: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useFollowingHighlights', () => ({
  useFollowingHighlights: () => ({ highlights: [], loading: false }),
}));

// ── Services ──────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/hashtag', () => ({
  getTrendingHashtags: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryCategoryCounts:      jest.fn().mockResolvedValue({ ok: false }),
  getDiscoveryCategoryCountsBatch: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/trips', () => ({
  listMyTrips: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/rentABuddy', () => ({
  getAvailableNow: jest.fn().mockResolvedValue({ ok: false }),
}));

// ── ForYouTab stub — captures its full props ──────────────────────────────────
// The standalone fork does NOT pass a listHeaderComponent; we capture all props
// so the test can assert that key is genuinely absent (not merely null).
let capturedForYouProps: Record<string, any> | null = null;
let forYouRendered = false;
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/ForYouTab', () => ({
  ForYouTab: (props: Record<string, any>) => {
    capturedForYouProps = props;
    forYouRendered = true;
    return null;
  },
}));

// ── Sub-components with correct subdirectory paths ────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/DiscoveryCategoryTab',    () => ({ DiscoveryCategoryTab:    () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/PlaceDetailSheet',        () => ({ PlaceDetailSheet:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/DestinationBar',          () => ({ DestinationBar:          () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SubmitPlaceSheet',        () => ({ SubmitPlaceSheet:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SectionErrorBoundary',    () => ({
  SectionErrorBoundary: ({ children }: any) => children,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassBuddyRow',           () => ({ CompassBuddyRow:         () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ManualCityPicker',                  () => ({ ManualCityPicker:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet',          () => ({ LayoverModeSheet:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/RouteBuilderSheet',                 () => ({ RouteBuilderSheet:       () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/FollowingHighlightsStrip',          () => ({ FollowingHighlightsStrip: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PlanPickerController',              () => ({
  usePlanPicker: () => ({ open: jest.fn(), close: jest.fn(), PlanPickerSheet: () => null }),
}));

import DiscoveryHub from '../discovery.tsx';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryHub screen — header/tab architecture (standalone)', () => {
  beforeEach(() => {
    capturedForYouProps = null;
    forYouRendered = false;
  });

  it('ForYouTab renders as the default tab and receives NO listHeaderComponent (header is fixed chrome)', async () => {
    await render(<DiscoveryHub />);
    await act(async () => {});

    // The default active tab is 'for_you', so ForYouTab must render.
    expect(forYouRendered).toBe(true);
    expect(capturedForYouProps).not.toBeNull();
    // The standalone fork renders the header as fixed chrome — it does NOT pass
    // the header into ForYouTab as a scrollable listHeaderComponent.
    expect('listHeaderComponent' in (capturedForYouProps as Record<string, any>)).toBe(false);
  });

  it('"Discover" title renders as fixed header chrome in the main tree', async () => {
    // ForYouTab is stubbed to null, so the only place "Discover" can appear is
    // the fixed header row rendered by discovery.tsx itself.
    const view = await render(<DiscoveryHub />);
    await act(async () => {});

    expect(view.getByText('Discover')).toBeTruthy();
  });

  it('the tab content area is a distinct sibling below the fixed header chrome', async () => {
    const { toJSON } = await render(<DiscoveryHub />);
    await act(async () => {});

    const tree = toJSON() as any;
    const rootChildren: any[] = Array.isArray(tree?.children) ? tree.children : [];

    // The standalone root View lays out: search entry bar, header row, then the
    // content area — all as fixed (non-absolute) chrome siblings. Confirm there
    // is MORE than one non-overlay sibling, i.e. the header is NOT folded into
    // the tab list (which is the mobile architecture this fork diverges from).
    let nonOverlaySiblings = 0;
    for (const child of rootChildren) {
      if (!child || typeof child !== 'object') continue;
      if (child.type === 'RCTModalHostView' || child.type === 'Modal') continue;
      const style = child?.props?.style ?? {};
      const flat = Array.isArray(style)
        ? Object.assign({}, ...style.map((s: any) => (s && typeof s === 'object' ? s : {})))
        : style;
      if (flat.position !== 'absolute') nonOverlaySiblings += 1;
    }

    expect(nonOverlaySiblings).toBeGreaterThan(1);
  });
});
