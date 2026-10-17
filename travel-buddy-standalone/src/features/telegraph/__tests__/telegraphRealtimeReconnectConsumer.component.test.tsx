import { useEffect } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react-native';

jest.mock('@supabase/supabase-js', () => ({
  ...jest.requireActual('@supabase/supabase-js'),
  createClient: jest.fn(() => ({})),
}));

import { telegraphRealtime } from '../../../services/telegraphRealtimeService.ts';
import { _setTestSupabase, _resetTestSupabase } from '../../../services/apiToken.ts';
import { useReconnectCatchUp } from '../hooks/useReconnectCatchUp.ts';

const originalXHR = global.XMLHttpRequest;
const originalFetch = global.fetch;
const originalApi = process.env.EXPO_PUBLIC_API_BASE_URL;
const stops: Array<() => void> = [];
const instances: TestXHR[] = [];

class TestXHR {
  readyState = 0;
  status = 0;
  responseText = '';
  onreadystatechange: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  constructor() { instances.push(this); }
  open() {}
  setRequestHeader() {}
  send() {}
  abort() {}
  opened(callback = this.onreadystatechange) { this.readyState = 2; this.status = 200; callback?.(); }
}

beforeEach(() => {
  jest.useFakeTimers();
  instances.length = 0;
  stops.length = 0;
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://127.0.0.1:9';
  global.XMLHttpRequest = TestXHR as unknown as typeof XMLHttpRequest;
  global.fetch = jest.fn(async () => { throw new Error('No network'); });
  _setTestSupabase({ auth: {
    getSession: async () => ({ data: { session: { access_token: 'same-owner-token', expires_at: 4_000_000_000 } } }),
    refreshSession: async () => ({ data: { session: null } }),
  } });
});

afterEach(async () => {
  await cleanup();
  for (const stop of stops) stop();
  jest.clearAllTimers();
  jest.useRealTimers();
  _resetTestSupabase();
  expect(global.fetch).not.toHaveBeenCalled();
  global.fetch = originalFetch;
  global.XMLHttpRequest = originalXHR;
  if (originalApi === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalApi;
});

it('an obsolete XHR must not trigger the mounted actual reconnect catch-up hook', async () => {
  const catchUp = jest.fn();
  await renderHook(() => useReconnectCatchUp(catchUp));
  await act(async () => { stops.push(telegraphRealtime.subscribe(() => {})); });
  await act(async () => { instances[0].opened(); });
  expect(catchUp).not.toHaveBeenCalled();
  const retired = instances[0];
  const retiredReady = retired.onreadystatechange;
  await act(async () => { retired.onerror?.(); });
  await act(async () => { await jest.advanceTimersByTimeAsync(2000); });
  expect(instances).toHaveLength(2);
  expect(telegraphRealtime.getStatus()).toBe('connecting');
  await act(async () => { retired.opened(retiredReady); });
  expect(catchUp).not.toHaveBeenCalled();
});

it('the current replacement opening triggers the mounted hook exactly once', async () => {
  const catchUp = jest.fn();
  await renderHook(() => useReconnectCatchUp(catchUp));
  await act(async () => { stops.push(telegraphRealtime.subscribe(() => {})); });
  await act(async () => { instances[0].opened(); });
  expect(catchUp).not.toHaveBeenCalled();
  await act(async () => { instances[0].onerror?.(); });
  await act(async () => { await jest.advanceTimersByTimeAsync(2000); });
  await act(async () => { instances[1].opened(); instances[1].opened(); });
  expect(catchUp).toHaveBeenCalledTimes(1);
});

it('delivers current frames but not retired frames after an actual hook consumer remount', async () => {
  const catchUp = jest.fn();
  const previousEvents = jest.fn();
  const previous = await renderHook(() => {
    useReconnectCatchUp(catchUp);
    useEffect(() => telegraphRealtime.subscribe(previousEvents), []);
  });
  const retired = instances[0];
  const retiredReady = retired.onreadystatechange;
  await act(async () => {
    retired.readyState = 3;
    retired.status = 200;
    retired.responseText = 'data: {"type":"message.created","payload":{"marker":"first"}}\n\n';
    retiredReady?.();
  });
  expect(previousEvents).toHaveBeenCalledTimes(1);
  await previous.unmount();
  const currentEvents = jest.fn();
  await renderHook(() => {
    useReconnectCatchUp(catchUp);
    useEffect(() => telegraphRealtime.subscribe(currentEvents), []);
  });
  await act(async () => {
    retired.responseText += 'data: {"type":"typing.started","payload":{"marker":"retired"}}\n\n';
    retiredReady?.();
  });
  expect(currentEvents).not.toHaveBeenCalled();
  expect(catchUp).not.toHaveBeenCalled();
  await act(async () => {
    const current = instances[1];
    current.readyState = 3;
    current.status = 200;
    current.responseText = 'data: {"type":"message.created","payload":{"marker":"current"}}\n\n';
    current.onreadystatechange?.();
  });
  expect(currentEvents).toHaveBeenCalledTimes(1);
  expect(currentEvents.mock.calls[0][0].payload.marker).toBe('current');
});

it('preserves the disabled catch-up hook while the current stream reconnects', async () => {
  const catchUp = jest.fn();
  await renderHook(() => useReconnectCatchUp(catchUp, false));
  await act(async () => { stops.push(telegraphRealtime.subscribe(() => {})); });
  await act(async () => { instances[0].opened(); instances[0].onerror?.(); });
  await act(async () => { await jest.advanceTimersByTimeAsync(2000); });
  await act(async () => { instances[1].opened(); });
  expect(catchUp).not.toHaveBeenCalled();
});
