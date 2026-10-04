/**
 * Public profile screen — "Stamps Earned" is a measurement or an unknown.
 *
 * The server answers `stampsEarned: null` with `stampsEarnedUnavailable: true`
 * when a read behind the count failed or was cut (passport lane, 2026-10-03).
 * The screen used to coerce anything non-numeric to 0 (`?? 0`), which put a
 * confident "0 Stamps Earned" on a profile whose count simply could not be read,
 * and fed that 0 to the milestone celebration.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react-native';

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

describe('Public profile screen — Stamps Earned', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetProfileByHandle.mockResolvedValue({
      ok: true,
      data: { id: 'user-pub-1', handle: 'traveler42', name: 'Traveler 42', openToMeet: false,
        isPrivate: false, isOwnProfile: false, spokenLanguages: [], travelStyles: [] },
    });
    mockGetPublicShowcase.mockResolvedValue([]);
  });
  afterEach(async () => { await act(async () => {}); });

  it('a measured count is shown as the number and reaches the milestone hook', async () => {
    mockUsePublicPassport.mockReturnValue(hookState(profile({ stampsEarned: 1500 })));
    await render(<PublicPassportScreen />);
    await act(async () => {});
    expect(screen.getByTestId('stats-n-Stamps Earned').props.children).toBe(1500);
    expect(mockMilestone).toHaveBeenLastCalledWith(1500, expect.anything());
  });

  it('an unavailable count is "—", not 0, and the milestone hook gets null', async () => {
    mockUsePublicPassport.mockReturnValue(
      hookState(profile({ stampsEarned: null, stampsEarnedUnavailable: true })),
    );
    await render(<PublicPassportScreen />);
    await act(async () => {});
    expect(screen.getByTestId('stats-n-Stamps Earned').props.children).toBe('—');
    expect(mockMilestone).toHaveBeenLastCalledWith(null, expect.anything());
  });

  it('a flagged response is unknown even if a number rode along with it', async () => {
    mockUsePublicPassport.mockReturnValue(
      hookState(profile({ stampsEarned: 0, stampsEarnedUnavailable: true })),
    );
    await render(<PublicPassportScreen />);
    await act(async () => {});
    expect(screen.getByTestId('stats-n-Stamps Earned').props.children).toBe('—');
  });
});
