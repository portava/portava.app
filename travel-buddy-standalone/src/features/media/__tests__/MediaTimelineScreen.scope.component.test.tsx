import React, { useEffect } from 'react';
import { Text, View } from 'react-native';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { MediaTimelineScreen } from '../screens/MediaTimelineScreen.tsx';
import { useLensProjection } from '../hooks/useLensProjection.ts';
import { mapTimeline } from '../services/mediaProjection.ts';
import type { MediaTimelineProjection } from '../types/mediaTimeline.ts';
import type { ProjectionResult } from '../types/media.ts';

const ALPHA = '11111111-1111-4111-8111-111111111111';
const BETA = '22222222-2222-4222-8222-222222222222';
const mockFetchTimeline = jest.fn();
jest.mock('../services/mediaProjection.ts', () => ({
  ...jest.requireActual('../services/mediaProjection.ts'),
  fetchTimeline: (...args: unknown[]) => mockFetchTimeline(...args),
}));

function timeline(label: string) {
  return mapTimeline({
    bands: {
      now: {
        live: true,
        items: [{ itemKind: 'liveClaim', renderClass: 'observed', label, live: true }],
      },
      typical: {
        items: [{ itemKind: 'pattern', renderClass: 'typical', label: `${label} pattern` }],
      },
    },
  });
}

function deferredTimeline() {
  let resolve!: (result: ProjectionResult<MediaTimelineProjection>) => void;
  const promise = new Promise<ProjectionResult<MediaTimelineProjection>>((complete) => { resolve = complete; });
  return { promise, resolve };
}

beforeEach(() => {
  mockFetchTimeline.mockReset();
});

it('never relabels another place’s current state or pattern while a new timeline loads or fails', async () => {
  const next = deferredTimeline();
  mockFetchTimeline.mockResolvedValueOnce({ ok: true, data: timeline('Alpha busy') });
  mockFetchTimeline.mockReturnValueOnce(next.promise);
  const view = await render(<MediaTimelineScreen placeId={ALPHA} label="Alpha" />);
  await waitFor(() => expect(screen.getByText('Alpha busy')).toBeTruthy());

  await view.rerender(<MediaTimelineScreen placeId={BETA} label="Beta" />);
  expect(screen.queryByText('Alpha busy')).toBeNull();
  expect(screen.queryByText('Alpha busy pattern')).toBeNull();
  expect(screen.queryByTestId('media-timeline-screen')).toBeNull();
  expect(mockFetchTimeline).toHaveBeenLastCalledWith(expect.objectContaining({ placeId: BETA }));

  await act(async () => next.resolve({ ok: false, data: null, errorKind: 'network', message: 'Unavailable' }));
  expect(screen.queryByText('Alpha busy pattern')).toBeNull();
  expect(screen.queryByText('Beta · over time')).toBeNull();
  expect(screen.getByText('Try again')).toBeTruthy();
});

it('does not carry a place-scoped current claim into the world timeline', async () => {
  const next = deferredTimeline();
  mockFetchTimeline.mockResolvedValueOnce({ ok: true, data: timeline('Alpha busy') });
  mockFetchTimeline.mockReturnValueOnce(next.promise);
  const view = await render(<MediaTimelineScreen placeId={ALPHA} label="Alpha" />);
  await waitFor(() => expect(screen.getByText('Alpha busy')).toBeTruthy());

  await view.rerender(<MediaTimelineScreen />);
  expect(screen.queryByText('Alpha busy')).toBeNull();
  await act(async () => next.resolve({ ok: true, data: mapTimeline({}) }));
  expect(screen.getByText('No current read')).toBeTruthy();
  expect(screen.queryByText('Alpha busy pattern')).toBeNull();
});

it('ignores an aborted place read that completes after the replacement timeline', async () => {
  const previous = deferredTimeline();
  mockFetchTimeline.mockReturnValueOnce(previous.promise);
  mockFetchTimeline.mockResolvedValueOnce({ ok: true, data: timeline('Beta quiet') });
  const view = await render(<MediaTimelineScreen placeId={ALPHA} label="Alpha" />);
  const previousSignal = mockFetchTimeline.mock.calls[0][0].signal as AbortSignal;
  await view.rerender(<MediaTimelineScreen placeId={BETA} label="Beta" />);
  await waitFor(() => expect(screen.getByText('Beta quiet')).toBeTruthy());
  expect(previousSignal.aborted).toBe(true);

  await act(async () => previous.resolve({ ok: true, data: timeline('Alpha busy') }));
  expect(screen.getByText('Beta quiet')).toBeTruthy();
  expect(screen.queryByText('Alpha busy')).toBeNull();
});

let reloadLens: () => void;
function LensState() {
  const { state, reload } = useLensProjection<MediaTimelineProjection>(mockFetchTimeline, () => false, ['same-place']);
  useEffect(() => { reloadLens = reload; }, [reload]);
  return <View><Text testID="lens-status">{state.status}</Text><Text>{state.data?.bands.now.items[0]?.label}</Text></View>;
}

it('preserves same-scope stale-while-revalidate when a reload fails', async () => {
  const refresh = deferredTimeline();
  mockFetchTimeline.mockResolvedValueOnce({ ok: true, data: timeline('Alpha busy') });
  mockFetchTimeline.mockReturnValueOnce(refresh.promise);
  await render(<LensState />);
  await waitFor(() => expect(screen.getByText('Alpha busy')).toBeTruthy());

  await act(async () => reloadLens());
  expect(screen.getByTestId('lens-status').props.children).toBe('revalidating');
  expect(screen.getByText('Alpha busy')).toBeTruthy();
  await act(async () => refresh.resolve({ ok: false, data: null, errorKind: 'network', message: 'Unavailable' }));
  expect(screen.getByTestId('lens-status').props.children).toBe('ready');
  expect(screen.getByText('Alpha busy')).toBeTruthy();
});
