/**
 * Follow requests, blocked, muted and restricted accounts — a failed read
 * says so, with a retry, instead of "No pending requests" / "No blocked
 * accounts" / "No muted accounts" / "No restricted accounts". The services
 * already answered ok:false; the screens dropped it.
 *
 *   P1  each screen: a failed read shows the error, and Try again reloads;
 *   P2  each screen: a real empty list still shows the empty state;
 *   P3  restricted: a failed Unrestrict keeps the row and says so.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — useFocusEffect runs the load once on mount
// (there is no navigator focus event under jest); router is a stub.
jest.mock('expo-router', () => {
  const R = require('react');
  return {
    useFocusEffect: (cb: () => void) => { R.useEffect(cb, []); },
    router: { back: jest.fn(), push: jest.fn() },
  };
});

const mockFollowRequests = jest.fn();
const mockBlockList = jest.fn();
const mockMuteList = jest.fn();
const mockRestrictList = jest.fn();
const mockUnrestrict = jest.fn();
// NOTE: intentionally exhaustive — the reads and writes these screens make;
// the real modules do an authed fetch.
jest.mock('../../src/services/follows', () => ({
  getMyFollowRequests: (...a: unknown[]) => mockFollowRequests(...a),
  respondToFollowRequest: jest.fn(),
}));
// NOTE: intentionally exhaustive — see above.
jest.mock('../../src/services/blocks', () => ({
  getBlockList: (...a: unknown[]) => mockBlockList(...a),
  unblockUser: jest.fn(),
}));
// NOTE: intentionally exhaustive — see above.
jest.mock('../../src/services/mutes', () => ({
  getMuteList: (...a: unknown[]) => mockMuteList(...a),
  unmuteUser: jest.fn(),
}));
// NOTE: intentionally exhaustive — see above.
jest.mock('../../src/services/restrict', () => ({
  getRestrictList: (...a: unknown[]) => mockRestrictList(...a),
  unrestrictUser: (...a: unknown[]) => mockUnrestrict(...a),
}));

// NOTE: intentionally exhaustive — AppHeader chrome is not under test.
jest.mock('../../src/components/ui/AppHeader', () => ({ AppHeader: () => null }));
// NOTE: intentionally exhaustive — the nav-bar collapse needs Reanimated internals.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => jest.fn(),
  NavBarFiller: () => null,
}));

import FollowRequestsScreen from '../follow-requests';
import BlockedUsersScreen from '../blocked-users';
import MutedUsersScreen from '../muted-users';
import RestrictedUsersScreen from '../restricted-users';

const SCREENS: Array<[string, React.ComponentType, jest.Mock, string, string]> = [
  ['follow requests', FollowRequestsScreen, mockFollowRequests, 'follow-requests-load-error', 'No pending requests'],
  ['blocked accounts', BlockedUsersScreen, mockBlockList, 'blocked-users-load-error', 'No blocked accounts'],
  ['muted accounts', MutedUsersScreen, mockMuteList, 'muted-users-load-error', 'No muted accounts'],
  ['restricted accounts', RestrictedUsersScreen, mockRestrictList, 'restricted-users-load-error', 'No restricted accounts'],
];

beforeEach(() => {
  for (const m of [mockFollowRequests, mockBlockList, mockMuteList, mockRestrictList, mockUnrestrict]) m.mockReset();
});

describe('privacy lists — a failed read is not an empty list', () => {
  it.each(SCREENS)('P1: %s — a failed read shows the error and Try again reloads', async (_n, Screen, read, errorId, emptyText) => {
    read.mockResolvedValueOnce({ ok: false, error: 'Failed to load' });
    read.mockResolvedValueOnce({ ok: true, data: [] });
    await render(<Screen />);
    expect(await screen.findByTestId(errorId)).toBeTruthy();
    expect(screen.queryByText(emptyText)).toBeNull();
    await act(async () => { fireEvent.press(screen.getByText('Try again')); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(emptyText)).toBeTruthy();
    expect(screen.queryByTestId(errorId)).toBeNull();
  });

  it.each(SCREENS)('P2: %s — a real empty list still shows the empty state', async (_n, Screen, read, errorId, emptyText) => {
    read.mockResolvedValue({ ok: true, data: [] });
    await render(<Screen />);
    expect(await screen.findByText(emptyText)).toBeTruthy();
    expect(screen.queryByTestId(errorId)).toBeNull();
  });

  it('P3: restricted — a failed Unrestrict keeps the row and says so', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockRestrictList.mockResolvedValue({ ok: true, data: [{ id: 'u-1', handle: 'mira', name: 'Mira', avatarUrl: null }] });
    mockUnrestrict.mockResolvedValue({ ok: false, error: 'db_error' });
    await render(<RestrictedUsersScreen />);
    expect(await screen.findByText('@mira')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByText('Unrestrict')); });
    expect(mockUnrestrict).toHaveBeenCalledWith('u-1');
    expect(screen.getByText('@mira')).toBeTruthy();
    expect(alertSpy).toHaveBeenCalledWith('Could not unrestrict', expect.stringMatching(/still restricted/));
    alertSpy.mockRestore();
  });
});
