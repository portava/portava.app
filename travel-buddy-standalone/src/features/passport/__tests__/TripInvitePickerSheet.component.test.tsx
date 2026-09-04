/**
 * TripInvitePickerSheet — the viewer-side "Invite to trip" action (§3 / TABLE 29
 * can_invite_trip / §32 trip_invite_from_passport).
 *
 *   1. Lists ONLY trips the viewer owns and that are not closed out — the
 *      server's invite route is owner-only, so anything else would be a dead
 *      button (selectInvitableTrips is also asserted directly).
 *   2. Pressing Invite sends through the injected `invite` seam with
 *      (tripId, subjectId), flips the row to "Invited", and emits
 *      trip_invite_from_passport ONCE with the subject id only.
 *   3. An idempotent "already_member" answer reads "Already on trip" and still
 *      counts as an initiated invite.
 *   4. A failed send never emits and offers Retry.
 *   5. Empty state when the viewer hosts nothing.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { TripInvitePickerSheet, selectInvitableTrips } from '../TripInvitePickerSheet.tsx';
import {
  resetPassportTelemetrySink,
  setPassportTelemetrySink,
  type PassportTelemetryEvent,
} from '../passportTelemetry.ts';
import type { TripRow } from '../../../services/trips.ts';

// NOTE: intentionally exhaustive — trips.ts reaches Supabase/the API; the
// sheet takes `loadTrips`/`invite` seams so the real module is never called.
jest.mock('../../../services/trips', () => ({
  listMyTrips: jest.fn(async () => []),
}));
// NOTE: intentionally exhaustive — friends.ts reaches the API; injected here.
jest.mock('../../../services/friends', () => ({
  sendTripInvite: jest.fn(async () => ({ ok: false, data: null })),
}));

// NOTE: react-native-safe-area-context needs a provider that isn't mounted in
// these unit renders — return fixed insets so the sheet lays out.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

function trip(over: Partial<TripRow>): TripRow {
  return {
    id: 'trip-1',
    ownerId: 'me',
    title: 'Bangkok week',
    destinationCity: 'Bangkok',
    destinationCountry: 'Thailand',
    neighborhoods: [],
    startDate: '2026-09-14',
    endDate: '2026-09-17',
    status: 'planning',
    visibility: 'public',
    travelStyle: null,
    openToMeet: false,
    coverUrl: null,
    coverMediaType: null,
    progress: 0,
    tripType: null,
    timezone: null,
    destinationLat: null,
    destinationLng: null,
    destinationPlaceId: null,
    tripNotes: null,
    showOnProfile: true,
    showInDiscovery: false,
    allowFriendSuggestions: false,
    allowTripCrewInvites: true,
    allowJoinRequests: false,
    showExactDates: true,
    showDestinationCity: true,
    delayedPostingDefault: false,
    preciseLocationVisible: false,
    ...over,
  } as TripRow;
}

describe('selectInvitableTrips', () => {
  it('keeps only owned, open trips; nothing without a viewer', () => {
    const trips = [
      trip({ id: 'own-open' }),
      trip({ id: 'own-done', status: 'completed' as TripRow['status'] }),
      trip({ id: 'theirs', ownerId: 'someone-else' }),
    ];
    expect(selectInvitableTrips(trips, 'me').map((t) => t.id)).toEqual(['own-open']);
    expect(selectInvitableTrips(trips, null)).toEqual([]);
  });
});

describe('TripInvitePickerSheet', () => {
  let events: PassportTelemetryEvent[];
  beforeEach(() => {
    events = [];
    setPassportTelemetrySink((e) => events.push(e));
  });
  afterEach(() => resetPassportTelemetrySink());

  it('lists the viewer-owned trips and sends an invite through the seam, emitting once', async () => {
    const loadTrips = jest.fn(async () => [trip({ id: 'trip-1' }), trip({ id: 'theirs', ownerId: 'x' })]);
    const invite = jest.fn(async (_tripId: string, _userId: string) => ({ ok: true, data: { status: 'invited' } }));

    await render(
      <TripInvitePickerSheet
        visible
        onClose={() => {}}
        subjectId="them-1"
        subjectName="Mai"
        viewerUserId="me"
        loadTrips={loadTrips}
        invite={invite}
      />,
    );

    expect(await screen.findByTestId('trip-invite-row-trip-1')).toBeTruthy();
    expect(screen.queryByTestId('trip-invite-row-theirs')).toBeNull();
    expect(screen.getByText('Pick one of your trips to invite Mai to.')).toBeTruthy();

    fireEvent.press(screen.getByTestId('trip-invite-btn-trip-1'));
    expect(await screen.findByText('Invited')).toBeTruthy();
    expect(invite).toHaveBeenCalledTimes(1);
    expect(invite).toHaveBeenCalledWith('trip-1', 'them-1');
    expect(events).toEqual([{ type: 'trip_invite_from_passport', payload: { subjectId: 'them-1' } }]);

    // The row is now inert (the button is disabled once done) — pressing again
    // sends nothing more.
    fireEvent.press(screen.getByTestId('trip-invite-btn-trip-1'));
    expect(invite).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
  });

  it('reads "Already on trip" for the idempotent server answer and still counts the invite', async () => {
    const invite = jest.fn(async () => ({ ok: true, data: { status: 'already_member' } }));
    await render(
      <TripInvitePickerSheet
        visible
        onClose={() => {}}
        subjectId="them-1"
        viewerUserId="me"
        loadTrips={async () => [trip({ id: 'trip-1' })]}
        invite={invite}
      />,
    );
    fireEvent.press(await screen.findByTestId('trip-invite-btn-trip-1'));
    expect(await screen.findByText('Already on trip')).toBeTruthy();
    expect(events.map((e) => e.type)).toEqual(['trip_invite_from_passport']);
  });

  it('a failed send emits nothing and offers Retry', async () => {
    const invite = jest.fn(async () => ({ ok: false, data: null }));
    await render(
      <TripInvitePickerSheet
        visible
        onClose={() => {}}
        subjectId="them-1"
        viewerUserId="me"
        loadTrips={async () => [trip({ id: 'trip-1' })]}
        invite={invite}
      />,
    );
    fireEvent.press(await screen.findByTestId('trip-invite-btn-trip-1'));
    expect(await screen.findByText("Couldn't send — try again")).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
    expect(events).toEqual([]);
  });

  it('shows the empty state when the viewer hosts no trips', async () => {
    await render(
      <TripInvitePickerSheet
        visible
        onClose={() => {}}
        subjectId="them-1"
        viewerUserId="me"
        loadTrips={async () => [trip({ id: 'theirs', ownerId: 'x' })]}
        invite={jest.fn()}
      />,
    );
    expect(await screen.findByTestId('trip-invite-empty')).toBeTruthy();
    expect(events).toEqual([]);
  });
});
