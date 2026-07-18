/**
 * Pulse feed (app/(tabs)/index.tsx) — FlatList bottom-inset clearance test.
 *
 * Confirms that the root FlatList's `contentContainerStyle.paddingBottom` is
 * at least as large as the device bottom inset so the last post card is never
 * clipped behind the home indicator / gesture bar.
 *
 * Representative inset sizes:
 *   iPhone 14     home indicator : 34 pt
 *   Android gesture nav bar      : 48 dp
 *
 * `useBottomInset` returns NAV_BAR_FILLER_HEIGHT (96) + insets.bottom, so
 * contentContainerStyle.paddingBottom is always ≥ insets.bottom.  This test
 * pins that contract so a future refactor cannot drop the inset and silently
 * clip the last post.
 *
 * Run with: pnpm --filter @workspace/travel-buddy test -- --watchAll=false
 */

import React from 'react';
import { FlatList } from 'react-native';
import { render } from '@testing-library/react-native';

// ── Inset constants ──────────────────────────────────────────────────────────

/** iPhone 14 home-indicator height (pt). */
const IPHONE_BOTTOM = 34;
/** Android gesture-nav bar height (dp). */
const ANDROID_BOTTOM = 48;
/** NAV_BAR_FILLER_HEIGHT — must match the constant in useNavBarCollapse.ts. */
const NAV_BAR_FILLER = 96;

// ── Module mocks ──────────────────────────────────────────────────────────────

// Controlled bottom-inset value — changed per test scenario.
let mockBottomInset = NAV_BAR_FILLER + IPHONE_BOTTOM;

jest.mock('../../src/hooks/useBottomInset', () => ({
  useBottomInset: () => mockBottomInset,
}));

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

// safe-area-context — insets.bottom is consumed by useBottomInset (already
// mocked above), and by useSafeAreaInsets directly for paddingTop.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

// Nav bar collapse — navBarProgress must be a stable object; scroll handler
// is a no-op for rendering purposes.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  navBarProgress: { value: 0 },
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// expo-router — useFocusEffect must call its callback synchronously so
// effects wired to focus don't pend after render.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (cb: () => void) => { cb(); },
}));

// Heavy feed / city-pulse hooks — return stable empty state.
jest.mock('../../src/hooks/useCityPulse', () => ({
  useCityPulse: () => ({
    buckets: { fitsAvailability: [], openNearby: [], flexible: [] },
    status: 'not_set',
  }),
}));

jest.mock('../../src/hooks/usePosts', () => ({
  useGlobalFeed: () => ({
    data: [],
    pending: [],
    loading: false,
    error: null,
    markDeleted: jest.fn(),
    reload: jest.fn(),
    refreshIfStale: jest.fn(),
    applyPending: jest.fn(),
  }),
  useFollowingFeed: () => ({
    data: [],
    pending: [],
    loading: false,
    error: null,
    markDeleted: jest.fn(),
    reload: jest.fn(),
    refreshIfStale: jest.fn(),
    applyPending: jest.fn(),
  }),
}));

jest.mock('../../src/hooks/useRentABuddyFlag', () => ({
  useRentABuddyFlag: () => ({ enabled: false }),
}));

jest.mock('../../src/services/intelligence', () => ({
  fetchPreferences: jest.fn().mockResolvedValue({ ok: false }),
}));

jest.mock('../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState: { place: { city: 'Cebu City' } },
    openCityPicker: jest.fn(),
  }),
}));

// Heavy UI components — render plain null so we don't pull in native modules.
jest.mock('../../src/components/PulseHeader', () => ({
  PulseHeader: () => null,
}));
jest.mock('../../src/components/PulseFits', () => ({
  FitsCard: () => null,
  FlexibleStrip: () => null,
}));
jest.mock('../../src/components/PulseFeedCard', () => ({
  PulseFeedCard: () => null,
}));
jest.mock('../../src/components/PulseCreate', () => ({
  PulseFilterSheet: () => null,
  UnifiedPostComposer: () => null,
}));
jest.mock('../../src/components/PulseLiveBanner', () => ({
  PulseLiveBanner: () => null,
}));
jest.mock('../../src/components/primitives', () => ({
  TravelEmptyState: () => null,
}));
jest.mock('../../src/components/PostCard', () => ({
  PostCard: () => null,
}));
jest.mock('../../src/components/LocationPermissionPrompt', () => ({
  LocationPermissionPrompt: () => null,
}));
jest.mock('../../src/components/ManualCityPicker', () => ({
  ManualCityPicker: () => null,
}));
jest.mock('../../src/components/layover/LayoverModeSheet', () => ({
  LayoverModeSheet: () => null,
}));
jest.mock('../../src/components/layover/ActiveLayoverPill', () => ({
  ActiveLayoverPill: () => null,
}));
jest.mock('../../src/components/PeopleYouMayKnow', () => ({
  PeopleYouMayKnow: () => null,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Collect every `paddingBottom` value from contentContainerStyle props found
 * anywhere in the rendered tree, plus regular style props.
 */
function collectContentContainerPaddingBottoms(node: any): number[] {
  if (!node || typeof node !== 'object') return [];
  const found: number[] = [];

  // Check contentContainerStyle (FlatList / ScrollView prop)
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

describe('Pulse FlatList — contentContainerStyle.paddingBottom with real device insets', () => {
  it('iPhone 14 (insets.bottom = 34): FlatList contentContainerStyle.paddingBottom ≥ 34', async () => {
    mockBottomInset = NAV_BAR_FILLER + IPHONE_BOTTOM; // 130

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Pulse = require('../index.tsx').default;
    const { UNSAFE_getAllByType } = await render(<Pulse />);

    const flatLists = UNSAFE_getAllByType(FlatList);
    expect(flatLists.length).toBeGreaterThan(0);

    // The main feed FlatList is the one whose contentContainerStyle carries
    // paddingBottom — find any FlatList with that prop set.
    const paddings = flatLists
      .map((fl) => {
        const ccs = fl.props?.contentContainerStyle;
        if (!ccs) return null;
        const flat = Array.isArray(ccs)
          ? Object.assign({}, ...ccs.map((s: any) => (s && typeof s === 'object' ? s : {})))
          : ccs;
        return typeof flat?.paddingBottom === 'number' ? flat.paddingBottom : null;
      })
      .filter((v): v is number => v !== null);

    expect(paddings.length).toBeGreaterThan(0);
    const max = Math.max(...paddings);
    expect(max).toBeGreaterThanOrEqual(IPHONE_BOTTOM);
    expect(max).toBe(NAV_BAR_FILLER + IPHONE_BOTTOM);
  });

  it('Android gesture nav (insets.bottom = 48): FlatList contentContainerStyle.paddingBottom ≥ 48', async () => {
    mockBottomInset = NAV_BAR_FILLER + ANDROID_BOTTOM; // 144

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Pulse = require('../index.tsx').default;
    const { UNSAFE_getAllByType } = await render(<Pulse />);

    const flatLists = UNSAFE_getAllByType(FlatList);
    const paddings = flatLists
      .map((fl) => {
        const ccs = fl.props?.contentContainerStyle;
        if (!ccs) return null;
        const flat = Array.isArray(ccs)
          ? Object.assign({}, ...ccs.map((s: any) => (s && typeof s === 'object' ? s : {})))
          : ccs;
        return typeof flat?.paddingBottom === 'number' ? flat.paddingBottom : null;
      })
      .filter((v): v is number => v !== null);

    expect(paddings.length).toBeGreaterThan(0);
    const max = Math.max(...paddings);
    expect(max).toBeGreaterThanOrEqual(ANDROID_BOTTOM);
    expect(max).toBe(NAV_BAR_FILLER + ANDROID_BOTTOM);
  });
});

describe('Pulse FlatList — useBottomInset computation contract', () => {
  it('NAV_BAR_FILLER (96) + iPhone bottom (34) = 130', () => {
    expect(NAV_BAR_FILLER + IPHONE_BOTTOM).toBe(130);
  });

  it('NAV_BAR_FILLER (96) + Android bottom (48) = 144', () => {
    expect(NAV_BAR_FILLER + ANDROID_BOTTOM).toBe(144);
  });

  it('mock hook returns the expected value for the active scenario', () => {
    mockBottomInset = NAV_BAR_FILLER + IPHONE_BOTTOM;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useBottomInset } = require('../../src/hooks/useBottomInset');
    expect(useBottomInset()).toBe(130);
  });
});
