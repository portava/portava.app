import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { PlaceLiveInformation } from '../sharing/PlaceLiveInformation.tsx';
import { currentPlaceClaims, stampPlaceLiveInformation } from '../sharing/placeLiveInformation.ts';
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(100_000); });
afterEach(() => { jest.useRealTimers(); });
it('uses the server validity from request start, not a later render or cache read', () => {
  const value = stampPlaceLiveInformation({ whyNow: ['crowd_busy'], whyNowValidForMs: 5000 }, 100_000);
  expect(value?.expiresAtMs).toBe(105_000);
  expect(currentPlaceClaims(value, 104_999)).toEqual(['crowd busy']);
  expect(currentPlaceClaims(value, 105_000)).toEqual([]);
});
it('ignores absent, unknown and invalid freshness rather than manufacturing live claims', () => {
  for (const whyNowValidForMs of [null, 0, -1, Infinity, NaN]) {
    expect(currentPlaceClaims(stampPlaceLiveInformation({ whyNow: ['crowd_busy'], whyNowValidForMs }, 100_000), 100_001)).toEqual([]);
  }
  expect(currentPlaceClaims({ whyNow: ['crowd_busy'], whyNowValidForMs: 10_000 }, 100_001)).toEqual([]);
});
it('removes live information at its expiry while the card stays mounted', async () => {
  const value = stampPlaceLiveInformation({ whyNow: ['crowd_busy', 'safety_caution'], whyNowValidForMs: 1000 }, 100_000);
  await render(<PlaceLiveInformation value={value} />);
  expect(screen.getByText('crowd busy')).toBeTruthy();
  expect(screen.getByText('safety caution')).toBeTruthy();
  await act(async () => { jest.advanceTimersByTime(1000); });
  expect(screen.queryByTestId('telegraph-place-live-information')).toBeNull();
});
it('a cached expired value stays hidden and a fresh server answer can replace it', async () => {
  const stale = stampPlaceLiveInformation({ whyNow: ['crowd_busy'], whyNowValidForMs: 1000 }, 98_000);
  const view = await render(<PlaceLiveInformation value={stale} />);
  expect(screen.queryByText('crowd busy')).toBeNull();
  await view.rerender(<PlaceLiveInformation value={stampPlaceLiveInformation({ whyNow: ['crowd_quiet'], whyNowValidForMs: 1000 }, 100_000)} />);
  expect(screen.getByText('crowd quiet')).toBeTruthy();
});
it('withholds the whole section when a revoked projection disappears', async () => {
  const view = await render(<PlaceLiveInformation value={stampPlaceLiveInformation({ whyNow: ['crowd_busy'], whyNowValidForMs: 1000 }, 100_000)} />);
  await view.rerender(<PlaceLiveInformation />);
  expect(screen.queryByTestId('telegraph-place-live-information')).toBeNull();
});
