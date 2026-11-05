import { filterCurrentPostAuthors } from '../postAuthorAudience.js';
import { readBlockExclusions } from '../exclusionSet.js';
import { isPostPublished, canReadPost } from '../postVisibility.js';
import { postPlaceWithheldFrom } from '../postPlaceDisclosure.js';
import { postMediaStorageRef } from '../media/postMediaModerationHold.js';
import { toCanonicalModerationStatus, toStoredMediaVisibility } from '../media/mediaAssetContract.js';
import { mayViewUnderOverride } from '../mediaVisibility.js';
import { NON_DISTRIBUTABLE_MEDIA_MODERATION_STATES } from '../mediaEligibility.js';

const ANONYMOUS = '00000000-0000-0000-0000-000000000000';
const MAX_POSTS = 160;
const SHELVES = ['videos', 'photos', 'viewpoints', 'foodNearby', 'experiences'];
const POST_COLUMNS = 'id,author_id,trip_id,visibility,status,post_status,publish_at,published_at,canonical_place_id,location_privacy_mode,deleted_at,updated_at,created_at,content,media_urls,media_type,media_thumbnail_url,post_buckets,like_count';
const MEDIA_COLUMNS = 'id,post_id,user_id,storage_bucket,storage_path,public_url,thumbnail_url,thumbnail_storage_path,media_type,processing_status,moderation_status,sort_order';

async function all(query: PromiseLike<any>): Promise<any[]> {
  const result = await query;
  if (result?.error || !Array.isArray(result?.data) || typeof result.count === 'number' && result.count > result.data.length) throw new Error('Community source unavailable');
  return result.data;
}

function ref(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = postMediaStorageRef(value);
  if (parsed.kind === 'object') return parsed.bucket === 'post-media' ? `${parsed.bucket}/${parsed.path}` : null;
  if (parsed.kind === 'unclean') return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

function objectPath(value: string): string | null {
  const parsed = postMediaStorageRef(value);
  return parsed.kind === 'object' ? parsed.path : null;
}

/** A bounded, batched current-source read. The cache orders IDs; it does not
 * authorize captions, images, author identities, or association with a place. */
export async function readLivingCommunityPosts(sc: any, ids: string[], placeId: string, viewerId?: string): Promise<Map<string, any>> {
  ids = [...new Set(ids)];
  if (ids.length > MAX_POSTS) throw new Error('Community source page is too large');
  if (!ids.length) return new Map();
  const viewer = viewerId || ANONYMOUS;
  const source = await all(sc.from('posts').select(POST_COLUMNS, { count: 'exact' }).in('id', ids).limit(MAX_POSTS));
  const publicRows = source.filter(p => p.canonical_place_id === placeId && p.status === 'active' && p.deleted_at == null
    && typeof p.author_id === 'string' && isPostPublished(p) && canReadPost(p, ANONYMOUS, false, false)
    && (!p.publish_at || Number.isFinite(Date.parse(p.publish_at)) && Date.parse(p.publish_at) <= Date.now())
    && !postPlaceWithheldFrom(p, viewerId));
  const [authors, blocks] = await Promise.all([
    filterCurrentPostAuthors(sc, viewer, publicRows, { throwOnUnavailable: true }),
    viewerId ? readBlockExclusions(sc, viewerId) : Promise.resolve({ ok: true as const, ids: new Set<string>() }),
  ]);
  if (!blocks.ok) throw new Error('Community block policy unavailable');
  const posts = authors.filter(p => !blocks.ids.has(p.author_id));
  if (!posts.length) return new Map();
  const media = await all(sc.from('post_media').select(MEDIA_COLUMNS, { count: 'exact' }).in('post_id', posts.map(p => p.id)).limit(1600));
  const candidates = posts.map(post => {
    const attached = media.filter(m => m.post_id === post.id).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const first = attached.find(m => m.user_id === post.author_id && m.processing_status === 'ready'
      && !NON_DISTRIBUTABLE_MEDIA_MODERATION_STATES.has(m.moderation_status));
    const original = first ? ref(first.storage_path ? `${first.storage_bucket}/${first.storage_path}` : first.public_url)
      : attached.length ? null : ref(post.media_urls?.[0]);
    return { post, first, original, thumbnail: original ? ref(first?.thumbnail_storage_path ? `${first.storage_bucket}/${first.thumbnail_storage_path}` : first?.thumbnail_url ?? post.media_thumbnail_url) : null };
  });
  const urls = [...new Set(candidates.flatMap(c => [c.original, c.thumbnail].filter((v): v is string => !!v)))];
  const paths = [...new Set(urls.map(objectPath).filter((v): v is string => !!v))];
  // No per-photo round trips for ordinary public media. All canonical assets,
  // retained moderation and attachment overrides are read once for the page.
  const [byPath, byUrl, ledger] = await Promise.all([
    paths.length ? all(sc.from('media_assets').select('id,owner_user_id,storage_bucket,storage_path,public_url,moderation_status,processing_status,visibility,deleted_at', { count: 'exact' }).in('storage_path', paths).limit(640)) : [],
    urls.length ? all(sc.from('media_assets').select('id,owner_user_id,storage_bucket,storage_path,public_url,moderation_status,processing_status,visibility,deleted_at', { count: 'exact' }).in('public_url', urls).limit(640)) : [],
    paths.length ? all(sc.from('post_media_moderation_ledger').select('storage_path,verdict', { count: 'exact' }).in('storage_path', paths).limit(640)) : [],
  ]);
  const assets = [...new Map([...byPath, ...byUrl].map(a => [a.id, a])).values()];
  const attachments = assets.length ? await all(sc.from('media_attachments').select('media_asset_id,entity_id,visibility_override', { count: 'exact' })
    .eq('entity_type', 'post').in('media_asset_id', assets.map(a => a.id)).in('entity_id', posts.map(p => p.id)).limit(1600)) : [];
  const out = new Map<string, any>();
  for (const { post, first, original, thumbnail } of candidates) {
    const allowed = async (url: string | null, isOriginal: boolean): Promise<boolean> => {
      if (!url) return false;
      const path = objectPath(url);
      const matching = assets.filter(a => ref(a.public_url) === url || path !== null && a.storage_bucket === 'post-media' && a.storage_path === path);
      for (const asset of matching) {
        if (asset.deleted_at != null || toCanonicalModerationStatus(asset.moderation_status) !== 'active'
          || asset.processing_status !== 'ready' || asset.owner_user_id !== post.author_id) return false;
        const options = { entity: { entityType: 'post', entityId: post.id }, context: post.trip_id ? { contextType: 'trip' as const, contextId: post.trip_id } : undefined };
        if (!await mayViewUnderOverride(sc, viewer, post.author_id, toStoredMediaVisibility(asset.visibility), options)) return false;
        for (const attachment of attachments.filter(a => a.media_asset_id === asset.id && a.entity_id === post.id)) {
          if (!await mayViewUnderOverride(sc, viewer, post.author_id, attachment.visibility_override, options)) return false;
        }
      }
      // Explicit current clearance can represent a successful appeal. A bare
      // legacy URL cannot bypass a retained rejection after attachment removal.
      const cleared = isOriginal && first && ['approved', 'active'].includes(first.moderation_status);
      if (!cleared && path && ledger.some(row => row.storage_path === path && ['rejected', 'flagged'].includes(row.verdict))) return false;
      return true;
    };
    const mediaUrl = await allowed(original, true) ? original : null;
    const thumbnailUrl = mediaUrl && await allowed(thumbnail, false) ? thumbnail : null;
    out.set(post.id, { id: post.id, mediaUrl, thumbnailUrl, caption: post.content ?? null, authorId: post.author_id,
      createdAt: post.created_at ?? null, mediaType: first?.media_type ?? post.media_type ?? null,
      buckets: Array.isArray(post.post_buckets) ? post.post_buckets : [], like_count: post.like_count ?? null,
      _updatedAt: post.updated_at ?? null });
  }
  return out;
}

export async function projectLivingCommunity(sc: any, payload: any, viewerId?: string): Promise<any> {
  const { _officialHeroImageUrl, ...clean } = payload;
  const empty = { ...clean, communityStatus: 'unavailable', hero: { imageUrl: _officialHeroImageUrl ?? null, videoUrl: null },
    bestOf: payload.bestOf ? Object.fromEntries(SHELVES.map(key => [key, []])) : null,
    buckets: (payload.buckets ?? []).map((b: any) => ({ ...b, posts: [], postCount: null })),
    timeline: payload.timeline ? { ...payload.timeline, posts: [] } : payload.timeline, aiSummary: null, topContributor: null, rating: null };
  try {
    const summary = payload.aiSummary ? await sc.from('place_ai_summaries').select('text,generated_at,post_ids_used').eq('place_id', payload.placeId).maybeSingle() : null;
    if (summary?.error) throw new Error('Summary provenance unavailable');
    const summaryIds: string[] = Array.isArray(summary?.data?.post_ids_used) ? summary.data.post_ids_used.filter((id: unknown) => typeof id === 'string') : [];
    const lists = [...(payload.timeline?.posts ?? []), ...(payload.buckets ?? []).flatMap((b: any) => b.posts ?? []), ...SHELVES.flatMap(key => payload.bestOf?.[key] ?? [])];
    const ids = [...new Set<string>([...lists.map((item: any) => item.postId ?? item.id).filter((id: unknown) => typeof id === 'string'), ...summaryIds])];
    const current = await readLivingCommunityPosts(sc, ids, payload.placeId, viewerId);
    const publicPost = (row: any) => { const { _updatedAt, ...rest } = row; return rest; };
    const mapList = (list: any[]) => list.flatMap(item => { const row = current.get(item.postId ?? item.id); return row ? [publicPost(row)] : []; });
    const bestOf = payload.bestOf ? Object.fromEntries(SHELVES.map(key => [key, (payload.bestOf[key] ?? []).flatMap((item: any) => {
      const row = current.get(item.postId ?? item.id); return row?.mediaUrl ? [{ postId: row.id, mediaUrl: row.mediaUrl, thumbnailUrl: row.thumbnailUrl, mediaType: row.mediaType, caption: row.caption }] : [];
    })])) : null;
    const summaryCurrent = summaryIds.length >= 3 && summary.data.text === payload.aiSummary.text && summary.data.generated_at === payload.aiSummary.generatedAt
      && summaryIds.every(id => { const row = current.get(id); return row && row._updatedAt && Date.parse(row._updatedAt) <= Date.parse(summary.data.generated_at); });
    const lostSource = current.size < ids.length;
    return { ...clean, communityStatus: 'ready',
      hero: { imageUrl: bestOf?.photos[0]?.mediaUrl ?? _officialHeroImageUrl ?? null, videoUrl: bestOf?.videos[0]?.mediaUrl ?? null }, bestOf,
      buckets: (payload.buckets ?? []).map((b: any) => ({ ...b, posts: mapList(b.posts ?? []).map((p: any) => ({ id: p.id, mediaUrl: p.mediaUrl, thumbnailUrl: p.thumbnailUrl, caption: p.caption })), ...(lostSource ? { postCount: null } : {}) })),
      timeline: payload.timeline ? { ...payload.timeline, posts: mapList(payload.timeline.posts ?? []).map((p: any) => { const { mediaType, buckets, ...rest } = p; return rest; }) } : payload.timeline,
      aiSummary: summaryCurrent ? payload.aiSummary : null,
      topContributor: payload.topContributor && [...current.values()].some(row => row.authorId === payload.topContributor.userId) && !lostSource ? payload.topContributor : null,
      rating: lostSource ? null : payload.rating };
  } catch { return empty; }
}
