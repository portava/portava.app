import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { MapSearchSheet } from '../MapSearchSheet.tsx';

const mockToken = jest.fn();
const mockFetch = jest.fn();

jest.mock('../../../services/apiToken.ts', () => {
  return { freshToken: (...args: unknown[]) => mockToken(...args) };
});
jest.mock('../../../services/discovery.ts', () => {
  return { postSearchSignal: jest.fn() };
});
jest.mock('react-native-safe-area-context', () => {
  return { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

const originalFetch = globalThis.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;

beforeEach(() => {
  jest.useFakeTimers();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://input.test';
  globalThis.fetch = mockFetch;
  mockToken.mockReset().mockResolvedValue('dummy-map-token');
  mockFetch.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
  jest.useRealTimers();
});

async function search(onSelect = jest.fn()) {
  const ui = await render(
    <MapSearchSheet visible lat={1.3} lng={103.8} city="Singapore" onClose={jest.fn()} onSelect={onSelect} />,
  );
  await fireEvent.changeText(ui.getByLabelText('Search the map'), 'museum');
  await act(async () => { jest.advanceTimersByTime(300); });
  return ui;
}

it('retains the authenticated map.search request, server rows, saved-lane coverage and selection targets', async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      suggestions: [
        {
          entityId: 'place-1', label: 'Museum',
          mapResult: { serverType: 'places', destinationRoute: '/place/place-1', metadata: { lat: 1.3, lng: 103.8 } },
        },
        {
          entityId: 'person-1', label: 'Museum friend',
          mapResult: { serverType: 'travelers', destinationRoute: '/profile/person-1' },
        },
        {
          entityId: 'saved-1', label: 'Saved museum',
          mapResult: { serverType: 'saved', metadata: { savedKind: 'place', lat: 1.3, lng: 103.8 } },
        },
      ],
      laneRefusals: { saved: { class: 'transient_db', code: 'saved_partial', coverage: 'partial' } },
    }),
  });
  const onSelect = jest.fn();
  const ui = await search(onSelect);
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const [url, request] = mockFetch.mock.calls[0];
  expect(url).toBe('https://input.test/api/input-assistance/suggest');
  expect(request.method).toBe('POST');
  expect(request.headers.Authorization).toBe('Bearer dummy-map-token');
  expect(JSON.parse(request.body)).toEqual({
    context: 'global_search', fieldId: 'map.search', text: 'museum',
    sessionContext: { surface: 'map' }, lat: 1.3, lng: 103.8, city: 'Singapore',
  });
  expect(request.signal.aborted).toBe(false);
  expect(ui.getByText('Saved museum')).toBeTruthy();
  expect(ui.getByText(/Some of your saved items couldn’t be loaded/)).toBeTruthy();
  await fireEvent.press(ui.getByLabelText('Museum, show on map'));
  expect(onSelect).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: 'place-1', detailRoute: '/place/place-1' }),
    expect.objectContaining({ kind: 'center', center: { lat: 1.3, lng: 103.8 } }),
  );
  await fireEvent.press(ui.getByLabelText('Museum friend, open details'));
  expect(onSelect).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: 'person-1', detailRoute: '/profile/person-1' }),
    { kind: 'none', reason: 'no_geometry' },
  );
});

it('a missing authentication token produces no request, no legacy fallback and no false empty state', async () => {
  mockToken.mockResolvedValue(null);
  const ui = await search();
  expect(mockFetch).not.toHaveBeenCalled();
  expect(ui.getByText('Not signed in')).toBeTruthy();
  expect(ui.queryByText(/Nothing matched/)).toBeNull();
});

it('a denied gateway response keeps the service error instead of falling back to another search', async () => {
  mockFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ message: 'Search is not permitted' }) });
  const ui = await search();
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(ui.getByText('Search is not permitted')).toBeTruthy();
  expect(ui.queryByText(/Nothing matched/)).toBeNull();
});

it('offline failure reports the original service error without replaying a prior saved page', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ suggestions: [{
      entityId: 'saved-1', label: 'Prior saved museum',
      mapResult: { serverType: 'saved', metadata: { savedKind: 'place', lat: 1.3, lng: 103.8 } },
    }] }),
  });
  const ui = await search();
  expect(ui.getByText('Prior saved museum')).toBeTruthy();
  mockFetch.mockRejectedValue(new TypeError('Offline'));
  await fireEvent.changeText(ui.getByLabelText('Search the map'), 'other museum');
  await act(async () => { jest.advanceTimersByTime(300); });
  expect(mockFetch).toHaveBeenCalledTimes(2);
  expect(ui.queryByText('Prior saved museum')).toBeNull();
  expect(ui.getByText('Network error — check your connection')).toBeTruthy();
  expect(ui.queryByText(/Nothing matched/)).toBeNull();
});
