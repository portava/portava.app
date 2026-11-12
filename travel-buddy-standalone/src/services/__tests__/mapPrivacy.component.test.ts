// NOTE: these boundary doubles control storage, owner changes and native location
// without loading an authenticated client or contacting a location provider.
const mockStorage = new Map<string, string>();
const mockToken = jest.fn();
let mockViewer = 'u:a'; let mockEpoch = 0;
const mockPermission = jest.fn(); const mockRecent = jest.fn();
// NOTE: in-memory storage tests durable withdrawal markers without a native filesystem.
jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: { getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null), setItem: jest.fn(async (key: string, value: string) => { mockStorage.set(key,value); }), removeItem: jest.fn(async (key: string) => { mockStorage.delete(key); }) } }));
// NOTE: token refresh is controlled to exercise account changes before dispatch.
jest.mock('../apiToken', () => ({ freshToken: () => mockToken() }));
// NOTE: a mutable scope is the test's account boundary; no auth client is created.
jest.mock('../discoveryViewerScope', () => ({ currentDiscoveryScope: () => ({ viewer: mockViewer, epoch: mockEpoch }), isCurrentDiscoveryScope: (scope: { viewer: string; epoch: number }) => scope.viewer === mockViewer && scope.epoch === mockEpoch }));
// NOTE: no device sensors are accessed; permission and delayed fix outcomes are deterministic.
jest.mock('expo-location', () => ({ getForegroundPermissionsAsync: () => mockPermission(), getLastKnownPositionAsync: () => mockRecent() }));
import { contributeNavigationIntent, readMapRouteConsent, readProtectedPlaces, saveProtectedPlace, setMapRouteConsent } from '../mapPrivacy.ts';
const realFetch = globalThis.fetch;
const consent = { available: true, granted: true, current: true, disclosure: { version: 'v1' } };
const response = (value: unknown, status = 200) => ({ ok: status < 300, status, json: async () => value }) as Response;
beforeEach(() => { mockViewer = `u:owner-${++mockEpoch}`; mockStorage.clear(); mockToken.mockReset().mockResolvedValue('token'); mockPermission.mockReset().mockResolvedValue({ status: 'granted' }); mockRecent.mockReset().mockResolvedValue({ timestamp: Date.now(), coords: { latitude: 16, longitude: 108 } }); process.env.EXPO_PUBLIC_API_BASE_URL = 'https://fixture.invalid'; });
afterEach(() => { globalThis.fetch = realFetch; });
it('rounds a private center before transport and does not start native location', async () => {
  const fetcher = jest.fn(async (_url: unknown, _init?: RequestInit) => response(null, 204)); globalThis.fetch = fetcher;
  await saveProtectedPlace('home', { lat: 16.123456, lng: 108.987654 });
  const init = fetcher.mock.calls[0][1] as RequestInit;
  expect(JSON.parse(init.body as string)).toEqual({ category: 'home', lat: 16.12, lng: 108.99, radiusMeters: 1500 });
  expect(mockPermission).not.toHaveBeenCalled(); expect(mockRecent).not.toHaveBeenCalled();
});
it('account change during token resolution prevents dispatch', async () => {
  mockToken.mockImplementation(async () => { mockEpoch++; return 'old-token'; }); const fetcher = jest.fn(); globalThis.fetch = fetcher;
  await expect(readProtectedPlaces()).rejects.toThrow('Account changed'); expect(fetcher).not.toHaveBeenCalled();
});
it('failed withdrawal immediately suppresses later contributions and retains a retry marker', async () => {
  globalThis.fetch = jest.fn(async () => response(null, 503));
  await expect(setMapRouteConsent(false)).rejects.toThrow();
  globalThis.fetch = jest.fn(async () => response(consent));
  expect(await readMapRouteConsent()).toMatchObject({ granted: false, withdrawalPending: true });
  await contributeNavigationIntent({ lat: 17, lng: 109 }); expect(mockPermission).not.toHaveBeenCalled();
  await expect(setMapRouteConsent(true, 'v1')).rejects.toThrow('pending withdrawal');
});
it('contribution never prompts for missing permission or uses stale fixes', async () => {
  const fetcher = jest.fn(async () => response(consent)); globalThis.fetch = fetcher;
  mockPermission.mockResolvedValue({ status: 'denied' }); await contributeNavigationIntent({ lat: 17, lng: 109 }); expect(mockRecent).not.toHaveBeenCalled();
  mockPermission.mockResolvedValue({ status: 'granted' }); mockRecent.mockResolvedValue({ timestamp: Date.now()-61000, coords: { latitude: 16, longitude: 108 } });
  await contributeNavigationIntent({ lat: 17, lng: 109 }); expect(fetcher.mock.calls).toHaveLength(2);
});
it('a withdrawal racing the native fix prevents the queued navigation write', async () => {
  const fetcher = jest.fn(async (_url: unknown, init?: RequestInit) => init?.method === 'PUT' ? response(null,503) : response(consent)); globalThis.fetch = fetcher;
  mockRecent.mockImplementation(async () => { await setMapRouteConsent(false).catch(() => {}); return { timestamp: Date.now(), coords: { latitude: 16, longitude: 108 } }; });
  await contributeNavigationIntent({ lat: 17, lng: 109 }); expect(fetcher.mock.calls.some(call => call[1]?.method === 'POST')).toBe(false);
});
it('only an explicit consenting navigation sends a fresh two-endpoint intent', async () => {
  const fetcher = jest.fn(async (_url: unknown, init?: RequestInit) => init?.method === 'POST' ? response({ stored: true }) : response(consent)); globalThis.fetch = fetcher;
  await contributeNavigationIntent({ lat: 17, lng: 109 });
  const sent = fetcher.mock.calls.find(call => call[1]?.method === 'POST'); expect(sent).toBeDefined();
  expect(JSON.parse(sent![1]!.body as string)).toMatchObject({ origin: { lat: 16, lng: 108 }, destination: { lat: 17, lng: 109 }, displayedVersion: 'v1' });
});
