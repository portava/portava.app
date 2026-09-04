/**
 * Component tests for TravelIdentityScreen — F6 Travel-DNA persistence (§19).
 *
 * The Show / Hide / Not-Me controls persist server-side via
 * `PUT /api/passport/me/travel-dna` while keeping the optimistic local update.
 * These tests prove the write seam:
 *   1. Toggling a control calls the writer with the correct {key, kind, state}
 *      and keeps the optimistic state on success (reconciled to the server value).
 *   2. A failed write REVERTS the optimistic change, so the control never lies
 *      about what was saved.
 *
 * The writer is injected via the `persistTravelDna` test seam so no network is
 * touched. render() is awaited (RNTL 14 + React 19 + jest-expo).
 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import TravelIdentityScreen from '../TravelIdentityScreen.tsx';
import type {
  TravelDnaPref,
  TravelDnaPrefInput,
} from '../../../services/passportProjection.ts';

// NOTE: intentional stub — TravelIdentityScreen imports putTravelDna +
// getTravelIdentity from this module, which reaches Supabase auth + the API
// server. The test injects the writer via a prop, so only the read seam and the
// erased type exports matter; this exhaustive factory is complete.
jest.mock('../../../services/passportProjection', () => ({
  getTravelIdentity: jest.fn(() => Promise.resolve({ ok: true, data: null })),
  getPassportJourneys: jest.fn(),
  putTravelDna: jest.fn(),
  _setTestAuthToken: jest.fn(),
}));

// NOTE: the session hook would otherwise pull in the real Supabase client at
// import time — return a fixed owner id so the read hook is inert.
jest.mock('../../../context/SessionContext', () => ({
  useSession: () => ({ userId: 'me-123' }),
}));

// NOTE: expo-router requires Expo native navigation modules unavailable in the
// jest-expo env — exhaustive stub of the members this screen touches.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

// NOTE: react-native-safe-area-context needs a provider not mounted in these
// unit renders — return fixed insets so the screen lays out.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

function makeIdentity() {
  return {
    userId: 'me-123',
    dimensions: [
      {
        key: 'rhythm',
        label: 'Rhythm',
        poles: { low: 'Early riser', high: 'Night owl' },
        position: 0.8,
        value: 'Night owl',
        evidence: ['3 nightlife visits'],
        state: 'shown' as const,
        inferred: false,
      },
    ],
    traits: [
      {
        key: 'night_explorer',
        label: 'Night Explorer',
        description: 'Comes alive after dark.',
        evidence: ['Nightlife interest'],
        state: 'shown' as const,
      },
    ],
    preferencesApplied: false,
    editable: true,
  };
}

describe('TravelIdentityScreen — Travel-DNA persistence (F6)', () => {
  it('persists a Hide via the write endpoint and keeps the optimistic state', async () => {
    const persist = jest.fn(
      (input: TravelDnaPrefInput): Promise<{ ok: true; data: TravelDnaPref }> =>
        Promise.resolve({ ok: true as const, data: { userId: 'me-123', ...input } }),
    );

    await render(
      <TravelIdentityScreen identityOverride={makeIdentity()} persistTravelDna={persist} />,
    );

    // First control belongs to the trait (Travel DNA group renders first).
    await waitFor(() => expect(screen.getAllByText('Hide').length).toBeGreaterThan(0));
    fireEvent.press(screen.getAllByText('Hide')[0]);

    // Wrote the owner's Show/Hide/Not-Me pref with the right key + kind + state.
    await waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    expect(persist).toHaveBeenCalledWith({ key: 'night_explorer', kind: 'trait', state: 'hidden' });

    // Optimistic state stands (reconciled to the echoed server value).
    await waitFor(() => expect(screen.getByText(/Hidden from your Passport/i)).toBeTruthy());
  });

  it('reverts the optimistic change when the write fails', async () => {
    const persist = jest.fn(() => Promise.resolve({ ok: false as const, message: 'nope' }));

    await render(
      <TravelIdentityScreen identityOverride={makeIdentity()} persistTravelDna={persist} />,
    );

    await waitFor(() => expect(screen.getAllByText('Hide').length).toBeGreaterThan(0));
    fireEvent.press(screen.getAllByText('Hide')[0]);

    await waitFor(() => expect(persist).toHaveBeenCalledTimes(1));

    // The failed write reverts the optimistic Hide — the "hidden" note is gone…
    await waitFor(() => expect(screen.queryByText(/Hidden from your Passport/i)).toBeNull());
    // …and the failure is surfaced.
    expect(screen.getByText(/Couldn.t save that change/i)).toBeTruthy();
  });

  it('persists a dimension control with kind "dimension"', async () => {
    const persist = jest.fn(
      (input: TravelDnaPrefInput): Promise<{ ok: true; data: TravelDnaPref }> =>
        Promise.resolve({ ok: true as const, data: { userId: 'me-123', ...input } }),
    );

    await render(
      <TravelIdentityScreen identityOverride={makeIdentity()} persistTravelDna={persist} />,
    );

    // Target the rhythm DIMENSION's control specifically (its own labelled
    // control container), not a trait or another axis.
    const rhythmControl = await waitFor(() =>
      screen.getByLabelText('Visibility control for rhythm'),
    );
    fireEvent.press(within(rhythmControl).getByText('Not me'));

    await waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    expect(persist).toHaveBeenCalledWith({ key: 'rhythm', kind: 'dimension', state: 'not_me' });
  });
});
