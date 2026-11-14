import React from 'react';
import { Text } from 'react-native';
import { render, screen, act, cleanup } from '@testing-library/react-native';
import { batchSignUrls, _resetBatchSignCache, _setTestSignTokenProvider, _evictBatchSignEntry, lastSignOutcome, MEDIA_SIGN_TIMEOUT_MS } from '../batchSignMedia.ts';
import { _resetDiscoveryViewerScopeForTests, setDiscoveryViewerFromSession } from '../../services/discoveryViewerScope.ts';
import { useHydratedMedia } from '../../services/mediaUrl.ts';

const ref = 'post-media/alice/photo.jpg';
const jwt = (user: string) => `header.${btoa(JSON.stringify({ sub: user }))}.signature`;
let token: string | null;
const originalFetch = global.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const signed = (url: string, ttlSeconds = 3600) => ({ ok: true, status: 200, json: async () => ({ signed: { [ref]: url }, ttlSeconds }) });
beforeEach(() => {
  jest.useFakeTimers();
  _resetDiscoveryViewerScopeForTests(); _resetBatchSignCache();
  token = jwt('alice'); setDiscoveryViewerFromSession('alice');
  _setTestSignTokenProvider(async () => token);
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
});
afterEach(async () => {
  await cleanup();
  await jest.advanceTimersByTimeAsync(0);
  expect(jest.getTimerCount()).toBe(0);
  _setTestSignTokenProvider(null); _resetBatchSignCache(); _resetDiscoveryViewerScopeForTests();
  global.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
  jest.useRealTimers();
});

test('cached private links are never reused after account replacement or sign-out', async () => {
  const send = jest.fn(async () => signed('https://storage.test/alice?token=a'));
  global.fetch = send as unknown as typeof fetch;
  expect((await batchSignUrls([ref])).get(ref)).toContain('token=a');
  expect((await batchSignUrls([ref])).get(ref)).toContain('token=a');
  expect(send).toHaveBeenCalledTimes(1);
  token = jwt('bob'); setDiscoveryViewerFromSession('bob');
  send.mockResolvedValue(signed('https://storage.test/bob?token=b'));
  expect((await batchSignUrls([ref])).get(ref)).toContain('token=b');
  expect(send).toHaveBeenCalledTimes(2);
  token = null; setDiscoveryViewerFromSession(null);
  expect((await batchSignUrls([ref])).get(ref)).toBe(ref);
  expect(send).toHaveBeenCalledTimes(2);
  expect(lastSignOutcome(ref)).toBe('unavailable');
});

test('a delayed token from another viewer never sends a signing request', async () => {
  token = jwt('bob'); global.fetch = jest.fn();
  expect((await batchSignUrls([ref])).get(ref)).toBe(ref);
  expect(global.fetch).not.toHaveBeenCalled();
});

test('account replacement interrupts a stuck response body and cannot refill the new cache', async () => {
  let release!: (body: unknown) => void;
  const json = jest.fn(() => new Promise(resolve => { release = resolve; }));
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json })) as unknown as typeof fetch;
  const pending = batchSignUrls([ref]); await jest.advanceTimersByTimeAsync(0);
  expect(json).toHaveBeenCalled();
  token = jwt('bob'); setDiscoveryViewerFromSession('bob');
  expect((await pending).get(ref)).toBe(ref);
  release({ signed: { [ref]: 'https://storage.test/private-a' }, ttlSeconds: 3600 }); await Promise.resolve();
  expect(lastSignOutcome(ref)).toBeNull();
  global.fetch = jest.fn(async () => signed('https://storage.test/current')) as unknown as typeof fetch;
  expect((await batchSignUrls([ref])).get(ref)).toContain('current');
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test.each([401, 403, 404, 410])('HTTP %s is a denial, never permission to display an offline private copy', async status => {
  global.fetch = jest.fn(async () => ({ ok: false, status })) as unknown as typeof fetch;
  expect((await batchSignUrls([ref])).get(ref)).toBe(ref);
  expect(lastSignOutcome(ref)).toBe('denied');
});

test('network outages, malformed responses and redirect refusals stay distinct', async () => {
  global.fetch = jest.fn(async () => { throw new Error('offline'); });
  await batchSignUrls([ref]); expect(lastSignOutcome(ref)).toBe('unreachable');
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
  await batchSignUrls([ref]); expect(lastSignOutcome(ref)).toBe('unavailable');
  global.fetch = jest.fn(async () => ({ ...signed('https://storage.test/x'), redirected: true })) as unknown as typeof fetch;
  await batchSignUrls([ref]); expect(lastSignOutcome(ref)).toBe('unavailable');
  expect(global.fetch).toHaveBeenCalledWith('https://api.test/api/media/sign', expect.objectContaining({ redirect: 'error', credentials: 'omit', cache: 'no-store' }));
});

test('a short-lived link expires in the cache before its actual grant', async () => {
  const send = jest.fn(async () => signed('https://storage.test/short', 60)); global.fetch = send as unknown as typeof fetch;
  await batchSignUrls([ref]); await jest.advanceTimersByTimeAsync(53_000); await batchSignUrls([ref]);
  expect(send).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(2_000); await batchSignUrls([ref]);
  expect(send).toHaveBeenCalledTimes(2);
});

test('evicting an expired image also evicts every resized version', async () => {
  const send = jest.fn(async () => signed('https://storage.test/resized')); global.fetch = send as unknown as typeof fetch;
  await batchSignUrls([ref], { width: 200 }); await batchSignUrls([ref], { width: 400 });
  _evictBatchSignEntry(ref);
  await batchSignUrls([ref], { width: 200 }); await batchSignUrls([ref], { width: 400 });
  expect(send).toHaveBeenCalledTimes(4);
});

test('token acquisition and response parsing share a bounded deadline', async () => {
  let release!: (token: string) => void;
  _setTestSignTokenProvider(() => new Promise(resolve => { release = resolve; })); global.fetch = jest.fn();
  const pending = batchSignUrls([ref]); await jest.advanceTimersByTimeAsync(MEDIA_SIGN_TIMEOUT_MS);
  expect((await pending).get(ref)).toBe(ref); release(jwt('alice')); await Promise.resolve();
  expect(global.fetch).not.toHaveBeenCalled();
  _setTestSignTokenProvider(async () => token);
  global.fetch = jest.fn(async () => ({ ok: true, json: () => new Promise(() => {}) })) as unknown as typeof fetch;
  const body = batchSignUrls([ref]); await jest.advanceTimersByTimeAsync(MEDIA_SIGN_TIMEOUT_MS);
  expect((await body).get(ref)).toBe(ref);
  expect(lastSignOutcome(ref)).toBe('unreachable');
});

function Consumer() {
  const { resolved, loading } = useHydratedMedia([ref]);
  return <Text>{loading ? 'loading' : resolved[ref]}</Text>;
}

test('the mounted hydration hook removes a prior viewer link while rechecking permission', async () => {
  global.fetch = jest.fn(async () => signed('https://storage.test/alice')) as unknown as typeof fetch;
  await render(<Consumer />);
  await act(async () => { await jest.advanceTimersByTimeAsync(0); });
  expect(screen.getByText('https://storage.test/alice')).toBeTruthy();
  let release!: (value: unknown) => void;
  global.fetch = jest.fn(() => new Promise(resolve => { release = resolve; })) as unknown as typeof fetch;
  await act(async () => { token = jwt('bob'); setDiscoveryViewerFromSession('bob'); });
  expect(screen.queryByText('https://storage.test/alice')).toBeNull();
  expect(screen.getByText('loading')).toBeTruthy();
  await act(async () => { release(signed('https://storage.test/bob')); });
  expect(screen.getByText('https://storage.test/bob')).toBeTruthy();
});
