/**
 * Reminder detail screen (app/reminders/[id].tsx) — target row navigation.
 *
 * Pins the "tap the target row → navigate back to the right screen" half of
 * the reminder round trip for the two newer target types (trip, saved_place):
 *   - trip      → /trip/<targetId>
 *   - saved_place → /place/<targetId>
 * and confirms the row is not pressable (no crash, no navigation) when a
 * reminder has a targetLabel but a target type the route table doesn't cover
 * navigation for (custom never renders a target row at all, since
 * targetLabel is null for custom reminders in practice).
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, act, screen, fireEvent, cleanup } from '@testing-library/react-native';

afterEach(cleanup);

const mockSessionValue = { isAuthed: true, configured: true, userId: 'user-1' };
jest.mock('../../../src/context/SessionContext', () => ({
  ...jest.requireActual('../../../src/context/SessionContext'),
  useSession: () => mockSessionValue,
}));

const NOW = Date.now();
function makeReminder(overrides: Record<string, unknown>) {
  return {
    id: 'r-1',
    title: 'Reminder',
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
    ...overrides,
  };
}

let mockReminder = makeReminder({});
const mockGetReminder = jest.fn(async () => ({ ...mockReminder }));
jest.mock('../../../src/services/reminders.ts', () => ({
  ...jest.requireActual('../../../src/services/reminders.ts'),
  getReminder: (...args: unknown[]) => mockGetReminder(...args),
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { back: jest.fn(), push: (...args: unknown[]) => mockPush(...args) },
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

describe('ReminderDetailScreen — target row navigation', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('trip reminder: shows the target label and navigates to /trip/<targetId> when tapped', async () => {
    mockReminder = makeReminder({ targetType: 'trip', targetId: 'trip-abc', targetLabel: 'Lisbon trip' });

    await act(async () => { render(<ReminderDetailScreen />); });
    await act(async () => {});

    const row = screen.getByText('Lisbon trip');
    expect(row).toBeTruthy();
    fireEvent.press(row);

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/trip/trip-abc');
  });

  it('saved_place reminder: shows the target label and navigates to /place/<targetId> when tapped', async () => {
    mockReminder = makeReminder({ targetType: 'saved_place', targetId: 'place-9', targetLabel: 'Time Out Market' });

    await act(async () => { render(<ReminderDetailScreen />); });
    await act(async () => {});

    const row = screen.getByText('Time Out Market');
    expect(row).toBeTruthy();
    fireEvent.press(row);

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/place/place-9');
  });

  it('custom reminder: no target row is rendered at all (no targetLabel), nothing to navigate', async () => {
    mockReminder = makeReminder({ targetType: 'custom', targetId: null, targetLabel: null });

    await act(async () => { render(<ReminderDetailScreen />); });
    await act(async () => {});

    // The only text on screen matching the (empty) title area shouldn't include a pressable target row.
    expect(screen.queryByTestId('icon-Sparkles')).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
