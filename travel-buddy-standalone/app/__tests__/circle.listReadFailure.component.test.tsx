/**
 * Circle — a failed Following / Followers read says so, with a retry, instead
 * of "No one in your circle yet" / "No followers yet".
 *
 *   C1  a failed Following read shows the error, and Try again reloads both lists;
 *   C2  a failed Followers read shows on the Followers tab only;
 *   C3  a real empty circle still shows the empty state.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — no trip param; router is a stub.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({}),
}));

const mockFollowing = jest.fn();
const mockFollowers = jest.fn();
// NOTE: intentionally exhaustive — the two reads the Circle screen makes.
jest.mock('../../src/services/follows', () => ({
  getMyFollowing: (...a: unknown[]) => mockFollowing(...a),
  getMyFollowers: (...a: unknown[]) => mockFollowers(...a),
}));
// NOTE: intentionally exhaustive — invites, trips and chat are not opened here.
jest.mock('../../src/services/friends', () => ({ sendTripInvite: jest.fn() }));
// NOTE: intentionally exhaustive — no trip param, so getTrip is never called.
jest.mock('../../src/services/trips', () => ({ getTrip: jest.fn() }));
// NOTE: intentionally exhaustive — Circle Chat is not opened here.
jest.mock('../../src/services/messaging', () => ({ openCircleChat: jest.fn() }));
// NOTE: intentionally exhaustive — age settings are read and left closed.
jest.mock('../../src/services/circleAgeSettings', () => ({
  getMyCircleAgeSettings: jest.fn(() => Promise.resolve({ ok: true, data: null })),
  updateCircleAgeSettings: jest.fn(),
}));
// NOTE: intentionally exhaustive — no availability in these cases.
jest.mock('../../src/services/availability', () => ({
  getCircleAvailability: jest.fn(() => Promise.resolve({ ok: true, data: { members: [] } })),
}));
// NOTE: intentionally exhaustive — signed in, configured.
jest.mock('../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: 'me', isAuthed: true, configured: true }),
}));
// NOTE: intentionally exhaustive — no one is blocked.
jest.mock('../../src/context/BlockedIdsContext', () => ({ useBlockedIds: () => ({ blockedIds: new Set(), isBlocked: () => false }) }));
// NOTE: intentional stub — header chrome is not under test.
jest.mock('../../src/components/ui/AppHeader', () => ({ AppHeader: () => null }));
// NOTE: intentional stub — availability UI is not under test.
jest.mock('../../src/components/AvailabilityGrid', () => ({ AvailabilityGrid: () => null }));
// NOTE: intentional stub — availability UI is not under test.
jest.mock('../../src/components/BestDaysBanner', () => ({ BestDaysBanner: () => null }));
// NOTE: intentional stub — the meetup sheet stays closed.
jest.mock('../../src/components/MeetupCreationSheet', () => ({ MeetupCreationSheet: () => null }));
// NOTE: intentional stub — highlight rings read the API.
jest.mock('../../src/components/HighlightRing', () => ({ HighlightRing: () => null }));
// NOTE: intentional stub — the highlight viewer stays closed.
jest.mock('../../src/components/HighlightViewer', () => ({ HighlightViewer: () => null }));
// NOTE: intentionally exhaustive — no highlight rings.
jest.mock('../../src/hooks/useHighlightRingState', () => ({ useHighlightRingState: () => ({ rings: {}, seen: new Set(), markSeen: jest.fn() }) }));
// NOTE: intentional stub — the row's interactive name/avatar/menu are not under test.
jest.mock('../../src/components/interaction/UserAvatarButton', () => ({ UserAvatarButton: () => null }));
// NOTE: intentional stub — the row's interactive name/avatar/menu are not under test.
jest.mock('../../src/components/interaction/UserNameButton', () => {
  const { Text } = jest.requireActual('react-native');
  return { UserNameButton: ({ name, handle }: { name?: string; handle?: string }) => <Text>{name ?? handle}</Text> };
});
// NOTE: intentional stub — the row's interactive name/avatar/menu are not under test.
jest.mock('../../src/components/interaction/UserOverflowMenu', () => ({ UserOverflowMenu: () => null }));
// NOTE: intentionally exhaustive — the nav-bar collapse needs Reanimated internals.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({ useNavBarScrollHandler: () => jest.fn(), NavBarFiller: () => null }));
// NOTE: intentionally exhaustive — a fixed inset.
jest.mock('../../src/hooks/useBottomInset', () => ({ usePlainBottomInset: () => 0 }));
// NOTE: intentional stub — the members panel reads the API.
jest.mock('../../src/components/circle/MyCircleMembersPanel', () => ({ MyCircleMembersPanel: () => null }));

import CircleScreen from '../circle';

const FAILED = { ok: false, data: null, errorKind: 'db_error' };
const EMPTY = { ok: true, data: [] };

beforeEach(() => { mockFollowing.mockReset(); mockFollowers.mockReset(); });

describe('Circle — a failed list read is not an empty circle', () => {
  it('C1: a failed Following read is said, and Try again reloads', async () => {
    mockFollowing.mockResolvedValueOnce(FAILED).mockResolvedValueOnce(EMPTY);
    mockFollowers.mockResolvedValue(EMPTY);
    await render(<CircleScreen />);
    await screen.findByText('Your circle could not be loaded');
    expect(screen.queryByText('No one in your circle yet')).toBeNull();

    await fireEvent.press(screen.getByLabelText('Try loading your circle again'));
    await screen.findByText('No one in your circle yet');
    expect(mockFollowing).toHaveBeenCalledTimes(2);
  });

  it('C2: a failed Followers read shows on the Followers tab only', async () => {
    mockFollowing.mockResolvedValue(EMPTY);
    mockFollowers.mockResolvedValue(FAILED);
    await render(<CircleScreen />);
    await screen.findByText('No one in your circle yet');
    expect(screen.queryByTestId('circle-list-error')).toBeNull();

    await fireEvent.press(screen.getByText('Followers'));
    await screen.findByText('Your followers could not be loaded');
    expect(screen.queryByText('No followers yet')).toBeNull();
  });

  it('C3: a real empty circle still shows the empty state', async () => {
    mockFollowing.mockResolvedValue(EMPTY);
    mockFollowers.mockResolvedValue(EMPTY);
    await render(<CircleScreen />);
    await screen.findByText('No one in your circle yet');
    expect(screen.queryByTestId('circle-list-error')).toBeNull();
  });
});
