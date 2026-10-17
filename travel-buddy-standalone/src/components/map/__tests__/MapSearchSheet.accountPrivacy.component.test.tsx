import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { MapSearchSheet } from '../MapSearchSheet.tsx';
import { setDiscoveryViewerFromSession } from '../../../services/discoveryViewerScope.ts';
import type { MapSearchPageResult } from '../../../platform/input-assistance/search/mapSearch.ts';

const mockRequest = jest.fn();
const mockSignal = jest.fn();
jest.mock('../../../platform/input-assistance/services/inputAssistance.ts', () => {
  return { requestMapSearchPage: (...args: unknown[]) => mockRequest(...args) };
});
jest.mock('../../../services/discovery.ts', () => {
  return { postSearchSignal: (...args: unknown[]) => mockSignal(...args) };
});
jest.mock('react-native-safe-area-context', () => {
  return { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

let pending: Array<{ signal: AbortSignal; resolve: (result: MapSearchPageResult) => void }>;
function answer(title: string): MapSearchPageResult {
  return { ok: true, results: [{ id: title, title, type: 'saved', metadata: { savedKind: 'place', lat: 1.3, lng: 103.8 } }] };
}
async function tick() {
  await act(async () => { jest.advanceTimersByTime(300); });
}
beforeEach(() => {
  jest.useFakeTimers();
  setDiscoveryViewerFromSession('account-a');
  pending = [];
  mockRequest.mockReset().mockImplementation((_query: string, _options: unknown, signal: AbortSignal) =>
    new Promise<MapSearchPageResult>((resolve) => pending.push({ signal, resolve })),
  );
  mockSignal.mockReset();
});
afterEach(() => jest.useRealTimers());

it.each(['account-b', 'account-a'])('rejects old saved results and search signals after relogin as %s', async (nextAccount) => {
  const ui = await render(<MapSearchSheet visible onClose={jest.fn()} onSelect={jest.fn()} />);
  await fireEvent.changeText(ui.getByLabelText('Search the map'), 'museum');
  await tick();
  await act(async () => {
    setDiscoveryViewerFromSession(null);
    setDiscoveryViewerFromSession(nextAccount);
    pending[0].resolve(answer('Old private save'));
  });
  expect(mockSignal).not.toHaveBeenCalled();
  expect(ui.queryByText('Old private save')).toBeNull();
  expect(pending[0].signal.aborted).toBe(true);
  await tick();
  expect(mockRequest).toHaveBeenCalledTimes(2);
  await act(async () => { pending[1].resolve(answer('Current save')); });
  expect(ui.getByText('Current save')).toBeTruthy();
  expect(mockSignal).toHaveBeenCalledTimes(1);
});

it('removes already rendered saved results on an account change without parent rerender', async () => {
  const ui = await render(<MapSearchSheet visible onClose={jest.fn()} onSelect={jest.fn()} />);
  await fireEvent.changeText(ui.getByLabelText('Search the map'), 'museum');
  await tick();
  await act(async () => { pending[0].resolve(answer('Old private save')); });
  expect(ui.getByText('Old private save')).toBeTruthy();
  await act(async () => { setDiscoveryViewerFromSession('account-b'); });
  expect(ui.queryByText('Old private save')).toBeNull();
});

it('same-account token refresh keeps a healthy in-flight search and emits its signal once', async () => {
  const ui = await render(<MapSearchSheet visible onClose={jest.fn()} onSelect={jest.fn()} />);
  await fireEvent.changeText(ui.getByLabelText('Search the map'), 'museum');
  await tick();
  await act(async () => {
    setDiscoveryViewerFromSession('account-a');
    pending[0].resolve(answer('Current save'));
  });
  expect(ui.getByText('Current save')).toBeTruthy();
  expect(mockSignal).toHaveBeenCalledTimes(1);
  expect(mockRequest).toHaveBeenCalledTimes(1);
});
