/**
 * Public profile screen — pull-to-refresh re-fetches data
 *
 * Confirms that triggering the ScrollView's RefreshControl.onRefresh:
 *   1. calls reload() from usePublicPassport (re-fetches passport data)
 *   2. calls getProfileByHandle() again (re-runs loadSocial)
 *   3. sets the refreshing spinner immediately when onRefresh fires
 *
 * testID "main-scroll" on both ScrollViews in app/u/[username].tsx (mutually
 * exclusive branches) lets us reach refreshControl via
 * scroll.props.refreshControl.props.onRefresh / .refreshing.
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router:               { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({ username: 'traveler42' }),
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

const mockReloadPassport = jest.fn();

// NOTE: intentionally exhaustive — the real hook calls Supabase and network.
jest.mock('../../../src/hooks/usePublicPassport', () => ({
  usePublicPassport: jest.fn(),
}));

const mockGetProfileByHandle = jest.fn();
const mockGetPublicShowcase  = jest.fn();

// NOTE: intentionally exhaustive — the real module imports Supabase.
jest.mock('../../../src/services/friends', () => ({
  getProfileByHandle: (...args: unknown[]) => mockGetProfileByHandle(...args),
  getProfileById:     jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentionally exhaustive — the real module imports Supabase.
jest.mock('../../../src/services/stampShowcase', () => ({
  getPublicShowcase: (...args: unknown[]) => mockGetPublicShowcase(...args),
}));

// NOTE: intentionally exhaustive — the real module imports Supabase.
jest.mock('../../../src/services/blocks', () => ({
  blockUser:      jest.fn().mockResolvedValue({ ok: true }),
  unblockUser:    jest.fn().mockResolvedValue({ ok: true }),
  getBlockStatus: jest.fn().mockResolvedValue({ ok: true, data: { iBlocked: false, theyBlockedMe: false } }),
}));

// NOTE: intentionally exhaustive — the real module imports Supabase.
jest.mock('../../../src/services/mutes', () => ({
  muteUser:      jest.fn().mockResolvedValue({ ok: true }),
  unmuteUser:    jest.fn().mockResolvedValue({ ok: true }),
  getMuteStatus: jest.fn().mockResolvedValue({ ok: true, data: { muted: false } }),
}));

// NOTE: intentionally exhaustive — the real module imports Supabase.
jest.mock('../../../src/services/saves', () => ({
  saveProfile:   jest.fn().mockResolvedValue({ ok: true }),
  unsaveProfile: jest.fn().mockResolvedValue({ ok: true }),
  getSaveStatus: jest.fn().mockResolvedValue({ ok: true, data: { isSaved: false } }),
}));

// NOTE: intentionally exhaustive — the real module imports Supabase.
jest.mock('../../../src/services/reports', () => ({
  submitReport: jest.fn().mockResolvedValue({ ok: true }),
}));

// NOTE: intentionally exhaustive — the real module imports Supabase.
jest.mock('../../../src/services/reviews', () => ({
  getUserReviews: jest.fn().mockResolvedValue({ avgRating: null, reviewCount: 0, reviews: [] }),
}));

// NOTE: intentionally exhaustive — the real module calls external buddy API.
jest.mock('../../../src/services/rentABuddy', () => ({
  getBuddyProfileByUserId: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentionally exhaustive — the real module imports Supabase.
jest.mock('../../../src/services/follows', () => ({
  followUser: jest.fn().mockResolvedValue({ ok: true }),
}));

// NOTE: intentionally exhaustive — the real module calls Supabase messaging.
jest.mock('../../../src/services/messaging', () => ({
  openDirectThread: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentionally exhaustive — imports Supabase + native-incompatible modules.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: 'current-user-1', isAuthed: true }),
}));

// NOTE: intentionally exhaustive — calls Supabase realtime subscriptions.
jest.mock('../../../src/hooks/useHighlightRingState', () => ({
  useHighlightRingState: () => null,
  viewedHighlightIds:    new Set<string>(),
}));

// NOTE: intentionally exhaustive — calls Supabase for follow state.
jest.mock('../../../src/hooks/useFollow', () => ({
  useFollow: () => ({ isFollowing: false, followsYou: false, loading: false, toggling: false, toggle: jest.fn() }),
}));

// NOTE: intentionally exhaustive — calls Supabase for friend status.
jest.mock('../../../src/hooks/useFriends', () => ({
  useFriendStatus: () => ({
    status: 'none', loading: false,
    send: jest.fn(), accept: jest.fn(), decline: jest.fn(), cancel: jest.fn(), remove: jest.fn(),
  }),
}));

// NOTE: intentionally exhaustive — calls Supabase for message permission.
jest.mock('../../../src/hooks/useMessaging', () => ({
  useMessagePermission: () => ({ verdict: 'allowed', loading: false }),
}));

// NOTE: intentionally exhaustive — accesses native scroll state.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller:           () => null,
}));

// NOTE: intentionally exhaustive — calls stamps analytics service.
jest.mock('../../../src/hooks/useMilestoneCelebration', () => ({
  useMilestoneCelebration: () => ({
    activeMilestone: null, sparkle: false, inkRing: false,
    confetti: false, onDismiss: jest.fn(),
  }),
}));

const Null = () => null;

// NOTE: intentional stub — pulls the passport document design (heavy SVG + fonts).
jest.mock('../../passport/[username]', () => ({ __esModule: true, default: Null }));
// NOTE: intentional stub — not under test; real component pulls native image/maps.
jest.mock('../../../src/components/PassportHero', () => ({ PassportHero: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/HighlightViewer', () => ({ HighlightViewer: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PostcardsTab', () => ({ PostcardsTab: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/StampsTab', () => ({ StampsTab: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/stamps/StampButton', () => ({ StampButton: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/AboutTab', () => ({ AboutTab: Null }));
// NOTE: intentional stub — not under test here; real MapTab pulls maplibre native modules.
jest.mock('../../../src/components/MapTab', () => ({ MapTab: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ReportSheet', () => ({ ReportSheet: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/TenKStampsBadge', () => ({ TenKStampsBadge: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/privacy/PrivateProfileWall', () => ({ PrivateProfileWall: Null }));

import PublicPassportScreen from '../[username].tsx';
const { usePublicPassport } = require('../../../src/hooks/usePublicPassport.ts');
const mockUsePublicPassport  = usePublicPassport as jest.Mock;

const MOCK_PUBLIC_PROFILE = {
  id: 'user-pub-1', handle: 'traveler42', name: 'Traveler 42',
  displayName: 'Traveler 42', avatarUrl: null, coverUrl: null,
  bio: null, homeCity: null, isPrivate: false, isOwnProfile: false,
  openToMeet: false, spokenLanguages: [], travelStyles: [],
  stampsEarned: 5, verificationLevel: 'none',
} as any;

const MOCK_SOCIAL_PROFILE = {
  id: 'user-pub-1', handle: 'traveler42', name: 'Traveler 42',
  openToMeet: false, isPrivate: false, isOwnProfile: false,
  spokenLanguages: [], travelStyles: [],
};

describe('Public profile screen — pull-to-refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockUsePublicPassport.mockReturnValue({
      profile:              MOCK_PUBLIC_PROFILE,
      postcards:            [],
      loading:              false,
      error:                null,
      isPrivate:            false,
      previewProfile:       null,
      isFriend:             false,
      friendRequestPending: false,
      privateProfileId:     null,
      notFound:             false,
      isBlocked:            false,
      blockedTargetId:      null,
      postcardSentinel:     null,
      reload:               mockReloadPassport,
    });

    mockGetProfileByHandle.mockResolvedValue({ ok: true, data: MOCK_SOCIAL_PROFILE });
    mockGetPublicShowcase.mockResolvedValue([]);
  });

  afterEach(async () => {
    await act(async () => {});
  });

  it('calls reload() and re-fetches social data when RefreshControl fires', async () => {
    await render(<PublicPassportScreen />);
    await act(async () => {});

    await waitFor(() => expect(mockGetProfileByHandle).toHaveBeenCalled());
    const socialCallsBefore = mockGetProfileByHandle.mock.calls.length;

    const scroll = await screen.findByTestId('main-scroll');
    await act(async () => { scroll.props.refreshControl.props.onRefresh(); });

    expect(mockReloadPassport).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(mockGetProfileByHandle.mock.calls.length).toBeGreaterThan(socialCallsBefore);
    });
  });

  it('sets refreshing=true immediately when onRefresh fires', async () => {
    mockGetProfileByHandle.mockReturnValue(new Promise(() => {}));

    await render(<PublicPassportScreen />);
    await act(async () => {});

    const scroll = await screen.findByTestId('main-scroll');
    await act(async () => { scroll.props.refreshControl.props.onRefresh(); });

    expect(screen.getByTestId('main-scroll').props.refreshControl.props.refreshing).toBe(true);
  });
});
