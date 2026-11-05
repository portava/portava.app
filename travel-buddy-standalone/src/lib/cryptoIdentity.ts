/** Native identity material belongs to one account. Legacy unowned keys are
 * preserved, but never silently attributed to whichever account signs in next. */
import { Platform } from 'react-native';
import { SECURE_KEYS, isNative, deleteSecure } from './secureStore.ts';
import type { MessagingOwnerRequest } from '../services/observedOwnerSnapshot.ts';
import { cryptoOwner, readLegacyCryptoSecret, readCryptoSecret, writeCryptoSecret, serializedCrypto, pendingWasConsumed, cryptoStorageKey } from './e2ee/nativeSessionStore.ts';

type Native = typeof import('../../vendor/expo-openmls/src/index.ts');
type Post = (path: string, body?: object) => Promise<{ data?: unknown; error?: unknown }>;
export const PENDING_PUBLIC = 'pending_keypackage_public';
export const PENDING_PUBLISHED = 'pending_keypackage_published';
export const LEGACY_PENDING = 'legacy_pending_keypackage';
const refillListeners = new Set<() => void>();
export const onKeyPackageConsumed = (listener: () => void): (() => void) => { refillListeners.add(listener); return () => { refillListeners.delete(listener); }; };
export function notifyKeyPackageConsumed(): void { for (const listener of refillListeners) listener(); }
export async function hasCryptoIdentity(request?: MessagingOwnerRequest): Promise<boolean> {
  if (!isNative()) return false;
  return Boolean(await readCryptoSecret(cryptoOwner(request), SECURE_KEYS.IDENTITY_PRIVATE_KEY));
}
export async function getIdentityPublicKey(request?: MessagingOwnerRequest): Promise<string | null> {
  return readCryptoSecret(cryptoOwner(request), SECURE_KEYS.IDENTITY_PUBLIC_KEY);
}
export async function getDeviceEd25519PublicKey(request?: MessagingOwnerRequest): Promise<string | null> {
  return readCryptoSecret(cryptoOwner(request), SECURE_KEYS.DEVICE_ED25519_PUBLIC_KEY);
}
export async function getRegisteredDeviceId(request?: MessagingOwnerRequest): Promise<string | null> {
  return readCryptoSecret(cryptoOwner(request), SECURE_KEYS.REGISTERED_DEVICE_ID);
}
export async function initCryptoIdentity(opts: {
  apiPost: Post;
  apiGet?: (path: string) => Promise<{ data?: unknown; error?: unknown }>;
  apiPut: (path: string, body: object) => Promise<{ data?: unknown; error?: unknown }>;
  owner?: MessagingOwnerRequest;
}): Promise<void> {
  if (!isNative()) return;
  const owner = cryptoOwner(opts.owner);
  const native = require('expo-openmls') as Native;
  return serializedCrypto(owner, '__identity__', async () => {
    const required = [SECURE_KEYS.IDENTITY_PRIVATE_KEY, SECURE_KEYS.IDENTITY_PUBLIC_KEY,
      SECURE_KEYS.DEVICE_ED25519_PRIVATE_KEY, SECURE_KEYS.DEVICE_ED25519_PUBLIC_KEY,
      SECURE_KEYS.DEVICE_X25519_PRIVATE_KEY, SECURE_KEYS.DEVICE_X25519_PUBLIC_KEY];
    const persistIdentity = async (values: string[]) => {
      // One recoverable keychain record precedes the individual compatibility
      // keys. An interrupted first initialization resumes the same identity.
      await writeCryptoSecret(owner, 'identity_bundle_v1', JSON.stringify(values));
      for (let i = 0; i < required.length; i++) await writeCryptoSecret(owner, required[i]!, values[i]!);
    };
    const bundle = await readCryptoSecret(owner, 'identity_bundle_v1');
    if (bundle && (await Promise.all(required.map((key) => readCryptoSecret(owner, key)))).some((value) => !value)) {
      const values: unknown = JSON.parse(bundle);
      if (!Array.isArray(values) || values.length !== required.length || values.some((value) => typeof value !== 'string' || !value)) throw new Error('The encrypted-message identity could not be recovered.');
      await persistIdentity(values as string[]);
    }
    // Old installs used global keys. Adopt only after the current account's
    // authenticated device census confirms both device ID and identity key.
    if ((await Promise.all(required.map((key) => readCryptoSecret(owner, key)))).some((value) => !value) && opts.apiGet) {
      const [legacyId, legacyPublic] = await Promise.all([readLegacyCryptoSecret(SECURE_KEYS.REGISTERED_DEVICE_ID), readLegacyCryptoSecret(SECURE_KEYS.IDENTITY_PUBLIC_KEY)]);
      cryptoOwner(owner);
      if (legacyId && legacyPublic) {
        const census = await opts.apiGet('/me/crypto-devices'); cryptoOwner(owner);
        if (census.error) throw new Error('Cannot verify the existing encrypted-message identity.');
        const devices = (census.data as { devices?: Array<{ id?: string; public_key?: string }> })?.devices;
        if (!Array.isArray(devices)) throw new Error('Cannot verify the existing encrypted-message identity.');
        if (devices.some((device) => device.id === legacyId && device.public_key === legacyPublic)) {
          const values = await Promise.all(required.map(readLegacyCryptoSecret)); cryptoOwner(owner);
          if (values.some((value) => !value)) throw new Error('The existing encrypted-message identity is incomplete.');
          const pending = await readLegacyCryptoSecret(SECURE_KEYS.MLS_PENDING_KEY_PACKAGE); cryptoOwner(owner);
          if (pending) {
            await writeCryptoSecret(owner, LEGACY_PENDING, pending);
          }
          await writeCryptoSecret(owner, SECURE_KEYS.REGISTERED_DEVICE_ID, legacyId);
          await persistIdentity(values as string[]);
        }
      }
    }
    const existing = await Promise.all(required.map((key) => readCryptoSecret(owner, key)));
    cryptoOwner(owner);
    if (existing.some((key) => !key)) {
      if (existing.some(Boolean)) throw new Error('The existing encrypted-message identity is incomplete.');
      const identity = await native.generateIdentityKeyPair(); cryptoOwner(owner);
      const device = await native.generateDeviceKeyPair(); cryptoOwner(owner);
      const values = [identity.privKeyB64, identity.pubKeyB64, device.ed25519PrivB64, device.ed25519PubB64, device.x25519PrivB64, device.x25519PubB64];
      if (values.some((value) => typeof value !== 'string' || !value)) throw new Error('Crypto identity generation failed.');
      await persistIdentity(values);
    }
    let deviceId = await readCryptoSecret(owner, SECURE_KEYS.REGISTERED_DEVICE_ID);
    if (!deviceId) {
      cryptoOwner(owner);
      const result = await opts.apiPost('/me/crypto-devices', { platform: Platform.OS }); cryptoOwner(owner);
      const data = result.data as { device?: { id?: unknown } } | null;
      if (result.error || typeof data?.device?.id !== 'string' || !data.device.id) throw new Error('Crypto device registration failed.');
      deviceId = data.device.id;
      await writeCryptoSecret(owner, SECURE_KEYS.REGISTERED_DEVICE_ID, deviceId);
    }
    const publicKey = await readCryptoSecret(owner, SECURE_KEYS.IDENTITY_PUBLIC_KEY); cryptoOwner(owner);
    const publishedIdentity = await opts.apiPost(`/me/crypto-devices/${encodeURIComponent(deviceId)}/public-key`, { publicKey }); cryptoOwner(owner);
    if (publishedIdentity.error) throw new Error('Crypto identity registration failed.');
    // Joining a Welcome records consumption in the SAME SQLCipher commit as
    // group state. Recover a crash before the separate Keychain cleanup here.
    for (const slot of [SECURE_KEYS.MLS_PENDING_KEY_PACKAGE, LEGACY_PENDING]) {
      const used = await readCryptoSecret(owner, slot);
      if (used && await pendingWasConsumed(owner, used)) {
        for (const key of slot === LEGACY_PENDING ? [slot] : [slot, PENDING_PUBLIC, PENDING_PUBLISHED]) {
          await deleteSecure(cryptoStorageKey(owner, key)); cryptoOwner(owner);
        }
      }
    }
    let pending = await readCryptoSecret(owner, SECURE_KEYS.MLS_PENDING_KEY_PACKAGE);
    let publicPackage = await readCryptoSecret(owner, PENDING_PUBLIC);
    // Legacy private material has its own bounded slot so a delayed old
    // Welcome remains decryptable while new conversations can obtain a key.
    if (!pending || !publicPackage) {
      const [priv, pub] = await Promise.all([
        readCryptoSecret(owner, SECURE_KEYS.DEVICE_ED25519_PRIVATE_KEY), readCryptoSecret(owner, SECURE_KEYS.DEVICE_ED25519_PUBLIC_KEY),
      ]);
      cryptoOwner(owner);
      if (!priv || !pub) throw new Error('Crypto device keys are missing.');
      const result = await native.generateKeyPackage(owner.ownerId, priv, pub); cryptoOwner(owner);
      if (!result.pendingStateB64 || !result.keyPackageB64) throw new Error('Key package generation failed.');
      pending = result.pendingStateB64; publicPackage = result.keyPackageB64;
      await writeCryptoSecret(owner, PENDING_PUBLIC, publicPackage);
      await writeCryptoSecret(owner, SECURE_KEYS.MLS_PENDING_KEY_PACKAGE, pending);
    }
    // Retry publication with exactly the same pending private/public pair. A
    // failed request or relaunch must not discard the key needed by a Welcome.
    if (await readCryptoSecret(owner, PENDING_PUBLISHED) === publicPackage) return;
    cryptoOwner(owner);
    const published = await opts.apiPost(`/me/devices/${encodeURIComponent(deviceId)}/key-packages`, { keyPackages: [publicPackage] });
    cryptoOwner(owner);
    if (published.error) throw new Error('Key package publication failed.');
    await writeCryptoSecret(owner, PENDING_PUBLISHED, publicPackage);
  });
}
