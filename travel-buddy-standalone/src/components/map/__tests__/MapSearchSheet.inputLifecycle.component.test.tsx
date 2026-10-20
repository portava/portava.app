import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { MapSearchSheet } from '../MapSearchSheet.tsx';
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

type Pending = {
  query: string;
  signal?: AbortSignal;
  resolve: (result: MapSearchPageResult) => void;
};
let pending: Pending[];

function answer(title: string): MapSearchPageResult {
  return {
    ok: true,
    results: [{ id: title, title, type: 'places', metadata: { lat: 1.3, lng: 103.8 } }],
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  pending = [];
  mockRequest.mockReset().mockImplementation((query: string, _options: unknown, signal?: AbortSignal) =>
    new Promise<MapSearchPageResult>((resolve) => pending.push({ query, signal, resolve })),
  );
  mockSignal.mockReset();
});

afterEach(() => jest.useRealTimers());

async function tick() {
  await act(async () => { jest.advanceTimersByTime(300); });
}

it('invalidates and aborts the earlier request as soon as another query is typed', async () => {
  const ui = await render(<MapSearchSheet visible onClose={jest.fn()} onSelect={jest.fn()} />);
  await fireEvent.changeText(ui.getByLabelText('Search the map'), 'old');
  await tick();
  await fireEvent.changeText(ui.getByLabelText('Search the map'), 'new');
  await act(async () => { pending[0].resolve(answer('Old result')); });
  expect(ui.queryByText('Old result')).toBeNull();
  expect(mockSignal).not.toHaveBeenCalled();
  expect(pending[0].signal?.aborted).toBe(true);
  await tick();
  await act(async () => { pending[1].resolve(answer('New result')); });
  expect(ui.getByText('New result')).toBeTruthy();
});

it('closing clears the pending search and prevents a late answer from resurfacing on reopen', async () => {
  const onSelect = jest.fn();
  const ui = await render(<MapSearchSheet visible onClose={jest.fn()} onSelect={onSelect} />);
  await fireEvent.changeText(ui.getByLabelText('Search the map'), 'old');
  await tick();
  await ui.rerender(<MapSearchSheet visible={false} onClose={jest.fn()} onSelect={onSelect} />);
  await act(async () => { pending[0].resolve(answer('Closed result')); });
  await ui.rerender(<MapSearchSheet visible onClose={jest.fn()} onSelect={onSelect} />);
  expect(ui.queryByText('Closed result')).toBeNull();
  expect(mockSignal).not.toHaveBeenCalled();
  expect(pending[0].signal?.aborted).toBe(true);
});

it('submit replaces the pending debounce rather than issuing the same query twice', async () => {
  const ui = await render(<MapSearchSheet visible onClose={jest.fn()} onSelect={jest.fn()} />);
  await fireEvent.changeText(ui.getByLabelText('Search the map'), 'museum');
  await fireEvent(ui.getByLabelText('Search the map'), 'submitEditing');
  await tick();
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(pending[0].signal).toBeDefined();
});

it('clearing the field cancels an in-flight request without reporting a search or a miss', async () => {
  const ui = await render(<MapSearchSheet visible onClose={jest.fn()} onSelect={jest.fn()} />);
  await fireEvent.changeText(ui.getByLabelText('Search the map'), 'museum');
  await tick();
  await fireEvent.changeText(ui.getByLabelText('Search the map'), '');
  await act(async () => { pending[0].resolve(answer('Cleared result')); });
  expect(ui.queryByText('Cleared result')).toBeNull();
  expect(ui.queryByText(/Nothing matched/)).toBeNull();
  expect(mockSignal).not.toHaveBeenCalled();
  expect(pending[0].signal?.aborted).toBe(true);
});

it('changing the map scope invalidates results before the next debounce fires', async () => {
  const ui = await render(<MapSearchSheet visible city="Paris" onClose={jest.fn()} onSelect={jest.fn()} />);
  await fireEvent.changeText(ui.getByLabelText('Search the map'), 'museum');
  await tick();
  await ui.rerender(<MapSearchSheet visible city="Rome" onClose={jest.fn()} onSelect={jest.fn()} />);
  await act(async () => { pending[0].resolve(answer('Paris result')); });
  expect(ui.queryByText('Paris result')).toBeNull();
  expect(mockSignal).not.toHaveBeenCalled();
  await tick();
  expect(mockRequest.mock.calls[1][1]).toEqual({ lat: undefined, lng: undefined, city: 'Rome' });
  await act(async () => { pending[1].resolve(answer('Rome result')); });
  expect(ui.getByText('Rome result')).toBeTruthy();
  expect(mockSignal).toHaveBeenCalledWith('museum', { city: 'Rome' });
});

it('unmount aborts work and suppresses late search signals even when transport ignores abort', async () => {
  const ui = await render(<MapSearchSheet visible onClose={jest.fn()} onSelect={jest.fn()} />);
  await fireEvent.changeText(ui.getByLabelText('Search the map'), 'museum');
  await tick();
  await ui.unmount();
  await act(async () => { pending[0].resolve(answer('Unmounted result')); });
  expect(mockSignal).not.toHaveBeenCalled();
  expect(pending[0].signal?.aborted).toBe(true);
});
