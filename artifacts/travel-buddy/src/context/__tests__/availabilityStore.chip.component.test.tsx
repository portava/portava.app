/**
 * Component test: AvailabilityStore → Passport chip sync after save.
 *
 * Scenario: the user navigates to the availability screen, toggles "Open to
 * meet", saves, and returns to the Passport tab.  The chip in PassportContent
 * reads from the same AvailabilityStore, so the updated in-memory state must
 * be reflected immediately — no extra network round-trip required.
 *
 * Covered cases:
 *  - toggle off → save → chip is absent
 *  - toggle on  → save → chip is present
 *
 * NOTE: render() must be awaited in this env (RNTL 14 + React 19 + jest-expo).
 */

import React from 'react';
import { Text, Pressable, View } from 'react-native';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react-native';
import { AvailabilityProvider, useAvailabilityStore } from '../AvailabilityStore.tsx';
import { resolveAvailabilityChip } from '../../lib/availabilityChip.ts';

// ── Service mocks ─────────────────────────────────────────────────────────────

const mockGetMyAvailability   = jest.fn();
const mockPatchMyAvailability = jest.fn();

jest.mock('../../services/availability.ts', () => ({
  ...jest.requireActual('../../services/availability.ts'),
  getMyAvailability:   (...args: unknown[]) => mockGetMyAvailability(...args),
  patchMyAvailability: (...args: unknown[]) => mockPatchMyAvailability(...args),
  patchMyQuickStatus:  jest.fn().mockResolvedValue({ ok: false, data: null }),
}));

// NOTE: intentionally exhaustive — SessionContext pulls in Supabase auth helpers
// at module level; spreading requireActual would execute that import chain and
// crash the JSDOM suite.  The provider only calls useSession() for two flags.
jest.mock('../SessionContext.tsx', () => ({
  useSession: () => ({ configured: true, isAuthed: true, userId: 'user-1' }),
}));

// NOTE: intentionally exhaustive — events.ts imports and re-exports large data
// fixtures; only mockAvailability is needed here, and requireActual is safe but
// the module also pulls in native-only deps in CI.
jest.mock('../../data/events.ts', () => ({
  mockAvailability: { weekly: { days: {} }, trips: [], openToMeet: false },
}));

// ── Minimal chip consumer ─────────────────────────────────────────────────────
//
// Mirrors what PassportContent does: read availability + quickStatus from the
// store, resolve the chip, and render it (or nothing when null).

function ChipConsumer() {
  const { availability, quickStatus, setOpenToMeet, save } = useAvailabilityStore();

  const chipState = resolveAvailabilityChip({
    openToMeet: availability.openToMeet,
    quickStatus: quickStatus ?? null,
    trips:       availability.trips,
    homeCity:    null,
    showHomeCity: false,
  });

  return (
    <View>
      {chipState ? <Text testID="chip">{chipState.primary}</Text> : null}
      <Pressable testID="btn-toggle-off" onPress={() => setOpenToMeet(false)} />
      <Pressable testID="btn-toggle-on"  onPress={() => setOpenToMeet(true)} />
      <Pressable testID="btn-save"       onPress={() => { void save(); }} />
    </View>
  );
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return <AvailabilityProvider>{children}</AvailabilityProvider>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockPatchMyAvailability.mockResolvedValue({ ok: true, data: null });
});

describe('AvailabilityStore → Passport chip: toggle off → save → chip absent', () => {
  it('chip disappears immediately on toggle-off and stays absent after save', async () => {
    // Backend starts with openToMeet = true (user was previously opted in).
    mockGetMyAvailability.mockResolvedValue({
      ok: true,
      data: { weeklyDays: {}, openToMeet: true, strictMode: false, quickStatus: null },
    });

    await render(<Wrapper><ChipConsumer /></Wrapper>);

    // After the initial backend load the chip should be visible.
    await waitFor(() => expect(screen.getByTestId('chip')).toBeTruthy());

    // Toggle off — in-memory store updates synchronously.
    await act(async () => {
      screen.getByTestId('btn-toggle-off').props.onPress();
    });

    // Chip disappears immediately (no save required for the in-memory update).
    await waitFor(() => expect(screen.queryByTestId('chip')).toBeNull());

    // Save — persists the new state to the backend.
    await act(async () => {
      screen.getByTestId('btn-save').props.onPress();
    });

    // Chip remains absent after the save completes.
    expect(screen.queryByTestId('chip')).toBeNull();
    expect(mockPatchMyAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ openToMeet: false }),
    );
  });
});

describe('AvailabilityStore → Passport chip: toggle on → save → chip present', () => {
  it('chip appears immediately on toggle-on and stays present after save', async () => {
    // Backend starts with openToMeet = false.
    mockGetMyAvailability.mockResolvedValue({
      ok: true,
      data: { weeklyDays: {}, openToMeet: false, strictMode: false, quickStatus: null },
    });

    await render(<Wrapper><ChipConsumer /></Wrapper>);

    // Initial state: chip absent.
    await waitFor(() => expect(screen.queryByTestId('chip')).toBeNull());

    // Toggle on — in-memory store updates synchronously.
    await act(async () => {
      screen.getByTestId('btn-toggle-on').props.onPress();
    });

    // Chip appears immediately.
    await waitFor(() => expect(screen.getByTestId('chip')).toBeTruthy());

    // Save — persists to the backend.
    await act(async () => {
      screen.getByTestId('btn-save').props.onPress();
    });

    // Chip persists after save.
    expect(screen.getByTestId('chip')).toBeTruthy();
    expect(mockPatchMyAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ openToMeet: true }),
    );
  });
});

describe('AvailabilityStore → Passport chip: toggle off → save fails → chip rolls back', () => {
  it('chip is present again after a failed save rolls back the in-memory state', async () => {
    // Backend starts with openToMeet = true (chip visible).
    mockGetMyAvailability.mockResolvedValue({
      ok: true,
      data: { weeklyDays: {}, openToMeet: true, strictMode: false, quickStatus: null },
    });
    // The save will fail.
    mockPatchMyAvailability.mockResolvedValue({ ok: false, message: 'Network error' });

    await render(<Wrapper><ChipConsumer /></Wrapper>);

    // After the initial backend load the chip should be visible.
    await waitFor(() => expect(screen.getByTestId('chip')).toBeTruthy());

    // Toggle off — in-memory store updates synchronously; chip disappears.
    fireEvent.press(screen.getByTestId('btn-toggle-off'));
    await waitFor(() => expect(screen.queryByTestId('chip')).toBeNull());

    // Save — the backend rejects the change.
    await act(async () => {
      fireEvent.press(screen.getByTestId('btn-save'));
    });

    // The store must have rolled back confirmedOpenToMeet (true) — not the
    // just-submitted optimistic value (false). Chip is present again.
    await waitFor(() => expect(screen.getByTestId('chip')).toBeTruthy());
    expect(mockPatchMyAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ openToMeet: false }),
    );
  });
});
