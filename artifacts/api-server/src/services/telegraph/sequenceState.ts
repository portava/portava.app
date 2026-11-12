import { isFlagEnabled } from '../../lib/featureFlags.js';
import { parseSequenceCursor } from '../telegraphMessageKernel.js';

export const SEQUENCE_STATE_FLAG = 'telegraph_sequence_state_enabled';
export const sequenceStateEnabled = (client: any): Promise<boolean> => isFlagEnabled(client, SEQUENCE_STATE_FLAG);

export type SequenceMembership = { visible_from_sequence?: number | string | null; visible_until_sequence?: number | string | null };
export function applySequenceWindow<T>(query: T, member: SequenceMembership, viewerId: string): T {
  let q: any = query;
  const lower = parseSequenceCursor(member.visible_from_sequence);
  const upper = parseSequenceCursor(member.visible_until_sequence);
  if (lower !== null) q = q.or(`sequence.gte.${lower},sender_id.eq.${viewerId}`);
  if (upper !== null) q = q.or(`sequence.lte.${upper},sender_id.eq.${viewerId}`);
  return q;
}
export function withinSequenceWindow(row: { sequence?: number | string | null; sender_id: string }, member: SequenceMembership, viewerId: string): boolean {
  const sequence = parseSequenceCursor(row.sequence);
  if (sequence === null) return false;
  if (row.sender_id === viewerId) return true;
  const lower = parseSequenceCursor(member.visible_from_sequence);
  const upper = parseSequenceCursor(member.visible_until_sequence);
  return (lower === null || sequence >= lower) && (upper === null || sequence <= upper);
}
export type Acknowledgement = { outcome: 'acknowledged'; advanced: boolean; sequence: string; lastReadAt: string | null; seenMessageIds: string[]; receiptRowsWritten: 0 };
export async function acknowledgeMessage(client: any, threadId: string, actorId: string, messageId: string, kind: 'seen' | 'delivered'):
 Promise<{ ok: true; data: Acknowledgement } | { ok: false; code: 'not_found' | 'degraded_unavailable' }> {
  try {
    const { data, error } = await client.rpc('telegraph_ack_message', { p_thread_id: threadId, p_actor_id: actorId, p_message_id: messageId, p_kind: kind });
    if (error || !data) return { ok: false, code: 'degraded_unavailable' };
    if (data.outcome === 'not_found') return { ok: false, code: 'not_found' };
    if (data.outcome !== 'acknowledged' || typeof data.advanced !== 'boolean' || parseSequenceCursor(data.sequence) === null || !Array.isArray(data.seenMessageIds)) return { ok: false, code: 'degraded_unavailable' };
    return { ok: true, data };
  } catch { return { ok: false, code: 'degraded_unavailable' }; }
}
