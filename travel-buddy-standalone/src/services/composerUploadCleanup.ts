import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchOwnedApi } from './ownedApiRequest.ts';
import type { MessagingOwnerRequest } from './messagingOwnerRequest.ts';
const chains = new Map<string, Promise<unknown>>();
/** Durable per-account cleanup journal. IDs only; draft text/media stay in their
 * feature store. Each explicit discard and foreground retries failed cleanup. */
export async function retryComposerUploadCleanup(owner: MessagingOwnerRequest, operation?: string): Promise<{
    published: string[];
    pending: string[];
}> {
    const key = `rumazi.composer-upload-cleanup.v1:${owner.ownerId}`;
    const work = (chains.get(key) ?? Promise.resolve()).catch(() => { }).then(async () => {
        const published: string[] = [];
        const raw = await AsyncStorage.getItem(key);
        const stored: unknown = raw === null ? [] : JSON.parse(raw);
        if (!Array.isArray(stored) || stored.some(value => typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)))
            throw new Error('Upload cleanup could not be read.');
        const ids = [...new Set([...stored as string[], ...(operation ? [operation] : [])])];
        await AsyncStorage.setItem(key, JSON.stringify(ids));
        for (const id of ids) {
            if (!owner.isCurrent())
                return { published, pending: JSON.parse(await AsyncStorage.getItem(key) ?? '[]') as string[] };
            try {
                const response = await fetchOwnedApi(`/api/media/drafts/${encodeURIComponent(id)}`, { method: 'DELETE', owner });
                if (!response.ok && response.status !== 409)
                    continue;
                if (response.status === 409) {
                    const receipt: unknown = await response.json();
                    if (!receipt || typeof receipt !== 'object' || !('error' in receipt) || receipt.error !== 'already_published') continue;
                    published.push(id);
                }
                // 409 means already published, which must never be removed as a draft.
                const current = JSON.parse(await AsyncStorage.getItem(key) ?? '[]') as string[];
                await AsyncStorage.setItem(key, JSON.stringify(current.filter(value => value !== id)));
            }
            catch { /* persisted for the next explicit action or foreground */ }
        }
        return { published, pending: JSON.parse(await AsyncStorage.getItem(key) ?? '[]') as string[] };
    });
    chains.set(key, work);
    try {
        return await work;
    }
    finally {
        if (chains.get(key) === work)
            chains.delete(key);
    }
}
