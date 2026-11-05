import { SECURE_KEYS, getSecure, setSecure } from '../../lib/secureStore.ts';
import { deviceSecretFromBytes } from '../../lib/sensing/commitment.ts';
let memorySecret: string | null = null;
let operations: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = operations.then(operation, operation);
  operations = result.catch(() => undefined); return result;
}
const valid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
async function readExisting(): Promise<string | null> {
  if (memorySecret) return memorySecret;
  const stored = await getSecure(SECURE_KEYS.SENSING_DEVICE_SECRET);
  if (!valid(stored)) return null;
  memorySecret = stored; return stored;
}
function newSecret(): string | null {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') return null;
  const bytes = new Uint8Array(32); globalThis.crypto.getRandomValues(bytes);
  return deviceSecretFromBytes(bytes);
}
async function persist(secret: string): Promise<boolean> {
  await setSecure(SECURE_KEYS.SENSING_DEVICE_SECRET, secret);
  // SecureStore can be unavailable/no-op on unsupported builds. Never upload
  // contributions whose erasure proof cannot survive this process.
  if (await getSecure(SECURE_KEYS.SENSING_DEVICE_SECRET) !== secret) return false;
  memorySecret = secret; return true;
}
export function readExistingSensingDeviceSecret(): Promise<string | null> { return serial(readExisting); }
export function sensingDeviceSecret(): Promise<string | null> {
  return serial(async () => {
    const existing = await readExisting(); if (existing) return existing;
    const next = newSecret(); return next && await persist(next) ? next : null;
  });
}
export function rotateSensingDeviceSecret(): Promise<boolean> {
  return serial(async () => { const next = newSecret(); return next ? persist(next) : false; });
}
export function _resetSensingDeviceSecret(): void { memorySecret = null; }
