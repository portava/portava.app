import { authorizeMediaAccess } from '../lib/mediaAccess.js';
import { postMediaStorageRef, postMediaModerationHold } from '../lib/media/postMediaModerationHold.js';
import { mediaKindForPath, synthesizeMediaItems } from '../lib/media/storageBackedPostMedia.js';

export interface SharedPostMedia {
  type: 'image' | 'video';
  uri: string;
  thumbnailUri: string | null;
}

/** Normalize to the private Portava bucket. Recipients never load a sender-selected host. */
function ownedKey(raw: unknown, authorId: string): string | null {
  if (typeof raw !== 'string') return null;
  const ref = postMediaStorageRef(raw);
  if (ref.kind !== 'object' || ref.bucket !== 'post-media' || !ref.path.startsWith(authorId + '/')) return null;
  return 'post-media/' + ref.path;
}

/** Call only after checking the destination and source audience for this viewer. */
export async function projectSharedPostMedia(sc: any, post: {
  id: string; author_id: string; media_urls?: string[]; media_type?: string; primary_media_type?: string;
}, viewerId: string): Promise<SharedPostMedia[]> {
  const { data, error } = await sc.from('post_media')
    .select('storage_path,media_type,public_url,thumbnail_url,sort_order,processing_status,moderation_status')
    .eq('post_id', post.id);
  if (error || !Array.isArray(data)) throw new Error('source_media_unavailable');
  // A rejected or processing row must never fall through to its old media_urls entry.
  const rows = data.length
    ? data.filter(row => row.processing_status === 'ready' && ['approved', 'pending'].includes(row.moderation_status))
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(row => ({ url: row.public_url, thumbnail_url: row.thumbnail_url, media_type: row.media_type, storage_path: row.storage_path }))
    : synthesizeMediaItems(post, new Map()).map(row => ({...row, storage_path: null}));
  const media: SharedPostMedia[] = [];
  for (const row of rows) {
    const uri = ownedKey(row.url, post.author_id);
    if (!uri || (row.storage_path && uri !== 'post-media/' + row.storage_path)) continue;
    const poster = ownedKey(row.thumbnail_url, post.author_id);
    media.push({type: mediaKindForPath(uri, row.media_type, row.media_type), uri, thumbnailUri: poster});
  }
  if (!media.length) return [];
  const paths = [...new Set(media.flatMap(item => [item.uri, ...(item.thumbnailUri ? [item.thumbnailUri] : [])]).map(key => key.slice('post-media/'.length)))];
  const ledger = await sc.from('post_media_moderation_ledger').select('storage_path').in('storage_path', paths);
  if (ledger.error || !Array.isArray(ledger.data)) throw new Error('source_media_unavailable');
  const held = new Set(ledger.data.map((row: {storage_path: string}) => 'post-media/' + row.storage_path));
  const allowed = media.filter(item => !held.has(item.uri)).map(item =>
    ({ ...item, thumbnailUri: item.thumbnailUri && !held.has(item.thumbnailUri) ? item.thumbnailUri : null }));
  const stage = await postMediaModerationHold(sc, allowed.map(item => item.uri));
  if (stage.state === 'unknown') throw new Error('source_media_unavailable');
  if (stage.state !== 'clear') return [];
  const checked = await Promise.all(allowed.map(async item => {
    const readable = (uri: string) => authorizeMediaAccess(sc, viewerId, 'post-media', uri.slice('post-media/'.length));
    if (!(await readable(item.uri))) return null;
    const thumbnailUri = item.thumbnailUri && await readable(item.thumbnailUri) ? item.thumbnailUri : null;
    return { ...item, thumbnailUri };
  }));
  return checked.filter((item): item is SharedPostMedia => item !== null);
}
