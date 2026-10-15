import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { router } from 'expo-router';
import { EventAttendancePanel } from '../EventAttendancePanel.tsx';
import { getEventAttendees, confirmAttendance, markNoShow } from '../../../services/events.ts';

jest.mock('expo-router', () => ({ ...jest.requireActual('expo-router'), router: { push: jest.fn() } }));
jest.mock('../../../services/events.ts', () => ({
  ...jest.requireActual('../../../services/events.ts'),
  getEventAttendees: jest.fn(), confirmAttendance: jest.fn(), markNoShow: jest.fn(),
}));
const mockBlockedIds = new Set<string>();
const mockBlockerIds = new Set<string>();
jest.mock('../../../context/BlockedIdsContext.tsx', () => ({
  ...jest.requireActual('../../../context/BlockedIdsContext.tsx'),
  useBlockedIds: () => ({ blockedIds: mockBlockedIds, blockerIds: mockBlockerIds, isLoading: false }),
}));

const attendee = {
  userId: 'u-1', handle: 'ana', displayName: 'Ana', avatarUrl: null, rsvpStatus: 'going',
  checkedInAt: null, confirmedAt: null, noShowAt: null, identityBadge: { tier: 'id_selfie' },
};
beforeEach(() => {
  jest.clearAllMocks(); mockBlockedIds.clear(); mockBlockerIds.clear();
  (getEventAttendees as jest.Mock).mockResolvedValue({ ok: true, data: { attendees: [attendee] } });
});

it('opens the attendee profile from their name without marking attendance', async () => {
  const ui = await render(<EventAttendancePanel event={{ id: 'event-1', state: 'started' }} />);
  await ui.findByText('Ana');
  expect(ui.getByTestId('verified-badge-id_selfie')).toBeTruthy();
  await fireEvent.press(ui.getByText('Ana'));
  expect(router.push).toHaveBeenCalledWith('/u/ana');
  expect(confirmAttendance).not.toHaveBeenCalled();
  expect(markNoShow).not.toHaveBeenCalled();
});

it('a badge opens only its criteria, not a profile or a moderation action', async () => {
  const ui = await render(<EventAttendancePanel event={{ id: 'event-1', state: 'started' }} />);
  await ui.findByText('Ana');
  const stopPropagation = jest.fn();
  await fireEvent.press(ui.getByTestId('verified-badge-id_selfie'), { stopPropagation });
  expect(stopPropagation).toHaveBeenCalledTimes(1);
  expect(ui.getByTestId('verified-badge-criteria')).toBeTruthy();
  expect(router.push).not.toHaveBeenCalled();
  expect(confirmAttendance).not.toHaveBeenCalled();
});

it.each(['blocked', 'blocker'])('suppresses profile navigation for a %s attendee', async (direction) => {
  (direction === 'blocked' ? mockBlockedIds : mockBlockerIds).add('u-1');
  const ui = await render(<EventAttendancePanel event={{ id: 'event-1', state: 'started' }} />);
  await ui.findByText('Ana');
  await fireEvent.press(ui.getByText('Ana'));
  expect(router.push).not.toHaveBeenCalled();
});

it('does not infer a badge from legacy verification or navigate a missing handle', async () => {
  (getEventAttendees as jest.Mock).mockResolvedValue({ ok: true, data: { attendees: [{ ...attendee, handle: null, identityBadge: null, verified: true }] } });
  const ui = await render(<EventAttendancePanel event={{ id: 'event-1', state: 'started' }} />);
  await ui.findByText('Ana');
  expect(ui.queryByTestId('verified-badge-id_selfie')).toBeNull();
  expect(ui.queryByTestId('verified-badge-id')).toBeNull();
  await fireEvent.press(ui.getByText('Ana'));
  expect(router.push).not.toHaveBeenCalled();
});
