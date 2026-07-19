/**
 * EventVoiceRoomCard — event-page entry states for the Event Voice Room:
 * hosts see Start, attendees see nothing until live, live shows the join
 * affordance with the listening count, denied users see nothing at all.
 */
import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';

const mockGetEventRoom = jest.fn();
// NOTE: exhaustive by design — the card imports only getEventRoom from the calls service.
jest.mock('../../../services/calls.ts', () => ({
  getEventRoom: (...args: any[]) => mockGetEventRoom(...args),
}));

const mockActions = {
  startEventRoom: jest.fn(async () => true),
  joinEventRoom: jest.fn(async () => true),
  setMinimized: jest.fn(),
};
let mockState: any;
// NOTE: exhaustive by design — the card reads state/actions only through these hooks.
jest.mock('../../../context/CallContext.tsx', () => ({
  useCallState: () => mockState,
  useCallActions: () => mockActions,
}));

// NOTE: exhaustive by design — the card only subscribes for group events.
jest.mock('../../../services/telegraphRealtimeService.ts', () => ({
  telegraphRealtime: { subscribe: jest.fn(() => () => {}) },
}));

import { EventVoiceRoomCard } from '../EventVoiceRoomCard.tsx';

beforeEach(() => {
  jest.clearAllMocks();
  mockState = { session: null };
});

afterEach(async () => { await act(async () => {}); });

const liveSession = {
  id: 'evc-1', callType: 'group_voice', contextType: 'event', contextId: 'event-1',
  threadId: null, startedBy: 'host-1', status: 'active',
  startedAt: '2026-07-19T10:00:00Z', connectedAt: '2026-07-19T10:00:01Z', endedAt: null,
};

test('host, no live room → Start Voice Room routes through startEventRoom', async () => {
  mockGetEventRoom.mockResolvedValue({ ok: true, data: { session: null, participantCount: 0, canStart: true }, error: null });
  const view = await render(<EventVoiceRoomCard eventId="event-1" />);
  await waitFor(() => expect(view.getByText('Start Voice Room')).toBeTruthy());

  fireEvent.press(view.getByLabelText('Start Voice Room'));
  await waitFor(() => expect(mockActions.startEventRoom).toHaveBeenCalledWith({ eventId: 'event-1' }));
  expect(mockActions.joinEventRoom).not.toHaveBeenCalled();
  await act(async () => {}); // flush the post-start refresh before the test ends
  await act(async () => {});
});

test('attendee, no live room → renders nothing (no start affordance)', async () => {
  mockGetEventRoom.mockResolvedValue({ ok: true, data: { session: null, participantCount: 0, canStart: false }, error: null });
  const view = await render(<EventVoiceRoomCard eventId="event-1" />);
  await waitFor(() => expect(mockGetEventRoom).toHaveBeenCalled());
  await act(async () => {});
  expect(view.toJSON()).toBeNull();
});

test('live room → Live Voice Room · N listening; joining uses joinEventRoom with the call id', async () => {
  mockGetEventRoom.mockResolvedValue({ ok: true, data: { session: liveSession, participantCount: 12, canStart: false }, error: null });
  const view = await render(<EventVoiceRoomCard eventId="event-1" />);
  await waitFor(() => expect(view.getByText('Live Voice Room · 12 listening')).toBeTruthy());
  expect(view.getByText('Join to listen — raise your hand to speak.')).toBeTruthy();

  fireEvent.press(view.getByLabelText('Live Voice Room · 12 listening'));
  await waitFor(() => expect(mockActions.joinEventRoom).toHaveBeenCalledWith({ callId: 'evc-1' }));
  expect(mockActions.startEventRoom).not.toHaveBeenCalled();
  await act(async () => {}); // flush the post-join refresh before the test ends
  await act(async () => {});
});

test('already in this room → restore affordance instead of re-join', async () => {
  mockGetEventRoom.mockResolvedValue({ ok: true, data: { session: liveSession, participantCount: 3, canStart: false }, error: null });
  mockState = { session: liveSession };
  const view = await render(<EventVoiceRoomCard eventId="event-1" />);
  await waitFor(() => expect(view.getByText("You're in this Voice Room")).toBeTruthy());

  fireEvent.press(view.getByLabelText("You're in this Voice Room"));
  expect(mockActions.setMinimized).toHaveBeenCalledWith(false);
  expect(mockActions.joinEventRoom).not.toHaveBeenCalled();
});

test('outside the event context (denied) renders nothing', async () => {
  mockGetEventRoom.mockResolvedValue({ ok: false, data: null, error: 'not_event_eligible' });
  const view = await render(<EventVoiceRoomCard eventId="event-1" />);
  await waitFor(() => expect(mockGetEventRoom).toHaveBeenCalled());
  await act(async () => {});
  expect(view.toJSON()).toBeNull();
});

// NOTE: kept last — rendering with a foreign in-progress session corrupts the
// next render in this file under React 19 + RNTL scheduling.
test('in another call → pressing the live card does not join', async () => {
  mockGetEventRoom.mockResolvedValue({ ok: true, data: { session: liveSession, participantCount: 3, canStart: false }, error: null });
  mockState = { session: { ...liveSession, id: 'other', contextType: 'trip_crew', contextId: 'trip-9' } };
  const view = await render(<EventVoiceRoomCard eventId="event-1" />);
  await waitFor(() => expect(view.getByText('Live Voice Room · 3 listening')).toBeTruthy());
  fireEvent.press(view.getByLabelText('Live Voice Room · 3 listening'));
  await act(async () => {});
  expect(mockActions.joinEventRoom).not.toHaveBeenCalled();
  expect(mockActions.startEventRoom).not.toHaveBeenCalled();
});
