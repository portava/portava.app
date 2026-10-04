/**
 * Edit trip (app/trip/edit.tsx) — a read that failed is "Could not load trip",
 * never "Trip not found" and never "Only the trip owner can edit this trip"
 * (census-trips §79).
 *
 * The co-host branch asked getTripMemberRole with `.catch(() => null)`, so an
 * outage on the role read told a co-host they had no right to edit their own
 * trip. getTrip now throws on a failed read and the role read is no longer
 * swallowed, so both failures reach the screen's existing load-error state.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */
import React from 'react';
import { render, act, screen } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({ id: 'trip-1' }),
}));

// NOTE: intentional stub — a signed-in co-host (not the owner) is the case under test.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ isAuthed: true, configured: true, userId: 'cohost-1' }),
}));

const mockGetTrip = jest.fn();
const mockGetTripMemberRole = jest.fn();
jest.mock('../../../src/services/trips', () => ({
  ...jest.requireActual('../../../src/services/trips'),
  getTrip: (...a: unknown[]) => mockGetTrip(...a),
  getTripMemberRole: (...a: unknown[]) => mockGetTripMemberRole(...a),
  updateTrip: jest.fn(),
}));

import EditTrip from '../edit.tsx';
import { TripsReadUnavailableError } from '../../../src/services/trips';

const TRIP = {
  id: 'trip-1', ownerId: 'owner-1', title: 'Lisbon', destinationCity: 'Lisbon', destinationCountry: 'Portugal',
  neighborhoods: [], startDate: null, endDate: null, status: 'planning', visibility: 'private',
  travelStyle: null, openToMeet: false, coverUrl: null, coverMediaType: null, progress: 0, tripNotes: null,
};

describe('Edit trip — failed reads', () => {
  beforeEach(() => { mockGetTrip.mockReset(); mockGetTripMemberRole.mockReset(); });

  it('an unreadable role is "Could not load trip", not "Only the trip owner can edit"', async () => {
    mockGetTrip.mockResolvedValue(TRIP);
    mockGetTripMemberRole.mockRejectedValue(new TripsReadUnavailableError('Your role on this trip', null));
    await render(<EditTrip />);
    await act(async () => {});
    expect(screen.getByText('Could not load trip.')).toBeTruthy();
    expect(screen.queryByText('Only the trip owner can edit this trip.')).toBeNull();
  });

  it('an unreadable trip is "Could not load trip", not "Trip not found"', async () => {
    mockGetTrip.mockRejectedValue(new TripsReadUnavailableError('This trip', null));
    await render(<EditTrip />);
    await act(async () => {});
    expect(screen.getByText('Could not load trip.')).toBeTruthy();
    expect(screen.queryByText('Trip not found.')).toBeNull();
  });

  it('control: a READ that says "member" still refuses a non-host', async () => {
    mockGetTrip.mockResolvedValue(TRIP);
    mockGetTripMemberRole.mockResolvedValue('member');
    await render(<EditTrip />);
    await act(async () => {});
    expect(screen.getByText('Only the trip owner can edit this trip.')).toBeTruthy();
  });
});
