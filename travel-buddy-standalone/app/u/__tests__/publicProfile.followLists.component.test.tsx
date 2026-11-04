/**
 * Public profile screen — the Followers count and "Following N" pill open the
 * lists.
 *
 * Both were plain text although app/followers.tsx and app/following.tsx take a
 * `userId`. They now open those lists for this person, and stay text on a
 * private profile the viewer may not see.
 *
 * TWO PRESSES in this file, in the last test (renderer press budget, see
 * .agents/memory/rntl-react19-renderer-budget.md); the private case is
 * query-only and runs first.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react-native';
import { router } from 'expo-router';

const mockReloadPassport = jest.fn();

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
  useFollow: () => ({
    isFollowing: false, followsYou: false, loading: false, toggling: false, toggle: jest.fn(),
    followersCount: 12, followingCount: 3,
  }),
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

const mockMilestone = jest.fn(() => ({
  activeMilestone: null, sparkle: false, inkRing: false,
  confetti: false, onDismiss: jest.fn(),
}));
// NOTE: intentionally exhaustive — calls stamps analytics service; the spy records the count it is fed.
jest.mock('../../../src/hooks/useMilestoneCelebration', () => ({
  useMilestoneCelebration: (...args: unknown[]) => mockMilestone(...(args as [])),
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

function profile(extra: Record<string, unknown>) {
  return {
    id: 'user-pub-1', handle: 'traveler42', name: 'Traveler 42',
    displayName: 'Traveler 42', avatarUrl: null, coverUrl: null,
    bio: null, homeCity: null, isPrivate: false, isOwnProfile: false,
    openToMeet: false, spokenLanguages: [], travelStyles: [],
    verificationLevel: 'none', ...extra,
  } as any;
}

function hookState(p: any) {
  return {
    profile: p, postcards: [], loading: false, error: null, isPrivate: false,
    previewProfile: null, isFriend: false, friendRequestPending: false,
    privateProfileId: null, notFound: false, isBlocked: false, blockedTargetId: null,
    postcardSentinel: null, reload: mockReloadPassport,
  };
}

const SOCIAL = {
  id: 'user-pub-1', handle: 'traveler42', name: 'Traveler 42', openToMeet: false,
  isPrivate: false, isOwnProfile: false, spokenLanguages: [], travelStyles: [],
};

jest.setTimeout(20000);

describe('Public profile screen — follow lists', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPublicShowcase.mockResolvedValue([]);
  });

  it('a private profile the viewer may not see keeps both as plain text', async () => {
    mockGetProfileByHandle.mockResolvedValue({ ok: true, data: { ...SOCIAL, isPrivate: true } });
    mockUsePublicPassport.mockReturnValue(hookState(profile({})));
    await render(<PublicPassportScreen />);
    await screen.findByText('This profile is private. Add as a friend to see more.');
    expect(screen.getByTestId('stats-n-Followers').props.children).toBe(12);
    expect(screen.queryByTestId('stats-open-Followers')).toBeNull();
    expect(screen.getByTestId('following-pill').props.accessibilityState?.disabled).toBe(true);
  });

  it('opens this person\'s followers and following', async () => {
    mockGetProfileByHandle.mockResolvedValue({ ok: true, data: SOCIAL });
    mockUsePublicPassport.mockReturnValue(hookState(profile({})));
    await render(<PublicPassportScreen />);
    await act(async () => {});
    await fireEvent.press(await screen.findByTestId('stats-open-Followers'));
    expect(router.push).toHaveBeenCalledWith('/followers?userId=user-pub-1&title=Traveler%2042');
    await fireEvent.press(screen.getByTestId('following-pill'));
    expect(router.push).toHaveBeenLastCalledWith('/following?userId=user-pub-1&title=Traveler%2042');
  });
});
