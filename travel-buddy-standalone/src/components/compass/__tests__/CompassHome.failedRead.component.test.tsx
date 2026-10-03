/**
 * CompassHome says a failed or partial read — census-discovery §105 sweep (DV-83 round 9,
 * register D-W11X2-65). Before §105 a failed fetch, an unread flag table
 * (`fallbackReason: compass_flags_unreadable`), a failed build (`compassEnabled: true,
 * fallback: true`) and a degraded projection (`degraded: true`, a section's source
 * `unavailable`) all rendered like "nothing to show": the cards collapsed and nothing said why.
 *
 *   CH1  a failed fetch → the failed line, never silence
 *   CH2  a failed build (enabled + fallback) → the failed line
 *   CH3  an unread flag table → the failed line
 *   CH4  a degraded projection → its cards AND the partial line
 *   CH5  CONTROL: Compass READ and off → no failed line (unchanged)
 *   CH6  CONTROL: a healthy home → no failed or partial line
 *   CH7  a THROWN fetch → the failed line
 *   CH8  a failed read, then a good refetch → the failed line clears
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

const mockPush = jest.fn();
// NOTE: intentionally minimal — CompassHome only uses router.push; spreading
// requireActual('expo-router') here drags in native navigation internals that
// crash under jest-expo.
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
}));

const mockFetchCompassHome = jest.fn();
jest.mock('../../../services/compass', () => ({
  ...jest.requireActual('../../../services/compass'),
  fetchCompassHome: (...args: unknown[]) => mockFetchCompassHome(...args),
}));

import { CompassHome } from '../CompassHome.tsx';

const FAILED = 'Some Compass suggestions couldn’t be loaded just now';
const PARTIAL = 'Some Compass suggestions couldn’t be loaded just now, so this list may be incomplete.';
const HOME = {
  compassEnabled: true, fallback: false, timeOfDay: 'evening', contextState: 'exploring_now', city: 'Cebu',
  bestNextMove: { id: 'ev-1', type: 'event', title: 'Rooftop DJ set', category: 'music', city: 'Cebu', data: null, explanationKey: null },
  circleActivity: null, startingSoon: null, tonightVibe: null, weatherWindow: null,
};

describe('CompassHome failed and partial reads (§105)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('CH1 a failed fetch → the failed line', async () => {
    mockFetchCompassHome.mockResolvedValue({ ok: false, error: 'http_503' });
    await render(<CompassHome onAsk={jest.fn()} />);
    await waitFor(() => expect(screen.queryByText(FAILED)).not.toBeNull());
  });

  it('CH2 a failed build → the failed line', async () => {
    mockFetchCompassHome.mockResolvedValue({ ok: true, data: { compassEnabled: true, fallback: true, fallbackReason: 'home_build_failed' } });
    await render(<CompassHome onAsk={jest.fn()} />);
    await waitFor(() => expect(screen.queryByText(FAILED)).not.toBeNull());
  });

  it('CH3 an unread flag table → the failed line', async () => {
    mockFetchCompassHome.mockResolvedValue({ ok: true, data: { compassEnabled: false, fallback: true, fallbackReason: 'compass_flags_unreadable' } });
    await render(<CompassHome onAsk={jest.fn()} />);
    await waitFor(() => expect(screen.queryByText(FAILED)).not.toBeNull());
  });

  it('CH4 a degraded projection → its cards and the partial line', async () => {
    mockFetchCompassHome.mockResolvedValue({ ok: true, data: { ...HOME, degraded: true, sources: { bestNextMove: 'ok', circleActivity: 'unavailable', startingSoon: 'ok', tonightVibe: 'ok', weatherWindow: 'ok' } } });
    await render(<CompassHome onAsk={jest.fn()} />);
    await waitFor(() => expect(screen.queryByText('Rooftop DJ set')).not.toBeNull());
    expect(screen.queryByText(PARTIAL)).not.toBeNull();
    expect(screen.queryByText(FAILED)).toBeNull();
  });

  it('CH5 CONTROL: Compass READ and off → no failed line', async () => {
    mockFetchCompassHome.mockResolvedValue({ ok: true, data: { compassEnabled: false, fallback: true } });
    await render(<CompassHome onAsk={jest.fn()} />);
    await waitFor(() => expect(mockFetchCompassHome).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(screen.queryByText(PARTIAL)).toBeNull();
  });

  it('CH6 CONTROL: a healthy home → no failed or partial line', async () => {
    mockFetchCompassHome.mockResolvedValue({ ok: true, data: { ...HOME, degraded: false } });
    await render(<CompassHome onAsk={jest.fn()} />);
    await waitFor(() => expect(screen.queryByText('Rooftop DJ set')).not.toBeNull());
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(screen.queryByText(PARTIAL)).toBeNull();
  });

  it('CH7 a thrown fetch → the failed line', async () => {
    mockFetchCompassHome.mockRejectedValue(new Error('socket hang up'));
    await render(<CompassHome onAsk={jest.fn()} />);
    await waitFor(() => expect(screen.queryByText(FAILED)).not.toBeNull());
  });

  it('CH8 a failed read, then a good refetch → the failed line clears', async () => {
    mockFetchCompassHome.mockResolvedValueOnce({ ok: false, error: 'http_503' });
    const view = await render(<CompassHome onAsk={jest.fn()} refreshNonce={0} />);
    await waitFor(() => expect(screen.queryByText(FAILED)).not.toBeNull());
    mockFetchCompassHome.mockResolvedValueOnce({ ok: true, data: { ...HOME, degraded: false } });
    await view.rerender(<CompassHome onAsk={jest.fn()} refreshNonce={1} />);
    await waitFor(() => expect(screen.queryByText('Rooftop DJ set')).not.toBeNull());
    expect(screen.queryByText(FAILED)).toBeNull();
  });
});
