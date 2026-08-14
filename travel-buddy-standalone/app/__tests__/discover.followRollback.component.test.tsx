/**
 * discover.followRollback.component.test.tsx
 *
 * Confirms that the Find Travelers screen (app/discover.tsx) correctly handles
 * optimistic follow state when the followUser / unfollowUser service returns
 * { ok: false } (a non-throwing API failure).
 *
 * Critical scenarios:
 *   1. Follow fails ({ ok: false }) → button reverts to "Follow"; user stays in suggestions.
 *   2. Follow succeeds ({ ok: true }) → user is removed from the suggestions list.
 *   3. Unfollow fails ({ ok: false }) → button reverts to "Following".
 *
 * Run: pnpm --dir travel-buddy-standalone run test:component
 */

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

// ── expo-router ───────────────────────────────────────────────────────────────
// useFocusEffect → plain useEffect so the initial load fires on mount without a
// real navigator context.
jest.mock('expo-router', () => {
  const R = require('react');
  return {
    router: { push: jest.fn(), back: jest.fn() },
    useFocusEffect: (cb: () => (() => void) | void) => {
      R.useEffect(() => {
        const cleanup = cb();
        return typeof cleanup === 'function' ? cleanup : undefined;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
    },
    useLocalSearchParams: () => ({}),
    usePathname: () => '/discover',
  };
});

// ── react-native-safe-area-context ───────────────────────────────────────────
// NOTE: intentionally exhaustive — only useSafeAreaInsets is used here; spreading
// requireActual would pull in native modules unavailable in jest-expo.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── Follows service ───────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — the real module connects to Supabase and makes
// network requests unavailable in the jest environment. We control all return values
// per test via mockResolvedValue.
jest.mock('../../src/services/follows', () => ({
  searchUsers:           jest.fn().mockResolvedValue({ ok: true, data: [] }),
  getSuggestedTravelers: jest.fn(),
  clearSuggestionsSeen:  jest.fn().mockResolvedValue(undefined),
  followUser:            jest.fn(),
  unfollowUser:          jest.fn(),
}));

// ── UI / Layout components ────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — AppHeader renders native navigation chrome
// (back button, status bar) requiring a navigator context unavailable here.
jest.mock('../../src/components/ui/AppHeader', () => ({
  AppHeader: () => null,
}));

jest.mock('../../src/components/ui/KeyboardSafeView', () => {
  const R = require('react');
  const RN = require('react-native');
  return {
    KeyboardSafeScrollView: ({ children }: { children: R.ReactNode }) =>
      R.createElement(RN.View, null, children),
  };
});

// NOTE: intentionally exhaustive — ProfileSkeleton renders animated shimmer views
// via Reanimated internals not configured for the jest-expo transform environment.
jest.mock('../../src/components/loading/ProfileSkeleton', () => ({
  ProfileSkeleton: () => null,
}));

// NOTE: intentionally exhaustive — EmptyState is not under test here; stubbing it
// avoids pulling in icon SVG transforms not available in jest.
jest.mock('../../src/components/ui/EmptyState', () => ({
  EmptyState: () => null,
}));

// ── Hooks ─────────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — the real useNavBarScrollHandler returns an
// Animated event handler that calls Reanimated internals not available in jest-expo.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller: () => null,
}));

// NOTE: intentionally exhaustive — only PlainBottomFiller is used in this screen;
// the real hook reads native inset measurements unavailable in jest.
jest.mock('../../src/hooks/useBottomInset', () => ({
  PlainBottomFiller: () => null,
}));

// ── AvatarImage (used inside ProfileCard) ─────────────────────────────────────
// NOTE: intentionally exhaustive — AvatarImage uses expo-image which loads native
// modules unavailable in the jest environment; null stub avoids the crash.
jest.mock('../../src/components/ui/DisplayMediaImage', () => ({
  AvatarImage: () => null,
}));

// ── lucide-react-native covered by the global Proxy mapper in jest.config.js ──

// ── Imports after mocks ───────────────────────────────────────────────────────

import DiscoverScreen from '../discover';
import {
  getSuggestedTravelers,
  followUser,
  unfollowUser,
} from '../../src/services/follows';

const mockGetSuggestions = getSuggestedTravelers as jest.Mock;
const mockFollowUser     = followUser            as jest.Mock;
const mockUnfollowUser   = unfollowUser          as jest.Mock;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<{
  id: string;
  isFollowing: boolean;
  isPrivate: boolean;
  friendRequestPending: boolean;
}> = {}) {
  return {
    id:                   overrides.id ?? 'user-1',
    displayName:          'Alice Traveler',
    username:             'alice',
    avatarUrl:            null,
    verified:             false,
    isFollowing:          overrides.isFollowing ?? false,
    isPrivate:            overrides.isPrivate ?? false,
    friendRequestPending: overrides.friendRequestPending ?? false,
    followerCount:        12,
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('DiscoverScreen — optimistic follow rollback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSuggestions.mockResolvedValue({ ok: true, data: [makeUser()] });
  });

  it('reverts "Follow" → "Following" back to "Follow" when followUser returns { ok: false }', async () => {
    mockFollowUser.mockResolvedValue({ ok: false, data: null, errorKind: 'db_error' });

    const { getByLabelText } = await render(<DiscoverScreen />);
    await act(async () => {});

    // Suggestions loaded — the Follow button should be present.
    const followBtn = await waitFor(() => getByLabelText('Follow'));
    expect(followBtn).toBeTruthy();

    // Tap Follow — optimistic update sets "Following" immediately.
    await act(async () => { fireEvent.press(followBtn); });

    // After the service returns { ok: false }, the UI must revert.
    await waitFor(() => {
      expect(getByLabelText('Follow')).toBeTruthy();
    });

    // The user must still be in the suggestions list (not removed on failure).
    expect(mockFollowUser).toHaveBeenCalledWith('user-1');
  });

  it('removes user from suggestions when followUser returns { ok: true }', async () => {
    mockFollowUser.mockResolvedValue({ ok: true, data: { following: true } });

    const { queryByLabelText } = await render(<DiscoverScreen />);
    await act(async () => {});

    const followBtn = await waitFor(() => queryByLabelText('Follow'));
    expect(followBtn).toBeTruthy();

    await act(async () => { fireEvent.press(followBtn!); });

    // After a successful follow the suggestion row is removed.
    await waitFor(() => {
      expect(queryByLabelText('Follow')).toBeNull();
    });
  });

  it('reverts "Unfollow" back to "Following" when unfollowUser returns { ok: false }', async () => {
    mockGetSuggestions.mockResolvedValue({
      ok: true,
      data: [makeUser({ isFollowing: true })],
    });
    mockUnfollowUser.mockResolvedValue({ ok: false, data: null, errorKind: 'db_error' });

    const { getByLabelText } = await render(<DiscoverScreen />);
    await act(async () => {});

    // Suggestions loaded with already-followed user.
    const unfollowBtn = await waitFor(() => getByLabelText('Unfollow'));
    expect(unfollowBtn).toBeTruthy();

    await act(async () => { fireEvent.press(unfollowBtn); });

    // After the service returns { ok: false }, the button reverts to "Unfollow".
    await waitFor(() => {
      expect(getByLabelText('Unfollow')).toBeTruthy();
    });
    expect(mockUnfollowUser).toHaveBeenCalledWith('user-1');
  });

  it('private account — shows "Request to follow" button, not Follow', async () => {
    mockGetSuggestions.mockResolvedValue({
      ok: true,
      data: [makeUser({ isPrivate: true })],
    });

    const { queryByLabelText } = await render(<DiscoverScreen />);
    await act(async () => {});

    await waitFor(() => {
      expect(queryByLabelText('Request to follow')).toBeTruthy();
      expect(queryByLabelText('Follow')).toBeNull();
    });
  });

  it('private account — shows "Pending" when friendRequestPending is true', async () => {
    mockGetSuggestions.mockResolvedValue({
      ok: true,
      data: [makeUser({ isPrivate: true, friendRequestPending: true })],
    });

    const { queryByLabelText } = await render(<DiscoverScreen />);
    await act(async () => {});

    await waitFor(() => {
      expect(queryByLabelText('Pending')).toBeTruthy();
      expect(queryByLabelText('Request to follow')).toBeNull();
    });
  });

  it('private account — request success sets "Pending" and calls followUser once', async () => {
    mockGetSuggestions.mockResolvedValue({
      ok: true,
      data: [makeUser({ isPrivate: true })],
    });
    mockFollowUser.mockResolvedValue({ ok: true, data: { following: false } });

    const { getByLabelText, queryByLabelText } = await render(<DiscoverScreen />);
    await act(async () => {});

    const requestBtn = await waitFor(() => getByLabelText('Request to follow'));
    await act(async () => { fireEvent.press(requestBtn); });

    await waitFor(() => {
      expect(queryByLabelText('Pending')).toBeTruthy();
    });
    expect(mockFollowUser).toHaveBeenCalledTimes(1);
    expect(mockFollowUser).toHaveBeenCalledWith('user-1');
  });

  it('private account — request failure ({ ok: false }) reverts button back to "Request to follow"', async () => {
    mockGetSuggestions.mockResolvedValue({
      ok: true,
      data: [makeUser({ isPrivate: true })],
    });
    mockFollowUser.mockResolvedValue({ ok: false, data: null, errorKind: 'db_error' });

    const { getByLabelText } = await render(<DiscoverScreen />);
    await act(async () => {});

    const requestBtn = await waitFor(() => getByLabelText('Request to follow'));
    await act(async () => { fireEvent.press(requestBtn); });

    // After { ok: false }, must revert to "Request to follow" — not stay as "Pending".
    await waitFor(() => {
      expect(getByLabelText('Request to follow')).toBeTruthy();
    });
  });
});
