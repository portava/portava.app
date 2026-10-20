/**
 * layoverLiveReturnSampler — the ONE-SHOT position fix behind live return assistance (census-layover L157, inside the
 * L164 boundary).
 *
 * This module ASKS NOTHING. The permission prompt happens once, when the traveller presses "Turn on live return
 * assistance", through `src/lib/location/locationRequestDoor.ts` (purpose `live_return_assistance`). After that, each
 * sample:
 *   1. READS the existing foreground permission (`getForegroundPermissionsAsync` — no prompt), and refuses unless it is
 *      already granted;
 *   2. takes ONE fix at the accuracy the adaptive policy chose (`layoverLiveSensing`), and returns it.
 * No watch, no background task, no continuous mode: the caller decides when the next one-shot fix is taken. The fix is
 * returned to the caller and goes nowhere else — this module sends nothing to any server.
 *
 * The guard in `src/lib/__tests__/layoverSensingCadence.test.ts` pins all of that mechanically: this file is a listed
 * location door, it uses only the two members above (plus `Accuracy`), the fix call sits after the granted check, and
 * only the live return card imports it.
 */
import * as Location from 'expo-location';

export type LiveReturnAccuracy = 'low' | 'balanced' | 'high';

export type LiveReturnFix =
  | { ok: true; lat: number; lng: number; accuracyMeters: number | null; atMs: number }
  | { ok: false; reason: 'permission_not_granted' | 'fix_failed' };

export async function sampleLiveReturnFix(accuracy: LiveReturnAccuracy): Promise<LiveReturnFix> {
  try { const { status } = await Location.getForegroundPermissionsAsync();
  if (status !== 'granted') return { ok: false, reason: 'permission_not_granted' };

    const level = accuracy === 'high' ? Location.Accuracy.High : accuracy === 'balanced' ? Location.Accuracy.Balanced : Location.Accuracy.Low;
    const pos = await Location.getCurrentPositionAsync({ accuracy: level });
    return { ok: true, lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyMeters: pos.coords.accuracy ?? null, atMs: Date.now() };
  } catch {
    return { ok: false, reason: 'fix_failed' };
  }
}
