/**
 * New-reminder screen (app/reminders/new.tsx) — auth gate.
 *
 * This screen has NO inherited auth guard from a parent layout — useSession()
 * gating inside the component is the ONLY thing that keeps an unauthenticated
 * user off the create form. Pins that an unauthenticated/unconfigured session
 * shows a sign-in prompt instead of the form, and never touches createReminder
 * or any of the attachment-picker services.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, act, screen, cleanup } from '@testing-library/react-native';

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

const mockCreateReminder = jest.fn(async () => ({ id: 'r-1' }));
jest.mock('../../../src/services/reminders.ts', () => ({
  ...jest.requireActual('../../../src/services/reminders.ts'),
  createReminder: (...args: unknown[]) => mockCreateReminder(...args),
}));

const mockListMyTrips = jest.fn(async () => []);
jest.mock('../../../src/services/trips.ts', () => ({
  ...jest.requireActual('../../../src/services/trips.ts'),
  listMyTrips: (...args: unknown[]) => mockListMyTrips(...args),
}));

const mockFetchTripPlan = jest.fn(async () => ({ items: [] }));
jest.mock('../../../src/services/tripPlan.ts', () => ({
  ...jest.requireActual('../../../src/services/tripPlan.ts'),
  fetchTripPlan: (...args: unknown[]) => mockFetchTripPlan(...args),
}));

const mockListSaved = jest.fn(async () => []);
jest.mock('../../../src/services/discoveryBookmarks.ts', () => ({
  ...jest.requireActual('../../../src/services/discoveryBookmarks.ts'),
  listSaved: (...args: unknown[]) => mockListSaved(...args),
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

import NewReminderScreen from '../new.tsx';

describe('NewReminderScreen — auth gate', () => {
  it('shows a sign-in prompt and never fetches attachment pickers or creates a reminder when unauthenticated', async () => {
    mockSessionValue = { isAuthed: false, configured: true, userId: null };
    mockCreateReminder.mockClear();
    mockListMyTrips.mockClear();
    mockListSaved.mockClear();

    await act(async () => { render(<NewReminderScreen />); });

    expect(screen.getByText('Sign in to create reminders.')).toBeTruthy();
    expect(screen.queryByText('New reminder')).toBeNull();
    expect(mockListMyTrips).not.toHaveBeenCalled();
    expect(mockListSaved).not.toHaveBeenCalled();
    expect(mockCreateReminder).not.toHaveBeenCalled();
  });

  it('shows the same sign-in prompt when session is not configured', async () => {
    mockSessionValue = { isAuthed: true, configured: false, userId: 'user-1' };

    await act(async () => { render(<NewReminderScreen />); });

    expect(screen.getByText('Sign in to create reminders.')).toBeTruthy();
  });

  it('renders the create form once authenticated and configured', async () => {
    mockSessionValue = { isAuthed: true, configured: true, userId: 'user-1' };

    await act(async () => { render(<NewReminderScreen />); });

    expect(screen.getByText('New reminder')).toBeTruthy();
    expect(screen.queryByText('Sign in to create reminders.')).toBeNull();
  });
});
