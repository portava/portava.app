/**
 * HostDashboardPanel — lifecycle actions go through their own routes
 * (PLAT-F26, PLAT-F28):
 *   - "Mark as completed" calls POST /events/:id/complete (attendance trust,
 *     stamps, review prompts), not PATCH { state };
 *   - there is no "Mark as started" button — PATCH cannot write `started` (the
 *     server refuses it by name); the panel says how an event starts instead;
 *   - the Attendance and Co-hosts tabs mount their panels.
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';

const mockApi = { completeEvent: jest.fn(), updateEvent: jest.fn(), getJoinRequests: jest.fn() };
jest.mock('../../services/events.ts', () => ({
  ...jest.requireActual('../../services/events.ts'),
  completeEvent: (...a: any[]) => mockApi.completeEvent(...a),
  updateEvent: (...a: any[]) => mockApi.updateEvent(...a),
  getJoinRequests: (...a: any[]) => mockApi.getJoinRequests(...a),
}));

// NOTE: intentional stubs — markers; each panel's behaviour is pinned in src/components/events/__tests__.
jest.mock('../events/EventAttendancePanel.tsx', () => {
  const { Text } = require('react-native');
  return { EventAttendancePanel: () => <Text>marker:attendance</Text> };
});
// NOTE: intentional stub — marker.
jest.mock('../events/EventCohostsPanel.tsx', () => {
  const { Text } = require('react-native');
  return { EventCohostsPanel: () => <Text>marker:cohosts</Text> };
});
// NOTE: intentional stub — marker.
jest.mock('../events/EventCancelControl.tsx', () => {
  const { Text } = require('react-native');
  return { EventCancelControl: () => <Text>marker:cancel</Text> };
});
// NOTE: intentional stub — not under test here.
jest.mock('../events/GenerateHeaderSheet.tsx', () => ({ GenerateHeaderSheet: () => null }));

import { HostDashboardPanel } from '../HostDashboardPanel.tsx';

const baseEvent: any = {
  id: 'ev-1', state: 'started', rsvpClosed: false, coverUrl: null, goingAttendees: [],
  isHost: true, myRole: 'host', hostId: 'host',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.getJoinRequests.mockResolvedValue({ ok: true, data: { requests: [] } });
});
afterEach(async () => { await act(async () => {}); });

test('Mark as completed calls the complete route, not PATCH', async () => {
  mockApi.completeEvent.mockResolvedValue({ ok: true, data: { ok: true } });
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
    const yes = (buttons ?? []).find((b) => b.text === 'Yes');
    yes?.onPress?.();
  });
  const onRefresh = jest.fn();
  const view = await render(<HostDashboardPanel event={baseEvent} onDismiss={jest.fn()} onRefresh={onRefresh} />);
  await act(async () => { fireEvent.press(view.getByText('Controls')); });
  await act(async () => { fireEvent.press(view.getByText('Mark as completed')); });
  await waitFor(() => expect(mockApi.completeEvent).toHaveBeenCalledWith('ev-1'));
  expect(mockApi.updateEvent).not.toHaveBeenCalled();
  await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  expect(view.getByText('marker:cancel')).toBeTruthy();
  alertSpy.mockRestore();
});

test('an open event has no "Mark as started"; the panel says how an event starts', async () => {
  const view = await render(<HostDashboardPanel event={{ ...baseEvent, state: 'open' }} onDismiss={jest.fn()} onRefresh={jest.fn()} />);
  await act(async () => { fireEvent.press(view.getByText('Controls')); });
  expect(view.queryByText('Mark as started')).toBeNull();
  expect(view.getByTestId('host-start-note')).toBeTruthy();
});

test('Attendance and Co-hosts tabs mount their panels', async () => {
  const view = await render(<HostDashboardPanel event={baseEvent} onDismiss={jest.fn()} onRefresh={jest.fn()} />);
  await act(async () => { fireEvent.press(view.getByText('Attendance')); });
  expect(view.getByText('marker:attendance')).toBeTruthy();
  await act(async () => { fireEvent.press(view.getByText('Co-hosts')); });
  expect(view.getByText('marker:cohosts')).toBeTruthy();
});
