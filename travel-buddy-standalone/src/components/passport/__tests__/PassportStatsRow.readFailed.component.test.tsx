/**
 * PassportStatsRow — Countries and Stamps on the owner's passport home are a
 * measurement or "—", never a confident 0 for a read that failed.
 *
 * Countries and Stamps come ONLY from GET /me/passport/stats. When the server's
 * user_stamps read fails it answers zeros with `readFailed: true`; when the
 * request itself fails the row had nothing at all. Both used to render "0
 * Countries · 0 Stamps" — a false statement about the traveller (passport lane,
 * 2026-10-03).
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

// NOTE: intentional stub — the real module reaches Supabase auth + fetch.
jest.mock('../../../services/passportStamps', () => ({
  ...jest.requireActual('../../../services/passportStamps'),
  getPassportStats: jest.fn(),
}));

import { PassportStatsRow } from '../PassportIdentityCard.tsx';
const { getPassportStats } = require('../../../services/passportStamps.ts');
const mockStats = getPassportStats as jest.Mock;

const PROFILE = { id: 'me', username: 'me', tripCount: 2, followersCount: 3, followingCount: 4 } as any;

function stats(extra: Record<string, unknown>) {
  return {
    countries: 4, cities: 9, neighborhoods: 0, planStamps: 0, hostStamps: 0, hiddenGemStamps: 0,
    safeReturnStamps: 0, totalStamps: 17, tripCount: 2, followersCount: 3, followingCount: 4,
    stampsEarned: 17, milestones: [], readFailed: false, ...extra,
  };
}

const n = (label: string) => screen.getByTestId(`passport-stat-n-${label}`).props.children;

describe('PassportStatsRow — unreadable stats are unknown, not zero', () => {
  beforeEach(() => jest.clearAllMocks());

  it('a measured read shows the numbers', async () => {
    mockStats.mockResolvedValue({ ok: true, data: stats({}) });
    await render(<PassportStatsRow profile={PROFILE} isOwner />);
    await waitFor(() => expect(n('Stamps')).toBe(17));
    expect(n('Countries')).toBe(4);
  });

  it('a genuine zero is still 0', async () => {
    mockStats.mockResolvedValue({ ok: true, data: stats({ countries: 0, totalStamps: 0 }) });
    await render(<PassportStatsRow profile={PROFILE} isOwner />);
    await waitFor(() => expect(n('Stamps')).toBe(0));
    expect(n('Countries')).toBe(0);
  });

  it('readFailed: true shows "—" for Countries and Stamps', async () => {
    mockStats.mockResolvedValue({ ok: true, data: stats({ countries: 0, totalStamps: 0, readFailed: true }) });
    await render(<PassportStatsRow profile={PROFILE} isOwner />);
    await waitFor(() => expect(n('Stamps')).toBe('—'));
    expect(n('Countries')).toBe('—');
  });

  it('a failed request shows "—", and the profile-backed counts still show', async () => {
    mockStats.mockResolvedValue({ ok: false, message: 'API 500' });
    await render(<PassportStatsRow profile={PROFILE} isOwner />);
    await waitFor(() => expect(n('Stamps')).toBe('—'));
    expect(n('Countries')).toBe('—');
    expect(n('Trips')).toBe('2');
  });

  it('a rejected request shows "—"', async () => {
    mockStats.mockRejectedValue(new Error('network'));
    await render(<PassportStatsRow profile={PROFILE} isOwner />);
    await waitFor(() => expect(n('Stamps')).toBe('—'));
  });
});
