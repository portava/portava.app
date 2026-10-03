/**
 * CompassHome says WHICH section could not be read — census-discovery §107 (DV-83 round 10,
 * register D-W11X2-67). The server now marks a section `unavailable` when its read failed: the
 * circle's presence reads, the forecast provider, a best move picked from a partial candidate pool.
 * Before §107 the home only printed one generic "may be incomplete" line and then drew a missing
 * section exactly like an empty one (no "Your circle" card = "nobody is around").
 *
 *   SU1  circleActivity unavailable → the circle line, never silence
 *   SU2  weatherWindow unavailable → the forecast line
 *   SU3  bestNextMove unavailable WITH a pick → the card AND the partial-pick line
 *   SU4  bestNextMove unavailable, no pick → the no-pick line
 *   SU5  startingSoon / tonightVibe unavailable → their lines
 *   SUc  CONTROL: every section ok → none of the lines
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

// NOTE: intentionally minimal — CompassHome only uses router.push; spreading requireActual('expo-router')
// drags in native navigation internals that crash under jest-expo (as CompassHome.failedRead does).
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const mockFetchCompassHome = jest.fn();
jest.mock('../../../services/compass', () => ({
  ...jest.requireActual('../../../services/compass'),
  fetchCompassHome: (...args: unknown[]) => mockFetchCompassHome(...args),
}));

import { CompassHome, HOME_SECTION_UNREAD } from '../CompassHome.tsx';

const OK = { bestNextMove: 'ok', circleActivity: 'ok', startingSoon: 'ok', tonightVibe: 'ok', weatherWindow: 'ok' } as const;
const PICK = { id: 'ev-1', type: 'event', title: 'Rooftop DJ set', category: 'music', city: 'Cebu', data: null, explanationKey: null };
function home(sources: Partial<Record<keyof typeof OK, 'ok' | 'unavailable'>>, over: Record<string, unknown> = {}) {
  const s = { ...OK, ...sources };
  return {
    compassEnabled: true, fallback: false, timeOfDay: 'evening', contextState: 'exploring_now', city: 'Cebu',
    bestNextMove: PICK, circleActivity: null, startingSoon: null, tonightVibe: null, weatherWindow: null,
    sources: s, degraded: Object.values(s).includes('unavailable'), ...over,
  };
}
async function mount(body: unknown) {
  mockFetchCompassHome.mockResolvedValue({ ok: true, data: body });
  await render(<CompassHome onAsk={jest.fn()} />);
  await waitFor(() => expect(mockFetchCompassHome).toHaveBeenCalled());
}

describe('CompassHome says which section could not be read (§107)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('SU1 circleActivity unavailable → the circle line', async () => {
    await mount(home({ circleActivity: 'unavailable' }));
    await waitFor(() => expect(screen.queryByText(HOME_SECTION_UNREAD.circleActivity)).not.toBeNull());
  });

  it('SU2 weatherWindow unavailable → the forecast line', async () => {
    await mount(home({ weatherWindow: 'unavailable' }));
    await waitFor(() => expect(screen.queryByText(HOME_SECTION_UNREAD.weatherWindow)).not.toBeNull());
  });

  it('SU3 bestNextMove unavailable with a pick → the card AND the partial-pick line', async () => {
    await mount(home({ bestNextMove: 'unavailable' }));
    await waitFor(() => expect(screen.queryByText('Rooftop DJ set')).not.toBeNull());
    expect(screen.queryByText(HOME_SECTION_UNREAD.bestNextMovePartial)).not.toBeNull();
    expect(screen.queryByText(HOME_SECTION_UNREAD.bestNextMove)).toBeNull();
  });

  it('SU4 bestNextMove unavailable, no pick → the no-pick line', async () => {
    await mount(home({ bestNextMove: 'unavailable' }, { bestNextMove: null }));
    await waitFor(() => expect(screen.queryByText(HOME_SECTION_UNREAD.bestNextMove)).not.toBeNull());
    expect(screen.queryByText(HOME_SECTION_UNREAD.bestNextMovePartial)).toBeNull();
  });

  it('SU5 startingSoon and tonightVibe unavailable → their lines', async () => {
    await mount(home({ startingSoon: 'unavailable', tonightVibe: 'unavailable' }));
    await waitFor(() => expect(screen.queryByText(HOME_SECTION_UNREAD.startingSoon)).not.toBeNull());
    expect(screen.queryByText(HOME_SECTION_UNREAD.tonightVibe)).not.toBeNull();
  });

  it('SUc CONTROL: every section ok → none of the lines', async () => {
    await mount(home({}));
    await waitFor(() => expect(screen.queryByText('Rooftop DJ set')).not.toBeNull());
    for (const text of Object.values(HOME_SECTION_UNREAD)) expect(screen.queryByText(text)).toBeNull();
  });
});
