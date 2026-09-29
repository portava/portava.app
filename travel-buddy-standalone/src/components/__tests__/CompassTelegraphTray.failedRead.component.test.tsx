/**
 * census-discovery §107 (DV-83 round 10, D-W11X2-68): the Telegraph "Ask Compass" tray never
 * draws a failed read as "nothing found". Adapted from the round-9 verifier's probe
 * (scratchpad v9-probes/zz-v9-CompassTelegraphTray.failedRead).
 *
 * The tray set its cards only on `result.ok`, so an HTTP failure, a network failure and a
 * refusal all rendered the EMPTY state: "No suggestions right now — Compass couldn't find
 * relevant recommendations for this chat." Its own header promised an unavailable state that
 * did not exist.
 *
 *   TT0  CONTROL (V9-TT0): a readable empty answer → the empty state
 *   TT1  (V9-TT1) the read fails (http_500) → the failed state, never "couldn't find"
 *   TT2  (V9-TT2) the read fails (network) → the failed state
 *   TT3  a refusal (`nothing`) → the failed state
 *   TT4  a `partial` answer → its cards AND the partial line
 *   TT5  the failed state's retry reads again, and a good answer replaces it
 *   TT6  a late answer from an earlier open never writes the tray
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';

// NOTE: a stand-in on purpose — the tray reads only useSafeAreaInsets, and the real provider needs a native context.
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
const mockFetch = jest.fn();
jest.mock('../../services/compass', () => ({
  ...jest.requireActual('../../services/compass'),
  fetchCompassTelegraphCards: (...args: unknown[]) => mockFetch(...args),
}));

import { CompassTelegraphTray, TELEGRAPH_TRAY_FAILED } from '../CompassTelegraphTray.tsx';

const EMPTY = /couldn't find relevant recommendations/;
const PARTIAL = 'Some Compass suggestions couldn’t be loaded just now, so this list may be incomplete.';
const CARD = { id: 'ev-1', type: 'event', title: 'Jazz night', city: 'Paris', category: 'music', description: null, imageUrl: null };
const CARD2 = { ...CARD, id: 'ev-2', title: 'Old answer' };
function mount(visible = true) {
  return render(<CompassTelegraphTray visible={visible} threadId="t-1" onDismiss={() => {}} onShareCard={() => {}} />);
}
const settled = () => waitFor(() => expect(screen.queryByText('Finding suggestions…')).toBeNull());

describe('CompassTelegraphTray over a failed read (§107)', () => {
  beforeEach(() => mockFetch.mockReset());

  it('TT0 (V9-TT0) CONTROL: a readable empty answer → the empty state', async () => {
    mockFetch.mockResolvedValue({ ok: true, cards: [], city: 'Paris' });
    mount();
    await waitFor(() => expect(screen.queryByText(EMPTY)).toBeTruthy());
    expect(screen.queryByText(TELEGRAPH_TRAY_FAILED)).toBeNull();
  });

  it('TT1 (V9-TT1) the read fails (http_500) → the failed state, never "couldn\'t find"', async () => {
    mockFetch.mockResolvedValue({ ok: false, error: 'http_500' });
    mount();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await settled();
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.queryByText(TELEGRAPH_TRAY_FAILED)).toBeTruthy();
  });

  it('TT2 (V9-TT2) the read fails (network) → the failed state', async () => {
    mockFetch.mockResolvedValue({ ok: false, error: 'network_error' });
    mount();
    await settled();
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.queryByText(TELEGRAPH_TRAY_FAILED)).toBeTruthy();
  });

  it('TT3 a refusal (nothing) → the failed state', async () => {
    mockFetch.mockResolvedValue({ ok: false, refused: true, error: 'telegraph_sources_unread' });
    mount();
    await settled();
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.queryByText(TELEGRAPH_TRAY_FAILED)).toBeTruthy();
  });

  it('TT4 a partial answer → its cards AND the partial line', async () => {
    mockFetch.mockResolvedValue({ ok: true, cards: [CARD], city: 'Paris', partial: true });
    mount();
    await waitFor(() => expect(screen.queryByText('Jazz night')).toBeTruthy());
    expect(screen.queryByText(PARTIAL)).toBeTruthy();
  });

  it('TT5 the retry reads again, and a good answer replaces the failed state', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, error: 'http_503' }).mockResolvedValueOnce({ ok: true, cards: [CARD], city: 'Paris' });
    mount();
    await waitFor(() => expect(screen.queryByText(TELEGRAPH_TRAY_FAILED)).toBeTruthy());
    fireEvent.press(screen.getByText('Try again'));
    await waitFor(() => expect(screen.queryByText('Jazz night')).toBeTruthy());
    expect(screen.queryByText(TELEGRAPH_TRAY_FAILED)).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('TT6 a late answer from an earlier open never writes the tray', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    mockFetch
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce({ ok: false, error: 'http_503' });
    const view = await mount(true);
    await view.rerender(<CompassTelegraphTray visible={false} threadId="t-1" onDismiss={() => {}} onShareCard={() => {}} />);
    await view.rerender(<CompassTelegraphTray visible threadId="t-1" onDismiss={() => {}} onShareCard={() => {}} />);
    await waitFor(() => expect(screen.queryByText(TELEGRAPH_TRAY_FAILED)).toBeTruthy());
    resolveFirst({ ok: true, cards: [CARD2], city: 'Paris' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Old answer')).toBeNull();
    expect(screen.queryByText(TELEGRAPH_TRAY_FAILED)).toBeTruthy();
  });
});
