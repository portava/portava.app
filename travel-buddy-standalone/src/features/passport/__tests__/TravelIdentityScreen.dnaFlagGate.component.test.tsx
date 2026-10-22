/**
 * Travel Identity — the Show / Hide / Not-Me controls exist only while a choice can be stored.
 *
 * writeTravelDnaPref refuses every write while `passport_travel_dna_enabled` is OFF (production, 2026-10-22) —
 * the flag gates EDITING, not the read. The owner's screen still drew Show / Hide / Not me on every reading, so
 * every tap flipped the control, failed, reverted and said "Couldn't save that change".
 *   D1  flag off, the owner's own view → the readings and their evidence, no controls, nothing written;
 *       the explainer does not promise controls;
 *   D2  flag on, the owner's own view → the controls, and a Hide is written;
 *   D3  flag on, a viewer projection → still no controls (§19/§30 unchanged).
 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import TravelIdentityScreen from '../TravelIdentityScreen.tsx';

const mockFlagsOn = new Set<string>();
// NOTE: intentionally exhaustive — the screen reads one flag through the context; the provider fetches over HTTP.
jest.mock('../../../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (k: string) => mockFlagsOn.has(k), loading: false }),
}));

// NOTE: intentionally exhaustive — the identity is passed in (identityOverride) and the writer is injected; this
// stops the data hook reaching Supabase auth + the API server.
jest.mock('../../../services/passportProjection', () => ({
  getTravelIdentity: jest.fn(() => new Promise(() => {})),
  getPassportJourneys: jest.fn(),
  putTravelDna: jest.fn(),
  _setTestAuthToken: jest.fn(),
}));

// NOTE: intentionally exhaustive — the session hook would pull in the real Supabase client at import time.
jest.mock('../../../context/SessionContext', () => ({
  useSession: () => ({ userId: 'me-123' }),
}));

// NOTE: intentionally exhaustive — expo-router needs native navigation modules; the screen uses `router` only.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

// NOTE: intentionally exhaustive — no SafeAreaProvider is mounted in these renders.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

const IDENTITY = {
  userId: 'me-123',
  dimensions: [
    { key: 'rhythm', label: 'Rhythm', poles: { low: 'Early riser', high: 'Night owl' }, position: 0.8, value: 'Night owl', evidence: ['3 nightlife visits'], state: 'shown', inferred: false },
  ],
  traits: [
    { key: 'night_explorer', label: 'Night Explorer', description: 'Comes alive after dark.', evidence: ['3 nightlife visits'], state: 'shown' },
  ],
  preferencesApplied: false,
  editable: true,
} as any;

beforeEach(() => { mockFlagsOn.clear(); });

describe('TravelIdentityScreen — passport_travel_dna_enabled gate', () => {
  it('D1: flag off, own view → readings and evidence, no Show/Hide/Not-me, nothing written', async () => {
    const persist = jest.fn();
    await render(<TravelIdentityScreen identityOverride={IDENTITY} persistTravelDna={persist} />);
    await waitFor(() => expect(screen.getByText('Night Explorer')).toBeTruthy());
    expect(screen.getAllByText('• 3 nightlife visits').length).toBeGreaterThan(0);
    expect(screen.queryByText('Show')).toBeNull();
    expect(screen.queryByText('Hide')).toBeNull();
    expect(screen.queryByText('Not me')).toBeNull();
    expect(screen.queryByLabelText('Visibility control for night_explorer')).toBeNull();
    expect(screen.queryByText(/you can Show, Hide or mark it/)).toBeNull();
    expect(screen.getByText(/Choosing which are shown isn’t available yet\./)).toBeTruthy();
    expect(persist).not.toHaveBeenCalled();
  });

  it('D2: flag on, own view → the controls, and a Hide is written', async () => {
    mockFlagsOn.add('passport_travel_dna_enabled');
    const persist = jest.fn((input: { key: string; kind: string; state: string }) => Promise.resolve({ ok: true, data: { userId: 'me-123', ...input } } as any));
    await render(<TravelIdentityScreen identityOverride={IDENTITY} persistTravelDna={persist} />);
    const control = await screen.findByLabelText('Visibility control for night_explorer');
    await fireEvent.press(within(control).getByText('Hide'));
    expect(persist).toHaveBeenCalledWith({ key: 'night_explorer', kind: 'trait', state: 'hidden' });
  });

  it('D3: flag on, a viewer projection → still no controls', async () => {
    mockFlagsOn.add('passport_travel_dna_enabled');
    await render(<TravelIdentityScreen targetUserId="them-1" identityOverride={IDENTITY} persistTravelDna={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Night Explorer')).toBeTruthy());
    expect(screen.queryByText('Not me')).toBeNull();
    expect(screen.getByText(/This traveler controls which are shown\./)).toBeTruthy();
  });
});
