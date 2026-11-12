import type { SupabaseClient } from '@supabase/supabase-js';
import { negotiateStoredMessageRows } from './platformReadDecorations.js';
import { parseKindEnvelope } from './messageKinds.js';
import { resolveShareProjections } from './shareables.js';

/** Owner-only live reference. Publishing a Memory does not publish its private
 * chat source. Deleted/unsent, blocked, restricted and out-of-window sources
 * produce the same unavailable result with no original title or storage key. */
export async function readMemoryMessageSource(sc: SupabaseClient, viewerId: string, memoryId: string, headers?: Record<string, unknown>) {
  const memory = await sc.from('memories').select('id, owner_id, state').eq('id', memoryId).maybeSingle();
  if (memory.error) throw new Error('Memory access unavailable');
  if (!memory.data || memory.data.owner_id !== viewerId || ['deleted', 'removed'].includes(memory.data.state)) return null;
  const ref = await sc.from('telegraph_memory_sources').select('message_id').eq('memory_id', memoryId).maybeSingle();
  if (ref.error) throw new Error('Memory source unavailable');
  if (!ref.data?.message_id) return null;
  return readLiveMessageSource(sc, viewerId, ref.data.message_id, headers);
}

export async function readLiveMessageSource(sc: SupabaseClient, viewerId: string, messageId: string, headers?: Record<string, unknown>) {
  const result = await sc.from('messages').select('id, thread_id, sender_id, body, content_ref, created_at, msg_type, subtype, media_type, media_url, deleted_at, unsent_at, sequence, ciphertext')
    .eq('id', messageId).maybeSingle();
  if (result.error) throw new Error('Message source unavailable');
  const msg = result.data;
  if (!msg || msg.deleted_at || msg.unsent_at || msg.ciphertext) return null;
  const member = await sc.from('message_thread_members').select('left_at, visible_from_at, visible_from_sequence, visible_until_sequence')
    .eq('thread_id', msg.thread_id).eq('user_id', viewerId).maybeSingle();
  if (member.error) throw new Error('Message access unavailable');
  if (!member.data || member.data.left_at) return null;
  if (msg.sender_id !== viewerId && ((member.data.visible_from_at && msg.created_at < member.data.visible_from_at)
    || (member.data.visible_from_sequence != null && (msg.sequence == null || Number(msg.sequence) < Number(member.data.visible_from_sequence)))
    || (member.data.visible_until_sequence != null && (msg.sequence == null || Number(msg.sequence) > Number(member.data.visible_until_sequence))))) return null;
  const [author] = await resolveShareProjections(sc, viewerId, msg.thread_id, [{ objectType: 'PROFILE', objectId: msg.sender_id }]);
  if (!author?.available) { if (author?.reason === 'unknown') throw new Error('Author access unavailable'); return null; }
  const [row] = await negotiateStoredMessageRows(sc, [msg], headers);
  const media: Array<{ url: string; mediaType: string }> = [];
  if (row.media_url && ['image', 'video', 'audio'].includes(row.media_type)) media.push({ url: row.media_url, mediaType: row.media_type });
  if (row.msg_type === 'media_album') {
    const env = parseKindEnvelope(row.msg_type, row.body);
    const assets = (env?.payload as { assets?: Array<{ url: string; mediaType: string }> } | undefined)?.assets;
    if (assets) media.push(...assets.map(asset => ({ url: asset.url, mediaType: asset.mediaType })));
  }
  // JSON and structured cards stay in their native conversation renderer.
  const body = row.msg_type === 'text' && typeof row.body === 'string' && !row.body.trim().startsWith('{') ? row.body : null;
  return { messageId: msg.id, threadId: msg.thread_id, createdAt: msg.created_at, body, media,
    label: media.length ? 'Saved media from Telegraph' : body ? 'Saved message from Telegraph' : 'Saved item from Telegraph' };
}
