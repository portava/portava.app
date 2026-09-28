/**
 * mediaCacheDevice — the device effects behind mediaCache: AsyncStorage for
 * payloads, the app's document directory for images, the signed-in account,
 * and the sign endpoint.
 *
 * Signing goes straight to batchSignUrls, NOT through mediaUrl.hydrateMediaUrls:
 * the hydration layer falls back to THIS cache's files when signing is
 * unreachable, and a cache that "signed" a ref with its own copy would be
 * storing a copy of a copy it may no longer be allowed to hold.
 */
import type { CacheEnv, CacheFiles } from './mediaCache.ts';

async function deviceFiles(): Promise<CacheFiles | null> {
  try {
    const fs = await import('expo-file-system/legacy');
    const root = fs.documentDirectory;
    if (!root) return null;
    const made = new Set<string>();
    return {
      dirFor: (accountId) => `${root}media-offline/${accountId}/`,
      async download(url, toUri) {
        try {
          const dir = toUri.slice(0, toUri.lastIndexOf('/') + 1);
          if (!made.has(dir)) {
            await fs.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
            made.add(dir);
          }
          const res = await fs.downloadAsync(url, toUri);
          if (res.status < 200 || res.status >= 300) {
            await fs.deleteAsync(toUri, { idempotent: true }).catch(() => {});
            return null;
          }
          const info = await fs.getInfoAsync(toUri);
          return info.exists ? info.size : null;
        } catch {
          return null;
        }
      },
      remove: (uri) => fs.deleteAsync(uri, { idempotent: true }),
    };
  } catch {
    return null;
  }
}

export async function deviceCacheEnv(): Promise<CacheEnv> {
  const storage = (await import('@react-native-async-storage/async-storage')).default;
  return {
    storage: {
      getItem: (k) => storage.getItem(k),
      setItem: (k, v) => storage.setItem(k, v),
      removeItem: (k) => storage.removeItem(k),
    },
    files: await deviceFiles(),
    accountId: async () => {
      const { getCurrentAccountId } = await import('../accountId.ts');
      return getCurrentAccountId();
    },
    now: () => Date.now(),
    async sign(refs) {
      const { batchSignUrls } = await import('../../lib/batchSignMedia.ts');
      const { isPrivateMediaRef } = await import('../mediaUrl.ts');
      const out: Record<string, string | null> = {};
      const privateRefs = refs.filter(isPrivateMediaRef);
      // Only private references are stored: they are the ones mediaUrl.hydrateMediaUrls
      // can serve from the cache (a public URL passes through it untouched).
      for (const ref of refs) if (!privateRefs.includes(ref)) out[ref] = null;
      if (privateRefs.length > 0) {
        const signed = await batchSignUrls(privateRefs);
        // batchSignUrls hands back the ORIGINAL ref when it could not sign it.
        for (const ref of privateRefs) {
          const s = signed.get(ref);
          out[ref] = s && s !== ref ? s : null;
        }
      }
      return out;
    },
  };
}
