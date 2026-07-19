/**
 * CrewCallCard — Start vs Join affordance for the crew voice room:
 * "Start Crew Call" when no room is live, "Join Crew Call · N people"
 * while one is, and hidden entirely for non-members.
 */
import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';

const mockGetCrewCall = jest.fn();
// NOTE: exhaustive by design — CrewCallCard imports only getCrewCall from the calls service.
jest.mock('../../../services/calls.ts', () => ({
  getCrewCall: (...args: any[]) => mockGetCrewCall(...args),
}));

const mockActions = {
  startCrewCall: jest.fn(async () => true),
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

import { CrewCallCard } from '../CrewCallCard.tsx';

beforeEach(() => {
  jest.clearAllMocks();
  mockState = { session: null };
});

afterEach(async () => { await act(async () => {}); });

const liveSession = {
  id: 'g1', callType: 'group_voice', contextType: 'trip_crew', contextId: 'trip-1',
  threadId: null, startedBy: 'u9', status: 'active',
  startedAt: '2026-07-19T10:00:00Z', connectedAt: '2026-07-19T10:00:01Z', endedAt: null,
};

test('no live room → Start Crew Call, pressing starts the crew call', async () => {
  mockGetCrewCall.mockResolvedValue({ ok: true, data: { session: null, participantCount: 0 }, error: null });
  const view = await render(<CrewCallCard tripId="trip-1" />);
  await waitFor(() => expect(view.getByText('Start Crew Call')).toBeTruthy());

  fireEvent.press(view.getByLabelText('Start Crew Call'));
  await waitFor(() => expect(mockActions.startCrewCall).toHaveBeenCalledWith({ tripId: 'trip-1' }));
});

test('live room → Join Crew Call · N people; joining routes through startCrewCall', async () => {
  mockGetCrewCall.mockResolvedValue({ ok: true, data: { session: liveSession, participantCount: 4 }, error: null });
  const view = await render(<CrewCallCard tripId="trip-1" />);
  await waitFor(() => expect(view.getByText('Join Crew Call · 4 people')).toBeTruthy());
  expect(view.getByText('A voice room is live for your crew.')).toBeTruthy();

  fireEvent.press(view.getByLabelText('Join Crew Call · 4 people'));
  await waitFor(() => expect(mockActions.startCrewCall).toHaveBeenCalledWith({ tripId: 'trip-1' }));
});

test('already in this crew call → restore affordance instead of re-join', async () => {
  mockGetCrewCall.mockResolvedValue({ ok: true, data: { session: liveSession, participantCount: 4 }, error: null });
  mockState = { session: liveSession };
  const view = await render(<CrewCallCard tripId="trip-1" />);
  await waitFor(() => expect(view.getByText("You're in this Crew Call")).toBeTruthy());

  fireEvent.press(view.getByLabelText("You're in this Crew Call"));
  expect(mockActions.setMinimized).toHaveBeenCalledWith(false);
  expect(mockActions.startCrewCall).not.toHaveBeenCalled();
});

test('non-member (presence denied) renders nothing', async () => {
  mockGetCrewCall.mockResolvedValue({ ok: false, data: null, error: 'not_crew_member' });
  const view = await render(<CrewCallCard tripId="trip-1" />);
  await waitFor(() => expect(mockGetCrewCall).toHaveBeenCalled());
  await act(async () => {});
  expect(view.queryByText('Start Crew Call')).toBeNull();
  expect(view.toJSON()).toBeNull();
});
