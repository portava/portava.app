/**
 * Component test: AvailabilityStore must never seed from fixture data.
 *
 * AvailabilityProvider is mounted app-wide (app/_layout.tsx:249), so whatever
 * it holds before the server answers is what every viewer sees. It used to seed
 * `useState` from `mockAvailability` (src/__fixtures__/events.ts) — a fixture
 * whose own header reads "not live user data. Do not use as primary data source
 * in authenticated flows" — which put a stranger's week (Fri/Sat/Sun
 * evening+late) and `openToMeet: true` in front of:
 *
 *   - signed-out viewers, for whom the mount fetch never runs at all, and
 *   - signed-in viewers, for the whole window before the fetch resolves.
 *
 * `openToMeet: true` is not cosmetic — app/availability.tsx renders it as
 * "Open to meet — shown on your Passport." And it was writable: `save()`
 * PATCHes whatever is in state, so a toggle landing before the fetch would
 * persist the fixture's blocks onto the user's real account.
 *
 * These cases pin the fail-closed pre-load value:
 *  - unauthenticated  → empty availability, and no fetch attempted
 *  - authenticated    → empty availability until the server answers
 *  - no provider      → the inert fallback store is empty too
 *  - failed save      → rolls back to fail-closed, not to a fabricated `true`
 *
 * NOTE: render() must be awaited in this env (RNTL 14 + React 19 + jest-expo).
 */

import React from 'react';
import { Text, Pressable, View } from 'react-native';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react-native';
import { AvailabilityProvider, useAvailabilityStore } from '../AvailabilityStore.tsx';
import { mockAvailability } from '../../data/events.ts';

// ── Service mocks ─────────────────────────────────────────────────────────────

const mockGetMyAvailability = jest.fn();
const mockPatchMyAvailability = jest.fn();

// NOTE: intentionally exhaustive — availability.ts imports Supabase helpers at
// module level, so spreading jest.requireActual would execute that import chain
// and crash the JSDOM suite. Only the three functions AvailabilityStore calls
// are needed here.
jest.mock('../../services/availability.ts', () => ({
  getMyAvailability: (...args: unknown[]) => mockGetMyAvailability(...args),
  patchMyAvailability: (...args: unknown[]) => mockPatchMyAvailability(...args),
  patchMyQuickStatus: jest.fn().mockResolvedValue({ ok: false, data: null }),
}));

const mockSession = { configured: true, isAuthed: true, userId: 'user-1' };
jest.mock('../SessionContext.tsx', () => ({
  ...jest.requireActual('../SessionContext.tsx'),
  useSession: () => mockSession,
}));

// ── Probe ─────────────────────────────────────────────────────────────────────

function Probe() {
  const { availability, save, saveError } = useAvailabilityStore();
  const days = availability.weekly?.days ?? {};
  return (
    <View>
      <Text testID="openToMeet">{String(availability.openToMeet)}</Text>
      <Text testID="dayCount">{String(Object.keys(days).length)}</Text>
      <Text testID="tripCount">{String(availability.trips.length)}</Text>
      <Text testID="saveError">{saveError ?? ''}</Text>
      <Pressable testID="btn-save" onPress={() => { void save(); }} />
    </View>
  );
}

/** The pre-load state every case below expects: nothing known, nothing claimed. */
function expectEmpty() {
  expect(screen.getByTestId('openToMeet')).toHaveTextContent('false');
  expect(screen.getByTestId('dayCount')).toHaveTextContent('0');
  expect(screen.getByTestId('tripCount')).toHaveTextContent('0');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSession.isAuthed = true;
  mockSession.configured = true;
  mockPatchMyAvailability.mockResolvedValue({ ok: true, data: null });
});

// ── Guard: the fixture is genuinely non-empty ────────────────────────────────
//
// Without this the assertions below would still pass if someone emptied the
// fixture, and the real regression — seeding from it — would slip back in
// unnoticed. This is what makes the rest of the file a guard rather than a
// tautology.

describe('mockAvailability fixture', () => {
  it('is non-empty and opted-in, so seeding from it is observably wrong', () => {
    expect(mockAvailability.openToMeet).toBe(true);
    expect(Object.keys(mockAvailability.weekly?.days ?? {}).length).toBeGreaterThan(0);
    expect(mockAvailability.trips.length).toBeGreaterThan(0);
  });
});

// ── The store itself ─────────────────────────────────────────────────────────

describe('AvailabilityStore pre-load state', () => {
  it('is empty for an unauthenticated viewer, and attempts no fetch', async () => {
    mockSession.isAuthed = false;
    mockGetMyAvailability.mockResolvedValue({ ok: true, data: null });

    await render(<AvailabilityProvider><Probe /></AvailabilityProvider>);

    expectEmpty();
    // The mount effect is gated on isAuthed — a signed-out viewer never asks,
    // so an empty render here is the only thing standing between them and
    // fabricated availability.
    expect(mockGetMyAvailability).not.toHaveBeenCalled();
  });

  it('is empty while an authenticated fetch is still in flight', async () => {
    // A promise that never settles: the window this test pins is exactly the
    // one the fixture seed used to fill.
    mockGetMyAvailability.mockReturnValue(new Promise(() => {}));

    await render(<AvailabilityProvider><Probe /></AvailabilityProvider>);

    expectEmpty();
    expect(mockGetMyAvailability).toHaveBeenCalled();
  });

  it('still renders empty when the fetch fails', async () => {
    mockGetMyAvailability.mockResolvedValue({ ok: false, data: null });

    await render(<AvailabilityProvider><Probe /></AvailabilityProvider>);

    await waitFor(() => expect(mockGetMyAvailability).toHaveBeenCalled());
    expectEmpty();
  });

  it('adopts server values once they arrive', async () => {
    // The counterpart to the cases above: empty must mean "not yet known",
    // not "this store never shows anything".
    mockGetMyAvailability.mockResolvedValue({
      ok: true,
      data: {
        weeklyDays: { mon: ['evening'] },
        openToMeet: true,
        strictMode: false,
        quickStatus: null,
      },
    });

    await render(<AvailabilityProvider><Probe /></AvailabilityProvider>);

    await waitFor(() => expect(screen.getByTestId('openToMeet')).toHaveTextContent('true'));
    expect(screen.getByTestId('dayCount')).toHaveTextContent('1');
  });
});

describe('AvailabilityStore with no provider', () => {
  it('falls back to an empty read-only store, not to the fixture', async () => {
    await render(<Probe />);
    expectEmpty();
  });
});

describe('AvailabilityStore failed save', () => {
  it('rolls back to the fail-closed baseline rather than a fabricated true', async () => {
    // Server says the user is not opted in; the save then fails. The rollback
    // target is the last server-confirmed value, which must never be the
    // fixture's `openToMeet: true`.
    mockGetMyAvailability.mockResolvedValue({
      ok: true,
      data: { weeklyDays: {}, openToMeet: false, strictMode: false, quickStatus: null },
    });
    mockPatchMyAvailability.mockResolvedValue({ ok: false, message: 'nope' });

    await render(<AvailabilityProvider><Probe /></AvailabilityProvider>);
    await waitFor(() => expect(mockGetMyAvailability).toHaveBeenCalled());

    await act(async () => {
      fireEvent.press(screen.getByTestId('btn-save'));
    });

    await waitFor(() => expect(screen.getByTestId('saveError')).toHaveTextContent('nope'));
    expect(screen.getByTestId('openToMeet')).toHaveTextContent('false');
  });
});
