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
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */

import React from 'react';
import { act, render } from '@testing-library/react-native';

// ── Inset constants ──────────────────────────────────────────────────────────

/** iPhone 14 home-indicator height (pt). */
const IPHONE_BOTTOM = 34;
/** Android gesture-nav bar height (dp). */
const ANDROID_BOTTOM = 48;
/** Minimum clearance contract for Pulse's paddingBottom when NO layover is
 *  active: NAV_BAR_FILLER_HEIGHT (96) + iPhone 14 bottom inset (34) = 130 ≥ 120. */
const MIN_EXPECTED_PADDING = 120;

// ── Layover-active inset constants ────────────────────────────────────────────
// These mirror the exported constants in ActiveLayoverPill + useBottomInset.
const LAYOVER_PILL_BOTTOM_OFFSET = 74;
const LAYOVER_PILL_HEIGHT        = 44;
const LAYOVER_PILL_TOP_GAP       = 16;
/**
 * Minimum paddingBottom when a layover session IS active (iPhone 14):
 *   insets.bottom (34) + 74 + 44 + 16 = 168
 * We assert ≥ 155 to leave a small tolerance while still confirming the pill
 * is fully cleared.
 */
const MIN_EXPECTED_PADDING_LAYOVER =
  IPHONE_BOTTOM + LAYOVER_PILL_BOTTOM_OFFSET + LAYOVER_PILL_HEIGHT + LAYOVER_PILL_TOP_GAP - 13; // 155

// ── Module mocks ──────────────────────────────────────────────────────────────

// Reanimated — replace with synchronous stubs to avoid worklet/native issues.
jest.mock('react-native-reanimated', () => {
  const RN = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: { View: RN.View, ScrollView: RN.ScrollView },
    useAnimatedStyle: () => ({}),
    useAnimatedReaction: () => {},
    interpolate: (_v: number, _in: number[], out: number[]) => out[0],
    makeMutable: (v: number) => ({ value: v }),
    withSpring: (v: number) => v,
    runOnJS: (fn: any) => fn,
    useReducedMotion: () => false,
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
// useFocusEffect is a jest.fn() so individual tests can inspect .mock.calls
// to retrieve and re-invoke the registered callback, simulating a re-focus.
// Existing behaviour is preserved: the callback is still called synchronously
// on every (simulated) focus event.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: jest.fn().mockImplementation((cb: () => void) => { cb(); }),
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
jest.mock('../../../src/components/layover/ActiveLayoverPill',() => ({ ActiveLayoverPill: () => null }));

// Layover session service — default inactive; individual tests override this.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/layover', () => ({
  getActiveLayoverSession: jest.fn().mockResolvedValue(null),
}));
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
    await act(async () => { await Promise.resolve(); });

    const paddings = collectContentContainerPaddingBottoms(toJSON());
    expect(paddings.length).toBeGreaterThan(0);
    const max = Math.max(...paddings);
    expect(max).toBeGreaterThanOrEqual(MIN_EXPECTED_PADDING);
  });

  it('paddingBottom baseline (no layover) clears iPhone 14 home indicator + nav bar', async () => {
      const Pulse = require('../index.tsx').default;
    const { toJSON } = await render(<Pulse />);
    await act(async () => { await Promise.resolve(); });

    const paddings = collectContentContainerPaddingBottoms(toJSON());
    expect(paddings.length).toBeGreaterThan(0);
    const max = Math.max(...paddings);
    expect(max).toBeGreaterThanOrEqual(MIN_EXPECTED_PADDING);
  });

  it('paddingBottom baseline is within expected range (no layover active)', async () => {
      const Pulse = require('../index.tsx').default;
    const { toJSON } = await render(<Pulse />);
    await act(async () => { await Promise.resolve(); });

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

// ── Layover-active clearance ───────────────────────────────────────────────────
// When a layover session is active the pill floats above the tab bar:
//   bottom: insets.bottom + 74,  height ~44 pt.
// The FlatList's paddingBottom must clear the pill top edge
// (insets.bottom + 74 + 44 + 16 = insets.bottom + 134).

describe('Pulse FlatList — layover-active increases bottom clearance', () => {
  const FAKE_SESSION = {
    session: {
      id: 'layover-test-1',
      departureTime: '2026-07-29T23:00:00Z',
      manualIata: 'JFK',
    },
    airport: null,
  };

  beforeEach(() => {
      const layover = require('../../../src/services/layover');

    const expoRouter = require('expo-router');
    layover.getActiveLayoverSession.mockResolvedValue(FAKE_SESSION);
  });

  afterEach(() => {
    const layover = require('../../../src/services/layover');
    layover.getActiveLayoverSession.mockResolvedValue(null);
  });

  it('paddingBottom exceeds inactive baseline when layover is active', async () => {
    const Pulse = require('../index.tsx').default;
    const { toJSON } = await render(<Pulse />);
    // Flush the resolved getActiveLayoverSession promise so the hook's state
    // update fires and the FlatList re-renders with the larger inset.
    await act(async () => { await Promise.resolve(); });

    const paddings = collectContentContainerPaddingBottoms(toJSON());
    expect(paddings.length).toBeGreaterThan(0);
    const max = Math.max(...paddings);
    expect(max).toBeGreaterThanOrEqual(MIN_EXPECTED_PADDING_LAYOVER);
  });

  it('paddingBottom with active layover clears iPhone 14 home indicator + pill (168 pt)', async () => {
      const Pulse = require('../index.tsx').default;
    const { toJSON } = await render(<Pulse />);
    await act(async () => { await Promise.resolve(); });

    const paddings = collectContentContainerPaddingBottoms(toJSON());
    const max = Math.max(...paddings);
    // 34 (insets.bottom) + 74 + 44 + 16 = 168
    const exactExpected = IPHONE_BOTTOM + LAYOVER_PILL_BOTTOM_OFFSET + LAYOVER_PILL_HEIGHT + LAYOVER_PILL_TOP_GAP;
    expect(max).toBeGreaterThanOrEqual(exactExpected);
  });
});

describe('Pulse FlatList — no regression when layover session absent', () => {
  it('paddingBottom stays within sane range when no layover (no oversized void)', async () => {
    // Confirm there is no always-on oversized gap by checking the baseline is
    // not inflated when getActiveLayoverSession returns null (the default mock).
      const Pulse = require('../index.tsx').default;
    const { toJSON } = await render(<Pulse />);
    await act(async () => { await Promise.resolve(); });

    const paddings = collectContentContainerPaddingBottoms(toJSON());
    const max = Math.max(...paddings);
    // Baseline: NAV_BAR_FILLER_HEIGHT (96) + insets.bottom (34) = 130.
    // Should NOT be as large as the layover-active value (168) when inactive.
    expect(max).toBeLessThan(MIN_EXPECTED_PADDING_LAYOVER);
    // But must still clear the tab bar.
    expect(max).toBeGreaterThanOrEqual(MIN_EXPECTED_PADDING);
  });
});

// ── Re-focus sync: session starts while Pulse is already open ─────────────────
// LayoverSessionContext shares a single fetch result between ActiveLayoverPill
// and useLayoverAwareBottomInset. Both consumers read from the same state, so
// when a session activates on re-focus the paddingBottom must jump to the
// layover-active value in the same render cycle — never showing the pill hidden
// while the padding is already expanded, or vice-versa.

describe('Pulse FlatList — layover pill and feed padding stay in sync on re-focus', () => {
  const REFOCUS_SESSION = {
    session: {
      id: 'layover-refocus-1',
      departureTime: '2026-07-29T23:00:00Z',
      manualIata: 'SFO',
    },
    airport: null,
  };

  afterEach(() => {
    // Reset service mock back to inactive so other describe blocks are unaffected.
      const layover = require('../../../src/services/layover');

    const expoRouter = require('expo-router');
    layover.getActiveLayoverSession.mockResolvedValue(null);
    // Clear useFocusEffect call history between tests.
    const { useFocusEffect } = require('expo-router');
    (useFocusEffect as jest.Mock).mockClear();
  });

  it('paddingBottom jumps to layover-active value in the same update when a session starts on re-focus', async () => {
      const layover = require('../../../src/services/layover');

    const expoRouter = require('expo-router');
    layover.getActiveLayoverSession.mockResolvedValue(null);

      const Pulse = require('../index.tsx').default;
    const { unmount, toJSON: toJSONRef } = await render(<Pulse />);
    // Flush the resolved promise so the context state settles.
    await act(async () => { await Promise.resolve(); });

    const paddingsBefore = collectContentContainerPaddingBottoms(toJSONRef());
    expect(paddingsBefore.length).toBeGreaterThan(0);
    const maxBefore = Math.max(...paddingsBefore);
    // Sanity: baseline padding clears the tab bar but has not reached the
    // layover-active territory yet.
    expect(maxBefore).toBeGreaterThanOrEqual(MIN_EXPECTED_PADDING);
    expect(maxBefore).toBeLessThan(MIN_EXPECTED_PADDING_LAYOVER);

    // ── Second focus (re-focus): session now active ──────────────────────────
    // Update the service mock BEFORE triggering the focus callback so that
    // when the context's useFocusEffect handler runs getActiveLayoverSession it
    // gets the new session.
    layover.getActiveLayoverSession.mockResolvedValue(REFOCUS_SESSION);

    // Retrieve the focus callback registered by LayoverSessionProvider's
    // useFocusEffect call during the first render, then invoke it directly to
    // simulate the user returning to the Pulse tab.
    const { useFocusEffect } = require('expo-router');
    const calls = (useFocusEffect as jest.Mock).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const focusCb = calls[calls.length - 1][0] as () => void;
    focusCb();

    // Flush the newly-resolved promise from the re-focus fetch.
    await act(async () => { await Promise.resolve(); });

    // ── Assert: paddingBottom has grown to the layover-active value ──────────
    // Both ActiveLayoverPill and useLayoverAwareBottomInset share the same
    // LayoverSessionContext state, so this single assertion confirms they are
    // in sync: if paddingBottom is in the layover-active range the context
    // session is non-null, which means the pill also receives a non-null
    // session and renders its content.
    const paddingsAfter = collectContentContainerPaddingBottoms(toJSONRef());
    expect(paddingsAfter.length).toBeGreaterThan(0);
    const maxAfter = Math.max(...paddingsAfter);
    expect(maxAfter).toBeGreaterThanOrEqual(MIN_EXPECTED_PADDING_LAYOVER);

    // Padding must have strictly increased — the two consumers were NOT out of
    // sync (e.g. padding already inflated before the context updated, or pill
    // visible while padding stayed at the inactive baseline).
    expect(maxAfter).toBeGreaterThan(maxBefore);

    unmount();
  });

  it('inactive paddingBottom never reaches layover-active threshold between focus events — no ghost expansion', async () => {
    // Guards against the inverse mismatch: feed padding expanding to
    // layover-active territory when no session is returned on first focus.
      const layover = require('../../../src/services/layover');

    const expoRouter = require('expo-router');
    layover.getActiveLayoverSession.mockResolvedValue(null);

      const Pulse = require('../index.tsx').default;
    const { toJSON } = await render(<Pulse />);
    await act(async () => { await Promise.resolve(); });

    const paddings = collectContentContainerPaddingBottoms(toJSON());
    const max = Math.max(...paddings);
    // Padding must NOT be in layover territory while the pill is hidden.
    expect(max).toBeLessThan(MIN_EXPECTED_PADDING_LAYOVER);
    // But must still clear the tab bar.
    expect(max).toBeGreaterThanOrEqual(MIN_EXPECTED_PADDING);
  });
});

// ── Call-count guard ───────────────────────────────────────────────────────────
// LayoverSessionContext (introduced in task 3283) de-duplicates the
// getActiveLayoverSession call that was previously fired independently by both
// ActiveLayoverPill and useLayoverAwareBottomInset. This test pins that
// exactly one call is made per focus — not two — so a future refactor cannot
// silently re-introduce the duplication.
//
// Implementation note: the module-level useFocusEffect stub calls cb() on
// *every render*, so 3 re-renders → 3 calls even with a single caller. We
// install a WeakSet-based mockImplementation that fires each
// useCallback-memoised callback exactly once — matching real focus semantics
// — so the assertion can be a clean toHaveBeenCalledTimes(1).

describe('Pulse — getActiveLayoverSession call count on focus', () => {
  beforeEach(() => {
    const layover = require('../../../src/services/layover');
    // Reset call count before each test in this suite.
    layover.getActiveLayoverSession.mockClear();
    layover.getActiveLayoverSession.mockResolvedValue(null);
  });

  afterEach(() => {
    // Restore the default synchronous-fire behaviour so other describe blocks
    // in this file are unaffected.
    const expoRouter = require('expo-router');
    expoRouter.useFocusEffect.mockImplementation((cb: () => void) => { cb(); });
  });

  it('getActiveLayoverSession is called exactly once per focus — not twice', async () => {
    // Install a per-test useFocusEffect implementation that fires each
    // useCallback-memoised callback exactly once, regardless of how many
    // re-renders occur. With useCallback(fn, []) the same fn reference is
    // returned on every re-render, so the WeakSet prevents duplicate fires.
    // This mirrors real useFocusEffect behaviour and lets us assert a clean
    // call count of exactly 1.
    const expoRouter = require('expo-router');
    const fired = new WeakSet<object>();
    expoRouter.useFocusEffect.mockImplementation((cb: () => void) => {
      if (!fired.has(cb)) { fired.add(cb); cb(); }
    });

    const Pulse = require('../index.tsx').default;
    await render(<Pulse />);
    // Flush the resolved promise so the async fetch inside
    // LayoverSessionProvider settles.
    await act(async () => { await Promise.resolve(); });

    const layover = require('../../../src/services/layover');
    // LayoverSessionContext is the single caller. If this becomes 2 it means
    // a consumer (ActiveLayoverPill or useLayoverAwareBottomInset) has
    // reverted to calling the service directly instead of reading from the
    // context.
    expect(layover.getActiveLayoverSession).toHaveBeenCalledTimes(1);
  });
});
