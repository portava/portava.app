/**
 * Component tests for SharedContextScreen — the "Shared Context · YOU TWO"
 * Passport surface (spec §17/§18, TABLE 17/18).
 *
 * Covers the contract points for this screen:
 *   1. Explainable overlap facts render (label + coarse detail), with the
 *      qualitative summary label ("Strong travel overlap").
 *   2. §18 / TABLE 18 — NO dating-style numeric match score is ever rendered
 *      (no percentage, no "/100", no "N% match").
 *   3. The "See What You Could Do" CTA is present and WIRED to the Compass
 *      handoff: pressing it hands the shared-context seed to the Compass ask
 *      surface (`/(tabs)/ai`) as a prefill message.
 *   4. Empty-overlap state — no facts, no CTA.
 *   5. (bonus) Error + retry state machine.
 *
 * NOTE: render() is awaited (RNTL 14 + React 19 + jest-expo) or the screen
 * stays unbound and queries throw "render not called".
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import SharedContextScreen from '../SharedContextScreen.tsx';
import { getSharedContext } from '../../../services/passportSharedContext.ts';
import { router } from 'expo-router';

// NOTE: intentional stub — the real service reaches Supabase auth + the API
// server, neither of which is available in the jest-expo env. getSharedContext
// is the seam under test; _setTestAuthToken is a no-op so imports don't crash.
jest.mock('../../../services/passportSharedContext', () => ({
  getSharedContext: jest.fn(),
  _setTestAuthToken: jest.fn(),
}));

// NOTE: expo-router requires Expo native navigation modules unavailable in the
// jest-expo env — exhaustive stub of the two members this screen touches.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

// NOTE: react-native-safe-area-context needs a provider that isn't mounted in
// these unit renders — return fixed insets so the screen lays out.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

const mockGetSharedContext = getSharedContext as jest.Mock;
const mockPush = router.push as jest.Mock;

// ── Fixtures ─────────────────────────────────────────────────────────────────

function overlapPayload() {
  return {
    sharedContext: {
      viewerId: 'me',
      ownerId: 'them',
      summaryLabel: 'Strong travel overlap',
      facts: [
        { key: 'both_in_city', label: 'Both in the same city', detail: 'Da Nang', magnitude: null },
        { key: 'both_free_tonight', label: 'Both free tonight', detail: null, magnitude: null },
        { key: 'mutual_follows', label: '3 mutual follows', detail: null, magnitude: 3 },
        { key: 'shared_cities', label: '2 shared cities', detail: 'Bangkok, Tokyo', magnitude: 2 },
        { key: 'intent_overlap', label: 'Shared interests', detail: 'Nightlife · Food', magnitude: 2 },
        { key: 'both_going_to', label: 'Both heading to the same place', detail: 'Bangkok', magnitude: 1 },
      ],
      compassHandoff: {
        eligible: true,
        city: 'Da Nang',
        overlapWindow: { status: 'open', expiresAt: null },
        sharedIntents: ['nightlife', 'food'],
        reasons: ['shared_context_present'],
      },
    },
  };
}

function emptyPayload() {
  return {
    sharedContext: {
      viewerId: 'me',
      ownerId: 'them',
      summaryLabel: 'No overlap yet',
      facts: [],
      compassHandoff: {
        eligible: false,
        city: null,
        overlapWindow: null,
        sharedIntents: [],
        reasons: ['insufficient_overlap'],
      },
    },
  };
}

beforeEach(() => {
  mockGetSharedContext.mockReset();
  mockPush.mockReset();
});

describe('SharedContextScreen', () => {
  it('renders explainable overlap facts and the qualitative summary label', async () => {
    mockGetSharedContext.mockResolvedValue({ ok: true, data: overlapPayload() });

    await render(<SharedContextScreen userId="them" otherName="Mai" />);

    // Qualitative label (NOT a numeric score)
    await waitFor(() => expect(screen.getByText('Strong travel overlap')).toBeTruthy());

    // Contributing facts (TABLE 17) — labels + coarse detail
    expect(screen.getByText('Both in the same city')).toBeTruthy();
    expect(screen.getByText('Da Nang')).toBeTruthy();
    expect(screen.getByText('Both free tonight')).toBeTruthy();
    expect(screen.getByText('3 mutual follows')).toBeTruthy(); // counts ARE allowed
    expect(screen.getByText('2 shared cities')).toBeTruthy();
    expect(screen.getByText('Nightlife · Food')).toBeTruthy();
    expect(screen.getByText('Both heading to the same place')).toBeTruthy();
  });

  it('never renders a dating-style numeric match score (§18 / TABLE 18)', async () => {
    mockGetSharedContext.mockResolvedValue({ ok: true, data: overlapPayload() });

    await render(<SharedContextScreen userId="them" otherName="Mai" />);
    await waitFor(() => expect(screen.getByText('Strong travel overlap')).toBeTruthy());

    const treeText = JSON.stringify(screen.toJSON());
    // No percentage, no "/100", no "N% match" compatibility number anywhere.
    expect(treeText).not.toMatch(/\d+\s*%/);
    expect(treeText).not.toContain('/100');
    expect(treeText.toLowerCase()).not.toMatch(/\d+\s*%?\s*match/);
  });

  it('shows the "See What You Could Do" CTA wired to the Compass handoff (§18)', async () => {
    mockGetSharedContext.mockResolvedValue({ ok: true, data: overlapPayload() });

    await render(<SharedContextScreen userId="them" otherName="Mai" />);

    const cta = await waitFor(() => screen.getByText('See What You Could Do'));
    fireEvent.press(cta);

    // Hands the seed to the Compass ask surface as a prefill message.
    expect(mockPush).toHaveBeenCalledTimes(1);
    const arg = mockPush.mock.calls[0][0];
    expect(arg.pathname).toBe('/(tabs)/ai');
    expect(typeof arg.params.prefillMessage).toBe('string');
    expect(arg.params.prefillMessage.length).toBeGreaterThan(0);
    // The permitted seed (coarse city) flows into the Compass prompt.
    expect(arg.params.prefillMessage).toContain('Da Nang');
  });

  it('shows the empty-overlap state with no CTA when there are no shared facts', async () => {
    mockGetSharedContext.mockResolvedValue({ ok: true, data: emptyPayload() });

    await render(<SharedContextScreen userId="them" otherName="Mai" />);

    await waitFor(() => expect(screen.getByText('No shared context yet')).toBeTruthy());
    // No facts, and no Compass CTA in the empty state.
    expect(screen.queryByText('See What You Could Do')).toBeNull();
    expect(screen.queryByText('Both in the same city')).toBeNull();
  });

  it('shows an error card and recovers on retry', async () => {
    mockGetSharedContext.mockResolvedValueOnce({ ok: false, message: 'Network error' });

    await render(<SharedContextScreen userId="them" otherName="Mai" />);

    await waitFor(() =>
      expect(screen.getByText("Couldn't load shared context")).toBeTruthy(),
    );

    // Retry resolves with an empty (but valid) overlap → empty state.
    mockGetSharedContext.mockResolvedValueOnce({ ok: true, data: emptyPayload() });
    fireEvent.press(screen.getByText('Tap to retry'));

    await waitFor(() =>
      expect(screen.getByText('No shared context yet')).toBeTruthy(),
    );
  });
});
