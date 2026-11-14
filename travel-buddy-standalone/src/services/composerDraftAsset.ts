import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { cleanLocalComposerAssets } from './localComposerAssetCleanup.ts';
import type { MessagingOwnerRequest } from './messagingOwnerRequest.ts';
import { preserveNativeDraftAsset, discardNativeDraftAsset, restoreNativeDraftAsset } from './nativeComposerAssets.ts';
/** App-owned local copy; no pre-publication network transfer. Fail visibly when
 * durable local files are unavailable instead of claiming a cached pick is saved. */
export async function preserveDraftAsset(uri: string, owner: MessagingOwnerRequest): Promise<string> {
    if (!owner.isCurrent())
        throw new Error('The draft account changed.');
    if (Platform.OS === 'web') {
        const { preserveBrowserDraftAsset, discardBrowserDraftAsset } = await import('./browserComposerAssets.ts');
        const result = await preserveBrowserDraftAsset(owner.ownerId, uri);
        if (!owner.isCurrent()) {
            await discardBrowserDraftAsset(owner.ownerId, result);
            throw new Error('The draft account changed.');
        }
        return result;
    }
    const fs = await import('expo-file-system/legacy');
    return preserveNativeDraftAsset(fs, uri, owner);
}
export async function discardDraftAsset(uri: string | null | undefined, accountId: string): Promise<void> {
    if (!uri)
        return;
    await cleanLocalComposerAssets(AsyncStorage, accountId, target => removeDraftAsset(target, accountId), uri);
}
async function removeDraftAsset(uri: string, accountId: string): Promise<void> {
    if (Platform.OS === 'web') {
        const { discardBrowserDraftAsset } = await import('./browserComposerAssets.ts');
        await discardBrowserDraftAsset(accountId, uri);
        return;
    }
    const fs = await import('expo-file-system/legacy');
    await discardNativeDraftAsset(fs, uri, accountId);
}
export async function retryDraftAssetCleanup(owner: MessagingOwnerRequest): Promise<void> {
    if (!owner.isCurrent()) return;
    await cleanLocalComposerAssets(AsyncStorage, owner.ownerId, async target => {
        if (!owner.isCurrent()) throw new Error('The draft account changed.');
        await removeDraftAsset(target, owner.ownerId);
    });
}
export async function restoreDraftAsset(uri: string, accountId: string): Promise<string> {
    if (Platform.OS === 'web') {
        const { restoreBrowserDraftAsset } = await import('./browserComposerAssets.ts');
        return restoreBrowserDraftAsset(accountId, uri);
    }
    const fs = await import('expo-file-system/legacy');
    return restoreNativeDraftAsset(fs, uri, accountId);
}

/** A restored browser URL owns a temporary Blob reference, not the saved draft. */
export function releaseDraftPreview(uri: string | null | undefined): void {
  if (Platform.OS === 'web' && uri?.startsWith('blob:')) URL.revokeObjectURL(uri);
}
