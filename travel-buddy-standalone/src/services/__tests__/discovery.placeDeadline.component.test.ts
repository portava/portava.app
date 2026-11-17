import { getDiscoveryPlaces, getCommunityPlaces, _setDiscoveryTokenSourceForTests, DISCOVERY_FEED_TIMEOUT_MS } from '../discovery.ts';
import { _resetDiscoveryViewerScopeForTests } from '../discoveryViewerScope.ts';

const realFetch = globalThis.fetch;
const realBase = process.env.EXPO_PUBLIC_API_BASE_URL;
beforeEach(() => {
  jest.useFakeTimers();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  _resetDiscoveryViewerScopeForTests();
  _setDiscoveryTokenSourceForTests(async () => null);
});
afterEach(() => {
  jest.useRealTimers(); globalThis.fetch = realFetch;
  _setDiscoveryTokenSourceForTests(null);
  if (realBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = realBase;
});

const reads = {
  places: () => getDiscoveryPlaces('Da Nang', 'for_you', { radiusKm: 25, openNow: false, minRating: null }),
  community: () => getCommunityPlaces('Da Nang'),
};
for (const [name, read] of Object.entries(reads)) {
  it.each(['token', 'headers', 'body'])(`${name}: a stalled %s stops loading and can be retried`, async stage => {
    let finishToken!: (value: null) => void;
    if (stage === 'token') _setDiscoveryTokenSourceForTests(() => new Promise(resolve => { finishToken = resolve; }));
    globalThis.fetch = jest.fn(stage === 'headers' ? () => new Promise<Response>(() => {}) : async () => ({
      ok: true, json: () => new Promise(() => {}),
    } as Response));
    const pending = read();
    await jest.advanceTimersByTimeAsync(DISCOVERY_FEED_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ ok: false, error: 'Places took too long to load. Try again.' });
    if (stage === 'token') {
      finishToken(null); await Promise.resolve(); await Promise.resolve();
      expect(fetch).not.toHaveBeenCalled();
    } else expect(jest.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
    _setDiscoveryTokenSourceForTests(async () => null);
    globalThis.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ places: [], items: [], city: 'Da Nang', total: 0 }) } as Response));
    expect((await read()).ok).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
}
