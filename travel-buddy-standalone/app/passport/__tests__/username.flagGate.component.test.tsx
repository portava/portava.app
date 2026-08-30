/**
 * Public passport screen — stamp_showcase_enabled flag gate
 *
 * Confirms the PublicStampShowcaseSection in app/passport/[username].tsx is
 * hidden when the `stamp_showcase_enabled` flag is off — even when the showcase
 * items have already loaded into state — and visible when the flag is on and
 * items are present.
 *
 * This mounts the REAL screen (not a local copy of the gate) so the shipped
 * render condition at [username].tsx:446 is the thing under test. The mount
 * scaffold mirrors username.anonMenuAbsent.component.test.tsx, which proves the
 * screen mounts; here we vary the flag + the getPublicShowcase result instead.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import type { ShowcaseStamp } from '../../../src/services/stampShowcase';

// ── expo-router — intentionally exhaustive ────────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: {
    push:     jest.fn(),
    replace:  jest.fn(),
    back:     jest.fn(),
    canGoBack: jest.fn(() => false),
    navigate: jest.fn(),
  },
  useLocalSearchParams: () => ({ username: 'traveler42' }),
  usePathname:          () => '/',
  useSegments:          () => [],
  useFocusEffect: (cb: () => (() => void) | void) => {
    require('react').useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── useSession ────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — imports Supabase + native-incompatible modules.
// Anonymous visitor: the showcase gate is auth-independent (only flag + items).
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ isAuthed: false, userId: null }),
}));

// ── usePublicPassport — returns a resolved public profile ─────────────────────
// NOTE: intentionally exhaustive — calls Supabase and full network stack.
jest.mock('../../../src/hooks/usePublicPassport', () => ({
  usePublicPassport: jest.fn(),
}));

// ── useFeatureFlags — controllable so each test flips stamp_showcase_enabled ──
// NOTE: intentionally exhaustive — fetches from /api/feature-flags on mount.
const mockIsEnabled = jest.fn<boolean, [string]>();
jest.mock('../../../src/context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: mockIsEnabled, loading: false }),
}));

// ── useFollow ─────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — calls Supabase for follow state.
jest.mock('../../../src/hooks/useFollow', () => ({
  useFollow: () => ({
    isFollowing: false, followsYou: false, loading: false,
    toggling: false, toggle: jest.fn(), followersCount: 0,
  }),
}));

// ── useHighlightRingState ─────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — calls Supabase realtime subscriptions.
jest.mock('../../../src/hooks/useHighlightRingState', () => ({
  useHighlightRingState: () => null,
}));

// ── Services ──────────────────────────────────────────────────────────────────
// getPublicShowcase drives showcaseItems — controllable per test.
const mockGetPublicShowcase = jest.fn();
jest.mock('../../../src/services/stampShowcase', () => ({
  getPublicShowcase: (...args: unknown[]) => mockGetPublicShowcase(...args),
}));

// NOTE: intentionally exhaustive — all import Supabase.
jest.mock('../../../src/services/blocks', () => ({
  blockUser: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../../src/services/messaging', () => ({
  openDirectThread: jest.fn().mockResolvedValue({ ok: false }),
}));
jest.mock('../../../src/services/reports', () => ({
  submitReport: jest.fn().mockResolvedValue({ ok: true }),
}));

// ── Hooks ─────────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — accesses native scroll / inset metrics.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller:           () => null,
}));
jest.mock('../../../src/hooks/useBottomInset', () => ({
  usePlainBottomInset: () => 0,
}));

// ── Lib ───────────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — re-exports from context files pulling Zustand.
jest.mock('../../../src/lib/availabilityChip', () => ({
  resolveAvailabilityChip: () => null,
}));

// ── passport utilities ────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — transitively imports RN components needing native modules.
jest.mock('../../../src/components/passport/passportTabs', () => ({
  resolveTabOrder: () => ['postcards'],
  TAB_LABELS: { postcards: 'Postcards' },
}));

// ── Sub-component stubs ───────────────────────────────────────────────────────
const Null = () => null;

// NOTE: intentional stub — not under test; pulls heavy SVG / native-image deps.
jest.mock('../../../src/components/passport/PassportIdentityCard', () => ({
  PassportIdentityCard: Null,
  PassportStatsRow:     Null,
}));
jest.mock('../../../src/components/passport/PassportDivider', () => ({
  PassportDivider: Null,
}));
jest.mock('../../../src/components/profile/CircleSection', () => ({
  CircleSection: Null,
}));
// NOTE: intentional stub — isUuidParam must return false so the screen renders
// the full PassportDocumentScreenInner branch (not the UUID redirect).
jest.mock('../../../src/components/profile/UuidHandleRedirect', () => ({
  UuidHandleRedirect: Null,
  isUuidParam: (_s: unknown) => false,
}));

// PublicStampShowcaseSection — testID-preserving stub so the gate is observable
// without loading expo-image / native stamp-rarity modules.
jest.mock('../../../src/components/stamps/PublicStampShowcaseSection', () => {
  const { View, Text } = require('react-native');
  return {
    PublicStampShowcaseSection: ({ items }: { items: any[] }) => (
      <View testID="public-showcase-section">
        <Text testID="showcase-item-count">{items.length}</Text>
      </View>
    ),
  };
});

jest.mock('../../../src/components/privacy/PrivateProfileWall', () => ({
  PrivateProfileWall: Null,
}));
jest.mock('../../../src/components/HighlightViewer', () => ({
  HighlightViewer: Null,
}));
jest.mock('../../../src/components/PostcardsTab', () => ({ PostcardsTab: Null }));
jest.mock('../../../src/components/StampsTab',    () => ({ StampsTab:    Null }));
jest.mock('../../../src/components/MemoriesTab',  () => ({ MemoriesTab:  Null }));
jest.mock('../../../src/components/TripsTab',     () => ({ TripsTab:     Null }));
jest.mock('../../../src/components/MapTab', () => ({ MapTab: Null }));

// ── Typed mock refs ───────────────────────────────────────────────────────────

const { usePublicPassport } = require('../../../src/hooks/usePublicPassport.ts');
const mockUsePublicPassport = usePublicPassport as jest.Mock;

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeItem(id: string): ShowcaseStamp {
  return {
    userStampId: id,
    rank: 1,
    earnedAt: '2026-07-01T00:00:00Z',
    city: 'Tokyo',
    country: 'Japan',
    titleOverride: null,
    definition: {
      slug: `slug-${id}`,
      name: `Stamp ${id}`,
      rarity: 'rare',
      stampType: 'location',
      category: 'location',
      artworkUrl: null,
    },
  } as ShowcaseStamp;
}

const ITEMS: ShowcaseStamp[] = [makeItem('s1'), makeItem('s2')];

const MOCK_PUBLIC_PROFILE = {
  id:                'user-pub-1',
  username:          'traveler42',
  displayName:       'Traveler 42',
  bio:               null,
  avatarUrl:         null,
  homeCity:          null,
  homeCountry:       null,
  travelStyle:       null,
  interests:         [],
  verified:          false,
  verificationStatus: 'unverified',
  verifiedAt:        null,
  passportVisibility: 'public',
  passportTabOrder:  null,
  openToMeet:        false,
  quickStatus:       null,
  createdAt:         null,
} as any;

const BASE_PASSPORT_STATE = {
  profile:              MOCK_PUBLIC_PROFILE,
  postcards:            [],
  loading:              false,
  error:                null,
  isPrivate:            false,
  isFriend:             true,
  friendRequestPending: false,
  previewProfile:       null,
  privateProfileId:     null,
  notFound:             false,
  isBlocked:            false,
  postcardSentinel:     null,
};

import PassportDeepLinkScreen from '../[username].tsx';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('public passport showcase — stamp_showcase_enabled flag gate (real screen)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUsePublicPassport.mockReturnValue(BASE_PASSPORT_STATE);
    mockGetPublicShowcase.mockResolvedValue(ITEMS);
  });

  afterEach(async () => {
    await act(async () => {});
  });

  it('hides the showcase when the flag is off — even when items have loaded', async () => {
    mockIsEnabled.mockReturnValue(false);
    mockGetPublicShowcase.mockResolvedValue(ITEMS);

    await render(<PassportDeepLinkScreen />);
    await act(async () => {}); // flush getPublicShowcase → setShowcaseItems(ITEMS)

    expect(screen.queryByTestId('public-showcase-section')).toBeNull();
  });

  it('shows the showcase when the flag is on and items are present', async () => {
    mockIsEnabled.mockImplementation((f: string) => f === 'stamp_showcase_enabled');
    mockGetPublicShowcase.mockResolvedValue(ITEMS);

    await render(<PassportDeepLinkScreen />);
    await act(async () => {});

    expect(screen.getByTestId('public-showcase-section')).toBeTruthy();
    expect(screen.getByTestId('showcase-item-count').props.children).toBe(2);
  });

  it('hides the showcase when the flag is on but getPublicShowcase returns null', async () => {
    mockIsEnabled.mockImplementation((f: string) => f === 'stamp_showcase_enabled');
    mockGetPublicShowcase.mockResolvedValue(null);

    await render(<PassportDeepLinkScreen />);
    await act(async () => {});

    expect(screen.queryByTestId('public-showcase-section')).toBeNull();
  });

  it('hides the showcase when the flag is on but getPublicShowcase returns empty', async () => {
    mockIsEnabled.mockImplementation((f: string) => f === 'stamp_showcase_enabled');
    mockGetPublicShowcase.mockResolvedValue([]);

    await render(<PassportDeepLinkScreen />);
    await act(async () => {});

    expect(screen.queryByTestId('public-showcase-section')).toBeNull();
  });
});
