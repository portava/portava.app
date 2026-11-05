import type { SupabaseClient } from '@supabase/supabase-js';
import { readFlagState } from '../../lib/featureFlags.js';
import type { TelegraphRelationship } from '../../domain/telegraph/contracts/telegraphRelationship.js';
import { readTelegraphRelationship, RELATIONSHIP_CONTEXT_FLAG } from './telegraphRelationship.js';

/** Request-scoped input shared by permissions and context; never a grant. */
export type ConversationRelationshipReading =
  | { status: 'read'; value: TelegraphRelationship }
  | { status: 'off' | 'unreadable' | 'not_applicable'; detail: string };

export async function readConversationRelationship(sc: SupabaseClient, viewerId: string, counterpartId: string | null, nowMs = Date.now()): Promise<ConversationRelationshipReading> {
  if (!counterpartId) return { status:'not_applicable', detail:'a relationship is between two people; this conversation is not a direct one' };
  const flag = await readFlagState(sc, 'telegraph_relationship_context_enabled');
  if (flag === 'unknown') return { status:'unreadable', detail:`${RELATIONSHIP_CONTEXT_FLAG} could not be read` };
  if (flag === 'off') return { status:'off', detail:`${RELATIONSHIP_CONTEXT_FLAG} is off` };
  try {
    const read = await readTelegraphRelationship(sc, viewerId, counterpartId, nowMs);
    return read.degraded
      ? { status:'unreadable', detail:'the relationship could not be read' }
      : { status:'read', value:read.relationship };
  } catch { return { status:'unreadable', detail:'the relationship could not be read' }; }
}
