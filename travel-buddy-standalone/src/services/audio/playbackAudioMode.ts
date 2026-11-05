/**
 * playbackAudioMode — the audio session every video and sound in the app plays in.
 *
 * ── WHY THIS EXISTS (2026-11-04: "the videos have no sound") ────────────────
 * Nothing set a playback mode, so iOS ran on expo-av's default,
 * playsInSilentModeIOS: false. expo-av maps that to the Ambient category, and
 * Ambient obeys the ringer switch: with the iPhone on silent every <Video> and
 * Sound played with no audio at all, unmuted or not. Video apps play through
 * the ringer switch, and this one now does too.
 *
 * The only setAudioModeAsync calls were the two recorders, and neither put the
 * session back afterwards:
 *   - VoiceRecorderSheet left allowsRecordingIOS: true (PlayAndRecord), which
 *     sends playback to the earpiece, so after one voice note every video was
 *     a whisper until the app restarted;
 *   - the acoustic meter wrote playsInSilentModeIOS: false and then reset only
 *     allowsRecordingIOS, and expo-av fills every key a call leaves out from
 *     the LAST mode, so the silent-switch mute came back.
 * Both now hand the session back by calling applyPlaybackAudioMode().
 *
 * ── MUTED VIDEO STAYS OUT OF THE WAY ────────────────────────────────────────
 * While every playing player is muted, expo-av runs the session as Playback
 * with MixWithOthers whatever this mode says (EXAV.m,
 * EXAVAudioSessionModeActiveMuted), so a muted autoplaying feed video never
 * stops the traveller's music. DoNotMix below applies only once a video plays
 * WITH sound, which pauses the music the way other video apps do.
 *
 * Web has no audio session (expo-av's web setAudioMode is a no-op), so this is
 * harmless there. Android keeps expo-av's defaults: it has no ringer-switch
 * mute, and ducking other apps is already its behaviour.
 */
import type { AudioMode } from 'expo-av';

/**
 * The full mode, every key spelled out: a partial call inherits whatever the
 * last caller left behind (see above), so restoring means writing all of it.
 * The interruption modes are expo-av's enum values written as numbers, so this
 * module does not need the enum objects at runtime (the jest stub of expo-av
 * exports Audio only).
 */
export const PLAYBACK_AUDIO_MODE: Readonly<AudioMode> = Object.freeze({
  allowsRecordingIOS: false,
  playsInSilentModeIOS: true,
  interruptionModeIOS: 1 as AudioMode['interruptionModeIOS'], // InterruptionModeIOS.DoNotMix
  staysActiveInBackground: false,
  interruptionModeAndroid: 2 as AudioMode['interruptionModeAndroid'], // InterruptionModeAndroid.DuckOthers, expo-av's default
  shouldDuckAndroid: true,
  playThroughEarpieceAndroid: false,
});

type AudioModeSetter = (mode: AudioMode) => Promise<unknown>;

/**
 * Put the session in playback mode. Resolves true when the mode was set, false
 * when it could not be (never rejects: a failed mode leaves playback exactly as
 * it was, which is no reason to break the caller). `setMode` is a test seam.
 */
export async function applyPlaybackAudioMode(setMode?: AudioModeSetter): Promise<boolean> {
  try {
    // expo-av is required here, not imported at the top, so a module that only
    // might need playback mode (the voice recorder) still loads it lazily.
    const set: AudioModeSetter | undefined = setMode ?? (require('expo-av') as typeof import('expo-av')).Audio?.setAudioModeAsync;
    if (typeof set !== 'function') return false;
    // A fresh object every time: expo-av writes the keys it fills in back
    // into the object it is handed, and the constant is frozen.
    await set({ ...PLAYBACK_AUDIO_MODE });
    return true;
  } catch {
    return false;
  }
}
