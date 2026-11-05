/**
 * playbackAudioMode — video and sound play through the iPhone's ringer switch,
 * out of the speaker, and every recorder hands the session back afterwards
 * (2026-11-04: "the videos have no sound right now").
 *
 *   1. The mode plays in silent mode and does not record: expo-av's default
 *      (Ambient) muted every video on a phone set to silent, and a recording
 *      mode (PlayAndRecord) sends playback to the earpiece.
 *   2. Every key is written, so nothing a recorder left behind survives.
 *   3. A failing native call never throws into the caller.
 *   4. The voice-note recorder restores the mode when it stops, and when it
 *      fails to start after switching the session to recording.
 */
import { applyPlaybackAudioMode, PLAYBACK_AUDIO_MODE } from '../playbackAudioMode.ts';
import { startExpoAvRecording, type RecorderAudio } from '../../../features/telegraph/voice/VoiceRecorderSheet.tsx';

const mockSetAudioMode = jest.fn();
const mockCreateAsync = jest.fn();
const mockStopAndUnload = jest.fn();

/** NOTE: Exhaustive native boundary; the real expo-av needs the ExponentAV device module. */
jest.mock('expo-av', () => ({
  Audio: { setAudioModeAsync: (...args: unknown[]) => mockSetAudioMode(...args) },
}));

// The recorder's Audio, handed in directly: the sheet reaches expo-av through a
// dynamic import, which jest cannot run.
const audio = {
  setAudioModeAsync: (...args: unknown[]) => mockSetAudioMode(...args),
  requestPermissionsAsync: async () => ({ granted: true }),
  RecordingOptionsPresets: { HIGH_QUALITY: {} },
  Recording: { createAsync: (...args: unknown[]) => mockCreateAsync(...args) },
} as unknown as RecorderAudio;

beforeEach(() => {
  mockSetAudioMode.mockReset().mockResolvedValue(undefined);
  mockStopAndUnload.mockReset().mockResolvedValue(undefined);
  mockCreateAsync.mockReset().mockResolvedValue({
    recording: {
      stopAndUnloadAsync: (...args: unknown[]) => mockStopAndUnload(...args),
      getURI: () => 'file:///cache/voice.m4a',
      setOnRecordingStatusUpdate: jest.fn(),
      setProgressUpdateInterval: jest.fn(),
    },
  });
});

describe('PLAYBACK_AUDIO_MODE', () => {
  it('plays through the ringer switch, from the speaker, and pauses other audio only when it has sound', () => {
    expect(PLAYBACK_AUDIO_MODE.playsInSilentModeIOS).toBe(true);
    expect(PLAYBACK_AUDIO_MODE.allowsRecordingIOS).toBe(false);
    expect(PLAYBACK_AUDIO_MODE.playThroughEarpieceAndroid).toBe(false);
    expect(PLAYBACK_AUDIO_MODE.staysActiveInBackground).toBe(false);
    expect(PLAYBACK_AUDIO_MODE.interruptionModeIOS).toBe(1); // InterruptionModeIOS.DoNotMix
  });
  it('spells out every key expo-av has, so a partial mode left by a recorder cannot survive', () => {
    expect(Object.keys(PLAYBACK_AUDIO_MODE).sort()).toEqual([
      'allowsRecordingIOS', 'interruptionModeAndroid', 'interruptionModeIOS', 'playThroughEarpieceAndroid',
      'playsInSilentModeIOS', 'shouldDuckAndroid', 'staysActiveInBackground',
    ]);
  });
});

describe('applyPlaybackAudioMode', () => {
  it('writes the whole mode through expo-av, as a fresh object', async () => {
    await expect(applyPlaybackAudioMode()).resolves.toBe(true);
    expect(mockSetAudioMode).toHaveBeenCalledTimes(1);
    const [written] = mockSetAudioMode.mock.calls[0];
    expect(written).toEqual(PLAYBACK_AUDIO_MODE);
    expect(written).not.toBe(PLAYBACK_AUDIO_MODE);
  });
  it('a native refusal resolves false instead of throwing', async () => {
    mockSetAudioMode.mockRejectedValueOnce(new Error('Impossible audio mode'));
    await expect(applyPlaybackAudioMode()).resolves.toBe(false);
  });
  it('uses the setter it is handed', async () => {
    const setter = jest.fn().mockResolvedValue(undefined);
    await applyPlaybackAudioMode(setter);
    expect(setter).toHaveBeenCalledWith({ ...PLAYBACK_AUDIO_MODE });
    expect(mockSetAudioMode).not.toHaveBeenCalled();
  });
});

describe('the voice-note recorder hands the session back', () => {
  it('records in recording mode, then restores playback mode once stopped', async () => {
    const started = await startExpoAvRecording(audio);
    if (!started.ok) throw new Error('recorder did not start');
    expect(mockSetAudioMode).toHaveBeenLastCalledWith(expect.objectContaining({ allowsRecordingIOS: true }));
    await started.recorder.stopAndUnloadAsync();
    expect(mockStopAndUnload).toHaveBeenCalledTimes(1);
    expect(mockSetAudioMode).toHaveBeenLastCalledWith(PLAYBACK_AUDIO_MODE);
    expect(started.recorder.getURI()).toBe('file:///cache/voice.m4a');
  });
  it('restores playback mode even when stopping fails', async () => {
    mockStopAndUnload.mockRejectedValueOnce(new Error('stop'));
    const started = await startExpoAvRecording(audio);
    if (!started.ok) throw new Error('recorder did not start');
    await expect(started.recorder.stopAndUnloadAsync()).rejects.toThrow('stop');
    expect(mockSetAudioMode).toHaveBeenLastCalledWith(PLAYBACK_AUDIO_MODE);
  });
  it('restores playback mode when the microphone fails to start after the switch', async () => {
    mockCreateAsync.mockRejectedValueOnce(new Error('mic busy'));
    await expect(startExpoAvRecording(audio)).resolves.toEqual({ ok: false, reason: 'error' });
    expect(mockSetAudioMode).toHaveBeenLastCalledWith(PLAYBACK_AUDIO_MODE);
  });
});
