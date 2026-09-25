/**
 * acousticSensingPermission — the runtime half of §4.1's "separate explicit
 * permission" for coarse acoustic sensing.
 *
 * The POLICY lives in `src/lib/sensing/acousticPermission.ts` (pure, storage
 * injected, and the file to read for why "separate" cannot mean the OS
 * microphone switch). This file binds it to the two things it needs on a
 * device: its own AsyncStorage key, and the OS microphone answer.
 *
 * ── THE TWO GATES, AND WHY BOTH ──────────────────────────────────────────────
 *   1. The purpose-scoped grant, stored under
 *      `sensing_acoustic_permission_v1` — a key nothing else in this app
 *      writes, so a call permission cannot set it and revoking it cannot break
 *      a call.
 *   2. The OS microphone permission, asked for FRESH each time, because the
 *      user can revoke it in Settings while the app is not running.
 *
 * `ensureAcousticSensingPermission` never PROMPTS. It reads. Prompting belongs
 * to a settings screen where the user is choosing, not to a background capture
 * loop that happens to want audio — which is the whole difference between this
 * and reusing the microphone the video call already opened.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ACOUSTIC_PERMISSION_DENIED,
  acousticCaptureAllowed,
  grantAcousticPermission,
  loadAcousticPermission,
  revokeAcousticPermission,
  type AcousticPermission,
  type StorageLike,
} from '../../lib/sensing/acousticPermission.ts';

const storage: StorageLike = {
  getItem: (k) => AsyncStorage.getItem(k),
  setItem: (k, v) => AsyncStorage.setItem(k, v),
  removeItem: (k) => AsyncStorage.removeItem(k),
};

/**
 * Read the OS microphone answer WITHOUT prompting. Absent module, web, or any
 * failure reads as not-granted.
 */
async function osMicrophoneGranted(): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const av = require('expo-av') as Record<string, any>;
    const res = await av?.Audio?.getPermissionsAsync?.();
    return res?.granted === true;
  } catch {
    return false;
  }
}

/** The current combined state. Never prompts; safe to call on every window. */
export async function readAcousticSensingPermission(): Promise<AcousticPermission> {
  const stored = await loadAcousticPermission(storage);
  if (!stored.granted) return stored;
  return { ...stored, osMicrophoneGranted: await osMicrophoneGranted() };
}

/** True iff BOTH the purpose-scoped grant and the OS permission are held. */
export async function acousticSensingAllowed(): Promise<boolean> {
  return acousticCaptureAllowed(await readAcousticSensingPermission());
}

/**
 * Record the user's explicit opt-in, prompting for the OS microphone ONLY here
 * — at the moment they chose it, on a surface that said what it is for.
 */
export async function requestAcousticSensingPermission(): Promise<AcousticPermission> {
  let granted = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const av = require('expo-av') as Record<string, any>;
    const res = await av?.Audio?.requestPermissionsAsync?.();
    granted = res?.granted === true;
  } catch {
    granted = false;
  }
  return grantAcousticPermission(storage, Date.now(), granted);
}

/** Withdraw the acoustic grant. Calls and video keep their microphone. */
export async function withdrawAcousticSensingPermission(): Promise<AcousticPermission> {
  return revokeAcousticPermission(storage, Date.now());
}

export { ACOUSTIC_PERMISSION_DENIED };
