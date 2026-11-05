const mockNativeSensor = jest.fn();
const mockRemove = jest.fn();
let mockCallback: ((value: { x: number; y: number; z: number }) => void) | undefined;
const mockSubscribe = jest.fn((callback: typeof mockCallback) => { mockCallback = callback; return { remove: mockRemove }; });
// NOTE: exhaustive Expo registry boundary; no native sensor is accessed in this suite.
jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: (...args: unknown[]) => mockNativeSensor(...args) }));
// NOTE: exhaustive virtual hardware module (not installed in the host test runtime).
jest.mock('expo-sensors', () => ({ Accelerometer: { setUpdateInterval: jest.fn(), addListener: (...args: [typeof mockCallback]) => mockSubscribe(...args) } }), { virtual: true });
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
