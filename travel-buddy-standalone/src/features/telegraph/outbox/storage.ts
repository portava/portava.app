import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSecure, setSecure, deleteSecure, isNative } from '../../../lib/secureStore.ts';
import { webStorage } from './webStorage.ts';
import { validate } from './validate.ts';
import type { OutboxEntry, OutboxScope, OutboxStorage } from './types.ts';

// Native: message content lives only in Keychain/Keystore. The AsyncStorage
// index contains identifiers and chunk counts, never message text or keys.
// Each update writes a new immutable version, then atomically switches its index.
// A crash during a write therefore leaves the previous version readable.
const CHUNK_SIZE = 1500;
const ownerLocks = new Map<string, Promise<unknown>>();
function serialized<T>(ownerId: string, action: () => Promise<T>): Promise<T> {
  const work = (ownerLocks.get(ownerId) ?? Promise.resolve()).catch(() => {}).then(action);
  ownerLocks.set(ownerId, work);
  void work.finally(() => { if (ownerLocks.get(ownerId) === work) ownerLocks.delete(ownerId); }).catch(() => {});
  return work;
}
const hex = (value: string) => Array.from(value).map((c) => c.codePointAt(0)!.toString(16).padStart(6, '0')).join('');
const indexKey = (ownerId: string) => `telegraph.outbox.v1.${ownerId}`;
interface NativeRef { clientId: string; sessionId: string; key: string; count: number; staging?: boolean }
async function readIndex(ownerId: string): Promise<NativeRef[]> {
  const raw = await AsyncStorage.getItem(indexKey(ownerId));
  if (!raw) return [];
  const refs: unknown = JSON.parse(raw);
  if (!Array.isArray(refs) || refs.some((r) => !r || typeof r.key !== 'string' || !r.key.startsWith(`telegraph.outbox.${hex(ownerId)}.`) || !Number.isInteger(r.count) || r.count < 1 || r.count > 200 || typeof r.sessionId !== 'string' || typeof r.clientId !== 'string')) throw new Error('The pending-message index is damaged.');
  return refs;
}
async function removeChunks(ref: NativeRef) {
  await Promise.all(Array.from({ length: ref.count }, (_, i) => deleteSecure(`${ref.key}.${i}`)));
}
const nativeStorage: OutboxStorage = {
  read: (scope) => serialized(scope.ownerId, async () => {
    const refs = (await readIndex(scope.ownerId)).filter((r) => r.sessionId === scope.sessionId && !r.staging);
    return Promise.all(refs.map(async (ref) => {
      const chunks = await Promise.all(Array.from({ length: ref.count }, (_, i) => getSecure(`${ref.key}.${i}`)));
      if (chunks.some((chunk) => chunk === null)) throw new Error('A pending message could not be recovered from secure storage.');
      return validate(JSON.parse(chunks.join('')), scope, ref.clientId);
    }));
  }),
  put: (entry, onlyIfPresent) => serialized(entry.ownerId, async () => {
    const refs = await readIndex(entry.ownerId);
    if (onlyIfPresent && !refs.some((r) => r.clientId === entry.clientId && r.sessionId === entry.sessionId && !r.staging)) throw new Error('Pending message was removed.');
    const raw = JSON.stringify(entry);
    const count = Math.ceil(raw.length / CHUNK_SIZE);
    if (count > 200 || refs.length >= 200 && !refs.some((ref) => ref.clientId === entry.clientId && ref.sessionId === entry.sessionId)) throw new Error('Pending-message storage is full.');
    const key = `telegraph.outbox.${hex(entry.ownerId)}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
    const ref: NativeRef = { clientId: entry.clientId, sessionId: entry.sessionId, key, count };
    try {
      // Journal even incomplete secure chunks so sign-out can erase them after a crash.
      await AsyncStorage.setItem(indexKey(entry.ownerId), JSON.stringify([...refs, { ...ref, staging: true }]));
      for (let i = 0; i < count; i++) {
        const chunk = raw.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        await setSecure(`${key}.${i}`, chunk);
        if (await getSecure(`${key}.${i}`) !== chunk) throw new Error('Secure storage is unavailable. Message was not sent.');
      }
      const previous = refs.find((r) => r.clientId === entry.clientId && r.sessionId === entry.sessionId);
      const next = refs.filter((r) => r !== previous);
      await AsyncStorage.setItem(indexKey(entry.ownerId), JSON.stringify([...next, ref]));
      if (previous) await removeChunks(previous).catch(() => {});
    } catch (error) {
      await removeChunks(ref).catch(() => {});
      await AsyncStorage.setItem(indexKey(entry.ownerId), JSON.stringify(refs)).catch(() => {});
      throw error;
    }
  }),
  remove: (scope, clientId) => serialized(scope.ownerId, async () => {
    const refs = await readIndex(scope.ownerId);
    const removed = refs.filter((r) => r.clientId === clientId && r.sessionId === scope.sessionId);
    await AsyncStorage.setItem(indexKey(scope.ownerId), JSON.stringify(refs.map((r) => removed.includes(r) ? { ...r, staging: true } : r)));
    await Promise.all(removed.map(removeChunks));
    await AsyncStorage.setItem(indexKey(scope.ownerId), JSON.stringify(refs.filter((r) => !removed.includes(r))));
  }),
  clearOwner: (ownerId) => serialized(ownerId, async () => {
    const refs = await readIndex(ownerId);
    await Promise.all(refs.map(removeChunks));
    await AsyncStorage.removeItem(indexKey(ownerId));
  }),
};

export const encryptedOutboxStorage: OutboxStorage = {
  read: (scope) => isNative() ? nativeStorage.read(scope) : serialized(scope.ownerId, () => webStorage.read(scope)),
  put: (entry, onlyIfPresent) => isNative() ? nativeStorage.put(entry, onlyIfPresent) : serialized(entry.ownerId, () => webStorage.put(entry, onlyIfPresent)),
  remove: (scope, clientId) => isNative() ? nativeStorage.remove(scope, clientId) : serialized(scope.ownerId, () => webStorage.remove(scope, clientId)),
  clearOwner: (ownerId) => isNative() ? nativeStorage.clearOwner(ownerId) : serialized(ownerId, () => webStorage.clearOwner(ownerId)),
};
