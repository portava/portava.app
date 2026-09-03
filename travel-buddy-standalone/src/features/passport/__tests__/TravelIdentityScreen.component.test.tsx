/**
 * Component tests for TravelIdentityScreen — the Travel DNA Passport surface.
 *
 * Covers the contract points for this screen (§19 / TABLE 20):
 *   1. Renders the inferred Travel DNA traits (Night Explorer, Hidden Gem
 *      Hunter, Food Driven) and the TABLE 20 travel-style dimensions — including
 *      axes the server did not infer (e.g. Energy, Group style), which the
 *      screen fills in as honest neutral defaults so the whole table is shown.
 *   2. Every reading is EXPLAINABLE — the evidence it was inferred from renders.
 *   3. Every reading is USER-CONTROLLED — Show / Hide / Not-Me controls are
 *      present and toggling them updates the visible state.
 *
 * NOTE: render() is awaited (RNTL 14 + React 19 + jest-expo) or the screen
 * stays unbound and queries throw "render not called".
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import TravelIdentityScreen from '../TravelIdentityScreen.tsx';
import { getTravelIdentity } from '../../../services/passportProjection.ts';

// NOTE: intentional stub — the real service reaches Supabase auth + the API
// server, neither available in jest-expo. getTravelIdentity is the seam under
// test; the type-only exports are erased at runtime so this factory is complete.
jest.mock('../../../services/passportProjection', () => ({
  getTravelIdentity: jest.fn(),
  getPassportJourneys: jest.fn(),
  _setTestAuthToken: jest.fn(),
}));

// NOTE: the session hook would otherwise pull in the real Supabase client at
// import time — return a fixed owner id so the data hook fetches from the mock.
jest.mock('../../../context/SessionContext', () => ({
  useSession: () => ({ userId: 'me-123' }),
}));

// NOTE: expo-router requires Expo native navigation modules unavailable in the
// jest-expo env — exhaustive stub of the members this screen touches.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

// NOTE: react-native-safe-area-context needs a provider that isn't mounted in
// these unit renders — return fixed insets so the screen lays out.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

const mockGetIdentity = getTravelIdentity as jest.Mock;

// ── Fixture — a partly-inferred travel identity (server omits some axes). ─────

function makeIdentity() {
  return {
    userId: 'me-123',
    dimensions: [
      { key: 'travel_pace', label: 'Travel pace', poles: { low: 'Relaxed', high: 'Packed' }, position: 0.15, value: 'Relaxed', evidence: ['Profile travel pace: relaxed'], state: 'shown', inferred: false },
      { key: 'rhythm', label: 'Rhythm', poles: { low: 'Early riser', high: 'Night owl' }, position: 0.8, value: 'Night owl', evidence: ['3 nightlife visits', 'Nightlife in interests'], state: 'shown', inferred: false },
      { key: 'interests', label: 'Interests', poles: null, position: null, value: 'Nightlife, Food', evidence: ['From profile interests'], state: 'shown', inferred: false },
      { key: 'languages', label: 'Languages', poles: null, position: null, value: 'EN, VI', evidence: ['From profile languages'], state: 'shown', inferred: false },
    ],
    traits: [
      { key: 'night_explorer', label: 'Night Explorer', description: 'Comes alive after dark — nightlife and late-evening plans.', evidence: ['3 nightlife visits', 'Nightlife interest'], state: 'shown' },
      { key: 'hidden_gem_hunter', label: 'Hidden Gem Hunter', description: 'Seeks out lesser-known spots over famous landmarks.', evidence: ['4 hidden gems discovered'], state: 'shown' },
      { key: 'food_driven', label: 'Food Driven', description: 'Plans travel around food and local cuisine.', evidence: ['Food interest'], state: 'shown' },
    ],
    preferencesApplied: false,
    editable: true,
  };
}

beforeEach(() => {
  mockGetIdentity.mockReset();
});

describe('TravelIdentityScreen', () => {
  it('renders the Travel DNA traits and the full TABLE 20 dimension set', async () => {
    mockGetIdentity.mockResolvedValue({ ok: true, data: makeIdentity() });

    await render(<TravelIdentityScreen />);

    // Travel DNA traits
    await waitFor(() => expect(screen.getByText('Night Explorer')).toBeTruthy());
    expect(screen.getByText('Hidden Gem Hunter')).toBeTruthy();
    expect(screen.getByText('Food Driven')).toBeTruthy();

    // Server-inferred dimensions
    expect(screen.getByText('Travel pace')).toBeTruthy();
    expect(screen.getByText('Rhythm')).toBeTruthy();
    expect(screen.getByText('Interests')).toBeTruthy();
    expect(screen.getByText('Languages')).toBeTruthy();
    // "Night owl" is both the rhythm reading and its high spectrum pole → twice.
    expect(screen.getAllByText('Night owl').length).toBeGreaterThan(0);

    // Axes the server did NOT infer are still shown (TABLE 20 completeness).
    expect(screen.getByText('Energy')).toBeTruthy();
    expect(screen.getByText('Group style')).toBeTruthy();
  });

  it('shows the explainability (evidence) for each reading', async () => {
    mockGetIdentity.mockResolvedValue({ ok: true, data: makeIdentity() });

    await render(<TravelIdentityScreen />);

    await waitFor(() => expect(screen.getAllByText('Why we inferred this').length).toBeGreaterThan(0));
    // Specific evidence strings from traits + dimensions render.
    expect(screen.getByText(/Nightlife interest/)).toBeTruthy();
    expect(screen.getByText(/From profile interests/)).toBeTruthy();
    expect(screen.getByText(/4 hidden gems discovered/)).toBeTruthy();
  });

  it('exposes Show / Hide / Not-Me controls and toggling Hide updates state', async () => {
    mockGetIdentity.mockResolvedValue({ ok: true, data: makeIdentity() });

    await render(<TravelIdentityScreen />);

    await waitFor(() => expect(screen.getAllByText('Show').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Hide').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Not me').length).toBeGreaterThan(0);

    // Nothing is hidden initially.
    expect(screen.queryByText(/Hidden from your Passport/i)).toBeNull();

    // Hiding the first item surfaces the "hidden" state note.
    fireEvent.press(screen.getAllByText('Hide')[0]);
    await waitFor(() => expect(screen.getByText(/Hidden from your Passport/i)).toBeTruthy());
  });

  it('marks a reading "Not me" when the Not-Me control is pressed', async () => {
    mockGetIdentity.mockResolvedValue({ ok: true, data: makeIdentity() });

    await render(<TravelIdentityScreen />);

    await waitFor(() => expect(screen.getAllByText('Not me').length).toBeGreaterThan(0));
    expect(screen.queryByText(/won.t be inferred again/i)).toBeNull();

    fireEvent.press(screen.getAllByText('Not me')[0]);
    await waitFor(() => expect(screen.getByText(/won.t be inferred again/i)).toBeTruthy());
  });

  it('shows an empty state when the projection carries no travel identity', async () => {
    mockGetIdentity.mockResolvedValue({ ok: true, data: null });

    await render(<TravelIdentityScreen />);

    await waitFor(() => expect(screen.getByText('No travel identity yet')).toBeTruthy());
    expect(screen.queryByText('Night Explorer')).toBeNull();
  });
});
