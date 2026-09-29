/**
 * /safe-return/:shareId — the trusted contact's live-share screen (TRUST-F10).
 *
 * Mounts LiveShareRecipientView on GET /api/safe-return/live-share/:shareId.
 * The three server answers stay apart on screen: 404 = the share has ended,
 * 403 = not shared with you, 503 / network = Retry. A read that failed is
 * never shown as "ended".
 */
import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

let mockParams: Record<string, string> = { shareId: 'share-1' };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => mockParams,
}));

jest.mock('../../../src/services/apiToken', () => ({
  ...jest.requireActual('../../../src/services/apiToken'),
  freshToken: async () => 'tok',
}));

import SafeReturnLiveShareScreen from '../[shareId]';

const fetchMock = jest.fn();
const realFetch = global.fetch;
beforeAll(() => { (global as any).fetch = fetchMock; });
afterAll(() => { (global as any).fetch = realFetch; });
beforeEach(() => { fetchMock.mockReset(); mockParams = { shareId: 'share-1' }; });
afterEach(async () => { await act(async () => {}); });

const reply = (status: number, body: unknown) => Promise.resolve({ status, ok: status < 300, json: async () => body });

test('an active share: the sharer, the approximate area and the countdown', async () => {
  fetchMock.mockReturnValue(reply(200, { ok: true, share: {
    shareId: 'share-1', status: 'active', sharingUserName: 'Ana', approximateArea: 'Lisbon, Portugal',
    areaStatus: 'known', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), secondsRemaining: 1800,
  } }));
  const view = await render(<SafeReturnLiveShareScreen />);
  await waitFor(() => expect(view.getByTestId('live-share-view')).toBeTruthy());
  expect(view.getByText('Ana')).toBeTruthy();
  expect(view.getByText('Lisbon, Portugal')).toBeTruthy();
  expect(view.getByText(/Ends in 30m/)).toBeTruthy();
  expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/safe-return\/live-share\/share-1$/);
});

test('503 is Retry — never "ended"; Retry reads again', async () => {
  fetchMock.mockReturnValueOnce(reply(503, { error: 'degraded_unavailable', message: 'This live share could not be loaded. Please try again.', retryable: true }));
  const view = await render(<SafeReturnLiveShareScreen />);
  await waitFor(() => expect(view.getByTestId('live-share-error')).toBeTruthy());
  expect(view.queryByText(/ended/)).toBeNull();
  fetchMock.mockReturnValueOnce(reply(200, { ok: true, share: { shareId: 'share-1', status: 'active', sharingUserName: 'Ana', approximateArea: 'Porto', expiresAt: null, secondsRemaining: null } }));
  await act(async () => { fireEvent.press(view.getByLabelText('Retry')); });
  await waitFor(() => expect(view.getByText('Porto')).toBeTruthy());
});

test('a network failure is Retry too', async () => {
  fetchMock.mockRejectedValueOnce(new Error('Network request failed'));
  const view = await render(<SafeReturnLiveShareScreen />);
  await waitFor(() => expect(view.getByTestId('live-share-error')).toBeTruthy());
});

test('404 says the share has ended, with the reason, and offers no Retry', async () => {
  fetchMock.mockReturnValueOnce(reply(404, { error: 'not_found', message: 'Live share has been stopped' }));
  const view = await render(<SafeReturnLiveShareScreen />);
  await waitFor(() => expect(view.getByTestId('live-share-ended')).toBeTruthy());
  expect(view.getByText(/This live share has ended\. Live share has been stopped\./)).toBeTruthy();
  expect(view.queryByLabelText('Retry')).toBeNull();
});

test('403 says it was not shared with you', async () => {
  fetchMock.mockReturnValueOnce(reply(403, { error: 'forbidden', message: 'You are not authorized to view this share' }));
  const view = await render(<SafeReturnLiveShareScreen />);
  await waitFor(() => expect(view.getByTestId('live-share-forbidden')).toBeTruthy());
});

test('a link with no share id says so and reads nothing', async () => {
  mockParams = { shareId: '' };
  const view = await render(<SafeReturnLiveShareScreen />);
  expect(view.getByTestId('live-share-bad-link')).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});
