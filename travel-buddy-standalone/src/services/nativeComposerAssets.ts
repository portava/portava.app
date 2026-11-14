import { newClientEventId } from './clientEventId.ts';
import type { MessagingOwnerRequest } from './messagingOwnerRequest.ts';
export interface DraftFileSystem {
  documentDirectory: string | null;
  makeDirectoryAsync(uri: string, options: { intermediates: boolean }): Promise<void>;
  copyAsync(options: { from: string; to: string }): Promise<void>;
  deleteAsync(uri: string, options: { idempotent: boolean }): Promise<void>;
  getInfoAsync(uri: string): Promise<{ exists: boolean }>;
}
function prefix(fs: DraftFileSystem, accountId: string): string {
  if (!fs.documentDirectory) throw new Error('Draft media storage is unavailable.');
  return `${fs.documentDirectory}composer-drafts/${encodeURIComponent(accountId)}/`;
}
const owned = (uri: string, folder: string) => uri.startsWith(folder) && !uri.includes('..') && !uri.includes('\\');
export async function preserveNativeDraftAsset(fs: DraftFileSystem, uri: string, owner: MessagingOwnerRequest): Promise<string> {
  if (!owner.isCurrent()) throw new Error('The draft account changed.');
  const folder = prefix(fs, owner.ownerId);
  if (owned(uri, folder)) return uri;
  await fs.makeDirectoryAsync(folder, { intermediates: true });
  // Keep only a codec extension, never the user-selected filename.
  const extension = /\.(jpg|jpeg|png|webp|heic|heif|mp4|mov|m4v)$/i.exec(uri.split(/[?#]/)[0]!)?.[0]?.toLowerCase() ?? '';
  const path = `${folder}${newClientEventId()}${extension}`;
  try { await fs.copyAsync({ from: uri, to: path }); }
  catch { await fs.deleteAsync(path, { idempotent: true }).catch(() => {}); throw new Error('Draft media could not be saved.'); }
  if (!owner.isCurrent()) { await fs.deleteAsync(path, { idempotent: true }); throw new Error('The draft account changed.'); }
  return path;
}
export async function discardNativeDraftAsset(fs: DraftFileSystem, uri: string, accountId: string): Promise<void> {
  if (owned(uri, prefix(fs, accountId))) await fs.deleteAsync(uri, { idempotent: true });
}
export async function restoreNativeDraftAsset(fs: DraftFileSystem, uri: string, accountId: string): Promise<string> {
  if (!owned(uri, prefix(fs, accountId)) || !(await fs.getInfoAsync(uri)).exists) throw new Error('Saved media is missing on this device.');
  return uri;
}
