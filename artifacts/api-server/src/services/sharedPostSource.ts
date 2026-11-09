import { ACCOUNT_STATE_GATE_SELECT, pickRestriction } from '../lib/accountStateGate.js';
import { readPairDirections } from '../lib/exclusionSet.js';
import { excludePrivateAuthorPosts } from '../lib/privacyFilter.js';
import { isPostgrestBackedClient } from '../lib/supabase.js';
import { projectSharedPostMedia, type SharedPostMedia } from './sharedPostMedia.js';

export const SHARED_AUTHOR_SELECT = 'id,handle,is_private,' + ACCOUNT_STATE_GATE_SELECT;
type Result = {available: false; reason: 'not_found' | 'deleted' | 'unauthorized' | 'private'} |
  {available: true; postId: string; text: string; author: string; version: string | null; media: SharedPostMedia[]};

/** Check every wrapper and source for this viewer. Only current source media leaves the chain. */
export async function readSharedPostSource(sc: any, postId: string, viewerId: string, seen = new Set<string>()): Promise<Result> {
  if (seen.has(postId) || seen.size >= 8) return {available: false, reason: 'not_found'};
  seen.add(postId);
  const {data: post, error} = await sc.from('posts')
    .select('id,author_id,content,visibility,status,post_status,deleted_at,sharing_disabled,reposting_disabled,post_reference_id,media_urls,media_type,primary_media_type,location_privacy_mode,updated_at,created_at')
    .eq('id', postId).maybeSingle();
  if (error) throw new Error('source_read_failed');
  if (!post || !post.author_id) return {available: false, reason: 'not_found'};
  const mine = viewerId === post.author_id;
  if (!mine) {
    const blocks = await readPairDirections(sc, viewerId, post.author_id);
    if (!blocks.ok) throw new Error('block_read_failed');
    if (blocks.aBlockedB || blocks.bBlockedA) return {available: false, reason: 'unauthorized'};
  }
  if (post.deleted_at || post.status !== 'active') return {available: false, reason: 'deleted'};
  if (!mine && (post.visibility !== 'public' || post.post_status !== 'published' || post.sharing_disabled || post.reposting_disabled)) {
    return {available: false, reason: 'private'};
  }
  const {data: author, error: authorError} = await sc.from('profiles').select(SHARED_AUTHOR_SELECT).eq('id', post.author_id).maybeSingle();
  if (authorError) throw new Error('author_read_failed');
  if (!author || author.account_status !== 'active') return {available: false, reason: 'unauthorized'};
  const states = author.user_account_states;
  if (!Array.isArray(states) && (states !== undefined || isPostgrestBackedClient(sc))) throw new Error('author_restriction_read_failed');
  if (pickRestriction(states ?? [], Date.now()).kind !== 'none') return {available: false, reason: 'unauthorized'};
  if (!(await excludePrivateAuthorPosts([{author_id: post.author_id, profile: author}], viewerId, sc, {profilesKey: 'profile'})).length) {
    return {available: false, reason: 'private'};
  }
  if (post.post_reference_id) {
    const nested = await sc.from('post_destination_references').select('post_id,owner_id,profile_post_id').eq('id', post.post_reference_id).maybeSingle();
    if (nested.error) throw new Error('reference_read_failed');
    if (!nested.data?.post_id || nested.data.profile_post_id !== post.id || nested.data.owner_id !== post.author_id) return {available:false, reason:'not_found'};
    return readSharedPostSource(sc, nested.data.post_id, viewerId, seen);
  }
  const version = !mine && (!post.location_privacy_mode || post.location_privacy_mode === 'delayed_until_exit') ? post.created_at : post.updated_at;
  const media = await projectSharedPostMedia(sc, post, viewerId);
  return { available: true, postId: post.id, text: typeof post.content === 'string' ? post.content.slice(0, 2000) : '',
    author: author.handle ? `@${author.handle}` : 'Traveler', version: typeof version === 'string' ? version : null, media };
}
