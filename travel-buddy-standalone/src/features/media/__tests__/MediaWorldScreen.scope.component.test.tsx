import React, { useEffect } from 'react';
import { Text, View } from 'react-native';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { useMediaWorld } from '../hooks/useMediaWorld.ts';
import { MediaWorldScreen } from '../screens/MediaWorldScreen.tsx';
import type { MediaWorldProjection } from '../types/mediaContext.ts';
import type { ProjectionResult } from '../types/media.ts';
import type { WorldParams } from '../services/mediaProjection.ts';

const mockFetchWorld = jest.fn();
jest.mock('../services/mediaProjection.ts', () => ({
  ...jest.requireActual('../services/mediaProjection.ts'),
  fetchWorld: (...args: unknown[]) => mockFetchWorld(...args),
}));
jest.mock('../hooks/useMediaCrowdFlow.ts', () => ({
  ...jest.requireActual('../hooks/useMediaCrowdFlow.ts'),
  useMediaCrowdFlow: () => [],
}));

function world(city: string): MediaWorldProjection {
  return {
    city: { id: city, name: city },
    cityVisualState: [{ id: `${city}-place`, name: `${city} waterfront`, perspectiveCount: 3, freshness: 'fresh' }],
    forYouNow: [{ id: `${city}-now`, category: `${city} nightlife`, count: 3, kind: 'fresh_perspectives', lens: 'places' }],
    changingNow: [],
    generatedAt: null,
  };
}

function deferredWorld() {
  let resolve!: (result: ProjectionResult<MediaWorldProjection>) => void;
  const promise = new Promise<ProjectionResult<MediaWorldProjection>>((complete) => { resolve = complete; });
  return { promise, resolve };
}

let reloadWorld: () => void;
function Dashboard(params: WorldParams) {
  const { state, reload } = useMediaWorld(params);
  useEffect(() => { reloadWorld = reload; }, [reload]);
  return (
    <View>
      <Text testID="world-status">{state.status}</Text>
      <Text testID="world-city">{state.data?.city?.name ?? params.city}</Text>
      <MediaWorldScreen state={state} mode="overview" city={params.city} onReload={reload} />
    </View>
  );
}

beforeEach(() => {
  mockFetchWorld.mockReset();
});

it('removes another city immediately and never restores it when the new city read fails', async () => {
  const next = deferredWorld();
  mockFetchWorld.mockResolvedValueOnce({ ok: true, data: world('Alpha') });
  mockFetchWorld.mockReturnValueOnce(next.promise);
  const view = await render(<Dashboard city="Alpha" lat={1} lng={2} />);
  await waitFor(() => expect(screen.getByText('Alpha waterfront')).toBeTruthy());

  await view.rerender(<Dashboard city="Beta" lat={3} lng={4} />);
  expect(screen.queryByText('Alpha waterfront')).toBeNull();
  expect(screen.queryByText('Alpha nightlife')).toBeNull();
  expect(screen.getByTestId('world-city').props.children).toBe('Beta');
  expect(screen.getByTestId('world-status').props.children).toBe('loading');
  expect(mockFetchWorld).toHaveBeenLastCalledWith(expect.objectContaining({ city: 'Beta', lat: 3, lng: 4 }));

  await act(async () => next.resolve({ ok: false, data: null, errorKind: 'network', message: 'Unavailable' }));
  expect(screen.getByTestId('world-status').props.children).toBe('error');
  expect(screen.queryByText('Alpha waterfront')).toBeNull();
  expect(screen.queryByText('Alpha nightlife')).toBeNull();
  expect(screen.getByText('Try again')).toBeTruthy();
});

it('keeps same-scope data during a refresh and its failure', async () => {
  const refresh = deferredWorld();
  mockFetchWorld.mockResolvedValueOnce({ ok: true, data: world('Alpha') });
  mockFetchWorld.mockReturnValueOnce(refresh.promise);
  await render(<Dashboard city="Alpha" lat={1} lng={2} />);
  await waitFor(() => expect(screen.getByText('Alpha waterfront')).toBeTruthy());

  await act(async () => reloadWorld());
  expect(screen.getByTestId('world-status').props.children).toBe('revalidating');
  expect(screen.getByText('Alpha waterfront')).toBeTruthy();
  await act(async () => refresh.resolve({ ok: false, data: null, errorKind: 'network', message: 'Unavailable' }));
  expect(screen.getByTestId('world-status').props.children).toBe('ready');
  expect(screen.getByText('Alpha waterfront')).toBeTruthy();
});

it('ignores a late result from an aborted location read after a newer location succeeds', async () => {
  const previous = deferredWorld();
  mockFetchWorld.mockReturnValueOnce(previous.promise);
  mockFetchWorld.mockResolvedValueOnce({ ok: true, data: world('Beta') });
  const view = await render(<Dashboard city="Alpha" lat={1} lng={2} />);
  const previousSignal = mockFetchWorld.mock.calls[0][0].signal as AbortSignal;
  await view.rerender(<Dashboard city="Beta" lat={3} lng={4} />);
  await waitFor(() => expect(screen.getByText('Beta waterfront')).toBeTruthy());
  expect(previousSignal.aborted).toBe(true);

  await act(async () => previous.resolve({ ok: true, data: world('Alpha') }));
  expect(screen.queryByText('Alpha waterfront')).toBeNull();
  expect(screen.getByText('Beta waterfront')).toBeTruthy();
});

it('does not retain a dashboard when the coordinates change without a city label', async () => {
  const next = deferredWorld();
  mockFetchWorld.mockResolvedValueOnce({ ok: true, data: world('Alpha') });
  mockFetchWorld.mockReturnValueOnce(next.promise);
  const view = await render(<Dashboard lat={1} lng={2} />);
  await waitFor(() => expect(screen.getByText('Alpha waterfront')).toBeTruthy());

  await view.rerender(<Dashboard lat={3} lng={4} />);
  expect(screen.queryByText('Alpha waterfront')).toBeNull();
  await act(async () => next.resolve({ ok: true, data: world('Beta') }));
  expect(screen.getByText('Beta waterfront')).toBeTruthy();
});
