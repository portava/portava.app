/**
 * Reminder detail screen (app/reminders/[id].tsx) — auth gate + delete
 * confirmation ordering.
 *
 * This screen has NO inherited auth guard from a parent layout — useSession()
 * gating inside the component is the ONLY thing that keeps an unauthenticated
 * user off the detail/edit/delete UI. Also pins that pressing the delete
 * button surfaces a confirmation BEFORE deleteReminder is called — not after,
 * and not skipped.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, act, screen, fireEvent, cleanup } from '@testing-library/react-native';
import { Alert } from 'react-native';

afterEach(cleanup);

let mockSessionValue: { isAuthed: boolean; configured: boolean; userId: string | null } = {
  isAuthed: true,
  configured: true,
  userId: 'user-1',
};
jest.mock('../../../src/context/SessionContext', () => ({
  ...jest.requireActual('../../../src/context/SessionContext'),
  useSession: () => mockSessionValue,
}));

const NOW = Date.now();
const mockReminder = {
  id: 'r-1',
  title: 'Pack bags',
  note: null,
  remindAt: new Date(NOW + 60 * 60_000).toISOString(),
  targetType: 'custom',
  targetId: null,
  tripId: null,
  targetLabel: null,
  status: 'upcoming',
  notificationId: 'notif-1',
  createdAt: new Date(NOW).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
};

const mockGetReminder = jest.fn(async () => ({ ...mockReminder }));
const mockDeleteReminder = jest.fn(async () => undefined);
const mockEditReminder = jest.fn(async () => ({ ...mockReminder }));
const mockSnoozeReminder = jest.fn(async () => ({ ...mockReminder }));
const mockCompleteReminder = jest.fn(async () => ({ ...mockReminder, status: 'completed' }));
const mockReopenReminder = jest.fn(async () => ({ ...mockReminder }));
jest.mock('../../../src/services/reminders.ts', () => ({
  ...jest.requireActual('../../../src/services/reminders.ts'),
  getReminder: (...args: unknown[]) => mockGetReminder(...args),
  deleteReminder: (...args: unknown[]) => mockDeleteReminder(...args),
  editReminder: (...args: unknown[]) => mockEditReminder(...args),
  snoozeReminder: (...args: unknown[]) => mockSnoozeReminder(...args),
  completeReminder: (...args: unknown[]) => mockCompleteReminder(...args),
  reopenReminder: (...args: unknown[]) => mockReopenReminder(...args),
}));

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { back: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => ({ id: 'r-1' }),
}));

// NOTE: intentional stub — keyboard-avoidance chrome, not under test here.
jest.mock('../../../src/components/ui/KeyboardSafeView.tsx', () => {
  const { View } = require('react-native');
  return { KeyboardSafeView: ({ children }: any) => <View>{children}</View> };
});

// NOTE: intentional stub — native date/time picker UI, not under test here.
jest.mock('../../../src/components/DateTimePickerField.tsx', () => ({
  DatePickerField: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import ReminderDetailScreen from '../[id].tsx';

describe('ReminderDetailScreen — auth gate', () => {
  it('shows a sign-in prompt and never fetches the reminder when unauthenticated', async () => {
    mockSessionValue = { isAuthed: false, configured: true, userId: null };
    mockGetReminder.mockClear();

    await act(async () => { render(<ReminderDetailScreen />); });

    expect(screen.getByText('Sign in to view this reminder.')).toBeTruthy();
    expect(mockGetReminder).not.toHaveBeenCalled();
  });

  it('shows the same sign-in prompt when session is not configured', async () => {
    mockSessionValue = { isAuthed: true, configured: false, userId: 'user-1' };
    mockGetReminder.mockClear();

    await act(async () => { render(<ReminderDetailScreen />); });

    expect(screen.getByText('Sign in to view this reminder.')).toBeTruthy();
    expect(mockGetReminder).not.toHaveBeenCalled();
  });
});

describe('ReminderDetailScreen — delete confirmation ordering', () => {
  beforeEach(() => {
    mockSessionValue = { isAuthed: true, configured: true, userId: 'user-1' };
    mockGetReminder.mockClear();
    mockDeleteReminder.mockClear();
  });

  it('shows a confirmation and does NOT delete until the destructive action is confirmed', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    await act(async () => { render(<ReminderDetailScreen />); });
    await act(async () => {});

    const deleteBtn = screen.getByTestId('icon-Trash2');
    await act(async () => { fireEvent.press(deleteBtn.parent!); });

    // Confirmation was surfaced...
    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [title] = alertSpy.mock.calls[0];
    expect(title).toMatch(/delete/i);

    // ...and deletion has NOT happened yet — only the confirm button's onPress does it.
    expect(mockDeleteReminder).not.toHaveBeenCalled();

    // Simulate the user confirming.
    const buttons = alertSpy.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
    const confirmButton = buttons.find((b) => /delete/i.test(b.text));
    expect(confirmButton).toBeDefined();
    await act(async () => { await confirmButton!.onPress?.(); });

    expect(mockDeleteReminder).toHaveBeenCalledTimes(1);
    expect(mockDeleteReminder).toHaveBeenCalledWith('r-1');

    alertSpy.mockRestore();
  });

  it('does nothing when the confirmation is cancelled', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    await act(async () => { render(<ReminderDetailScreen />); });
    await act(async () => {});

    const deleteBtn = screen.getByTestId('icon-Trash2');
    await act(async () => { fireEvent.press(deleteBtn.parent!); });

    const buttons = alertSpy.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
    const cancelButton = buttons.find((b) => /cancel/i.test(b.text));
    expect(cancelButton).toBeDefined();
    // Cancel has no onPress in this screen's Alert config (default dismiss).
    expect(cancelButton!.onPress).toBeUndefined();

    expect(mockDeleteReminder).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });
});
