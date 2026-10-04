/**
 * HighlightViewersSheet — "who viewed my Highlight" is a claim, so a failed
 * read must not make it.
 *
 * WHAT WAS WRONG (lane highlights, 2026-10-03). `fetchHighlightViewers`
 * resolving `{ ok: false }` was rendered as `👁 0 viewers` and "No views yet." —
 * the owner was told nobody had seen their Highlight on the strength of a
 * request that failed. And the read had no stale-response guard: an answer for
 * the PREVIOUS Highlight that landed late overwrote the current one's list.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — react-native-safe-area-context needs a
// native SafeAreaProvider jest-expo does not supply.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// NOTE: intentionally exhaustive — Avatar hydrates private-bucket media.
jest.mock('../ui/Avatar.tsx', () => ({ Avatar: () => null }));

const mockFetchViewers = jest.fn();
jest.mock('../../services/highlights.ts', () => ({
  ...jest.requireActual('../../services/highlights.ts'),
  fetchHighlightViewers: (...a: unknown[]) => mockFetchViewers(...a),
}));

import { HighlightViewersSheet } from '../HighlightViewersSheet.tsx';

const H1 = '11111111-1111-4111-8111-111111111111';
const H2 = '22222222-2222-4222-8222-222222222222';
const viewer = (name: string) => ({ userId: name, handle: name, name, avatarUrl: null, viewedAt: new Date().toISOString(), likedByMe: false });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => mockFetchViewers.mockReset());

it('a failed read is an error with a retry — not "0 viewers" and not "No views yet."', async () => {
  mockFetchViewers.mockResolvedValueOnce({ ok: false, data: null, errorKind: 'db_error' });
  await render(<HighlightViewersSheet visible highlightId={H1} onClose={() => {}} />);
  expect(await screen.findByTestId('highlight-viewers-error')).toBeTruthy();
  expect(screen.queryByText('No views yet.')).toBeNull();
  expect(screen.queryByText(/0 viewers/)).toBeNull();

  mockFetchViewers.mockResolvedValueOnce({ ok: true, data: [viewer('Ana')] });
  await act(async () => { fireEvent.press(screen.getByTestId('highlight-viewers-retry')); });
  expect(await screen.findByText('Ana')).toBeTruthy();
  expect(screen.getByText(/1 viewer$/)).toBeTruthy();
});

it('a real empty list is still "No views yet."', async () => {
  mockFetchViewers.mockResolvedValueOnce({ ok: true, data: [] });
  await render(<HighlightViewersSheet visible highlightId={H1} onClose={() => {}} />);
  expect(await screen.findByText('No views yet.')).toBeTruthy();
});

it('a late answer for the previous Highlight does not replace the current one', async () => {
  const first = deferred<any>();
  mockFetchViewers.mockImplementationOnce(() => first.promise);
  mockFetchViewers.mockResolvedValueOnce({ ok: true, data: [viewer('Bo')] });
  const view = await render(<HighlightViewersSheet visible highlightId={H1} onClose={() => {}} />);
  await view.rerender(<HighlightViewersSheet visible highlightId={H2} onClose={() => {}} />);
  expect(await screen.findByText('Bo')).toBeTruthy();
  await act(async () => { first.resolve({ ok: true, data: [viewer('Stale')] }); });
  expect(screen.queryByText('Stale')).toBeNull();
  expect(screen.getByText('Bo')).toBeTruthy();
});
