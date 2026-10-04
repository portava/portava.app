/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; sweep SW17): Pulse (app/(tabs)/index.tsx) never says a failed or
 * partial read of today's events as "No plans fit your availability yet", and hands Explore Today what was not read.
 *
 * useCityPulse reads GET /events for the city. A failed read answered `[]` in production and a cut one (`truncated`)
 * was read as whole, so the screen said "No plans fit your availability yet." and Explore Today "Nothing on the calendar
 * yet" over a read that never completed. The hook now says `eventsUnread` ('failed' | 'partial'). The harness is
 * Pulse.staleBucketShape's (every child stubbed; Explore Today echoes the prop it is handed).
 *
 *   HP1  no availability set, today's events read failed → Explore Today is handed eventsUnread 'failed'
 *   HP2  availability set, nothing fits, the read failed → "Couldn't load every plan for today", never "No plans fit…"
 *   HP0  CONTROL: availability set, nothing fits, the read whole → "No plans fit your availability yet."
 *   HP0b CONTROL: no availability set, the read whole → Explore Today is handed no mark
 */
import React from 'react';
import { render, act } from '@testing-library/react-native';

let mockStatus: string = 'not_set';
let mockUnread: 'failed' | 'partial' | null = null;

// ── Reanimated ────────────────────────────────────────────────────────────────
jest.mock('react-native-reanimated', () => {
  const RN = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: { View: RN.View, ScrollView: RN.ScrollView },
    useAnimatedStyle:     () => ({}),
    useAnimatedReaction:  () => {},
    interpolate:          (_v: number, _in: number[], out: number[]) => out[0],
    makeMutable:          (v: number) => ({ value: v }),
    withSpring:           (v: number) => v,
    runOnJS:              (fn: any) => fn,
    useReducedMotion:     () => false,
  };
});

// ── Safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider:  ({ children }: any) => children,
}));

// ── Nav-bar collapse ──────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  navBarProgress:         { value: 0 },
  NAV_BAR_FILLER_HEIGHT:  96,
}));

// ── expo-router ───────────────────────────────────────────────────────────────
// useFocusEffect runs synchronously so mount-time effects fire in tests.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router:          { push: jest.fn(), back: jest.fn() },
  useFocusEffect:  (cb: () => void) => { cb(); },
}));

// ── Screen timing / snapshot cache — stub ─────────────────────────────────────
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

// ── useCityPulse — reads mockBuckets at call time so tests can vary the shape ──
// This is the hook under test. Each scenario below overwrites mockBuckets before
// rendering, which causes useCityPulse to return a different (possibly degraded)
// bucket object without needing to re-register the mock.
// NOTE: intentional exhaustive stub — useCityPulse has no other exports consumed
// by index.tsx; spreading requireActual would pull in real Supabase calls.
jest.mock('../../../src/hooks/useCityPulse', () => ({
  useCityPulse: () => ({
    buckets: { fitsAvailability: [], openNearby: [], flexible: [] },
    events:  [],
    status:  mockStatus,
    eventsUnread: mockUnread,
  }),
}));

// ── Remaining feed hooks ───────────────────────────────────────────────────────
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
  FOCUS_REFETCH_TTL_MS: 60000,
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
jest.mock('../../../src/hooks/useRankOutcome', () => ({
  fireRankOutcome: jest.fn(),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/intelligence', () => ({
  fetchPreferences: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/layover', () => ({
  getActiveLayoverSession: jest.fn().mockResolvedValue(null),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/rentABuddy', () => ({
  getLaunchStatus: jest.fn().mockResolvedValue({ ok: false }),
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

// ── UI sub-components — render null ───────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PulseHeader',              () => ({ PulseHeader:             () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui/AppHeader.tsx',         () => ({ AppHeader: () => null, OVERLAY_HEADER_HEIGHT: 44 }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/NotificationBell',         () => ({ NotificationBell:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PulseFits',                () => ({ FitsCard: () => null, FlexibleStrip: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ExploreTodaySection', () => ({
  ExploreTodaySection: (p: { eventsUnread?: string | null }) => {
    const { Text } = require('react-native');
    return <Text>{`explore:${p.eventsUnread ?? 'none'}`}</Text>;
  },
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PulseFeedCard',            () => ({ PulseFeedCard:            () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PulseCreate',              () => ({ PulseFilterSheet: () => null, UnifiedPostComposer: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/primitives',               () => ({ TravelEmptyState:         () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/LocationPermissionPrompt', () => ({ LocationPermissionPrompt: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ManualCityPicker',         () => ({ ManualCityPicker:         () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet', () => ({ LayoverModeSheet:         () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/ActiveLayoverPill',() => ({ ActiveLayoverPill:        () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PeopleYouMayKnow',         () => ({ PeopleYouMayKnow:         () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/CircleCompassSuggestions', () => ({ CircleCompassSuggestions: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/LivePulseRail',            () => ({ LivePulseRail:            () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/loading/FeedSkeleton',     () => ({ FeedSkeleton:             () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ui',                       () => ({ Chip:                     () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LayoverSessionContext',        () => ({
  LayoverSessionProvider:    ({ children }: any) => children,
  useLayoverSessionContext:   () => ({ session: null }),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

async function open() {
  const Pulse = require('../index.tsx').default;
  const r = await render(<Pulse />);
  await act(async () => { await Promise.resolve(); });
  return r;
}

describe('census-discovery §117 (SW17): Pulse says what it could not read of today\'s events', () => {
  it('HP1 no availability, the read failed → Explore Today is handed eventsUnread "failed"', async () => {
    mockStatus = 'not_set'; mockUnread = 'failed';
    const r = await open();
    expect(r.getByText('explore:failed')).toBeTruthy();
  });
  it('HP2 availability set, nothing fits, the read failed → "Couldn\'t load every plan for today"', async () => {
    mockStatus = 'open_tonight'; mockUnread = 'failed';
    const r = await open();
    expect(r.getByText("Couldn't load every plan for today")).toBeTruthy();
    expect(r.queryByText('No plans fit your availability yet.')).toBeNull();
  });
  it('HP0 CONTROL: availability set, nothing fits, the read whole → "No plans fit your availability yet."', async () => {
    mockStatus = 'open_tonight'; mockUnread = null;
    const r = await open();
    expect(r.getByText('No plans fit your availability yet.')).toBeTruthy();
  });
  it('HP0b CONTROL: no availability, the read whole → Explore Today is handed no mark', async () => {
    mockStatus = 'not_set'; mockUnread = null;
    const r = await open();
    expect(r.getByText('explore:none')).toBeTruthy();
  });
});
