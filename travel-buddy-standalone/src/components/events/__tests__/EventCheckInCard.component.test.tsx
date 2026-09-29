/**
 * EventCheckInCard — the attendee's self check-in on the event page (PLAT-F26).
 *
 * Offered only to a Going attendee who is not staff, only inside the window the
 * server accepts (lib/eventCheckIn.ts ↔ routes/events.ts eventCheckInRefusal),
 * and a refusal is shown as the server's message — never as a check-in.
 */
import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';

const mockSelfCheckIn = jest.fn();
// NOTE: exhaustive by design — the card imports only selfCheckIn (and a type) from the events service.
jest.mock('../../../services/events.ts', () => ({
  selfCheckIn: (...args: any[]) => mockSelfCheckIn(...args),
}));

import { EventCheckInCard } from '../EventCheckInCard.tsx';

const START = Date.parse('2026-10-01T18:00:00Z');
const H = 3_600_000;

function ev(over: Record<string, unknown> = {}): any {
  return {
    id: 'ev-1', state: 'open', startsAt: new Date(START).toISOString(), endsAt: null,
    isHost: false, myRole: null, myRsvp: 'going', myAttendanceState: null, ...over,
  };
}

beforeEach(() => jest.clearAllMocks());
afterEach(async () => { await act(async () => {}); });

test('inside the window a Going attendee gets Check in; success shows the time and refreshes', async () => {
  mockSelfCheckIn.mockResolvedValue({ ok: true, data: { ok: true, checkedInAt: new Date(START).toISOString() } });
  const onCheckedIn = jest.fn();
  const view = await render(<EventCheckInCard event={ev()} now={START - 30 * 60_000} onCheckedIn={onCheckedIn} />);
  fireEvent.press(view.getByLabelText('Check in'));
  await waitFor(() => expect(view.getByTestId('event-checkin-done')).toBeTruthy());
  expect(mockSelfCheckIn).toHaveBeenCalledWith('ev-1');
  expect(onCheckedIn).toHaveBeenCalled();
});

test('a server refusal is shown as its message, never as checked in', async () => {
  mockSelfCheckIn.mockResolvedValue({ ok: false, message: 'Check-in opens 60 minutes before the event starts' });
  const view = await render(<EventCheckInCard event={ev()} now={START} />);
  fireEvent.press(view.getByLabelText('Check in'));
  await waitFor(() => expect(view.getByTestId('event-checkin-error')).toBeTruthy());
  expect(view.getByText('Check-in opens 60 minutes before the event starts')).toBeTruthy();
  expect(view.queryByTestId('event-checkin-done')).toBeNull();
});

test('more than an hour before the start: says when check-in opens, no button', async () => {
  const view = await render(<EventCheckInCard event={ev()} now={START - 2 * H} />);
  expect(view.getByTestId('event-checkin-not-yet')).toBeTruthy();
  expect(view.queryByLabelText('Check in')).toBeNull();
});

test('already checked in (the raw snake_case row the API sends) shows done, not the button', async () => {
  const view = await render(<EventCheckInCard event={ev({ myAttendanceState: { checked_in_at: new Date(START).toISOString() } })} now={START} />);
  expect(view.getByTestId('event-checkin-done')).toBeTruthy();
  expect(view.queryByLabelText('Check in')).toBeNull();
});

test('nothing for staff, for a non-Going RSVP, or once the window has closed', async () => {
  for (const e of [ev({ isHost: true }), ev({ myRole: 'co_host' }), ev({ myRsvp: 'maybe' }), ev({ state: 'cancelled' })]) {
    const view = await render(<EventCheckInCard event={e} now={START} />);
    expect(view.toJSON()).toBeNull();
    view.unmount();
  }
  const late = await render(<EventCheckInCard event={ev()} now={START + 9 * H} />);
  expect(late.toJSON()).toBeNull();
});
