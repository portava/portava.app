const mockStorage = new Map<string, string>();
const mockSet = jest.fn(async (key: string, value: string) => { mockStorage.set(key, value); });
const mockReadSecret = jest.fn(async (): Promise<string | null> => 'a'.repeat(64));
const mockRotate = jest.fn(async () => true);
// NOTE: exhaustive storage and secret boundary, with a durable map across module restarts. No device secret or network is accessed.
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: async (key: string) => mockStorage.get(key) ?? null, setItem: (...args: [string, string]) => mockSet(...args), removeItem: async (key: string) => { mockStorage.delete(key); } }));
jest.mock('../sensingDeviceSecret.ts', () => ({ readExistingSensingDeviceSecret: () => mockReadSecret(), rotateSensingDeviceSecret: () => mockRotate(), sensingDeviceSecret: jest.fn() }));
let service: typeof import('../sensingErasure.ts');
let scope: typeof import('../../discoveryViewerScope.ts');
let request: jest.Mock;
const originalFetch = global.fetch;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
beforeEach(() => {
  mockStorage.clear(); mockSet.mockClear(); mockSet.mockImplementation(async (key, value) => { mockStorage.set(key, value); });
  mockReadSecret.mockReset().mockResolvedValue('a'.repeat(64)); mockRotate.mockReset().mockResolvedValue(true);
  jest.isolateModules(() => { service = require('../sensingErasure.ts'); scope = require('../../discoveryViewerScope.ts'); });
  scope.setDiscoveryViewerFromSession('erase-owner'); process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test';
  request = jest.fn(async () => ({ status: 204 })); global.fetch = request;
});
afterEach(() => { global.fetch = originalFetch; });
it('pauses before I/O, erases hourly proofs with only anonymous credential, rotates only after 204, then resumes', async () => {
  const changes = jest.fn(); service.onSensingErasureChange(changes); service.registerSensingRevocationCredential(() => 'opaque-session');
  const pending = service.eraseRecentSensingContributions(); expect(changes).toHaveBeenCalledTimes(1);
  expect(await pending).toEqual({ ok: true });
  const [url, options] = request.mock.calls[0]; expect(url).toBe('https://api.example.test/api/v1/sensing/revoke');
  expect(options.headers).toEqual({ 'Content-Type': 'application/json', 'X-Sensing-Credential': 'opaque-session' });
  const body = JSON.parse(options.body); expect(Object.keys(body)).toEqual(['epochs']); expect(body.epochs).toHaveLength(73);
  expect(new Set(body.epochs.map((entry: { rotationEpoch: number }) => entry.rotationEpoch)).size).toBe(73);
  for (const entry of body.epochs) { expect(Object.keys(entry)).toEqual(['rotationEpoch', 'epochSecret']); expect(entry.epochSecret).toMatch(/^[0-9a-f]{64}$/); }
  expect(options.body).not.toContain('a'.repeat(64)); expect(options.body).not.toContain('erase-owner');
  expect(mockRotate).toHaveBeenCalledTimes(1); expect(await service.isSensingErasurePending()).toBe(false); expect(changes).toHaveBeenCalledTimes(2);
});
it('network failure retains proof material and a durable pause across restart; retry can complete', async () => {
  request.mockRejectedValueOnce(new Error('offline'));
  expect((await service.eraseRecentSensingContributions()).ok).toBe(false); expect(mockRotate).not.toHaveBeenCalled();
  expect(await service.isSensingErasurePending()).toBe(true);
  jest.isolateModules(() => { service = require('../sensingErasure.ts'); scope = require('../../discoveryViewerScope.ts'); });
  scope.setDiscoveryViewerFromSession('erase-owner'); expect(await service.isSensingErasurePending()).toBe(true);
  expect((await service.eraseRecentSensingContributions()).ok).toBe(true); expect(await service.isSensingErasurePending()).toBe(false);
});
it('missing previous secret does not mint a secret or send a request', async () => {
  mockReadSecret.mockResolvedValue(null); expect(await service.eraseRecentSensingContributions()).toEqual({ ok: true, nothingStored: true });
  expect(request).not.toHaveBeenCalled(); expect(mockRotate).not.toHaveBeenCalled();
});
it('a failed secure rotation keeps capture paused after server success', async () => {
  mockRotate.mockResolvedValue(false); expect((await service.eraseRecentSensingContributions()).ok).toBe(false);
  expect(await service.isSensingErasurePending()).toBe(true); expect(mockStorage.size).toBe(1);
});
it('cannot dispatch after an account change while loading the proof', async () => {
  let resolve!: (value: string) => void; mockReadSecret.mockReturnValue(new Promise(done => { resolve = done; }));
  const pending = service.eraseRecentSensingContributions(); await flush(); scope.setDiscoveryViewerFromSession('replacement'); resolve('a'.repeat(64));
  expect(await pending).toEqual({ ok: false, reason: 'account_changed' }); expect(request).not.toHaveBeenCalled(); expect(await service.isSensingErasurePending()).toBe(true);
});
it('does not send when the durable pause cannot be recorded', async () => {
  mockSet.mockRejectedValueOnce(new Error('storage failed'));
  expect((await service.eraseRecentSensingContributions()).ok).toBe(false); expect(request).not.toHaveBeenCalled(); expect(await service.isSensingErasurePending()).toBe(true);
});
it('refuses concurrent attempts without duplicating proof requests', async () => {
  let resolve!: (value: { status: number }) => void; request.mockReturnValue(new Promise(done => { resolve = done; }));
  const pending = service.eraseRecentSensingContributions(); await flush(); expect(await service.eraseRecentSensingContributions()).toEqual({ ok: false, reason: 'busy' });
  resolve({ status: 204 }); await pending; expect(request).toHaveBeenCalledTimes(1);
});
it('signed-out callers cannot start a deletion', async () => {
  scope.setDiscoveryViewerFromSession(null); expect(await service.eraseRecentSensingContributions()).toEqual({ ok: false, reason: 'unavailable' }); expect(request).not.toHaveBeenCalled();
});
