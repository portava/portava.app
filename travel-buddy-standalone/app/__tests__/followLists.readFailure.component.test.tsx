/**
 * Followers and Following — a failed read says so, with a retry, instead of
 * "No followers yet" / "Not following anyone yet".
 *
 *   L1  Followers: a failed read shows the error and Try again reloads;
 *   L2  Following: the same;
 *   L3  a real empty list still shows the empty state, not the error;
 *   L4  someone else's empty list does not say "People who follow you".
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

const mockParams: { userId?: string; title?: string } = {};
// NOTE: intentionally exhaustive — useFocusEffect runs the load once on mount
// (there is no navigator focus event under jest); router is a stub.
jest.mock('expo-router', () => {
  const R = require('react');
  return {
    useFocusEffect: (cb: () => void) => { R.useEffect(cb, []); },
    useLocalSearchParams: () => mockParams,
    router: { back: jest.fn(), push: jest.fn() },
  };
});

const mockMyFollowers = jest.fn();
const mockMyFollowing = jest.fn();
const mockUserFollowers = jest.fn();
const mockUserFollowing = jest.fn();
// NOTE: intentionally exhaustive — the four reads these screens make; the real
// module does an authed fetch.
jest.mock('../../src/services/follows', () => ({
  getMyFollowers: (...a: unknown[]) => mockMyFollowers(...a),
  getMyFollowing: (...a: unknown[]) => mockMyFollowing(...a),
  getUserFollowers: (...a: unknown[]) => mockUserFollowers(...a),
  getUserFollowing: (...a: unknown[]) => mockUserFollowing(...a),
}));

// NOTE: intentionally exhaustive — AppHeader chrome is not under test.
jest.mock('../../src/components/ui/AppHeader', () => ({ AppHeader: () => null }));
// NOTE: intentionally exhaustive — OfficialBadge renders an SVG asset.
jest.mock('../../src/components/OfficialBadge', () => ({ OfficialBadge: () => null }));
// NOTE: intentionally exhaustive — the nav-bar collapse needs Reanimated internals.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => jest.fn(),
  NavBarFiller: () => null,
}));

import FollowersScreen from '../followers';
import FollowingScreen from '../following';

const FAILED = { ok: false, data: null, errorKind: 'db_error' };
const EMPTY = { ok: true, data: [] };
const ONE = { ok: true, data: [{ id: 'u-9', handle: 'mira', name: 'Mira', avatarUrl: null }] };

beforeEach(() => {
  for (const m of [mockMyFollowers, mockMyFollowing, mockUserFollowers, mockUserFollowing]) m.mockReset();
  delete mockParams.userId;
  delete mockParams.title;
});

describe('Followers and Following — a failed read is not an empty list', () => {
  it('L1: Followers shows the failure, and Try again reloads', async () => {
    mockMyFollowers.mockResolvedValueOnce(FAILED).mockResolvedValueOnce(ONE);
    await render(<FollowersScreen />);
    await screen.findByTestId('followers-error');
    expect(screen.getByText('Followers could not be loaded')).toBeTruthy();
    expect(screen.queryByText('No followers yet')).toBeNull();

    await fireEvent.press(screen.getByLabelText('Try loading followers again'));
    await screen.findByText('@mira');
    expect(mockMyFollowers).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('followers-error')).toBeNull();
  });

  it('L2: Following shows the failure, and Try again reloads', async () => {
    mockMyFollowing.mockResolvedValueOnce(FAILED).mockResolvedValueOnce(EMPTY);
    await render(<FollowingScreen />);
    await screen.findByTestId('following-error');
    expect(screen.queryByText('Not following anyone yet')).toBeNull();

    await fireEvent.press(screen.getByLabelText('Try loading following again'));
    await screen.findByText('Not following anyone yet');
  });

  it('L3: a real empty list still shows the empty state', async () => {
    mockMyFollowers.mockResolvedValue(EMPTY);
    await render(<FollowersScreen />);
    await screen.findByText('No followers yet');
    expect(screen.queryByTestId('followers-error')).toBeNull();
  });

  it("L4: someone else's empty list is about them, not you", async () => {
    mockParams.userId = 'u-2';
    mockParams.title = 'Mira';
    mockUserFollowers.mockResolvedValue(EMPTY);
    await render(<FollowersScreen />);
    await screen.findByText('People who follow them will appear here.');
    expect(screen.queryByText('People who follow you will appear here.')).toBeNull();
    expect(mockMyFollowers).not.toHaveBeenCalled();
  });
});
