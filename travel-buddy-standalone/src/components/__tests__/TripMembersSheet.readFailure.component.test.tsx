/**
 * TripMembersSheet — a members list or an invite picker that could not be
 * read says so (census-trips §79).
 *
 * Before: a failed GET /trips/:id/members left `members: []`, and the sheet
 * said "1 member" and "No members yet." about a trip with a crew; a failed
 * GET /invitable-users set `candidatesLoaded` and said "No friends left to
 * invite."; and getTrip — which now THROWS on a failed read instead of
 * answering null — rejected inside the loader with no catch, leaving the
 * spinner up forever.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */
import React from 'react';
import { render, act, screen, fireEvent } from '@testing-library/react-native';

// NOTE: intentional stub — the signed-in owner is fixed; not under test here.
jest.mock('../../context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: 'owner-1', isAuthed: true, configured: true }),
}));

const mockGetTripMembers = jest.fn();
const mockGetInvitable = jest.fn();
const mockGetCircleMembers = jest.fn();
jest.mock('../../services/friends.ts', () => ({
  ...jest.requireActual('../../services/friends.ts'),
  getTripMembers: (...a: unknown[]) => mockGetTripMembers(...a),
  getTripInvitableUsers: (...a: unknown[]) => mockGetInvitable(...a),
  getCircleMembers: (...a: unknown[]) => mockGetCircleMembers(...a),
  sendTripInvite: jest.fn(),
}));

const mockGetTrip = jest.fn();
jest.mock('../../services/trips.ts', () => ({
  ...jest.requireActual('../../services/trips.ts'),
  getTrip: (...a: unknown[]) => mockGetTrip(...a),
}));

import { TripMembersSheet } from '../TripMembersSheet.tsx';
import { TripsReadUnavailableError } from '../../services/trips.ts';

const CARL = { id: 'carl-1', handle: 'carl', name: 'Carl Crew', avatarUrl: null };
const DORA = { id: 'dora-1', handle: 'dora', name: 'Dora Friend', avatarUrl: null };
const FAILED = { ok: false, data: null, errorKind: 'network', message: 'Network request failed' };

async function open() {
  await render(<TripMembersSheet type="trip" id="trip-1" onDismiss={() => {}} />);
  await act(async () => {});
}

describe('TripMembersSheet — failed reads', () => {
  beforeEach(() => {
    mockGetTripMembers.mockReset();
    mockGetInvitable.mockReset();
    mockGetTrip.mockReset().mockResolvedValue({ id: 'trip-1', ownerId: 'owner-1' });
  });

  it('control: a members read that answers lists the crew and counts them', async () => {
    mockGetTripMembers.mockResolvedValue({ ok: true, data: { members: [CARL], invited: [] } });
    await open();
    expect(screen.getByText('Carl Crew')).toBeTruthy();
    expect(screen.getByText('2 members')).toBeTruthy();
  });

  it('a failed members read is "couldn\'t load", never "No members yet." or a count', async () => {
    mockGetTripMembers.mockResolvedValue(FAILED);
    await open();
    expect(screen.getByText("Couldn't load the members.")).toBeTruthy();
    expect(screen.queryByText('No members yet.')).toBeNull();
    expect(screen.queryByText('1 member')).toBeNull();
    // and nobody is offered an invite on a roster nobody read
    expect(screen.queryByText('Invite a friend')).toBeNull();
  });

  it('Try again re-reads, and a read that then answers lists the crew', async () => {
    mockGetTripMembers.mockResolvedValueOnce(FAILED).mockResolvedValueOnce({ ok: true, data: { members: [CARL], invited: [] } });
    await open();
    await act(async () => { fireEvent.press(screen.getByText('Try again')); });
    await act(async () => {});
    expect(screen.getByText('Carl Crew')).toBeTruthy();
    expect(mockGetTripMembers).toHaveBeenCalledTimes(2);
  });

  it('getTrip throwing (a failed trip read) ends the spinner in the same honest state', async () => {
    mockGetTripMembers.mockResolvedValue({ ok: true, data: { members: [CARL], invited: [] } });
    mockGetTrip.mockRejectedValue(new TripsReadUnavailableError('This trip', null));
    await open();
    expect(screen.getByText("Couldn't load the members.")).toBeTruthy();
  });

  it('a failed invite-candidates read is "couldn\'t load", never "No friends left to invite."', async () => {
    mockGetTripMembers.mockResolvedValue({ ok: true, data: { members: [CARL], invited: [] } });
    mockGetInvitable.mockResolvedValue(FAILED);
    await open();
    await act(async () => { fireEvent.press(screen.getByText('Invite a friend')); });
    await act(async () => {});
    expect(screen.getByText("Couldn't load your friends.")).toBeTruthy();
    expect(screen.queryByText('No friends left to invite.')).toBeNull();
  });

  it('a circle sheet with a failed members read says so too', async () => {
    mockGetCircleMembers.mockResolvedValue(FAILED);
    await render(<TripMembersSheet type="circle" id="owner-1" onDismiss={() => {}} />);
    await act(async () => {});
    expect(screen.getByText("Couldn't load the members.")).toBeTruthy();
    expect(screen.queryByText('No members yet.')).toBeNull();
  });

  it('control: an invite-candidates read that answers empty IS "No friends left to invite."', async () => {
    mockGetTripMembers.mockResolvedValue({ ok: true, data: { members: [CARL], invited: [] } });
    mockGetInvitable.mockResolvedValue({ ok: true, data: { groupMembers: [CARL], otherFollowers: [] } });
    await open();
    await act(async () => { fireEvent.press(screen.getByText('Invite a friend')); });
    await act(async () => {});
    expect(screen.getByText('No friends left to invite.')).toBeTruthy();
  });

  it('after a failed candidates read, Try again re-reads and lists the friend', async () => {
    mockGetTripMembers.mockResolvedValue({ ok: true, data: { members: [CARL], invited: [] } });
    mockGetInvitable.mockResolvedValueOnce(FAILED).mockResolvedValueOnce({ ok: true, data: { groupMembers: [], otherFollowers: [DORA] } });
    await open();
    await act(async () => { fireEvent.press(screen.getByText('Invite a friend')); });
    await act(async () => {});
    await act(async () => { fireEvent.press(screen.getByText('Try again')); });
    await act(async () => {});
    expect(screen.getByText('Dora Friend')).toBeTruthy();
  });
});
