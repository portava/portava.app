const mockNativeSensor = jest.fn();
const mockRemove = jest.fn();
let mockCallback: ((value: { x: number; y: number; z: number }) => void) | undefined;
const mockSubscribe = jest.fn((callback: typeof mockCallback) => { mockCallback = callback; return { remove: mockRemove }; });
// NOTE: exhaustive Expo registry boundary; no native sensor is accessed in this suite.
jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: (...args: unknown[]) => mockNativeSensor(...args) }));
// NOTE: exhaustive virtual hardware module (not installed in the host test runtime).
jest.mock('expo-sensors', () => ({ Accelerometer: { setUpdateInterval: jest.fn(), addListener: (...args: [typeof mockCallback]) => mockSubscribe(...args) } }), { virtual: true });
const mockReadLocation = jest.fn();
const mockRequestLocation = jest.fn();
const mockWatchLocation = jest.fn();
// NOTE: The Expo foreground-location interface is the hardware boundary under test.
jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: () => mockReadLocation(),
  requestForegroundPermissionsAsync: () => mockRequestLocation(),
  watchPositionAsync: (...args: unknown[]) => mockWatchLocation(...args),
  Accuracy: { Balanced: 3 },
}));
let sources!: typeof import('../deviceSensorSources.ts');
beforeEach(() => { jest.clearAllMocks(); mockCallback = undefined; mockNativeSensor.mockReturnValue({}); jest.isolateModules(() => { sources = require('../deviceSensorSources.ts'); }); });
it('finds the accelerometer through Expo’s registry when it is absent from NativeModules', () => {
  const source = sources.createDeviceMotionSource(); expect(source).not.toBeNull();
  expect(mockNativeSensor).toHaveBeenCalledWith('ExponentAccelerometer');
  const sample = jest.fn(); const stop = source!.subscribe(sample);
  mockCallback?.({ x: 1, y: 2, z: 3 }); expect(sample).toHaveBeenCalledTimes(1);
  stop(); mockCallback?.({ x: 1, y: 2, z: 3 }); expect(sample).toHaveBeenCalledTimes(1); expect(mockRemove).toHaveBeenCalledTimes(1);
});
it('an older build without the native module degrades without trying to subscribe', () => {
  mockNativeSensor.mockReturnValue(null);
  expect(sources.createDeviceMotionSource()).toBeNull(); expect(mockSubscribe).not.toHaveBeenCalled();
});

it('can resume area sensing after an explicit OS location grant without prompting at startup', async () => {
  mockReadLocation.mockResolvedValue({ granted: false, canAskAgain: true });
  mockRequestLocation.mockResolvedValue({ granted: true });
  const changed = jest.fn();
  const unsubscribe = sources.onAreaLocationGranted(changed);
  expect(await sources.areaLocationAccess()).toBe('requestable');
  expect(mockRequestLocation).not.toHaveBeenCalled();
  expect(await sources.areaLocationAccess(true)).toBe('granted');
  expect(changed).toHaveBeenCalledTimes(1);
  unsubscribe();
});

it('a stationary phone can produce successive fresh fixes and never reuses a stale native fix', async () => {
  mockReadLocation.mockResolvedValue({ granted: true });
  const remove = jest.fn(); mockWatchLocation.mockResolvedValue({ remove });
  const consumer = jest.fn();
  const now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const stop = sources.createDeviceLocationSource().subscribe(consumer);
    await Promise.resolve(); await Promise.resolve();
    const [options, receive] = mockWatchLocation.mock.calls[0]!;
    expect(options.distanceInterval).toBe(0);
    const fix = { latitude: 1, longitude: 1, accuracy: 30 };
    receive({ coords: fix, timestamp: now - 600_000 });
    receive({ coords: fix, timestamp: now });
    receive({ coords: fix, timestamp: now });
    clock.mockReturnValue(now + 300_000);
    receive({ coords: fix, timestamp: now + 300_000 });
    expect(consumer).toHaveBeenCalledTimes(2);
    stop(); receive({ coords: fix, timestamp: now + 330_000 });
    expect(consumer).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
  } finally { clock.mockRestore(); }
});
