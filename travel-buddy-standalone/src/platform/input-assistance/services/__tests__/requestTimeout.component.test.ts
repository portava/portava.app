/**
 * requestSuggestions / requestMapSearchPage — a HUNG gateway is an UNAVAILABLE
 * gateway. census-discovery §80 follow-up, register D-W10-S1-4 ("The timeout").
 *
 * E-9 made the legacy typeahead run only while the gateway reports
 * `unavailable`. With no timeout, a gateway that accepted the connection and
 * never answered was never `unavailable`: the fallback never started and the
 * spinner stayed. The request now gives up after SUGGEST_TIMEOUT_MS, and that
 * outcome is `unavailable` (§38's signal), distinct from the caller's own abort
 * of a superseded keystroke, which stays `aborted` and never flips the field.
 *
 * Run with: pnpm test:component
 */

// NOTE: exhaustive — the real token helper reaches the Supabase client.
const mockToken = jest.fn<Promise<string | null>, []>();
jest.mock('../../../../services/apiToken.ts', () => ({ freshToken: () => mockToken() }));
import { fetchInputPolicies } from '../policyClient.ts';
import { _resetDiscoveryViewerScopeForTests, setDiscoveryViewerFromSession } from '../../../../services/discoveryViewerScope.ts';

import {
  requestSuggestions,
  requestMapSearchPage,
  SUGGEST_TIMEOUT_MS,
} from '../inputAssistance.ts';

/** A fetch that never answers, and rejects only when its signal aborts. */
function hangingFetch() {
  return jest.fn((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const e = new Error('The operation was aborted.');
        e.name = 'AbortError';
        reject(e);
      });
    }),
  );
}

const REQ = { context: 'global_search' as const, fieldId: 'test.timeout', text: 'tokyo' };

beforeEach(() => {
  jest.useFakeTimers();
  mockToken.mockReset().mockResolvedValue('tok');
  _resetDiscoveryViewerScopeForTests();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
});
afterEach(() => {
  jest.useRealTimers();
});

test('the budget is a decided number, not an accident', () => {
  expect(SUGGEST_TIMEOUT_MS).toBe(5000);
});

test('a hung suggest request becomes UNAVAILABLE after the budget, not a forever spinner', async () => {
  (global as any).fetch = hangingFetch();
  const pending = requestSuggestions(REQ);
  let settled: unknown = null;
  void pending.then((r) => { settled = r; });
  await jest.advanceTimersByTimeAsync(SUGGEST_TIMEOUT_MS - 1);
  expect(settled).toBeNull();
  await jest.advanceTimersByTimeAsync(1);
  const res = await pending;
  expect(res).toMatchObject({ ok: false, aborted: false, unavailable: true });
});

test("the caller's own abort (a superseded keystroke) stays ABORTED, not unavailable", async () => {
  (global as any).fetch = hangingFetch();
  const ctrl = new AbortController();
  const pending = requestSuggestions(REQ, ctrl.signal);
  await jest.advanceTimersByTimeAsync(10);
  ctrl.abort();
  const res = await pending;
  expect(res).toMatchObject({ ok: false, aborted: true, unavailable: false });
});

test('a hung Map search page resolves to an error line after the budget', async () => {
  (global as any).fetch = hangingFetch();
  const pending = requestMapSearchPage('kopitiam', {});
  await jest.advanceTimersByTimeAsync(SUGGEST_TIMEOUT_MS);
  const res = await pending;
  expect(res).toEqual({ ok: false, error: 'Network error — check your connection' });
});

test('CONTROL: a prompt answer is served, and no timer is left behind', async () => {
  (global as any).fetch = jest.fn(async () => ({
    ok: true, status: 200, json: async () => ({ requestId: 'r', policyVersion: 'p', suggestions: [] }),
  }));
  const res = await requestSuggestions(REQ);
  expect(res.ok).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});

test('a stalled sign-in cannot keep the suggestion, map or policy request alive or send late text', async () => {
  const resolvers: Array<(token: string) => void> = [];
  mockToken.mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
  const send = jest.fn();
  global.fetch = send;
  const attempts = [requestSuggestions(REQ), requestMapSearchPage('test city'), fetchInputPolicies()];
  await jest.advanceTimersByTimeAsync(SUGGEST_TIMEOUT_MS);
  const [suggest, map, policy] = await Promise.all(attempts);
  expect(suggest).toMatchObject({ ok: false, aborted: false, unavailable: true });
  expect(map.ok).toBe(false);
  expect(policy).toMatchObject({ ok: false, unavailable: true });
  resolvers.forEach(resolve => resolve('late-token'));
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
});

test('superseding input or switching accounts during token lookup sends no retired query', async () => {
  let resolveToken!: (token: string) => void;
  mockToken.mockImplementation(() => new Promise(resolve => { resolveToken = resolve; }));
  const send = jest.fn(); global.fetch = send;
  const controller = new AbortController();
  const old = requestSuggestions(REQ, controller.signal);
  controller.abort();
  expect(await old).toMatchObject({ ok: false, aborted: true });
  const moved = requestSuggestions(REQ);
  setDiscoveryViewerFromSession('other');
  resolveToken('other-token');
  expect(await moved).toMatchObject({ ok: false, aborted: true });
  expect(send).not.toHaveBeenCalled();
});

test('a stalled response body and a temporarily unavailable gateway activate fallback', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, json: () => new Promise(() => {}) })) as unknown as typeof fetch;
  const attempt = requestSuggestions(REQ);
  await jest.advanceTimersByTimeAsync(SUGGEST_TIMEOUT_MS);
  expect(await attempt).toMatchObject({ ok: false, unavailable: true });
  global.fetch = jest.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
  expect(await requestSuggestions(REQ)).toMatchObject({ ok: false, unavailable: true });
});
