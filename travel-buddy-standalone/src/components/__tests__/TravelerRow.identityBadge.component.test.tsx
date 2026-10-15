import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { router } from 'expo-router';
import { TravelerRow } from '../TravelerRow.tsx';
import { UserNameButton } from '../interaction/UserNameButton.tsx';
import type { TravelerSearchResult } from '../../services/follows.ts';

jest.mock('expo-router', () => ({ ...jest.requireActual('expo-router'), router: { push: jest.fn() } }));
jest.mock('../../services/follows.ts', () => ({
  ...jest.requireActual('../../services/follows.ts'), followUser: jest.fn(), unfollowUser: jest.fn(),
}));
jest.mock('../../hooks/useHighlightRingState.ts', () => ({
  ...jest.requireActual('../../hooks/useHighlightRingState.ts'), useHighlightRingState: () => null,
}));
jest.mock('../HighlightViewer.tsx', () => ({ ...jest.requireActual('../HighlightViewer.tsx'), HighlightViewer: () => null }));
jest.mock('../SaveButton.tsx', () => ({ ...jest.requireActual('../SaveButton.tsx'), SaveButton: () => null }));
jest.mock('../interaction/UserOverflowMenu.tsx', () => ({ ...jest.requireActual('../interaction/UserOverflowMenu.tsx'), UserOverflowMenu: () => null }));
const mockBlockedIds = new Set<string>();
const mockBlockerIds = new Set<string>();
jest.mock('../../context/BlockedIdsContext.tsx', () => ({
  ...jest.requireActual('../../context/BlockedIdsContext.tsx'),
  useBlockedIds: () => ({ blockedIds: mockBlockedIds, blockerIds: mockBlockerIds, isLoading: false }),
}));

const traveler: TravelerSearchResult = {
  id: 'traveler-1', displayName: 'Ana', username: 'ana', avatarUrl: null,
  followerCount: 3, isFollowing: false, isPrivate: false,
};

beforeEach(() => { jest.clearAllMocks(); mockBlockedIds.clear(); mockBlockerIds.clear(); });

it.each(['id', 'id_selfie'] as const)('renders a server %s badge inside the identity link and preserves profile navigation', async (tier) => {
  const ui = await render(<TravelerRow user={{ ...traveler, identityBadge: { tier } }} />);
  expect(ui.getByTestId(`verified-badge-${tier}`)).toBeTruthy();
  await fireEvent.press(ui.getByText('Ana'));
  expect(router.push).toHaveBeenCalledWith('/u/ana');
});

it.each([undefined, null, true, { tier: 'trusted_traveler' }, { tier: 'unknown' }])('never manufactures identity verification from a legacy flag or malformed badge: %p', async (identityBadge) => {
  const ui = await render(<TravelerRow user={{ ...traveler, verified: true, identityBadge } as TravelerSearchResult} />);
  expect(ui.queryByTestId('verified-badge-id')).toBeNull();
  expect(ui.queryByTestId('verified-badge-id_selfie')).toBeNull();
});

it('a badge tap opens its criteria, not the profile', async () => {
  const ui = await render(<TravelerRow user={{ ...traveler, identityBadge: { tier: 'id' } }} />);
  const stopPropagation = jest.fn();
  await fireEvent.press(ui.getByTestId('verified-badge-id'), { stopPropagation });
  expect(stopPropagation).toHaveBeenCalledTimes(1);
  expect(router.push).not.toHaveBeenCalled();
  expect(ui.getByTestId('verified-badge-criteria')).toBeTruthy();
});

it.each(['blocked', 'blocker'])('withholds the name badge and navigation for a %s traveler', async (direction) => {
  (direction === 'blocked' ? mockBlockedIds : mockBlockerIds).add(traveler.id);
  const ui = await render(<TravelerRow user={{ ...traveler, identityBadge: { tier: 'id' } }} />);
  expect(ui.getByText('Unavailable user')).toBeTruthy();
  expect(ui.queryByTestId('verified-badge-id')).toBeNull();
  await fireEvent.press(ui.getByText('Unavailable user'));
  expect(router.push).not.toHaveBeenCalled();
});

it('preserves own-name navigation through the shared identity link', async () => {
  const ui = await render(<UserNameButton userId="me" currentUserId="me" handle="ana" displayName="Ana" identityBadge={{ tier: 'id' }} />);
  await fireEvent.press(ui.getByText('Ana'));
  expect(router.push).toHaveBeenCalledWith('/(tabs)/passport');
});

it('routes an own traveler row to Passport, without offering Follow', async () => {
  const ui = await render(<TravelerRow user={traveler} isOwnProfile />);
  await fireEvent.press(ui.getByText('Ana'));
  expect(router.push).toHaveBeenCalledWith('/(tabs)/passport');
  expect(ui.queryByText('Follow')).toBeNull();
});

it.each([
  { isOfficial: true, label: 'Portava Official' },
  { isOfficial: false, label: 'Verified traveler' },
])('does not relabel the existing $label indicator as identity verification', async ({ isOfficial, label }) => {
  const ui = await render(<TravelerRow user={{ ...traveler, verified: true, isOfficial }} />);
  expect(ui.getByLabelText(label)).toBeTruthy();
  expect(ui.queryByTestId('verified-badge-id')).toBeNull();
  expect(ui.queryByTestId('verified-badge-id_selfie')).toBeNull();
});

it('removes the badge when a refreshed traveler response no longer provides it', async () => {
  const ui = await render(<TravelerRow user={{ ...traveler, identityBadge: { tier: 'id' } }} />);
  expect(ui.getByTestId('verified-badge-id')).toBeTruthy();
  await ui.rerender(<TravelerRow user={traveler} />);
  expect(ui.queryByTestId('verified-badge-id')).toBeNull();
});

it.each([{ handle: null, disabled: false }, { handle: 'ana', disabled: true }])('preserves a disabled identity link: %p', async ({ handle, disabled }) => {
  const ui = await render(<UserNameButton userId="traveler-1" handle={handle} displayName="Ana" disabled={disabled} />);
  await fireEvent.press(ui.getByText('Ana'));
  expect(router.push).not.toHaveBeenCalled();
});
