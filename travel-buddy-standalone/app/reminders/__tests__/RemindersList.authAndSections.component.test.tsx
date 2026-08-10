/**
 * Reminders list (app/reminders/index.tsx) — auth gate + Upcoming/Completed
 * section wiring.
 *
 * This screen has NO inherited auth guard from a parent layout — useSession()
 * gating inside the component is the ONLY thing that keeps an unauthenticated
 * user off the list. This test pins that:
 *   1. unauthenticated / unconfigured session → sign-in prompt, no list, no
 *      "New" button.
 *   2. authenticated session → the list renders, split into Upcoming and
 *      Completed sections with the correct reminder under each.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, act, screen, cleanup } from '@testing-library/react-native';

afterEach(cleanup);

// ── Session mock (swapped per test via mockSessionValue) ────────────────────
let mockSessionValue: { isAuthed: boolean; configured: boolean; userId: string | null } = {
  isAuthed: true,
  configured: true,
  userId: 'user-1',
};
jest.mock('../../../src/context/SessionContext', () => ({
  ...jest.requireActual('../../../src/context/SessionContext'),
  useSession: () => mockSessionValue,
}));

// ── Reminders service ─────────────────────────────────────────────────────
const NOW = Date.now();
const mockReminders = [
  {
    id: 'r-upcoming',
    title: 'Upcoming: pack bags',
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
  },
  {
    id: 'r-completed',
    title: 'Completed: buy tickets',
    note: null,
    remindAt: new Date(NOW - 60 * 60_000).toISOString(),
    targetType: 'trip',
    targetId: 'trip-1',
    tripId: null,
    targetLabel: 'Tokyo trip',
    status: 'completed',
    notificationId: null,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  },
  {
    id: 'r-saved-place',
    title: 'Book the tasting menu',
    note: null,
    remindAt: new Date(NOW + 2 * 60 * 60_000).toISOString(),
    targetType: 'saved_place',
    targetId: 'place-9',
    tripId: null,
    targetLabel: 'Time Out Market',
    status: 'upcoming',
    notificationId: 'notif-2',
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  },
];
// Return a fresh copy each call — the component's load() does `all.sort(...)`
// in place, and sorting a shared array reference here would silently reorder
// mockReminders itself across tests (ascending remindAt swaps completed/upcoming).
const mockLoadReminders = jest.fn(async () => [...mockReminders]);
jest.mock('../../../src/services/reminders.ts', () => ({
  ...jest.requireActual('../../../src/services/reminders.ts'),
  loadReminders: (...args: unknown[]) => mockLoadReminders(...args),
}));

// NOTE: intentional stub — not under test here.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import RemindersScreen from '../index.tsx';

describe('RemindersScreen — auth gate', () => {
  it('shows a sign-in prompt and never calls loadReminders when unauthenticated', async () => {
    mockSessionValue = { isAuthed: false, configured: true, userId: null };
    mockLoadReminders.mockClear();

    await act(async () => { render(<RemindersScreen />); });

    expect(screen.getByText('Sign in to see your reminders.')).toBeTruthy();
    expect(screen.queryByText('Reminders')).toBeNull();
    expect(mockLoadReminders).not.toHaveBeenCalled();
  });

  it('shows the same sign-in prompt when session is not configured, even if isAuthed is stale-true', async () => {
    mockSessionValue = { isAuthed: true, configured: false, userId: 'user-1' };
    mockLoadReminders.mockClear();

    await act(async () => { render(<RemindersScreen />); });

    expect(screen.getByText('Sign in to see your reminders.')).toBeTruthy();
    expect(mockLoadReminders).not.toHaveBeenCalled();
  });
});

describe('RemindersScreen — Upcoming / Completed sections', () => {
  beforeEach(() => {
    mockSessionValue = { isAuthed: true, configured: true, userId: 'user-1' };
    mockLoadReminders.mockClear();
  });

  it('renders an Upcoming section with the upcoming reminder and a Completed section with the completed one', async () => {
    await act(async () => { render(<RemindersScreen />); });
    await act(async () => {});

    expect(mockLoadReminders).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Upcoming')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByText('Upcoming: pack bags')).toBeTruthy();
    expect(screen.getByText('Completed: buy tickets')).toBeTruthy();
  });

  it('renders a saved_place reminder in the Upcoming section with its target label, distinct from the trip reminder', async () => {
    await act(async () => { render(<RemindersScreen />); });
    await act(async () => {});

    expect(screen.getByText('Book the tasting menu')).toBeTruthy();
    // targetLabel is appended to the meta line ("<when> · <targetLabel>") —
    // confirms the saved_place row isn't blank or falling through to a
    // default that drops or mislabels the target.
    expect(screen.getByText(/Time Out Market/)).toBeTruthy();
    expect(screen.getByText(/Tokyo trip/)).toBeTruthy();
  });

  it('omits the Completed section entirely when there are no completed reminders', async () => {
    mockLoadReminders.mockResolvedValueOnce([mockReminders[0]]);
    await act(async () => { render(<RemindersScreen />); });
    await act(async () => {});

    expect(screen.getByText('Upcoming')).toBeTruthy();
    expect(screen.queryByText('Completed')).toBeNull();
  });
});
