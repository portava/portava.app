import { isPublicPlaceRailPost } from './placeCollections.js';
import { filterCurrentPostAuthors } from '../postAuthorAudience.js';
import { readBlockExclusions } from '../exclusionSet.js';
import { authorizeMediaAccess } from '../mediaAccess.js';
import { postMediaStorageRef } from '../media/postMediaModerationHold.js';
import { NON_DISTRIBUTABLE_MEDIA_MODERATION_STATES } from '../mediaEligibility.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A valid, unassigned identity keeps anonymous PostgREST UUID filters valid.
const ANONYMOUS = '00000000-0000-0000-0000-000000000000';
export interface LivingDedupSample {
  mediaId: string;
  postId: string;
  mediaUrl: string;
  thumbnailUrl: string | null;
  mediaType: 'image';
}

async function rows(query: PromiseLike<any>): Promise<any[]> {
  const result = await query;
  if (result.error || !Array.isArray(result.data)) throw new Error('Dedup source unavailable');
  return result.data;
}

/** A stored ID is never a URL. Private storage keeps its canonical key so the
 * client's normal media hydration/relay remains the only byte grant. */
function mediaRef(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ref = postMediaStorageRef(value);
  if (ref.kind === 'object') return ref.bucket === 'post-media' ? `${ref.bucket}/${ref.path}` : null;
  if (ref.kind === 'unclean') return null;
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; }
  catch { return null; }
}

async function permittedRef(sc: any, viewerId: string, value: unknown): Promise<string | null> {
  const url = mediaRef(value);
  if (!url) return null;
  const ref = postMediaStorageRef(url);
  if (ref.kind === 'object' && !await authorizeMediaAccess(sc, viewerId, ref.bucket, ref.path)) return null;
  return url;
}

/** Resolve the small dedup sample at RESPONSE time, including warm/stale cache
 * hits. Cached IDs/counts/URLs never override current source policy. Only the
 * number of visible samples is exposed; the worker's member_count can include
 * private or withdrawn posts and does not mean distinct travelers. */
export async function projectLivingDedup(sc: any, payload: any, viewerId?: string): Promise<any> {
  const base = { ...payload, dedupGroups: [], dedupStatus: 'ready' };
  if (!Array.isArray(payload?.dedupGroups) || payload.dedupGroups.length === 0) return base;
  const viewer = viewerId || ANONYMOUS;
  try {
    const groups = await rows(sc.from('media_dedup_groups')
      .select('id,sample_media_ids').eq('canonical_place_id', payload.placeId)
      .order('member_count', { ascending: false }).limit(5));
    const sampleIds = (g: any): string[] => [...new Set<string>(Array.isArray(g.sample_media_ids)
      ? g.sample_media_ids.filter((id: unknown): id is string => typeof id === 'string' && UUID.test(id)) : [])].slice(0, 3);
    const ids = [...new Set(groups.flatMap(sampleIds))];
    if (!ids.length) return base;
    const media = await rows(sc.from('post_media').select('id,post_id,user_id,canonical_place_id,media_type,storage_bucket,storage_path,public_url,thumbnail_url,thumbnail_storage_path,processing_status,moderation_status').in('id', ids));
    const ready = media.filter(m => m.media_type === 'image' && m.processing_status === 'ready'
      && !NON_DISTRIBUTABLE_MEDIA_MODERATION_STATES.has(m.moderation_status)
      && m.canonical_place_id === payload.placeId && UUID.test(m.post_id));
    if (!ready.length) return base;
    const posts = await rows(sc.from('posts').select('id,author_id,visibility,status,post_status,canonical_place_id,location_privacy_mode,published_at,deleted_at')
      .in('id', [...new Set(ready.map(m => m.post_id))]));
    const publicPosts = posts.filter(p => p.canonical_place_id === payload.placeId && p.status === 'active' && typeof p.author_id === 'string' && p.deleted_at == null && isPublicPlaceRailPost(p));
    const authors = await filterCurrentPostAuthors(sc, viewer, publicPosts, { throwOnUnavailable: true });
    const blocks = viewerId ? await readBlockExclusions(sc, viewerId) : { ok: true as const, ids: new Set<string>() };
    if (!blocks.ok) throw new Error('Dedup block policy unavailable');
    const allowed = new Map(authors.filter(p => !blocks.ids.has(p.author_id)).map(p => [p.id, p]));
    const samples = new Map<string, LivingDedupSample>();
    await Promise.all(ready.map(async m => {
      const post = allowed.get(m.post_id);
      if (!post || m.user_id !== post.author_id) return;
      const original = await permittedRef(sc, viewer, m.storage_path ? `${m.storage_bucket}/${m.storage_path}` : m.public_url);
      if (!original) return;
      const thumbnail = await permittedRef(sc, viewer, m.thumbnail_storage_path ? `${m.storage_bucket}/${m.thumbnail_storage_path}` : m.thumbnail_url);
      samples.set(m.id, { mediaId: m.id, postId: m.post_id, mediaUrl: original, thumbnailUrl: thumbnail, mediaType: 'image' });
    }));
    return { ...base, dedupGroups: groups.flatMap(g => {
      const visible = sampleIds(g).flatMap(id => samples.has(id) ? [samples.get(id)!] : []);
      return visible.length ? [{ groupId: g.id, memberCount: visible.length, samples: visible,
        sampleUrls: visible.map(sample => sample.thumbnailUrl ?? sample.mediaUrl) }] : [];
    }) };
  } catch {
    return { ...base, dedupStatus: 'unavailable' };
  }
}
