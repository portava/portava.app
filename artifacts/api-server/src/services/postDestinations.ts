import { readSharedPostSource } from './sharedPostSource.js';
import type { SharedPostMedia } from './sharedPostMedia.js';
import { excludePrivateAuthorPosts } from '../lib/privacyFilter.js';
import { isBlockedBetween } from '../lib/blockGuard.js';
import { canReadMemory } from './memory/memoryReadPolicy.js';
import { decideHighlightViewAccess } from '../routes/highlights.js';
import { resolveAccountRestriction } from '../lib/accountStateGate.js';
import { hiddenItemKeys, itemKey } from './memory/memoryItemVisibility.js';

export const POST_REFERENCE_MEDIA_TYPE = 'application/vnd.portava.post-reference+json';
export const POST_REFERENCE_URI_PREFIX = 'portava-post-reference:';
export type PostReferenceView = { available: true; postId: string; author: string; text: string; media: SharedPostMedia[] }
  | { available: false };

/** Resolve without exposing removal reasons or version metadata on a public destination. */
export async function readReferenceSource(sc: any, postId: string, viewerId: string): Promise<PostReferenceView> {
  const result = await readSharedPostSource(sc, postId, viewerId);
  if (!result.available) return { available: false };
  const { version: _version, ...source } = result;
  return source;
}

/** Destination visibility is checked BEFORE the source can disclose anything. */
export async function readPostReference(sc: any, referenceId: string, viewerId: string): Promise<PostReferenceView | null> {
  const read = await sc.from('post_destination_references').select('id,owner_id,post_id,memory_item_id,highlight_id,profile_post_id').eq('id', referenceId).maybeSingle();
  if (read.error) throw new Error('reference_read_failed');
  const ref = read.data;
  if (!ref) return null;
  if (ref.memory_item_id) {
    const item = await sc.from('memory_items').select('id,memory_id,media_url,media_type,position').eq('id', ref.memory_item_id).maybeSingle();
    if (item.error) throw new Error('destination_read_failed');
    if (!item.data || item.data.media_type !== POST_REFERENCE_MEDIA_TYPE || item.data.media_url !== POST_REFERENCE_URI_PREFIX + ref.id) return null;
    const memory = await sc.from('memories').select('*').eq('id', item.data.memory_id).maybeSingle();
    if (memory.error) throw new Error('destination_read_failed');
    if (!memory.data || memory.data.owner_id !== ref.owner_id || ['deleted', 'removed'].includes(memory.data.state)
      || !(await canReadMemory(sc, memory.data, viewerId, 'single')) || await isBlockedBetween(sc, viewerId, ref.owner_id)) return null;
    if (viewerId !== ref.owner_id) {
      const hidden = await hiddenItemKeys(sc, [item.data.memory_id]);
      if (!hidden.ok) throw new Error('destination_read_failed');
      if (hidden.keys.has(itemKey(item.data.memory_id, item.data.position))) return null;
    }
  } else if (ref.highlight_id) {
    const access = await decideHighlightViewAccess(sc, viewerId, ref.highlight_id);
    if (!access.ok) { if (access.code === 'db_error') throw new Error('destination_read_failed'); return null; }
    if (access.h.owner_id !== ref.owner_id) return null;
    const item = await sc.from('highlights').select('media_url,media_type').eq('id', ref.highlight_id).maybeSingle();
    if (item.error) throw new Error('destination_read_failed');
    if (!item.data || item.data.media_type !== POST_REFERENCE_MEDIA_TYPE || item.data.media_url !== POST_REFERENCE_URI_PREFIX + ref.id) return null;
  } else if (ref.profile_post_id) {
    const wrapper = await sc.from('posts').select('id,author_id,post_reference_id,visibility,status,post_status,deleted_at')
      .eq('id', ref.profile_post_id).maybeSingle();
    if (wrapper.error) throw new Error('destination_read_failed');
    const p = wrapper.data;
    if (!p || p.post_reference_id !== ref.id || p.author_id !== ref.owner_id || p.deleted_at || p.status !== 'active'
      || (viewerId !== p.author_id && (p.visibility !== 'public' || p.post_status !== 'published'))) return null;
    if (await isBlockedBetween(sc, viewerId, p.author_id)) return null;
    const restrictions = await resolveAccountRestriction(sc, p.author_id);
    if (restrictions.state !== 'ok') throw new Error('author_read_failed');
    if (restrictions.accountStatus !== 'active' || restrictions.restriction.kind !== 'none') return null;
    const profile = await sc.from('profiles').select('is_private').eq('id', p.author_id).maybeSingle();
    if (profile.error) throw new Error('author_read_failed');
    if (!profile.data || !(await excludePrivateAuthorPosts([{author_id:p.author_id, profile:profile.data}], viewerId, sc, {profilesKey:'profile'})).length) return null;
  } else return null;
  return ref.post_id ? readReferenceSource(sc, ref.post_id, viewerId) : { available: false };
}
