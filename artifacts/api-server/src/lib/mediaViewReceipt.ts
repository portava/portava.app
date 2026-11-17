import { createHash } from 'node:crypto';

export interface MediaViewObservation {
  viewerId: string;
  itemId: string;
  sessionId: string;
  eventId: string;
  type: 'impression' | 'qualified_view' | 'completion' | 'rewatch';
  watchedMs?: number;
}

/** Reuse rank_events' existing UUID primary key. The namespace and authenticated
 * owner prevent a caller choosing another writer's or another account's key.
 * The caller keeps eventId stable across retries, including a lost response.
 */
export function mediaViewReceiptId(viewerId: string, eventId: string): string {
  const digest = createHash('sha256').update(JSON.stringify(['media-view-v1', viewerId.toLowerCase(), eventId.toLowerCase()])).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

type Result = { status: 'inserted' | 'duplicate' | 'conflict' | 'unserved' | 'failed' };

export async function writeMediaViewReceipt(sc: any, observation: MediaViewObservation): Promise<Result> {
  const { type, watchedMs } = observation;
  const viewerId = observation.viewerId.toLowerCase();
  const itemId = observation.itemId.toLowerCase();
  const sessionId = observation.sessionId.toLowerCase();
  const eventId = observation.eventId.toLowerCase();
  const id = mediaViewReceiptId(viewerId, eventId);
  const row = {
    id, user_id: viewerId, item_id: itemId, item_kind: 'post', content_type: 'post',
    surface: 'watch_feed', session_id: sessionId, event_type: `watch_${type}`,
    outcome: type === 'impression' ? 'impression' : 'analytics',
    features: watchedMs === undefined ? {} : { watched_ms: watchedMs },
  };
  const matches = (existing: any): boolean => !!existing
    && ['id', 'user_id', 'item_id', 'session_id', 'surface', 'event_type', 'outcome'].every(key => existing[key] === (row as any)[key])
    && (existing.features?.watched_ms ?? null) === (watchedMs ?? null);
  try {
    // Only a server-issued serve for this authenticated viewer, item and session
    // can anchor the observation. A view row cannot bootstrap another view.
    const served = await sc.from('rank_events').select('id,position')
      .eq('user_id', viewerId).eq('item_id', itemId).eq('session_id', sessionId)
      .eq('surface', 'watch_feed').is('event_type', null).limit(1).maybeSingle();
    if (served.error) return { status: 'failed' };
    if (!served.data) return { status: 'unserved' };
    const inserted = await sc.from('rank_events').insert({ ...row, position: served.data.position ?? null })
      .select('id,user_id,item_id,session_id,surface,event_type,outcome,features').single();
    if (!inserted.error) return { status: matches(inserted.data) ? 'inserted' : 'failed' };
    if (inserted.error.code !== '23505') return { status: 'failed' };
    // The unique primary key, not a process-local cache, arbitrates concurrent
    // retries. Confirm its exact payload before acknowledging a duplicate.
    const existing = await sc.from('rank_events').select('id,user_id,item_id,session_id,surface,event_type,outcome,features').eq('id', id).maybeSingle();
    if (existing.error || !existing.data) return { status: 'failed' };
    return { status: matches(existing.data) ? 'duplicate' : 'conflict' };
  } catch {
    return { status: 'failed' };
  }
}
