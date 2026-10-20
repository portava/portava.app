import type { SensingCaptureHandle } from '../sensingCapture.ts';
import { ACOUSTIC_PERMISSION_STORAGE_KEY, acousticCaptureAllowed } from '../../../lib/sensing/acousticPermission.ts';

const mockStorage = new Map<string, string>();
const mockGet = jest.fn(async (key: string) => mockStorage.get(key) ?? null);
const mockSet = jest.fn(async (key: string, value: string) => { mockStorage.set(key, value); });
const mockOsRead = jest.fn(async () => ({ granted: true }));
const mockOsRequest = jest.fn(async () => ({ granted: true }));
const mockConsentListeners = new Set<() => void>();
const mockReadConsent = jest.fn(async () => consent(true, true));
const mockSubmit = jest.fn(async (_payload: unknown) => ({ ok: true }));
const mockReset = jest.fn();
const mockMeterStop = jest.fn();
const mockLocationCallbacks = new Set<(sample: unknown) => void>();
const mockMeterCallbacks = new Set<(sample: unknown) => void>();
const mockCaptures: SensingCaptureHandle[] = [];
let mockForeground: ((state: string) => void) | null = null;
const mockRemoveForeground = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () => ({
  ...jest.requireActual('@react-native-async-storage/async-storage'),
  getItem: (key: string) => mockGet(key), setItem: (key: string, value: string) => mockSet(key, value),
}));
/** NOTE: Exhaustive native boundary; importing Expo AV requires the unavailable ExponentAV device module. */
jest.mock('expo-av', () => ({
  Audio: { getPermissionsAsync: () => mockOsRead(), requestPermissionsAsync: () => mockOsRequest() },
}));
jest.mock('react-native', () => {
  const native = jest.requireActual('react-native');
  return Object.defineProperty(Object.create(native), 'AppState', { value: { ...native.AppState, addEventListener: (_event: string, callback: (state: string) => void) => {
    mockForeground = callback;
    return { remove: mockRemoveForeground };
  } } });
});
jest.mock('../../sensingConsent.ts', () => ({
  ...jest.requireActual('../../sensingConsent.ts'),
  readSensingConsent: () => mockReadConsent(),
  onSensingConsentChange: (callback: () => void) => { mockConsentListeners.add(callback); return () => mockConsentListeners.delete(callback); },
}));
jest.mock('../../apiToken.ts', () => ({ ...jest.requireActual('../../apiToken.ts'), freshToken: async () => 'synthetic-token' }));
jest.mock('../sensingTransport.ts', () => ({
  ...jest.requireActual('../sensingTransport.ts'), createSensingTransport: () => ({ submit: mockSubmit, reset: mockReset }),
}));
jest.mock('../deviceSensorSources.ts', () => ({
  ...jest.requireActual('../deviceSensorSources.ts'), createDeviceMotionSource: () => null,
  createDeviceLocationSource: () => ({ subscribe: (callback: (sample: unknown) => void) => {
    mockLocationCallbacks.add(callback); return () => mockLocationCallbacks.delete(callback);
  } }),
}));
jest.mock('../acousticMeterSource.ts', () => ({
  ...jest.requireActual('../acousticMeterSource.ts'),
  createAcousticMeterSource: (permission: Parameters<typeof acousticCaptureAllowed>[0]) => {
    if (!jest.requireActual('../../../lib/sensing/acousticPermission.ts').acousticCaptureAllowed(permission)) return null;
    return { subscribe: (callback: (sample: unknown) => void) => {
      mockMeterCallbacks.add(callback);
      return () => { mockMeterCallbacks.delete(callback); mockMeterStop(); };
    } };
  },
}));
jest.mock('../sensingCapture.ts', () => ({
  ...jest.requireActual('../sensingCapture.ts'),
  startSensingCapture: (deps: unknown) => {
    const handle = jest.requireActual('../sensingCapture.ts').startSensingCapture(deps);
    mockCaptures.push(handle);
    return handle;
  },
}));

let permissions: typeof import('../acousticSensingPermission.ts');
let installSensingCapture: typeof import('../installSensingCapture.ts').installSensingCapture;
let installations: Array<{ dispose(): void }>;
function consent(capture: boolean, upload: boolean) {
  return { status: 'ok', state: { consents: {
    capture: { effective: capture }, upload: { effective: upload }, surface: { effective: false },
  } } };
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => { resolve = done; });
  return { promise, resolve };
}
async function settle() { for (let turn = 0; turn < 60; turn += 1) await Promise.resolve(); }
async function install(granted = true) {
  if (granted) await permissions.requestAcousticSensingPermission();
  const installation = installSensingCapture();
  installations.push(installation);
  await settle();
  return installation;
}
async function window() {
  const started = Date.now();
  for (let index = 0; index < 20; index += 1) {
    for (const callback of mockLocationCallbacks) callback({ t: started + index * 1000, lat: 40.75, lng: -73.98, accuracyM: 10, speedMps: 0 });
    for (const callback of mockMeterCallbacks) callback({ t: started + index * 250, dbfs: -30 });
  }
  jest.setSystemTime(started + 60000);
  await mockCaptures[mockCaptures.length - 1].flush();
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://127.0.0.1:9';
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-16T12:00:00Z'));
  mockStorage.clear();
  mockGet.mockReset().mockImplementation(async key => mockStorage.get(key) ?? null);
  mockSet.mockReset().mockImplementation(async (key, value) => { mockStorage.set(key, value); });
  mockOsRead.mockReset().mockResolvedValue({ granted: true });
  mockOsRequest.mockReset().mockResolvedValue({ granted: true });
  mockReadConsent.mockReset().mockImplementation(async () => consent(true, true));
  for (const mock of [mockSubmit, mockReset, mockMeterStop, mockRemoveForeground]) mock.mockClear();
  mockConsentListeners.clear(); mockLocationCallbacks.clear(); mockMeterCallbacks.clear(); mockCaptures.length = 0;
  installations = [];
  jest.isolateModules(() => {
    permissions = require('../acousticSensingPermission.ts');
    ({ installSensingCapture } = require('../installSensingCapture.ts'));
  });
});
afterEach(() => { for (const installation of installations) installation.dispose(); jest.useRealTimers(); });

test('healthy explicit grant contributes coarse acoustic fields through the real loop', async () => {
  await install(); await window();
  expect(mockSubmit.mock.calls[0][0]).toHaveProperty('acoustic.energy_bucket', 3);
});
test('withdrawal detaches immediately before persistence resolves and omits acoustic in the next window', async () => {
  await install();
  const pending = deferred<void>();
  mockSet.mockImplementationOnce(async (key, value) => { await pending.promise; mockStorage.set(key, value); });
  const withdrawal = permissions.withdrawAcousticSensingPermission();
  expect(mockMeterCallbacks.size).toBe(0);
  expect(mockMeterStop).toHaveBeenCalled();
  await settle(); await window();
  expect(mockSubmit.mock.calls[0][0]).not.toHaveProperty('acoustic');
  pending.resolve(); await withdrawal;
});
test('failed withdrawal never reloads an old stored grant through foreground or installer remount', async () => {
  const first = await install();
  const savedGrant = mockStorage.get(ACOUSTIC_PERMISSION_STORAGE_KEY);
  mockSet.mockRejectedValue(new Error('Synthetic storage unavailable'));
  await permissions.withdrawAcousticSensingPermission();
  expect(mockStorage.get(ACOUSTIC_PERMISSION_STORAGE_KEY)).toBe(savedGrant);
  expect(acousticCaptureAllowed(await permissions.readAcousticSensingPermission())).toBe(false);
  mockForeground?.('active'); await settle(); await window();
  expect(mockSubmit.mock.calls[0][0]).not.toHaveProperty('acoustic');
  first.dispose(); await install(false);
  expect(mockMeterCallbacks.size).toBe(0);
  expect(mockOsRequest).toHaveBeenCalledTimes(1);
});
test('explicit withdrawal retry saves denial and a later explicit grant alone may restore capture', async () => {
  await install();
  mockSet.mockRejectedValueOnce(new Error('Synthetic storage unavailable'));
  await permissions.withdrawAcousticSensingPermission();
  await permissions.withdrawAcousticSensingPermission();
  expect(JSON.parse(mockStorage.get(ACOUSTIC_PERMISSION_STORAGE_KEY)!)).toMatchObject({ granted: false });
  expect(mockOsRequest).toHaveBeenCalledTimes(1);
  await permissions.requestAcousticSensingPermission(); await settle();
  expect(mockMeterCallbacks.size).toBe(1);
});
test('failed grant cannot enable capture over an older saved grant', async () => {
  await permissions.requestAcousticSensingPermission();
  mockSet.mockRejectedValue(new Error('Synthetic storage unavailable'));
  await permissions.withdrawAcousticSensingPermission();
  await permissions.requestAcousticSensingPermission();
  expect(acousticCaptureAllowed(await permissions.readAcousticSensingPermission())).toBe(false);
});
test('late OS opt-in completion cannot overtake withdrawal or persist a grant', async () => {
  const pending = deferred<{ granted: boolean }>();
  mockOsRequest.mockReturnValueOnce(pending.promise);
  const grant = permissions.requestAcousticSensingPermission();
  await permissions.withdrawAcousticSensingPermission();
  pending.resolve({ granted: true }); await grant;
  expect(JSON.parse(mockStorage.get(ACOUSTIC_PERMISSION_STORAGE_KEY)!)).toMatchObject({ granted: false });
  expect(acousticCaptureAllowed(await permissions.readAcousticSensingPermission())).toBe(false);
});
test('an in-flight grant write is followed by the newer withdrawal, never the reverse', async () => {
  const pending = deferred<void>();
  mockSet.mockImplementationOnce(async (key, value) => { await pending.promise; mockStorage.set(key, value); });
  const grant = permissions.requestAcousticSensingPermission(); await settle();
  const withdrawal = permissions.withdrawAcousticSensingPermission(); await settle();
  expect(mockSet).toHaveBeenCalledTimes(1);
  pending.resolve(); await Promise.all([grant, withdrawal]);
  expect(JSON.parse(mockStorage.get(ACOUSTIC_PERMISSION_STORAGE_KEY)!)).toMatchObject({ granted: false });
});
test('queued superseded grant is skipped while a later withdrawal still saves', async () => {
  const pending = deferred<void>();
  mockSet.mockImplementationOnce(async (key, value) => { await pending.promise; mockStorage.set(key, value); });
  const first = permissions.withdrawAcousticSensingPermission(); await settle();
  const grant = permissions.requestAcousticSensingPermission(); await settle();
  const last = permissions.withdrawAcousticSensingPermission();
  pending.resolve(); await Promise.all([first, grant, last]);
  expect(mockSet.mock.calls.every(([, value]) => JSON.parse(value).granted === false)).toBe(true);
});
for (const stage of ['storage', 'OS']) {
  test(`late ${stage} read cannot restore withdrawn permission`, async () => {
    await permissions.requestAcousticSensingPermission();
    const stored = mockStorage.get(ACOUSTIC_PERMISSION_STORAGE_KEY)!;
    const pendingStorage = deferred<string>();
    const pendingOs = deferred<{ granted: boolean }>();
    if (stage === 'storage') mockGet.mockReturnValueOnce(pendingStorage.promise);
    else mockOsRead.mockReturnValueOnce(pendingOs.promise);
    const read = permissions.readAcousticSensingPermission(); await settle();
    await permissions.withdrawAcousticSensingPermission();
    pendingStorage.resolve(stored); pendingOs.resolve({ granted: true });
    expect(acousticCaptureAllowed(await read)).toBe(false);
  });
}
test('grant attaches to an already-running location loop without a foreground event', async () => {
  await install(false); expect(mockMeterCallbacks.size).toBe(0);
  await permissions.requestAcousticSensingPermission(); await settle();
  expect(mockMeterCallbacks.size).toBe(1);
});
test('default and OS-denied permissions stay closed without passive prompting', async () => {
  await install(false); await permissions.readAcousticSensingPermission();
  expect(mockOsRequest).not.toHaveBeenCalled(); expect(mockMeterCallbacks.size).toBe(0);
  mockOsRequest.mockResolvedValueOnce({ granted: false }); mockOsRead.mockResolvedValue({ granted: false });
  await permissions.requestAcousticSensingPermission(); await settle();
  expect(mockMeterCallbacks.size).toBe(0);
});
test('capture denial cannot be overridden by explicit acoustic opt-in', async () => {
  mockReadConsent.mockResolvedValue(consent(false, false)); await install();
  expect(mockCaptures).toHaveLength(0);
});
test('upload denial retains local capture but sends nothing', async () => {
  mockReadConsent.mockResolvedValue(consent(true, false)); await install(); await window();
  expect(mockMeterCallbacks.size).toBe(1); expect(mockSubmit).not.toHaveBeenCalled();
});
test('a later denied recheck defeats an older in-flight granted recheck', async () => {
  await install();
  const pending = deferred<ReturnType<typeof consent>>();
  mockReadConsent.mockReturnValueOnce(pending.promise);
  mockForeground?.('active'); await settle();
  mockReadConsent.mockResolvedValue(consent(false, false));
  for (const callback of mockConsentListeners) callback(); await settle();
  pending.resolve(consent(true, true)); await settle();
  expect(mockMeterCallbacks.size).toBe(0); expect(mockLocationCallbacks.size).toBe(0);
});
test('a later OS denial cannot be overwritten by an earlier OS-granted read', async () => {
  await install();
  const pending = deferred<{ granted: boolean }>();
  mockOsRead.mockReturnValueOnce(pending.promise);
  const old = permissions.readAcousticSensingPermission(); await settle();
  mockOsRead.mockResolvedValue({ granted: false });
  expect(acousticCaptureAllowed(await permissions.readAcousticSensingPermission())).toBe(false);
  pending.resolve({ granted: true });
  expect(acousticCaptureAllowed(await old)).toBe(false);
});
test('overlapping healthy passive readers preserve saved-grant startup without prompting', async () => {
  mockStorage.set(ACOUSTIC_PERMISSION_STORAGE_KEY, JSON.stringify({ scope: 'sensing.acoustic.energy', granted: true,
    grantedAt: '2026-10-16T12:00:00Z', revokedAt: null, osMicrophoneGranted: false }));
  const pending = deferred<{ granted: boolean }>();
  const installation = installSensingCapture(); installations.push(installation);
  await Promise.resolve();
  mockOsRead.mockReturnValueOnce(pending.promise);
  const settingsRead = permissions.readAcousticSensingPermission(); await settle();
  pending.resolve({ granted: true }); await settingsRead; await settle();
  expect(mockMeterCallbacks.size).toBe(1); expect(mockOsRequest).not.toHaveBeenCalled();
});
test('old stopped-loop submit cannot use newly granted upload eligibility', async () => {
  await install(); const old = mockCaptures[0];
  const started = Date.now();
  for (const callback of mockLocationCallbacks) callback({ t: started, lat: 40.75, lng: -73.98, accuracyM: 10, speedMps: 0 });
  await permissions.withdrawAcousticSensingPermission();
  await permissions.requestAcousticSensingPermission(); await settle();
  await old.flush(); expect(mockSubmit).not.toHaveBeenCalled();
});
test('a failing permission listener cannot reverse denial or prevent persistence', async () => {
  await install();
  const unsubscribe = permissions.onAcousticSensingPermissionChange(() => { throw Error('listener'); });
  await permissions.withdrawAcousticSensingPermission(); unsubscribe();
  expect(acousticCaptureAllowed(await permissions.readAcousticSensingPermission())).toBe(false);
  expect(JSON.parse(mockStorage.get(ACOUSTIC_PERMISSION_STORAGE_KEY)!).granted).toBe(false);
  expect(mockMeterCallbacks.size).toBe(0);
});
for (const stage of ['consent', 'OS']) {
  test(`dispose fences pending ${stage} and unsubscribes from local changes`, async () => {
    await permissions.requestAcousticSensingPermission();
    const pendingConsent = deferred<ReturnType<typeof consent>>();
    const pendingOs = deferred<{ granted: boolean }>();
    if (stage === 'consent') mockReadConsent.mockReturnValueOnce(pendingConsent.promise);
    else mockOsRead.mockReturnValueOnce(pendingOs.promise);
    const installation = installSensingCapture(); await settle(); installation.dispose();
    pendingConsent.resolve(consent(true, true)); pendingOs.resolve({ granted: true }); await settle();
    await permissions.requestAcousticSensingPermission(); await settle();
    expect(mockCaptures).toHaveLength(0); expect(mockConsentListeners.size).toBe(0);
    expect(mockRemoveForeground).toHaveBeenCalled();
  });
}
test('cold start still honors a saved explicit grant without prompting', async () => {
  mockStorage.set(ACOUSTIC_PERMISSION_STORAGE_KEY, JSON.stringify({ scope: 'sensing.acoustic.energy', granted: true,
    grantedAt: '2026-10-16T12:00:00Z', revokedAt: null, osMicrophoneGranted: false }));
  await install(false);
  expect(mockMeterCallbacks.size).toBe(1); expect(mockOsRequest).not.toHaveBeenCalled();
});
