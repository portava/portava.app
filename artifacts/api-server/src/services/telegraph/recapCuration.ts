import type { SupabaseClient } from '@supabase/supabase-js';
import type { RecapRow, SessionRecap } from './memoryNotes.js';
import { resolveShareProjections } from './shareables.js';
import { coalescingClient } from './coalescedReads.js';

/** This is an index of references, never a copy of private message bodies or
 * storage URLs. Every action reauthorizes the selected source at its writer. */
export function recapSourceChoices(recap: SessionRecap, rows: readonly RecapRow[]) {
  const selected = new Set(recap.sourceMessageIds);
  return rows.filter(row => selected.has(row.id) && !row.deleted_at).map(row => {
    const media = row.media_type === 'image' ? 'photo' : row.media_type === 'video' ? 'video'
      : row.msg_type?.toLowerCase() === 'media_album' ? 'album' : 'place';
    return { messageId: row.id, kind: media, label: media === 'photo' ? 'Photo' : media === 'video' ? 'Video'
      : media === 'album' ? 'Photo / video album' : 'Shared place', createdAt: row.created_at };
  });
}

export async function recapPeopleChoices(client: SupabaseClient, viewerId: string, threadId: string, participantIds: readonly string[]) {
  const ids = [...new Set(participantIds)].filter(id => id !== viewerId).slice(0, 100);
  const batched = coalescingClient(client) as unknown as SupabaseClient;
  const resolved = await Promise.all(ids.map(async objectId => {
    const [result] = await resolveShareProjections(batched, viewerId, threadId, [{ objectType: 'PROFILE', objectId }]);
    // Unknown privacy is an error, not a successful empty list.
    if (result && !result.available && result.reason === 'unknown') throw new Error('Profile availability could not be verified');
    return result?.available ? { userId: objectId, label: result.projection.title, deepLink: result.deepLink } : null;
  }));
  return { people: resolved.filter((person): person is NonNullable<typeof person> => person !== null),
    truncated: new Set(participantIds.filter(id => id !== viewerId)).size > ids.length };
}
