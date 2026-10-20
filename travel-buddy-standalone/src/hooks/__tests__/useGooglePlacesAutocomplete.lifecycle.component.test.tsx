import { act, renderHook } from '@testing-library/react-native';
import { useGooglePlacesAutocomplete } from '../useGooglePlacesAutocomplete.ts';
import type { Place } from '../../lib/location/placeTypes.ts';

type SearchProps = { query: string; options: NonNullable<Parameters<typeof useGooglePlacesAutocomplete>[1]> };
const originalFetch = global.fetch;
const mockFetch = jest.fn();
const initial: SearchProps = { query: 'Paris', options: { countryCode: 'FR', type: 'city' } };
const currentPlace: Place = {
  id: 'fixture-paris', name: 'Paris', displayName: 'Paris', type: 'city', country: 'France', countryCode: 'FR',
  city: 'Paris', region: null, district: null, lat: null, lng: null, timezone: null, source: 'google',
};

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function response(places: Place[]) {
  return { ok: true, json: async () => ({ places }) } as Response;
}

async function advance() {
  await act(async () => { jest.advanceTimersByTime(300); });
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

describe('Google place autocomplete lifecycle', () => {
  it.each(['', 'P'])('withholds late results for disabled query %j', async (query) => {
    const pending = deferred<Response>();
    mockFetch.mockReturnValueOnce(pending.promise);
    const hook = await renderHook((value: SearchProps) => useGooglePlacesAutocomplete(value.query, value.options), { initialProps: initial });
    await advance();
    const signal = mockFetch.mock.calls[0][1].signal as AbortSignal;
    await hook.rerender({ ...initial, query });
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(response([currentPlace])); });
    expect(hook.result.current).toEqual({ places: [], loading: false });
  });

  it.each([{ countryCode: 'US' }, { type: 'all' as const }])('clears completed results when scope changes %j', async (changed) => {
    mockFetch.mockResolvedValueOnce(response([currentPlace])).mockResolvedValueOnce(response([]));
    const hook = await renderHook((value: SearchProps) => useGooglePlacesAutocomplete(value.query, value.options), { initialProps: initial });
    await advance();
    expect(hook.result.current.places).toEqual([currentPlace]);
    await hook.rerender({ ...initial, options: { ...initial.options, ...changed } });
    expect(hook.result.current).toEqual({ places: [], loading: true });
    await advance();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const url = new URL(mockFetch.mock.calls[1][0], 'https://fixture.invalid');
    expect(url.searchParams.get('countryCode')).toBe(changed.countryCode ?? 'FR');
    expect(url.searchParams.get('type')).toBe(changed.type === 'all' ? null : 'city');
    expect(hook.result.current).toEqual({ places: [], loading: false });
  });

  it('ignores old successes and loading completion while a replacement is pending', async () => {
    const old = deferred<Response>();
    const current = deferred<Response>();
    mockFetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const hook = await renderHook((value: SearchProps) => useGooglePlacesAutocomplete(value.query, value.options), { initialProps: initial });
    await advance();
    await hook.rerender({ ...initial, query: 'Lyon' });
    await advance();
    await act(async () => { old.resolve(response([currentPlace])); });
    expect(hook.result.current).toEqual({ places: [], loading: true });
    await act(async () => { current.resolve(response([])); });
    expect(hook.result.current).toEqual({ places: [], loading: false });
  });

  it('does not let an old failure erase a newer successful answer', async () => {
    const old = deferred<Response>();
    mockFetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response([currentPlace]));
    const hook = await renderHook((value: SearchProps) => useGooglePlacesAutocomplete(value.query, value.options), { initialProps: initial });
    await advance();
    await hook.rerender({ ...initial, query: 'Paris France' });
    await advance();
    await act(async () => { old.reject(new Error('old transport')); });
    expect(hook.result.current).toEqual({ places: [currentPlace], loading: false });
  });

  it('rechecks ownership after response-body parsing', async () => {
    const body = deferred<{ places: Place[] }>();
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => body.promise });
    const hook = await renderHook((value: SearchProps) => useGooglePlacesAutocomplete(value.query, value.options), { initialProps: initial });
    await advance();
    await hook.rerender({ ...initial, query: '' });
    await act(async () => { body.resolve({ places: [currentPlace] }); });
    expect(hook.result.current).toEqual({ places: [], loading: false });
  });

  it('aborts on unmount without cancelling another mounted request', async () => {
    const old = deferred<Response>();
    mockFetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response([currentPlace]));
    const first = await renderHook(() => useGooglePlacesAutocomplete(initial.query, initial.options));
    await advance();
    const signal = mockFetch.mock.calls[0][1].signal as AbortSignal;
    await first.unmount();
    expect(signal.aborted).toBe(true);
    const second = await renderHook(() => useGooglePlacesAutocomplete(initial.query, initial.options));
    await advance();
    await act(async () => { old.resolve(response([])); });
    expect(second.result.current).toEqual({ places: [currentPlace], loading: false });
  });

  it('keeps current provider failure as an empty completed fallback', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const hook = await renderHook(() => useGooglePlacesAutocomplete(initial.query, initial.options));
    await advance();
    expect(hook.result.current).toEqual({ places: [], loading: false });
  });

  it('cancels a superseded debounce before sending', async () => {
    const hook = await renderHook((value: SearchProps) => useGooglePlacesAutocomplete(value.query, value.options), { initialProps: initial });
    await hook.rerender({ ...initial, query: '' });
    await advance();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
