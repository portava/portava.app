// NOTE: exhaustive auth boundary; these tests exercise the real budget and viewer scope without a native auth client.
jest.mock('../../../../services/apiToken.ts', () => ({ freshToken: () => mockToken() }));
// NOTE: exhaustive auth subscription seam; prevents native session initialization in the locator unit fixture.
jest.mock('../../../../services/auth.ts', () => ({ onAuthChange: jest.fn(), getSessionUserId: jest.fn() }));
// NOTE: exhaustive native-location adapter; no permission prompt or device GPS is available in Jest.
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, getForegroundPermissionsAsync: () => mockPermission(), getCurrentPositionAsync: () => mockPosition() }));
const mockToken = jest.fn();
const mockPermission = jest.fn();
const mockPosition = jest.fn();
import { createDeviceLocator } from '../deviceLocator.ts';
const expoDeviceLocator = createDeviceLocator(async () => jest.requireMock('expo-location'));

import { _resetDiscoveryViewerScopeForTests, setDiscoveryViewerFromSession } from '../../../../services/discoveryViewerScope.ts';

const oldBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const oldFetch = globalThis.fetch;
beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks(); _resetDiscoveryViewerScopeForTests();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  mockToken.mockResolvedValue('synthetic'); mockPermission.mockResolvedValue({ status: 'granted' });
  mockPosition.mockResolvedValue({ coords: { latitude: 16, longitude: 108 } });
  globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ place: { district: 'Hai Chau', city: 'Da Nang' } }) });
});
afterEach(() => {
  jest.useRealTimers(); globalThis.fetch = oldFetch; _resetDiscoveryViewerScopeForTests();
  if (oldBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL; else process.env.EXPO_PUBLIC_API_BASE_URL = oldBase;
});

it('reads only an already permitted position and returns a coarse label through a secure request', async () => {
  expect(await expoDeviceLocator.permission()).toBe('granted');
  expect(await expoDeviceLocator.currentLabel()).toBe('Hai Chau, Da Nang');
  expect(fetch).toHaveBeenCalledWith('https://api.test/api/location/reverse-geocode', expect.objectContaining({ redirect: 'error', credentials: 'omit' }));
  mockPermission.mockResolvedValue({ status: 'denied' }); mockPosition.mockClear();
  expect(await expoDeviceLocator.currentLabel()).toBeNull(); expect(mockPosition).not.toHaveBeenCalled();
});

it('rejects unsafe origins before reading position and bounds stalled GPS', async () => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test@evil.test';
  expect(await expoDeviceLocator.currentLabel()).toBeNull(); expect(mockPosition).not.toHaveBeenCalled();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  mockPosition.mockImplementation(() => new Promise(() => {}));
  const pending = expoDeviceLocator.currentLabel();
  await jest.advanceTimersByTimeAsync(15001);
  expect(await pending).toBeNull(); expect(mockPosition).toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it('cannot send a position resolved after the account changes', async () => {
  let resolve!: (value: unknown) => void;
  mockPosition.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const pending = expoDeviceLocator.currentLabel();
  await jest.advanceTimersByTimeAsync(0);
  setDiscoveryViewerFromSession('another-owner');
  resolve({ coords: { latitude: 16, longitude: 108 } });
  expect(await pending).toBeNull(); expect(mockPosition).toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
