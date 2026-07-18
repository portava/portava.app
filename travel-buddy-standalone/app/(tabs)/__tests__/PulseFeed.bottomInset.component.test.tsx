/**
 * Pulse feed (app/(tabs)/index.tsx) — FlatList bottom-inset clearance test.
 *
 * Confirms that the root FlatList's `contentContainerStyle.paddingBottom` is
 * at least as large as the device home-indicator / gesture-nav bar height so
 * the last post card is never clipped.
 *
 * After the Pulse rewrite: the screen uses a hardcoded paddingBottom of 120
 * (which exceeds any common home-indicator height). This test pins that
 * contract so a future refactor cannot silently drop the clearance.
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
/** Minimum clearance expected from Pulse's hardcoded paddingBottom (120). */
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
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

// Nav bar collapse
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  navBarProgress: { value: 0 },
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// expo-router
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (cb: () => void) => { cb(); },
}));

// ── Comment count store ───────────────────────────────────────────────────────
jest.mock('../../../src/lib/commentCountStore', () => ({
  getCommentCountSnapshot: () => new Map(),
  subscribeCommentCount:   () => () => {},
}));

// ── ScreenErrorBoundary — passthrough ─────────────────────────────────────────
jest.mock('@/components/ScreenErrorBoundary', () => ({
  ScreenErrorBoundary: ({ children }: any) => children,
}));

// Heavy feed / city-pulse hooks — return stable empty state.
jest.mock('../../../src/hooks/useCityPulse', () => ({
  useCityPulse: () => ({
    buckets: { fitsAvailability: [], openNearby: [], flexible: [] },
    status: 'not_set',
  }),
}));

// usePulseFeed replaced useGlobalFeed as the primary Pulse feed hook.
jest.mock('../../../src/hooks/usePulseFeed', () => ({
  usePulseFeed: () => ({
    items: [], placeCards: [], loading: false, loadingMore: false,
    error: null, reload: jest.fn(), loadMore: jest.fn(), markDeleted: jest.fn(),
  }),
}));

jest.mock('../../../src/hooks/usePosts', () => ({
  useFollowingFeed: () => ({
    data: [], loading: false, loadingMore: false, error: null,
    markDeleted: jest.fn(), reload: jest.fn(), loadMore: jest.fn(),
  }),
}));

jest.mock('../../../src/hooks/useRentABuddyFlag', () => ({
  useRentABuddyFlag: () => ({ enabled: false }),
}));

jest.mock('../../../src/hooks/useCircleFlag', () => ({
  useCircleFlag: () => ({ enabled: false }),
}));

jest.mock('../../../src/hooks/useLivePulse', () => ({
  useLivePulse: () => ({ refresh: jest.fn() }),
}));

jest.mock('../../../src/services/intelligence', () => ({
  fetchPreferences: jest.fn().mockResolvedValue({ ok: false }),
}));

jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState: { place: { city: 'Cebu City' }, coords: null },
    openCityPicker: jest.fn(),
  }),
}));

// Heavy UI components — render plain null.
jest.mock('../../../src/components/PulseHeader',             () => ({ PulseHeader:            () => null }));
jest.mock('../../../src/components/PulseFits',               () => ({ FitsCard: () => null, FlexibleStrip: () => null }));
jest.mock('../../../src/components/PulseFeedCard',           () => ({ PulseFeedCard:          () => null }));
jest.mock('../../../src/components/PulseCreate',             () => ({ PulseFilterSheet: () => null, UnifiedPostComposer: () => null }));
jest.mock('../../../src/components/primitives',              () => ({ TravelEmptyState:        () => null }));
jest.mock('../../../src/components/PostCard',                () => ({ PostCard:                () => null }));
jest.mock('../../../src/components/LocationPermissionPrompt',() => ({ LocationPermissionPrompt: () => null }));
jest.mock('../../../src/components/ManualCityPicker',        () => ({ ManualCityPicker:        () => null }));
jest.mock('../../../src/components/layover/LayoverModeSheet', () => ({ LayoverModeSheet:       () => null }));
jest.mock('../../../src/components/layover/ActiveLayoverPill',() => ({ ActiveLayoverPill:      () => null }));
jest.mock('../../../src/components/PeopleYouMayKnow',        () => ({ PeopleYouMayKnow:        () => null }));
jest.mock('../../../src/components/CircleCompassSuggestions', () => ({ CircleCompassSuggestions: () => null }));
jest.mock('../../../src/components/LivePulseRail',           () => ({ LivePulseRail:           () => null }));
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
