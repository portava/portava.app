import { fetchOwnedApi, type OwnedApiContext } from './ownedApiRequest.ts';
import { mapHighlight, type Highlight, type HighlightResult } from './highlights.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VISIBILITY = new Set(['public', 'travelers_nearby', 'circle_only', 'trip_only', 'private']);

/** Saved identifiers are navigation targets; the server resolves current access. */
export async function fetchHighlightDetail(id: string, context: OwnedApiContext = {}): Promise<HighlightResult<Highlight>> {
  if (!UUID.test(id)) return { ok: false, data: null, errorKind: 'not_found' };
  try {
    const response = await fetchOwnedApi(`/api/highlights/${encodeURIComponent(id)}`, context);
    const row = await response.json();
    if (!response.ok) return { ok: false, data: null, errorKind: response.status === 404 ? 'not_found'
      : response.status === 401 ? 'unauthenticated' : response.status === 403 ? 'forbidden' : 'degraded_unavailable' };
    if (!row || row.id !== id || !UUID.test(row.owner_id ?? '') || typeof row.media_url !== 'string' || !row.media_url
      || typeof row.media_type !== 'string' || !row.media_type || !VISIBILITY.has(row.visibility)
      || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))
      || (row.expires_at !== null && (typeof row.expires_at !== 'string' || !Number.isFinite(Date.parse(row.expires_at))))
      || row.deleted_at != null || row.archived_at != null
      || !Number.isInteger(row.viewCount) || row.viewCount < 0 || !Number.isInteger(row.likeCount) || row.likeCount < 0
      || typeof row.viewedByMe !== 'boolean' || typeof row.likedByMe !== 'boolean') {
      return { ok: false, data: null, errorKind: 'degraded_unavailable' };
    }
    if (row.expires_at !== null && Date.parse(row.expires_at) <= Date.now()) return { ok: false, data: null, errorKind: 'not_found' };
    return { ok: true, data: mapHighlight(row) };
  } catch { return { ok: false, data: null, errorKind: 'network_unreachable' }; }
}
