/**
 * census-discovery §108 (DV-83 round 11, D-W11X2-81). Rent-a-Buddy's "Compass Picks" strip
 * (`CompassBuddyRow`), open since §104.10. It set `items` to `[]` on any failed read and then
 * self-hid exactly as it does when the read ANSWERED with no one: a transport failure or a refused
 * GET /compass/recommendations was drawn as "no picks". It now says a failed read, and keeps partial
 * picks under the shared "may be incomplete" line, as CompassTravelerRow does (D-W11X2-55).
 *
 *   BR1  the buddy read fails (transport, or refused `nothing`) → the failed line, never the hidden strip
 *   BR2  a `partial` answer beside picks → the picks and the incomplete line
 *   BRc  CONTROL: the read answers with no one → hidden; the flag off (disabled) → hidden; picks → no notice
 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';

// NOTE: intentional stub — only router.push is exercised.
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));

const mockFetchCompassSettings = jest.fn();
const mockFetchCompassBuddyMatches = jest.fn();

// NOTE: a stand-in on purpose — each case fixes the settings and buddy answers.
jest.mock('../../../services/compass', () => ({
  ...jest.requireActual('../../../services/compass'),
  fetchCompassSettings:     (...args: unknown[]) => mockFetchCompassSettings(...args),
  fetchCompassBuddyMatches: (...args: unknown[]) => mockFetchCompassBuddyMatches(...args),
}));

import { CompassBuddyRow } from '../CompassBuddyRow.tsx';

const BUDDY = {
  id: 'buddy-1', title: 'Ana', city: 'Cebu', category: 'city', reason: 'Highly rated local', score: 0.9,
  data: { displayName: 'Ana', verified: true, availabilityStatus: 'available_today', averageRating: 4.8, reviewCount: 12, hourlyRateUsd: 20, languages: ['English'], coverPhotoUrl: null },
};

beforeEach(() => {
  mockFetchCompassSettings.mockReset(); mockFetchCompassBuddyMatches.mockReset();
  mockFetchCompassSettings.mockResolvedValue({ ok: true, data: { show_buddy_recommendations: true } });
});

describe('§108 CompassBuddyRow over a failed or partial read', () => {
  it('BR1 a transport failure → the failed line, never the hidden strip', async () => {
    mockFetchCompassBuddyMatches.mockResolvedValue({ ok: false, error: 'http_503' });
    await render(<CompassBuddyRow city="Cebu" />);
    await waitFor(() => expect(screen.queryByTestId('compass-buddies-failed')).not.toBeNull());
  });

  it('BR1b a refused `nothing` read → the failed line', async () => {
    mockFetchCompassBuddyMatches.mockResolvedValue({ ok: false, error: 'refused', refused: true });
    await render(<CompassBuddyRow city="Cebu" />);
    await waitFor(() => expect(screen.queryByTestId('compass-buddies-failed')).not.toBeNull());
  });

  it('BR2 a `partial` answer beside picks → the picks and the incomplete line', async () => {
    mockFetchCompassBuddyMatches.mockResolvedValue({ ok: true, disabled: false, data: [BUDDY], partial: true });
    await render(<CompassBuddyRow city="Cebu" />);
    await waitFor(() => expect(screen.queryByText('Ana')).not.toBeNull());
    expect(screen.queryByTestId('compass-buddies-partial')).not.toBeNull();
  });

  it('BRc CONTROL: no one → hidden; disabled → hidden; picks → no notice', async () => {
    const settle = async () => { await waitFor(() => expect(mockFetchCompassBuddyMatches).toHaveBeenCalled()); await act(async () => {}); await act(async () => {}); };
    mockFetchCompassBuddyMatches.mockResolvedValue({ ok: true, disabled: false, data: [] });
    const a = await render(<CompassBuddyRow city="Cebu" />);
    await settle();
    expect(screen.queryByText('Compass Picks')).toBeNull();
    expect(screen.queryByTestId('compass-buddies-failed')).toBeNull();
    await a.unmount(); mockFetchCompassBuddyMatches.mockClear();
    mockFetchCompassBuddyMatches.mockResolvedValue({ ok: true, data: [], disabled: true });
    const b = await render(<CompassBuddyRow city="Cebu" />);
    await settle();
    expect(screen.queryByText('Compass Picks')).toBeNull();
    expect(screen.queryByTestId('compass-buddies-failed')).toBeNull();
    await b.unmount(); mockFetchCompassBuddyMatches.mockClear();
    mockFetchCompassBuddyMatches.mockResolvedValue({ ok: true, disabled: false, data: [BUDDY] });
    await render(<CompassBuddyRow city="Cebu" />);
    await waitFor(() => expect(screen.queryByText('Ana')).not.toBeNull());
    expect(screen.queryByTestId('compass-buddies-failed')).toBeNull();
    expect(screen.queryByTestId('compass-buddies-partial')).toBeNull();
  });
});
