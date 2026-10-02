/**
 * WP-10 TRIP-F06 (census-trips §77, WP10-D3): a pending requester withdraws
 * their request; the id comes from the idempotent join-request route.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { PrivateTripCard, type PrivateTripPreview } from '../PrivateTripCard.tsx';

// NOTE: intentionally exhaustive — services/trips reaches lib/supabase; only
// requestTripAccess is rendered through here.
jest.mock('../../../services/trips', () => ({
  requestTripAccess: jest.fn().mockResolvedValue({ ok: false }),
}));
jest.mock('../../../features/trips/joinRequests/tripJoinRequests.ts', () => ({
  ...jest.requireActual('../../../features/trips/joinRequests/tripJoinRequests.ts'),
  sendJoinRequest: jest.fn(),
  cancelJoinRequest: jest.fn(),
}));

const jr = jest.requireMock('../../../features/trips/joinRequests/tripJoinRequests.ts') as Record<string, jest.Mock>;

const TRIP: PrivateTripPreview = {
  isPrivate: true, id: 'trip-1', title: 'Alps', coverImageUrl: null,
  ownerDisplayName: 'Marco', ownerHandle: 'marco', ownerId: 'o1', myJoinRequestStatus: 'pending',
};

beforeEach(() => jest.clearAllMocks());

it('withdrawing recovers the pending request\'s id and cancels exactly that request', async () => {
  jr.sendJoinRequest.mockResolvedValue({ state: 'pending', requestId: 'r9' });
  jr.cancelJoinRequest.mockResolvedValue({ state: 'done', data: { status: 'cancelled' }, status: 200 });
  await render(<PrivateTripCard trip={TRIP} />);
  await fireEvent.press(screen.getByTestId('private-trip-cancel-request'));
  await waitFor(() => expect(jr.cancelJoinRequest).toHaveBeenCalledWith('trip-1', 'r9'));
  await waitFor(() => expect(screen.getByText('Request Access')).toBeTruthy());
  expect(screen.getByText('Request withdrawn.')).toBeTruthy();
});

it('a withdrawal the server refused keeps the request pending and says why', async () => {
  jr.sendJoinRequest.mockResolvedValue({ state: 'pending', requestId: 'r9' });
  jr.cancelJoinRequest.mockResolvedValue({ state: 'refused', status: 409, reason: 'invalid_state_transition', detail: 'Request is already approved' });
  await render(<PrivateTripCard trip={TRIP} />);
  await fireEvent.press(screen.getByTestId('private-trip-cancel-request'));
  await waitFor(() => expect(screen.getByText('Request is already approved')).toBeTruthy());
  expect(screen.getByText('Request sent')).toBeTruthy();
});

it('a request that could not be sent says so instead of doing nothing', async () => {
  await render(<PrivateTripCard trip={{ ...TRIP, myJoinRequestStatus: null }} />);
  await fireEvent.press(screen.getByText('Request Access'));
  await waitFor(() => expect(screen.getByText("Your request couldn't be sent. Try again.")).toBeTruthy());
});
