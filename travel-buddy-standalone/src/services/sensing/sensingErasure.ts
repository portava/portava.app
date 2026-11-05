import AsyncStorage from '@react-native-async-storage/async-storage';
import { currentDiscoveryScope, isCurrentDiscoveryScope } from '../discoveryViewerScope.ts';
import { deriveEpochSecret } from '../../lib/sensing/commitment.ts';
import { readExistingSensingDeviceSecret, rotateSensingDeviceSecret } from './sensingDeviceSecret.ts';
const KEY = 'sensing_pending_device_erasure_v1';
const HOUR = 3_600_000;
const listeners = new Set<() => void>();
let pending: boolean | null = null;
let busy = false;
let credentialReader: (() => string | null) | null = null;
const notify = () => { for (const listener of listeners) { try { listener(); } catch {} } };
export function onSensingErasureChange(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function registerSensingRevocationCredential(reader: () => string | null): () => void {
  credentialReader = reader; return () => { if (credentialReader === reader) credentialReader = null; };
}
export async function isSensingErasurePending(): Promise<boolean> {
  if (pending !== null) return pending;
  try { const raw = await AsyncStorage.getItem(KEY); if (pending === null) pending = raw !== null; }
  catch { return true; } // unreadable retry marker grants no capture
  return pending;
}
export type SensingErasureResult = { ok: true; nothingStored?: boolean } | { ok: false; reason: 'busy' | 'unavailable' | 'failed' | 'account_changed' };
/** Explicit user action only. Sends epoch proofs, never a bearer/profile ID or device secret. */
export async function eraseRecentSensingContributions(): Promise<SensingErasureResult> {
  if (busy) return { ok: false, reason: 'busy' };
  const owner = currentDiscoveryScope();
  if (!owner.viewer?.startsWith('u:')) return { ok: false, reason: 'unavailable' };
  busy = true;
  const credential = credentialReader?.() ?? null;
  pending = true; notify(); // clears raw buffers and aborts active transport first
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const epoch = Math.floor(Date.now() / HOUR);
    const epochs = Array.from({ length: 73 }, (_, offset) => epoch - offset).filter(value => value >= 0);
    await AsyncStorage.setItem(KEY, JSON.stringify({ epochs }));
    const secret = await readExistingSensingDeviceSecret();
    if (!isCurrentDiscoveryScope(owner)) return { ok: false, reason: 'account_changed' };
    if (!secret) {
      await AsyncStorage.removeItem(KEY); pending = false; notify();
      return { ok: true, nothingStored: true };
    }
    const base = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
    if (!base) return { ok: false, reason: 'unavailable' };
    const response = await fetch(`${base}/api/v1/sensing/revoke`, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(credential ? { 'X-Sensing-Credential': credential } : {}) },
      body: JSON.stringify({ epochs: epochs.map(rotationEpoch => ({ rotationEpoch, epochSecret: deriveEpochSecret(secret, rotationEpoch) })) }),
    });
    if (response.status !== 204) return { ok: false, reason: 'failed' };
    if (!await rotateSensingDeviceSecret()) return { ok: false, reason: 'failed' };
    await AsyncStorage.removeItem(KEY); pending = false; notify();
    return { ok: true };
  } catch { return { ok: false, reason: 'failed' }; }
  finally { clearTimeout(timer); busy = false; }
}
