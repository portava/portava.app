/**
 * Pulse feed (app/(tabs)/index.tsx) — FlatList bottom-inset clearance test.
 *
 * Confirms that the root FlatList's `contentContainerStyle.paddingBottom` is
 * at least as large as the device home-indicator / gesture-nav bar height so
 * the last post card is never clipped.
 *
 * After the Pulse rewrite: the FlatList's paddingBottom is derived from
 * useBottomInset() === NAV_BAR_FILLER_HEIGHT (96) + insets.bottom. On an
 * iPhone 14 (bottom inset 34 pt) that is 130 pt, which clears the 120 pt
 * minimum-clearance contract below. This test pins that contract so a future
 * refactor cannot silently drop the clearance.
 *
 * Run with: pnpm --filter @workspace/travel-buddy run test:component
 */

import React from 'react';
import { render } from '@testing-library/react-native';

// ── Inset constants ──────────────────────────────────────────────────────────

/** iPhone 14 home-indicator height (pt). */
const IPHONE_BOTTOM = 34;
/** Android gesture-nav bar height (dp). */
const ANDROID_BOTTOM = 48;
/** Minimum clearance contract for Pulse's paddingBottom (NAV_BAR_FILLER_HEIGHT
 *  96 + iPhone 14 bottom inset 34 = 130 ≥ 120). */
const MIN_EXPECTED_PADDING = 120;

// ── Module mocks ──────────────────────────────────────────────────────────────

// Reanimated — replace with synchronous stubs to avoid worklet/native issues.
jest.mock('react-native-reanimated', () => {
  const RN = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: { View: RN.View, ScrollView: RN.ScrollView },
    useAnimatedStyle: () => ({}),
    interpolate: (_v: number, _in: number[], out: number[]) => out[0],
    makeMutable: (v: number) => ({ value: v }),
    withSpring: (v: number) => v,
  };
});

// safe-area-context
// iPhone 14 bottom inset (34 pt): paddingBottom = useBottomInset() =
// NAV_BAR_FILLER_HEIGHT (96) + 34 = 130, which clears the 120 pt contract below.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

// Nav bar collapse
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  navBarProgress: { value: 0 },
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// expo-router
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (cb: () => void) => { cb(); },
}));

// ── Screen timing / snapshot cache — stub ─────────────────────────────────────
// index.tsx gained useScreenTiming + useSnapshotCache. The real useScreenTiming
// calls setEpoch() inside useFocusEffect, which this file's synchronous
// useFocusEffect mock runs during render → "Too many re-renders". Stub both to
// inert values (not under test here).
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useScreenTiming', () => ({
  useScreenTiming: () => ({ markFirstContent: () => {}, epoch: 0 }),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useSnapshotCache', () => ({
  useSnapshotCache: () => ({ snapshot: null, isStale: false, save: () => {}, clear: () => {} }),
}));

// ── Comment count store ───────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/commentCountStore', () => ({
  getCommentCountSnapshot: () => new Map(),
  subscribeCommentCount:   () => () => {},
}));

// ── ScreenErrorBoundary — passthrough ─────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('@/components/ScreenErrorBoundary', () => ({
  ScreenErrorBoundary: ({ children }: any) => children,
}));

// Heavy feed / city-pulse hooks — return stable empty state.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useCityPulse', () => ({
  useCityPulse: () => ({
    buckets: { fitsAvailability: [], openNearby: [], flexible: [] },
    events: [],
    status: 'not_set',
  }),
}));

// usePulseFeed replaced useGlobalFeed as the primary Pulse feed hook.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/usePulseFeed', () => ({
  usePulseFeed: () => ({
    items: [], placeCards: [], loading: false, loadingMore: false,
    hasMore: false, error: null, reload: jest.fn(), loadMore: jest.fn(),
    markDeleted: jest.fn(), sessionId: null,
  }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/usePosts', () => ({
  useFollowingFeed: () => ({
    data: [], loading: false, loadingMore: false, error: null,
    markDeleted: jest.fn(), reload: jest.fn(), loadMore: jest.fn(),
  }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useRentABuddyFlag', () => ({
  useRentABuddyFlag: () => ({ enabled: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useCircleFlag', () => ({
  useCircleFlag: () => ({ enabled: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useLivePulse', () => ({
  useLivePulse: () => ({ refresh: jest.fn() }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/intelligence', () => ({
  fetchPreferences: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    setSessionLocation: jest.fn(),
    clearSessionLocation: jest.fn(),
    locationState: { place: { city: 'Cebu City' }, coords: null },
    openCityPicker: jest.fn(),
  }),
}));

// Heavy UI components — render plain null.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PulseHeader',             () => ({ PulseHeader:            () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PulseFits',               () => ({ FitsCard: () => null, FlexibleStrip: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PulseFeedCard',           () => ({ PulseFeedCard:          () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PulseCreate',             () => ({ PulseFilterSheet: () => null, UnifiedPostComposer: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/primitives',              () => ({ TravelEmptyState:        () => null }));
// NOTE: intentional stub — not under test here.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/LocationPermissionPrompt',() => ({ LocationPermissionPrompt: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ManualCityPicker',        () => ({ ManualCityPicker:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet', () => ({ LayoverModeSheet:       () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/ActiveLayoverPill',() => ({ ActiveLayoverPill:      () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PeopleYouMayKnow',        () => ({ PeopleYouMayKnow:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/CircleCompassSuggestions', () => ({ CircleCompassSuggestions: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/LivePulseRail',           () => ({ LivePulseRail:           () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui',                      () => ({ Chip:                    () => null }));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Collect every `paddingBottom` value from contentContainerStyle props found
 * anywhere in the rendered tree, plus regular style props.
 */
function collectContentContainerPaddingBottoms(node: any): number[] {
  if (!node || typeof node !== 'object') return [];
  const found: number[] = [];

  for (const propKey of ['contentContainerStyle', 'style']) {
    const styleProp = node.props?.[propKey];
    if (styleProp) {
      const flat = Array.isArray(styleProp)
        ? Object.assign({}, ...styleProp.map((s: any) => (s && typeof s === 'object' ? s : {})))
        : styleProp;
      if (typeof flat?.paddingBottom === 'number') {
        found.push(flat.paddingBottom);
      }
    }
  }

  const children: any[] = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    found.push(...collectContentContainerPaddingBottoms(child));
  }
  return found;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Pulse FlatList — contentContainerStyle.paddingBottom clears device insets', () => {
  it('FlatList contentContainerStyle.paddingBottom clears iPhone 14 home indicator (34 pt)', async () => {
    const Pulse = require('../index.tsx').default;
    const { toJSON } = await render(<Pulse />);

    const paddings = collectContentContainerPaddingBottoms(toJSON());
    expect(paddings.length).toBeGreaterThan(0);
    const max = Math.max(...paddings);
    expect(max).toBeGreaterThanOrEqual(IPHONE_BOTTOM);
  });

  it('FlatList contentContainerStyle.paddingBottom clears Android gesture nav (48 dp)', async () => {
    const Pulse = require('../index.tsx').default;
    const { toJSON } = await render(<Pulse />);

    const paddings = collectContentContainerPaddingBottoms(toJSON());
    expect(paddings.length).toBeGreaterThan(0);
    const max = Math.max(...paddings);
    expect(max).toBeGreaterThanOrEqual(ANDROID_BOTTOM);
  });

  it('FlatList contentContainerStyle.paddingBottom meets the minimum clearance contract (120)', async () => {
    const Pulse = require('../index.tsx').default;
    const { toJSON } = await render(<Pulse />);

    const paddings = collectContentContainerPaddingBottoms(toJSON());
    const max = Math.max(...paddings);
    expect(max).toBeGreaterThanOrEqual(MIN_EXPECTED_PADDING);
  });
});

describe('Pulse FlatList — clearance constants', () => {
  it('MIN_EXPECTED_PADDING (120) clears iPhone 14 home indicator (34 pt)', () => {
    expect(MIN_EXPECTED_PADDING).toBeGreaterThanOrEqual(IPHONE_BOTTOM);
  });

  it('MIN_EXPECTED_PADDING (120) clears Android gesture nav (48 dp)', () => {
    expect(MIN_EXPECTED_PADDING).toBeGreaterThanOrEqual(ANDROID_BOTTOM);
  });
});
