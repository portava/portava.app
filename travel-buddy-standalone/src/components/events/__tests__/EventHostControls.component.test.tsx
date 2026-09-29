/**
 * Host Dashboard controls built for testing mode:
 *   EventAttendancePanel (PLAT-F26) — attendance list, confirm / no-show;
 *   EventCohostsPanel    (PLAT-F28) — list, add from Going, remove;
 *   EventCancelControl   (PLAT-F28) — cancel through POST /cancel with a reason.
 *
 * Failure honesty throughout: a failed read is an error with Retry (never an
 * empty list) and a refused write is the server's message (never a success).
 */
import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';

const mockApi = {
  getEventAttendees: jest.fn(), confirmAttendance: jest.fn(), markNoShow: jest.fn(),
  getEventCohosts: jest.fn(), addEventCohost: jest.fn(), removeEventCohost: jest.fn(),
  cancelEventWithReason: jest.fn(),
};
// NOTE: exhaustive by design — these three components import only these calls (and types) from the events service.
jest.mock('../../../services/events.ts', () => ({
  getEventAttendees: (...a: any[]) => mockApi.getEventAttendees(...a),
  confirmAttendance: (...a: any[]) => mockApi.confirmAttendance(...a),
  markNoShow: (...a: any[]) => mockApi.markNoShow(...a),
  getEventCohosts: (...a: any[]) => mockApi.getEventCohosts(...a),
  addEventCohost: (...a: any[]) => mockApi.addEventCohost(...a),
  removeEventCohost: (...a: any[]) => mockApi.removeEventCohost(...a),
  cancelEventWithReason: (...a: any[]) => mockApi.cancelEventWithReason(...a),
}));

import { EventAttendancePanel } from '../EventAttendancePanel.tsx';
import { EventCohostsPanel } from '../EventCohostsPanel.tsx';
import { EventCancelControl } from '../EventCancelControl.tsx';

beforeEach(() => jest.clearAllMocks());
afterEach(async () => { await act(async () => {}); });

const row = (over: Record<string, unknown> = {}) => ({
  userId: 'u-1', handle: 'ana', displayName: null, avatarUrl: null, rsvpStatus: 'going',
  checkedInAt: '2026-10-01T18:05:00Z', confirmedAt: null, noShowAt: null, ...over,
});

describe('EventAttendancePanel', () => {
  test('a failed read is an error with Retry, not an empty list; Retry reloads', async () => {
    mockApi.getEventAttendees.mockResolvedValueOnce({ ok: false, message: 'Only host or moderators can view the full attendee list' });
    const view = await render(<EventAttendancePanel event={{ id: 'ev-1', state: 'started' }} />);
    await waitFor(() => expect(view.getByTestId('attendance-error')).toBeTruthy());
    expect(view.queryByText('Nobody is going yet')).toBeNull();
    mockApi.getEventAttendees.mockResolvedValueOnce({ ok: true, data: { attendees: [row()] } });
    fireEvent.press(view.getByLabelText('Retry'));
    await waitFor(() => expect(view.getByTestId('attendance-list')).toBeTruthy());
  });

  test('while started: confirm and no-show call the routes and update the row', async () => {
    mockApi.getEventAttendees.mockResolvedValue({ ok: true, data: { attendees: [row()] } });
    mockApi.confirmAttendance.mockResolvedValue({ ok: true, data: { ok: true, confirmedAt: '2026-10-01T19:00:00Z' } });
    mockApi.markNoShow.mockResolvedValue({ ok: true, data: { ok: true, noShowAt: '2026-10-01T19:30:00Z' } });
    const view = await render(<EventAttendancePanel event={{ id: 'ev-1', state: 'started' }} />);
    await waitFor(() => expect(view.getByText(/1 going · 1 checked in/)).toBeTruthy());
    fireEvent.press(view.getByLabelText('Confirm ana attended'));
    await waitFor(() => expect(view.getByText(/^Attended/)).toBeTruthy());
    expect(mockApi.confirmAttendance).toHaveBeenCalledWith('ev-1', 'u-1');
    fireEvent.press(view.getByLabelText('Mark ana as a no-show'));
    await waitFor(() => expect(view.getByText(/^No-show/)).toBeTruthy());
    expect(mockApi.markNoShow).toHaveBeenCalledWith('ev-1', 'u-1');
  });

  test('a refused mark shows the server message and the row keeps its state', async () => {
    mockApi.getEventAttendees.mockResolvedValue({ ok: true, data: { attendees: [row()] } });
    mockApi.confirmAttendance.mockResolvedValue({ ok: false, message: 'User does not have a Going RSVP for this event' });
    const view = await render(<EventAttendancePanel event={{ id: 'ev-1', state: 'completed' }} />);
    await waitFor(() => expect(view.getByLabelText('Confirm ana attended')).toBeTruthy());
    fireEvent.press(view.getByLabelText('Confirm ana attended'));
    await waitFor(() => expect(view.getByText('User does not have a Going RSVP for this event')).toBeTruthy());
    expect(view.queryByText(/^Attended/)).toBeNull();
  });

  test('before the stored state is started, no marking buttons and the reason is said', async () => {
    mockApi.getEventAttendees.mockResolvedValue({ ok: true, data: { attendees: [row()] } });
    const view = await render(<EventAttendancePanel event={{ id: 'ev-1', state: 'open' }} />);
    await waitFor(() => expect(view.getByTestId('attendance-not-open')).toBeTruthy());
    expect(view.queryByLabelText('Confirm ana attended')).toBeNull();
    expect(view.getByText(/Checked in/)).toBeTruthy();
  });
});

describe('EventCohostsPanel', () => {
  const event = {
    id: 'ev-1', hostId: 'host', isHost: true, myRole: 'host' as const,
    goingAttendees: [
      { id: 'host', handle: 'me', displayName: null, avatarUrl: null },
      { id: 'u-2', handle: 'bo', displayName: null, avatarUrl: null },
    ],
  };

  test('a failed read is an error with Retry, not "No co-hosts yet"', async () => {
    mockApi.getEventCohosts.mockResolvedValue({ ok: false, message: 'db_error' });
    const view = await render(<EventCohostsPanel event={event} />);
    await waitFor(() => expect(view.getByTestId('cohosts-error')).toBeTruthy());
    expect(view.queryByText('No co-hosts yet')).toBeNull();
  });

  test('the host adds a co-host from people going (not themselves) and removes one', async () => {
    mockApi.getEventCohosts
      .mockResolvedValueOnce({ ok: true, data: { cohosts: [] } })
      .mockResolvedValueOnce({ ok: true, data: { cohosts: [{ user_id: 'u-2', handle: 'bo', displayName: null, avatarUrl: null, permissions: null, added_by: 'host', added_at: null }] } });
    mockApi.addEventCohost.mockResolvedValue({ ok: true, data: { ok: true, userId: 'u-2' } });
    mockApi.removeEventCohost.mockResolvedValue({ ok: true, data: { ok: true } });
    const onChanged = jest.fn();
    const view = await render(<EventCohostsPanel event={event} onChanged={onChanged} />);
    await waitFor(() => expect(view.getByText('No co-hosts yet')).toBeTruthy());
    expect(view.queryByLabelText('Make @me a co-host')).toBeNull();
    fireEvent.press(view.getByLabelText('Make @bo a co-host'));
    await waitFor(() => expect(view.getByLabelText('Remove @bo as co-host')).toBeTruthy());
    expect(mockApi.addEventCohost).toHaveBeenCalledWith('ev-1', 'u-2');
    fireEvent.press(view.getByLabelText('Remove @bo as co-host'));
    await waitFor(() => expect(view.getByText('No co-hosts yet')).toBeTruthy());
    expect(mockApi.removeEventCohost).toHaveBeenCalledWith('ev-1', 'u-2');
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  test('a refused add (e.g. blocked) is shown as the server message', async () => {
    mockApi.getEventCohosts.mockResolvedValue({ ok: true, data: { cohosts: [] } });
    mockApi.addEventCohost.mockResolvedValue({ ok: false, message: "You can't add this person as a co-host" });
    const view = await render(<EventCohostsPanel event={event} />);
    await waitFor(() => expect(view.getByLabelText('Make @bo a co-host')).toBeTruthy());
    fireEvent.press(view.getByLabelText('Make @bo a co-host'));
    await waitFor(() => expect(view.getByTestId('cohosts-action-error')).toBeTruthy());
    expect(view.getByText("You can't add this person as a co-host")).toBeTruthy();
  });

  test('a co-host sees the list without add / remove controls', async () => {
    mockApi.getEventCohosts.mockResolvedValue({ ok: true, data: { cohosts: [{ user_id: 'u-2', handle: 'bo', displayName: null, avatarUrl: null, permissions: null, added_by: 'host', added_at: null }] } });
    const view = await render(<EventCohostsPanel event={{ ...event, isHost: false, myRole: 'co_host' as const }} />);
    await waitFor(() => expect(view.getByTestId('cohosts-list')).toBeTruthy());
    expect(view.queryByLabelText('Remove @bo as co-host')).toBeNull();
    expect(view.queryByText('Add a co-host from people going')).toBeNull();
  });
});

describe('EventCancelControl', () => {
  test('two steps; sends the reason to POST /cancel; success calls onCancelled', async () => {
    mockApi.cancelEventWithReason.mockResolvedValue({ ok: true, data: { ok: true } });
    const onCancelled = jest.fn();
    const view = await render(<EventCancelControl eventId="ev-1" onCancelled={onCancelled} />);
    await act(async () => { fireEvent.press(view.getByTestId('event-cancel-start')); });
    await waitFor(() => expect(view.getByTestId('event-cancel-confirm')).toBeTruthy());
    await act(async () => { fireEvent.changeText(view.getByLabelText('Cancellation reason'), 'Venue closed'); });
    fireEvent.press(view.getByTestId('event-cancel-submit'));
    await waitFor(() => expect(onCancelled).toHaveBeenCalled());
    expect(mockApi.cancelEventWithReason).toHaveBeenCalledWith('ev-1', 'Venue closed');
  });

  test('a refusal stays on the confirm step with the server message', async () => {
    mockApi.cancelEventWithReason.mockResolvedValue({ ok: false, message: 'Only the host can cancel this event' });
    const onCancelled = jest.fn();
    const view = await render(<EventCancelControl eventId="ev-1" onCancelled={onCancelled} />);
    await act(async () => { fireEvent.press(view.getByTestId('event-cancel-start')); });
    await waitFor(() => expect(view.getByTestId('event-cancel-confirm')).toBeTruthy());
    fireEvent.press(view.getByTestId('event-cancel-submit'));
    await waitFor(() => expect(view.getByTestId('event-cancel-error')).toBeTruthy());
    expect(view.getByText('Only the host can cancel this event')).toBeTruthy();
    expect(onCancelled).not.toHaveBeenCalled();
  });
});
