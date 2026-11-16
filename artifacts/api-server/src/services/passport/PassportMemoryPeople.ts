/** P77's owner-only People view. The relationship is private; participant
 * facts always come from canonical Memories and their existing consent policy. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { lookupMemoryRedirect } from '../memory/memoryIdRedirects.js';
import { loadParticipantVisibility, projectParticipants, type ParticipantListProjection } from '../memory/memoryParticipantVisibility.js';

export type PassportMemoryPeople =
  | { state: 'unlinked' }
  | { state: 'unavailable'; sourceId?: string }
  | { state: 'ready'; sourceId: string; resolvedSourceId: string; participants: ParticipantListProjection['participants']; anonymousCount: number };

type Source = { id: string; owner_id: string; state: string; visibility: string; trip_id: string | null };
const SOURCE_SELECT = 'id,owner_id,state,visibility,trip_id';
const complete = (r: { data: unknown; error: unknown; count: number | null }): r is { data: Record<string, unknown>[]; error: null; count: number } =>
  !r.error && Array.isArray(r.data) && Number.isInteger(r.count) && r.count === r.data.length;

async function readPeople(sc: SupabaseClient, ownerId: string, sourceId: string): Promise<PassportMemoryPeople> {
  const unavailable: PassportMemoryPeople = { state: 'unavailable', sourceId };
  const read = (id: string) => sc.from('memories').select(SOURCE_SELECT).eq('id', id).maybeSingle();
  const original = await read(sourceId);
  if (original.error || !original.data || original.data.owner_id !== ownerId) return unavailable;
  let source = original.data as Source;
  if (source.state === 'deleted') {
    const redirect = await lookupMemoryRedirect(sc, sourceId);
    if (redirect.state !== 'redirect') return unavailable;
    const next = await read(redirect.to);
    if (next.error || !next.data || next.data.owner_id !== ownerId || next.data.state === 'deleted') return unavailable;
    source = next.data as Source;
  }
  if (!source.state) return unavailable;
  const tags = await sc.from('memory_tags').select('tagged_user_id,status', { count: 'exact' }).eq('memory_id', source.id);
  if (!complete(tags) || tags.data.some(t => typeof t.tagged_user_id !== 'string' || !t.tagged_user_id)) return unavailable;
  const ids = [...new Set(tags.data.map(t => String(t.tagged_user_id)))];
  const context = await loadParticipantVisibility(sc, source, ownerId, ids);
  const profiles = new Map<string, { name?: string | null; handle?: string | null }>();
  if (ids.length) {
    const result = await sc.from('profiles').select('id,name,handle', { count: 'exact' }).in('id', ids);
    if (!complete(result)) return unavailable;
    for (const row of result.data) profiles.set(String(row.id), { name: typeof row.name === 'string' ? row.name : null, handle: typeof row.handle === 'string' ? row.handle : null });
  }
  const projected = projectParticipants(context, tags.data as { tagged_user_id: string; status?: unknown }[], profiles);
  return { state: 'ready', sourceId, resolvedSourceId: source.id, participants: projected.participants, anonymousCount: projected.anonymousCount };
}

/** This entry point verifies the owner itself; callers cannot attach another
 * user's private source merely by supplying scrapbook IDs. No cache survives a
 * fresh read, so removal, blocking, redirects and deletion are re-evaluated. */
export async function loadPassportMemoryPeople(sc: SupabaseClient, ownerId: string, passportIds: readonly string[]): Promise<Map<string, PassportMemoryPeople>> {
  const ids = [...new Set(passportIds)];
  const results = new Map<string, PassportMemoryPeople>(ids.map(id => [id, { state: 'unavailable' }]));
  if (!ids.length || ids.length > 100) return results;
  try {
    const owners = await sc.from('passport_memories').select('id', { count: 'exact' }).eq('user_id', ownerId).eq('status', 'active').in('id', ids);
    if (!complete(owners) || owners.data.length !== ids.length) return results;
    const links = await sc.from('passport_memory_sources').select('passport_memory_id,memory_id', { count: 'exact' }).in('passport_memory_id', ids);
    if (!complete(links) || links.data.some(row => typeof row.memory_id !== 'string' || !ids.includes(String(row.passport_memory_id)))) return results;
    const byId = new Map(links.data.map(row => [String(row.passport_memory_id), String(row.memory_id)]));
    const sources = new Map<string, PassportMemoryPeople>();
    for (const id of ids) {
      const source = byId.get(id);
      try {
        if (source && !sources.has(source)) sources.set(source, await readPeople(sc, ownerId, source));
        results.set(id, source ? sources.get(source)! : { state: 'unlinked' });
      }
      catch { results.set(id, { state: 'unavailable', ...(source ? { sourceId: source } : {}) }); }
    }
  } catch {
    // Resolved database errors are checked by complete(); thrown transport
    // failures retain the explicit unavailable result for unread entries.
    return results;
  }
  return results;
}
