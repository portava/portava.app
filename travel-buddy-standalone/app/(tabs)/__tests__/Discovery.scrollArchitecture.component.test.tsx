/**
 * Discovery (app/(tabs)/discovery.tsx) — scroll-architecture regression test.
 *
 * Confirms that after Task #1519, the discovery header (title + search bar +
 * filters) is passed INTO the ForYouTab as the `listHeaderComponent` prop —
 * NOT rendered as a sibling View above the tab.
 *
 * Run with: pnpm --filter @workspace/travel-buddy test -- --watchAll=false
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';

// ── Safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
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

jest.mock('../../../src/hooks/useBottomInset', () => ({
  useBottomInset: () => 130,
}));

// ── Session + location ────────────────────────────────────────────────────────
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ configured: true, isAuthed: true, userId: 'u1' }),
}));

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
jest.mock('../../../src/hooks/useRentABuddyFlag', () => ({
  useRentABuddyFlag: () => ({ enabled: false }),
}));

jest.mock('../../../src/hooks/useFollowingHighlights', () => ({
  useFollowingHighlights: () => ({ highlights: [], loading: false }),
}));

// ── Services ──────────────────────────────────────────────────────────────────
jest.mock('../../../src/services/hashtag', () => ({
  getTrendingHashtags: jest.fn().mockResolvedValue({ ok: false }),
}));

jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryCategoryCounts:      jest.fn().mockResolvedValue({ ok: false }),
  getDiscoveryCategoryCountsBatch: jest.fn().mockResolvedValue({ ok: false }),
}));

jest.mock('../../../src/services/trips', () => ({
  listMyTrips: jest.fn().mockResolvedValue({ ok: false }),
}));

jest.mock('../../../src/services/rentABuddy', () => ({
  getAvailableNow: jest.fn().mockResolvedValue({ ok: false }),
}));

// ── ForYouTab stub — captures listHeaderComponent prop ────────────────────────
let capturedListHeaderComponent: React.ReactNode = null;
jest.mock('../../../src/components/discovery/ForYouTab', () => ({
  ForYouTab: ({ listHeaderComponent }: { listHeaderComponent?: React.ReactNode }) => {
    capturedListHeaderComponent = listHeaderComponent ?? null;
    return null;
  },
}));

// ── Sub-components with correct subdirectory paths ────────────────────────────
jest.mock('../../../src/components/discovery/DiscoveryCategoryTab',    () => ({ DiscoveryCategoryTab:    () => null }));
jest.mock('../../../src/components/discovery/PlaceDetailSheet',        () => ({ PlaceDetailSheet:        () => null }));
jest.mock('../../../src/components/discovery/DestinationBar',          () => ({ DestinationBar:          () => null }));
jest.mock('../../../src/components/discovery/SubmitPlaceSheet',        () => ({ SubmitPlaceSheet:        () => null }));
jest.mock('../../../src/components/discovery/SectionErrorBoundary',    () => ({
  SectionErrorBoundary: ({ children }: any) => children,
}));
jest.mock('../../../src/components/compass/CompassBuddyRow',           () => ({ CompassBuddyRow:         () => null }));
jest.mock('../../../src/components/ManualCityPicker',                  () => ({ ManualCityPicker:        () => null }));
jest.mock('../../../src/components/layover/LayoverModeSheet',          () => ({ LayoverModeSheet:        () => null }));
jest.mock('../../../src/components/RouteBuilderSheet',                 () => ({ RouteBuilderSheet:       () => null }));
jest.mock('../../../src/components/FollowingHighlightsStrip',          () => ({ FollowingHighlightsStrip: () => null }));
jest.mock('../../../src/components/PlanPickerController',              () => ({
  usePlanPicker: () => ({ open: jest.fn(), close: jest.fn(), PlanPickerSheet: () => null }),
}));

import DiscoveryHub from '../discovery.tsx';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryHub screen — scroll architecture', () => {
  beforeEach(() => {
    capturedListHeaderComponent = null;
  });

  it('ForYouTab receives a non-null listHeaderComponent — header is inside the scroll container', async () => {
    await render(<DiscoveryHub />);
    await act(async () => {});

    // The discovery header (title, search, filters) must be passed INTO the
    // tab's list as its scrollable header — not rendered as an independent
    // sibling above the tab component.
    expect(capturedListHeaderComponent).not.toBeNull();
  });

  it('listHeaderComponent contains the "Discover" title when rendered standalone', async () => {
    await render(<DiscoveryHub />);
    await act(async () => {});

    // ForYouTab is stubbed (returns null), so discoveryHeader never appears in
    // the main DOM tree.  Render the captured prop in isolation to confirm the
    // "Discover" title is present inside the header block.
    expect(capturedListHeaderComponent).not.toBeNull();

    const { getByText } = await render(
      capturedListHeaderComponent as React.ReactElement,
    );
    expect(getByText('Discover')).toBeTruthy();
  });

  it('root View has no non-overlay header sibling above the tab component', async () => {
    const { toJSON } = await render(<DiscoveryHub />);
    await act(async () => {});

    const tree = toJSON() as any;
    const rootChildren: any[] = Array.isArray(tree?.children) ? tree.children : [];

    // Modal hosts are acceptable overlays; skip them.
    // Any remaining non-absolute child above the tab is a fixed header split.
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

    // At most one non-overlay root child: the tab container.
    expect(nonOverlaySiblings).toBeLessThanOrEqual(1);
  });
});
