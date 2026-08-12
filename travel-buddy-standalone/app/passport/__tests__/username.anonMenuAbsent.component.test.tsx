/**
 * Public passport screen — ⋯ button absent for unauthenticated visitors
 *
 * Confirms that the "More options" (⋯) button in the nav header of
 * app/passport/[username].tsx is:
 *   • NOT rendered when viewed by an unauthenticated user (isAuthed=false)
 *   • IS rendered when viewed by an authenticated, non-owner user (isAuthed=true, !isOwner)
 *
 * The gate is the ternary on line 348:
 *   {isAuthed && !isOwner ? <Pressable accessibilityLabel="More options" …> : <View …>}
 *
 * Purely client-side: the flag is set by useSession().isAuthed — no server call
 * is needed to drive the assertion.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react-native';

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

// ── useSession — mutable so each test can set isAuthed independently ──────────
// NOTE: intentionally exhaustive — imports Supabase + native-incompatible modules.
const mockUseSession = jest.fn();
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: (...args: unknown[]) => mockUseSession(...args),
}));

// ── usePublicPassport — returns a resolved public profile ─────────────────────
// NOTE: intentionally exhaustive — calls Supabase and full network stack.
jest.mock('../../../src/hooks/usePublicPassport', () => ({
  usePublicPassport: jest.fn(),
}));

// ── useFeatureFlags ───────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — fetches from /api/feature-flags on mount.
jest.mock('../../../src/context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: () => false, loading: false }),
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
// NOTE: intentionally exhaustive — all import Supabase.
jest.mock('../../../src/services/stampShowcase', () => ({
  getPublicShowcase: jest.fn().mockResolvedValue([]),
}));

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
// NOTE: intentionally exhaustive — accesses native scroll metrics.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller:           () => null,
}));

// NOTE: intentionally exhaustive — accesses native inset metrics.
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

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/passport/PassportDivider', () => ({
  PassportDivider: Null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/profile/CircleSection', () => ({
  CircleSection: Null,
}));

// NOTE: intentional stub — isUuidParam must return false so the screen renders
// the full PassportDocumentScreenInner branch (not the UUID redirect).
jest.mock('../../../src/components/profile/UuidHandleRedirect', () => ({
  UuidHandleRedirect: Null,
  isUuidParam: (_s: unknown) => false,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/stamps/PublicStampShowcaseSection', () => ({
  PublicStampShowcaseSection: Null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/privacy/PrivateProfileWall', () => ({
  PrivateProfileWall: Null,
}));

// NOTE: intentional stub — not under test here; pulls native video modules.
jest.mock('../../../src/components/HighlightViewer', () => ({
  HighlightViewer: Null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PostcardsTab', () => ({ PostcardsTab: Null }));
jest.mock('../../../src/components/StampsTab',    () => ({ StampsTab:    Null }));
jest.mock('../../../src/components/MemoriesTab',  () => ({ MemoriesTab:  Null }));
jest.mock('../../../src/components/TripsTab',     () => ({ TripsTab:     Null }));
// NOTE: intentional stub — MapTab pulls maplibre native modules.
jest.mock('../../../src/components/MapTab', () => ({ MapTab: Null }));

// ── Typed mock refs ───────────────────────────────────────────────────────────

const { usePublicPassport } = require('../../../src/hooks/usePublicPassport.ts');
const mockUsePublicPassport = usePublicPassport as jest.Mock;

// ── Shared profile fixture ────────────────────────────────────────────────────

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

describe('Public passport screen — ⋯ button visibility for unauthenticated visitor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUsePublicPassport.mockReturnValue(BASE_PASSPORT_STATE);
  });

  afterEach(async () => {
    await act(async () => {});
  });

  it('does NOT render the ⋯ button when the visitor is unauthenticated (isAuthed=false)', async () => {
    // Anonymous visitor: no session, no userId.
    mockUseSession.mockReturnValue({ isAuthed: false, userId: null });

    await render(<PassportDeepLinkScreen />);
    await act(async () => {});

    // The "More options" button must be completely absent — not just disabled.
    expect(screen.queryByLabelText('More options')).toBeNull();
  });

  it('renders the ⋯ button when the visitor is authenticated and is NOT the owner', async () => {
    // Authenticated visitor viewing someone else's passport.
    mockUseSession.mockReturnValue({ isAuthed: true, userId: 'viewer-user-99' });

    await render(<PassportDeepLinkScreen />);
    await act(async () => {});

    // The profile.id ('user-pub-1') !== viewerUserId ('viewer-user-99') so
    // isOwner=false, meaning the button should appear.
    expect(screen.getByLabelText('More options')).toBeTruthy();
  });

  it('does NOT render the ⋯ button when the authenticated viewer IS the owner', async () => {
    // The viewer's userId matches the profile id — they are the owner.
    mockUseSession.mockReturnValue({ isAuthed: true, userId: 'user-pub-1' });

    await render(<PassportDeepLinkScreen />);
    await act(async () => {});

    // Owner view: no block/report options, button absent.
    expect(screen.queryByLabelText('More options')).toBeNull();
  });
});
