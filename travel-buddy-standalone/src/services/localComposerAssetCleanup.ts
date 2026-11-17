/** Local operational journal only. Never exported to analytics or the network. */
export interface LocalCleanupStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
const chains = new Map<string, Promise<unknown>>();
export const localAssetCleanupKey = (account: string) => `rumazi.composer-asset-cleanup.v1:${encodeURIComponent(account)}`;
export async function cleanLocalComposerAssets(storage: LocalCleanupStorage, account: string, remove: (uri: string) => Promise<void>, uri?: string): Promise<void> {
  const key = localAssetCleanupKey(account);
  const work = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const raw = await storage.getItem(key);
    const saved: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(saved) || saved.some(value => typeof value !== 'string' || !value)) throw new Error('Local media cleanup journal is unreadable.');
    let pending = [...new Set<string>([...saved, ...(uri ? [uri] : [])])];
    if (uri) await storage.setItem(key, JSON.stringify(pending));
    for (const target of [...pending]) {
      try { await remove(target); } catch { continue; }
      pending = pending.filter(value => value !== target);
      // A failed acknowledgement safely repeats the idempotent delete.
      await storage.setItem(key, JSON.stringify(pending));
    }
    if (pending.length) throw new Error('Local media cleanup is pending.');
    await storage.removeItem(key);
  });
  chains.set(key, work);
  try { await work; } finally { if (chains.get(key) === work) chains.delete(key); }
}
