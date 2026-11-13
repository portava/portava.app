import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchOwnedApi } from './ownedApiRequest.ts';
import type { MessagingOwnerRequest } from './messagingOwnerRequest.ts';
import { isComposerOutcomeEvent, type ComposerOutcomeEvent } from './composerOutcome.ts';
// One account/session queue shared by composers. It contains enum-only events.
const pending = new Map<string, ComposerOutcomeEvent[]>();
const chains = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, op: () => Promise<T>): Promise<T> {
    const work = (chains.get(key) ?? Promise.resolve()).catch(() => { }).then(op);
    chains.set(key, work);
    void work.finally(() => { if (chains.get(key) === work)
        chains.delete(key); }).catch(() => { });
    return work;
}
export async function deliverComposerOutcome(owner: MessagingOwnerRequest | null, allowed: () => boolean, event?: ComposerOutcomeEvent): Promise<boolean> {
    if (event && !isComposerOutcomeEvent(event))
        return false;
    const key = owner ? `rumazi.composer-outcomes.v1:${owner.ownerId}` : null;
    const memoryKey = owner ? `${key}:${owner.sessionId}` : null;
    if (!owner?.isCurrent() || !key)
        return false;
    return await serialize(key, async () => {
        if (!owner.isCurrent())
            return;
        for (const existing of pending.keys())
            if (existing.startsWith(`${key}:`) && existing !== memoryKey)
                pending.delete(existing);
        if (!allowed()) {
            pending.delete(memoryKey!);
            await AsyncStorage.removeItem(key);
            return;
        }
        let events = pending.get(memoryKey!);
        if (!events) {
            const raw = await AsyncStorage.getItem(key);
            const saved = raw ? JSON.parse(raw) as {
                session?: unknown;
                events?: unknown;
            } : null;
            events = saved?.session === owner.sessionId && Array.isArray(saved.events) ? saved.events.filter(isComposerOutcomeEvent).slice(-50) : [];
        }
        if (!owner.isCurrent() || !allowed())
            return;
        if (event && !events.some(row => row.event_id === event.event_id))
            events = [...events.slice(-49), event];
        pending.set(memoryKey!, events);
        if (!events.length) {
            await AsyncStorage.removeItem(key);
            return;
        }
        // Persist IDs before send; an interrupted acknowledgement retries the same IDs.
        await AsyncStorage.setItem(key, JSON.stringify({ session: owner.sessionId, events }));
        const response = await fetchOwnedApi('/api/media/analytics/composer-outcomes', { method: 'POST', body: { events }, owner, isCurrent: () => allowed() });
        if (!response.ok || !owner.isCurrent() || !allowed())
            return;
        const receipt: unknown = await response.json();
        if (!receipt || typeof receipt !== 'object' || !('accepted' in receipt) || receipt.accepted !== events.length)
            return;
        await AsyncStorage.removeItem(key);
        pending.delete(memoryKey!);
        return true;
    }).catch(() => false) === true;
}
