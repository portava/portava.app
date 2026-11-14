import { withServiceRequest } from '../serviceRequest.ts';
import { _resetDiscoveryViewerScopeForTests, noteDiscoveryViewer } from '../discoveryViewerScope.ts';

const never = <T>(): Promise<T> => new Promise(() => {});
const response = (json: () => Promise<unknown>) => ({ ok: true, status: 200, json });
const originalFetch = globalThis.fetch;
beforeEach(() => { _resetDiscoveryViewerScopeForTests(); jest.useFakeTimers(); });
afterEach(() => { globalThis.fetch = originalFetch; jest.useRealTimers(); });

it('bounds token refresh and never starts a late write', async () => {
  let token!: (v: string) => void;
  globalThis.fetch = jest.fn();
  const result = withServiceRequest(async (r) => {
    await r.token(() => new Promise<string>((resolve) => { token = resolve; }));
    return r.fetch('https://api.test/api/events', { method: 'POST' });
  }, { timeoutMs: 30 }).catch((e) => e);
  await jest.advanceTimersByTimeAsync(31);
  expect((await result).name).toBe('TimeoutError');
  token('token'); await Promise.resolve();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it('uses one deadline for headers and body, even if the transport ignores abort', async () => {
  globalThis.fetch = jest.fn(async () => { await new Promise((r) => setTimeout(r, 20)); return response(() => never()); }) as any;
  const result = withServiceRequest(async (r) => (await r.fetch('https://api.test/api/wall')).json(), { timeoutMs: 30 }).catch((e) => e);
  await jest.advanceTimersByTimeAsync(31);
  expect((await result).name).toBe('TimeoutError');
  expect(jest.getTimerCount()).toBe(0);
});
it('cancels a body read and does not retry a mutation', async () => {
  const cancel = new AbortController();
  globalThis.fetch = jest.fn(async () => response(() => never())) as any;
  const result = withServiceRequest(async (r) => (await r.fetch('https://api.test/api/events', { method: 'POST' })).json(), { signal: cancel.signal }).catch((e) => e);
  await jest.advanceTimersByTimeAsync(0); cancel.abort();
  expect((await result).name).toBe('AbortError');
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});
it('rejects a late private result after the viewer changes', async () => {
  let resolve!: (v: unknown) => void;
  globalThis.fetch = jest.fn(async () => response(() => new Promise((r) => { resolve = r; }))) as any;
  const result = withServiceRequest(async (r) => (await r.fetch('https://api.test/api/trips/me')).json()).catch((e) => e);
  await jest.advanceTimersByTimeAsync(0); noteDiscoveryViewer('u:another'); resolve({ trips: ['private'] });
  expect((await result).message).toMatch(/account|visibility/);
});
it('does not send an already cancelled request', async () => {
  const cancel = new AbortController(); cancel.abort(); globalThis.fetch = jest.fn();
  await expect(withServiceRequest((r) => r.fetch('https://api.test/api/stamps'), { signal: cancel.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it('refuses redirected responses', async () => {
  globalThis.fetch = jest.fn(async () => ({ ...response(async () => ({})), redirected: true })) as any;
  await expect(withServiceRequest((r) => r.fetch('https://api.test/api/stamps'))).rejects.toThrow('redirected');
});
it('keeps successful JSON responses and clears its timer', async () => {
  globalThis.fetch = jest.fn(async () => response(async () => ({ objects: [] }))) as any;
  expect(await withServiceRequest(async (r) => (await r.fetch('https://api.test/api/map/projection')).json())).toEqual({ objects: [] });
  expect(jest.getTimerCount()).toBe(0);
});
