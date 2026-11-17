import AsyncStorage from '@react-native-async-storage/async-storage';

// A failed/offline withdrawal must not silently resume collection after restart.
// This is an account-local feature preference, never an analytics record.
type Hold = { revision: number; pending: boolean; blocked: boolean; loaded: boolean; loading?: Promise<void>; writes: Promise<void> };
const holds = new Map<string, Hold>();
const listeners = new Set<(ownerId: string) => void>();
const key = (ownerId: string) => `portava:intel-consent-withdrawal:v1:${encodeURIComponent(ownerId)}`;
function entry(ownerId: string): Hold {
  let value = holds.get(ownerId);
  if (!value) { value = { revision: 0, pending: false, blocked: false, loaded: false, writes: Promise.resolve() }; holds.set(ownerId, value); }
  return value;
}
function notify(ownerId: string): void { for (const listener of listeners) { try { listener(ownerId); } catch {} } }
async function load(ownerId: string, value: Hold): Promise<void> {
  if (value.loaded) return;
  if (!value.loading) {
    const revision = value.revision;
    value.loading = AsyncStorage.getItem(key(ownerId)).then(stored => {
      if (value.revision === revision) value.blocked = value.blocked || stored !== null;
      value.loaded = true;
    }).finally(() => { value.loading = undefined; });
  }
  await value.loading;
}
function persist(ownerId: string, value: Hold, blocked: boolean): Promise<void> {
  const next = value.writes.catch(() => {}).then(() => blocked ? AsyncStorage.setItem(key(ownerId), '1') : AsyncStorage.removeItem(key(ownerId)));
  value.writes = next;
  return next;
}
export function onIntelConsentChange(listener: (ownerId: string) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export async function intelWithdrawalPending(ownerId: string): Promise<boolean> {
  const value = entry(ownerId); await load(ownerId, value); return value.blocked || value.pending;
}
/** Synchronous invalidation happens before storage, token refresh, or network. */
export function beginIntelConsentChange(ownerId: string, enabled: boolean) {
  const value = entry(ownerId);
  const revision = ++value.revision;
  value.pending = true;
  if (!enabled) value.blocked = true;
  notify(ownerId);
  const current = () => value.revision === revision;
  return {
    current,
    async prepare() {
      if (!enabled) { await persist(ownerId, value, true); value.loaded = true; }
      else await load(ownerId, value);
    },
    async settle(granted: boolean) {
      if (!current()) return;
      if (granted) {
        await persist(ownerId, value, false);
        if (!current()) return;
        value.blocked = false;
        value.loaded = true;
      }
      value.pending = false;
      notify(ownerId);
    },
  };
}
