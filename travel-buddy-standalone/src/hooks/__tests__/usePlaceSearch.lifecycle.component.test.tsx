import { act, renderHook } from '@testing-library/react-native';
import { usePlaceSearch } from '../usePlaceSearch.ts';
import { getCached, makeCacheKey, setCached, setInFlight, deleteInFlight } from '../../lib/location/placeSearchCache.ts';
import type { Place } from '../../lib/location/placeTypes.ts';

type SearchOptions = NonNullable<Parameters<typeof usePlaceSearch>[1]>;
type SearchProps = { query: string; options: SearchOptions };

const originalFetch = global.fetch;
const mockFetch = jest.fn();
let sequence = 0;

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function place(name: string): Place {
  return {
    id: name, name, displayName: name, type: 'city', country: 'United States', countryCode: 'US',
    region: null, city: name, district: null, lat: 1, lng: 2, timezone: null, source: 'canonical',
  };
}

function response(places: Place[]) {
  return { ok: true, json: async () => ({ places }) } as Response;
}

function props(): SearchProps {
  sequence += 1;
  return { query: `lifecycle-${sequence}`, options: { countryCode: 'US', type: 'city', lat: 1, lng: 2 } };
}

async function advance() {
  await act(async () => { jest.advanceTimersByTime(350); });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockFetch.mockReset();
  global.fetch = mockFetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});

describe('place search request ownership', () => {
  it.each([
    { countryCode: 'FR' }, { type: 'airport' }, { lat: 20 }, { lng: 30 },
  ])('starts a new request for changed options %j without changing text', async (changed) => {
    const initial = props();
    mockFetch.mockResolvedValue(response([place('old')]));
    const hook = await renderHook((value: SearchProps) => usePlaceSearch(value.query, value.options), { initialProps: initial });
    await advance();
    expect(hook.result.current.results).toEqual([place('old')]);
    mockFetch.mockResolvedValue(response([place('new')]));
    const next = { ...initial, options: { ...initial.options, ...changed } };
    await hook.rerender(next);
    expect(hook.result.current.results).toEqual([]);
    expect(hook.result.current.loading).toBe(true);
    await advance();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const url = new URL(mockFetch.mock.calls[1][0], 'https://fixture.invalid');
    for (const [key, value] of Object.entries(changed)) expect(url.searchParams.get(key)).toBe(String(value));
    expect(hook.result.current.results).toEqual([place('new')]);
  });

  it('ignores a superseded success and prevents its cache write', async () => {
    const initial = props();
    const old = deferred<Response>();
    const current = deferred<Response>();
    mockFetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const hook = await renderHook((value: SearchProps) => usePlaceSearch(value.query, value.options), { initialProps: initial });
    await advance();
    const signal = mockFetch.mock.calls[0][1].signal as AbortSignal;
    await hook.rerender({ ...initial, query: `${initial.query}-new` });
    expect(signal.aborted).toBe(true);
    await advance();
    await act(async () => { old.resolve(response([place('stale')])); });
    expect(hook.result.current).toEqual({ results: [], loading: true, error: null });
    expect(getCached(makeCacheKey(initial.query, initial.options))).toBeNull();
    await act(async () => { current.resolve(response([place('current')])); });
    expect(hook.result.current).toEqual({ results: [place('current')], loading: false, error: null });
  });

  it('ignores superseded failure while the new request is pending', async () => {
    const initial = props();
    const old = deferred<Response>();
    const current = deferred<Response>();
    mockFetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const hook = await renderHook((value: SearchProps) => usePlaceSearch(value.query, value.options), { initialProps: initial });
    await advance();
    await hook.rerender({ ...initial, query: `${initial.query}-new` });
    await advance();
    await act(async () => { old.reject(new Error('old network failure')); });
    expect(hook.result.current).toEqual({ results: [], loading: true, error: null });
    await act(async () => { current.resolve(response([place('current')])); });
    expect(hook.result.current.error).toBeNull();
  });

  it('does not restore results after the query is cleared', async () => {
    const initial = props();
    const pending = deferred<Response>();
    mockFetch.mockReturnValueOnce(pending.promise);
    const hook = await renderHook((value: SearchProps) => usePlaceSearch(value.query, value.options), { initialProps: initial });
    await advance();
    await hook.rerender({ ...initial, query: '' });
    await act(async () => { pending.resolve(response([place('stale')])); });
    expect(hook.result.current).toEqual({ results: [], loading: false, error: null });
    expect(getCached(makeCacheKey(initial.query, initial.options))).toBeNull();
  });

  it('does not replace a new warm-cache answer with the old response', async () => {
    const initial = props();
    const pending = deferred<Response>();
    mockFetch.mockReturnValueOnce(pending.promise);
    const nextQuery = `${initial.query}-warm`;
    setCached(makeCacheKey(nextQuery, initial.options), [place('warm')]);
    const hook = await renderHook((value: SearchProps) => usePlaceSearch(value.query, value.options), { initialProps: initial });
    await advance();
    await hook.rerender({ ...initial, query: nextQuery });
    expect(hook.result.current.results).toEqual([place('warm')]);
    await act(async () => { pending.resolve(response([place('stale')])); });
    expect(hook.result.current).toEqual({ results: [place('warm')], loading: false, error: null });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('aborts its transport and refuses late cache writes after unmount', async () => {
    const initial = props();
    const pending = deferred<Response>();
    mockFetch.mockReturnValueOnce(pending.promise);
    const hook = await renderHook(() => usePlaceSearch(initial.query, initial.options));
    await advance();
    const signal = mockFetch.mock.calls[0][1].signal as AbortSignal;
    await hook.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(response([place('stale')])); });
    expect(getCached(makeCacheKey(initial.query, initial.options))).toBeNull();
  });

  it('checks ownership again after response-body parsing', async () => {
    const initial = props();
    const body = deferred<{ places: Place[] }>();
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => body.promise });
    const hook = await renderHook((value: SearchProps) => usePlaceSearch(value.query, value.options), { initialProps: initial });
    await advance();
    await hook.rerender({ ...initial, query: '' });
    await act(async () => { body.resolve({ places: [place('stale')] }); });
    expect(hook.result.current.results).toEqual([]);
    expect(getCached(makeCacheKey(initial.query, initial.options))).toBeNull();
  });

  it('fences a shared request without cancelling another consumer', async () => {
    const initial = props();
    const shared = deferred<Place[]>();
    const key = makeCacheKey(initial.query, initial.options);
    setInFlight(key, shared.promise);
    try {
      const first = await renderHook((value: SearchProps) => usePlaceSearch(value.query, value.options), { initialProps: initial });
      const second = await renderHook(() => usePlaceSearch(initial.query, initial.options));
      await advance();
      await first.rerender({ ...initial, query: '' });
      await act(async () => { shared.resolve([place('shared')]); });
      expect(first.result.current).toEqual({ results: [], loading: false, error: null });
      expect(second.result.current).toEqual({ results: [place('shared')], loading: false, error: null });
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      deleteInFlight(key);
    }
  });

  it('preserves current failure feedback and explicit retry', async () => {
    const initial = props();
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce(response([place('retried')]));
    const hook = await renderHook((value: SearchProps) => usePlaceSearch(value.query, value.options), { initialProps: initial });
    await advance();
    expect(hook.result.current).toEqual({ results: [], loading: false, error: 'Location search unavailable.' });
    await hook.rerender({ ...initial, options: { ...initial.options, refreshKey: 1 } });
    expect(hook.result.current.error).toBeNull();
    await advance();
    expect(hook.result.current).toEqual({ results: [place('retried')], loading: false, error: null });
  });

  it.each([Object.assign(new Error('aborted'), { name: 'AbortError' }), { name: 'AbortError' }])('preserves silent abort handling for %j', async (error) => {
    const initial = props();
    mockFetch.mockRejectedValueOnce(error);
    const hook = await renderHook(() => usePlaceSearch(initial.query, initial.options));
    await advance();
    expect(hook.result.current).toEqual({ results: [], loading: false, error: null });
  });

  it('cancels debounced requests before the transport starts', async () => {
    const initial = props();
    const hook = await renderHook((value: SearchProps) => usePlaceSearch(value.query, value.options), { initialProps: initial });
    await hook.rerender({ ...initial, query: '' });
    await advance();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(hook.result.current.loading).toBe(false);
  });
});
