import { ACOUSTIC_SENSING_SCOPE, ACOUSTIC_PERMISSION_DENIED } from '../../../lib/sensing/acousticPermission.ts';

const mockMode = jest.fn();
const mockDelete = jest.fn();
const mockRecordings: MockRecording[] = [];
let mockPrepare = () => Promise.resolve();
let mockStart = () => Promise.resolve();
let mockUnload = () => Promise.resolve();
let mockUri: string | null = 'file:///cache/AV/recording-owned.m4a';
let mockReleased = true;
class MockRecording {
  callback: ((status: { metering: number }) => void) | null = null;
  prepareToRecordAsync = jest.fn(() => mockPrepare());
  startAsync = jest.fn(() => mockStart());
  stopAndUnloadAsync = jest.fn(() => mockUnload());
  getURI = jest.fn(() => mockUri);
  getStatusAsync = jest.fn(async () => ({ canRecord: !mockReleased, isRecording: !mockReleased, isDoneRecording: mockReleased }));
  setProgressUpdateInterval = jest.fn();
  setOnRecordingStatusUpdate = jest.fn((callback) => { this.callback = callback; });
  constructor() { mockRecordings.push(this); }
}
/** NOTE: Exhaustive native boundary; importing Expo AV requires the unavailable ExponentAV device module. */
jest.mock('expo-av', () => ({
  Audio: { Recording: MockRecording, setAudioModeAsync: (...args: unknown[]) => mockMode(...args) },
}));
jest.mock('expo-file-system/legacy', () => ({
  ...jest.requireActual('expo-file-system/legacy'),
  cacheDirectory: 'file:///cache/',
  deleteAsync: (...args: unknown[]) => mockDelete(...args),
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let turn = 0; turn < 60; turn += 1) await Promise.resolve(); }
const permission = { ...ACOUSTIC_PERMISSION_DENIED, scope: ACOUSTIC_SENSING_SCOPE, granted: true, revokedAt: null, osMicrophoneGranted: true };
let createSource: typeof import('../acousticMeterSource.ts').createAcousticMeterSource;
const cleanups: Array<() => void> = [];
function subscribe() {
  const sample = jest.fn();
  const stop = createSource(permission)!.subscribe(sample);
  cleanups.push(stop);
  return { sample, stop };
}
beforeEach(() => {
  mockRecordings.length = 0;
  mockMode.mockReset().mockResolvedValue(undefined);
  mockDelete.mockReset().mockResolvedValue(undefined);
  mockPrepare = () => Promise.resolve();
  mockStart = () => Promise.resolve();
  mockUnload = () => Promise.resolve();
  mockUri = 'file:///cache/AV/recording-owned.m4a';
  mockReleased = true;
  jest.isolateModules(() => { createSource = require('../acousticMeterSource.ts').createAcousticMeterSource; });
});
afterEach(async () => { cleanups.splice(0).forEach((stop) => stop()); await settle(); });

describe('Sensing owned recorder lifetime and cache cleanup', () => {
  test('default and foreign-purpose permissions construct no source', () => {
    expect(createSource(ACOUSTIC_PERMISSION_DENIED)).toBeNull();
    expect(createSource({ ...permission, scope: 'call.microphone' })).toBeNull();
    expect(mockRecordings).toHaveLength(0);
  });
  test('healthy metering emits only finite levels and cleans its own file after release', async () => {
    const { sample, stop } = subscribe(); await settle();
    const recorder = mockRecordings[0];
    recorder.callback?.({ metering: -24 }); recorder.callback?.({ metering: NaN });
    expect(sample).toHaveBeenCalledTimes(1);
    expect(sample.mock.calls[0][0]).toEqual({ t: expect.any(Number), dbfs: -24 });
    const captured = recorder.callback;
    stop(); stop(); captured?.({ metering: -20 }); await settle();
    expect(sample).toHaveBeenCalledTimes(1);
    expect(recorder.stopAndUnloadAsync).toHaveBeenCalledTimes(1);
    expect(recorder.callback).toBeNull();
    expect(mockDelete).toHaveBeenCalledWith(mockUri, { idempotent: true });
    expect(recorder.stopAndUnloadAsync.mock.invocationCallOrder[0]).toBeLessThan(mockDelete.mock.invocationCallOrder[0]);
  });
  test.each(['mode', 'prepare', 'start'] as const)('unsubscribe during %s owns eventual cleanup', async (stage) => {
    const held = deferred();
    if (stage === 'mode') mockMode.mockImplementationOnce(() => held.promise);
    if (stage === 'prepare') mockPrepare = () => held.promise;
    if (stage === 'start') mockStart = () => held.promise;
    const { stop } = subscribe(); await settle(); stop(); held.resolve(); await settle();
    if (stage === 'mode') expect(mockRecordings).toHaveLength(0);
    else {
      expect(mockRecordings[0].stopAndUnloadAsync).toHaveBeenCalledTimes(1);
      expect(mockRecordings[0].startAsync).toHaveBeenCalledTimes(stage === 'prepare' ? 0 : 1);
    }
    expect(mockMode).toHaveBeenLastCalledWith({ allowsRecordingIOS: false });
  });
  test.each(['prepare', 'start'] as const)('%s rejection still releases the owned recorder', async (stage) => {
    if (stage === 'prepare') mockPrepare = async () => { throw Error('prepare'); };
    else mockStart = async () => { throw Error('start'); };
    subscribe(); await settle();
    expect(mockRecordings[0].stopAndUnloadAsync).toHaveBeenCalledTimes(1);
    expect(mockRecordings[0].callback).toBeNull();
    expect(mockMode).toHaveBeenLastCalledWith({ allowsRecordingIOS: false });
  });
  test('a successor waits for pending release and the old audio mode reset', async () => {
    const held = deferred(); mockUnload = () => held.promise;
    const first = subscribe(); await settle(); first.stop(); await settle();
    const second = subscribe(); await settle();
    expect(mockRecordings).toHaveLength(1);
    expect(mockDelete).not.toHaveBeenCalled();
    held.resolve(); await settle();
    expect(mockRecordings).toHaveLength(2);
    expect(mockMode.mock.calls.map(([mode]) => mode.allowsRecordingIOS)).toEqual([true, false, true]);
    second.stop();
  });
  test('a queued subscription cancelled before acquisition never constructs another recorder', async () => {
    const first = subscribe(); await settle();
    const second = subscribe(); second.stop(); first.stop(); await settle();
    expect(mockRecordings).toHaveLength(1);
  });
  test('unresolved native start gates samples immediately and blocks later acquisition', async () => {
    const held = deferred(); mockStart = () => held.promise;
    const first = subscribe(); await settle();
    const callback = mockRecordings[0].callback;
    first.stop(); callback?.({ metering: -10 }); subscribe(); await settle();
    expect(first.sample).not.toHaveBeenCalled(); expect(mockRecordings).toHaveLength(1);
    held.resolve(); await settle(); expect(mockRecordings).toHaveLength(2);
  });
  test('mode setup rejection attempts reset without constructing a recorder', async () => {
    mockMode.mockRejectedValueOnce(Error('mode'));
    subscribe(); await settle();
    expect(mockRecordings).toHaveLength(0);
    expect(mockMode).toHaveBeenLastCalledWith({ allowsRecordingIOS: false });
  });
  test('mode reset failure quarantines a later sensing recorder', async () => {
    const first = subscribe(); await settle(); mockMode.mockRejectedValueOnce(Error('mode reset'));
    first.stop(); await settle(); subscribe(); await settle();
    expect(mockRecordings).toHaveLength(1);
  });
  test('pending file deletion never delays audio-mode cleanup after native release', async () => {
    const held = deferred(); mockDelete.mockReturnValueOnce(held.promise);
    const first = subscribe(); await settle(); first.stop(); await settle();
    expect(mockRecordings[0].stopAndUnloadAsync).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockMode).toHaveBeenLastCalledWith({ allowsRecordingIOS: false });
    held.resolve(); await settle();
  });
  test('a detached callback that throws during cleanup cannot bypass recorder release', async () => {
    const first = subscribe(); await settle();
    mockRecordings[0].setOnRecordingStatusUpdate.mockImplementation(() => { throw Error('callback'); });
    first.stop(); await settle();
    expect(mockRecordings[0].stopAndUnloadAsync).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });
  test('unknown release failure blocks a competing recorder and never deletes the file', async () => {
    mockReleased = false; mockUnload = async () => { throw Error('unload'); };
    const first = subscribe(); await settle(); first.stop(); await settle(); subscribe(); await settle();
    expect(mockRecordings).toHaveLength(1);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockRecordings[0].callback).toBeNull();
  });
  test('Expo stop error after confirmed unload still permits exact-file cleanup', async () => {
    mockUnload = async () => { throw Error('E_AUDIO_NODATA'); };
    const first = subscribe(); await settle(); first.stop(); await settle();
    expect(mockDelete).toHaveBeenCalledTimes(1);
    subscribe(); await settle(); expect(mockRecordings).toHaveLength(2);
  });
  test.each([null, 'https://host/recording-owned.m4a', 'file:///other/AV/recording-owned.m4a', 'file:///cache/AV/', 'file:///cache/AV/../secret', 'file:///cache/AV/recording-%2e%2e.m4a', 'file:///cache/AV/another-feature.m4a'])('refuses non-owned URI %s', async (uri) => {
    mockUri = uri;
    const { stop } = subscribe(); await settle(); stop(); await settle();
    expect(mockRecordings[0].stopAndUnloadAsync).toHaveBeenCalledTimes(1);
    expect(mockDelete).not.toHaveBeenCalled();
  });
  test('Android owned cache recording is cleaned', async () => {
    mockUri = 'file:///cache/Audio/recording-123-abc.3gp';
    const { stop } = subscribe(); await settle(); stop(); await settle();
    expect(mockDelete).toHaveBeenCalledWith(mockUri, { idempotent: true });
  });
  test.each(['uri', 'delete'] as const)('%s failure does not prevent native release or block a successor', async (stage) => {
    const { stop } = subscribe(); await settle();
    if (stage === 'uri') mockRecordings[0].getURI.mockImplementation(() => { throw Error('uri'); });
    else mockDelete.mockRejectedValue(Error('delete'));
    stop(); await settle(); subscribe(); await settle();
    expect(mockRecordings[0].stopAndUnloadAsync).toHaveBeenCalledTimes(1);
    expect(mockRecordings[0].callback).toBeNull();
    expect(mockRecordings).toHaveLength(2);
  });
});
