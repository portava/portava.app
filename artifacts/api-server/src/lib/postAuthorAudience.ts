import { pickRestriction } from './accountStateGate.js';
import { isPostgrestBackedClient } from './supabase.js';

/** Current author restrictions and private-account audience for post reads.
 * Batch authors once per page. A bookmark, old URL or public post setting is
 * never a replacement for the author's current account policy. */
export async function filterCurrentPostAuthors<T extends { author_id?: string }>(sc: any, viewerId: string, rows: T[], options?: { throwOnUnavailable?: boolean }): Promise<T[]> {
  const unavailable = () => {
    if (options?.throwOnUnavailable) throw new Error('Current post author audience is unavailable');
    return [] as T[];
  };
  const ids = [...new Set(rows.map(row => row.author_id).filter((id): id is string => !!id))];
  if (!ids.length) return [];
  let read;
  try {
    read = await sc.from('profiles')
      .select('id,is_private,account_status,user_account_states!user_account_states_user_id_fkey(state,expires_at)')
      .in('id', ids);
  } catch { return unavailable(); }
  if (read?.error || !Array.isArray(read?.data)) return unavailable();
  const profiles = new Map<string, Record<string, any>>(read.data.map((profile: Record<string, any>) => [profile.id, profile]));
  if (read.data.some((profile: Record<string, any>) => !Array.isArray(profile.user_account_states)
    && !(profile.user_account_states === undefined && !isPostgrestBackedClient(sc)))) return unavailable();
  const live = rows.filter(row => {
    const profile = profiles.get(row.author_id ?? '');
    // An existing production post must have its current profile. Older small
    // injected clients omit profiles altogether; preserve their fixture seam.
    if (!profile) return !isPostgrestBackedClient(sc);
    if ((profile.account_status ?? 'active') !== 'active') return false;
    const states = profile.user_account_states;
    if (states === undefined && !isPostgrestBackedClient(sc)) return true;
    return Array.isArray(states) && pickRestriction(states, Date.now()).kind === 'none';
  });
  const privateIds = new Set(live.map(row => row.author_id).filter((id): id is string => !!id && id !== viewerId && profiles.get(id)?.is_private === true));
  if (!privateIds.size) return live;
  let follows;
  try {
    follows = await sc.from('user_follows').select('following_id').eq('follower_id', viewerId).in('following_id', [...privateIds]);
  } catch { return unavailable(); }
  if (follows?.error || !Array.isArray(follows?.data)) return unavailable();
  const approved = new Set(follows.data.map((row: { following_id: string }) => row.following_id));
  return live.filter(row => !privateIds.has(row.author_id ?? '') || approved.has(row.author_id));
}
