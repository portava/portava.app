import { mayDiscloseGemIdentity } from '../services/hiddenGems/HiddenGemPrivacyGuard.js';
import { blockedAmong } from '../services/memory/memoryReadPolicy.js';
import { excludePrivateAuthorPosts } from './privacyFilter.js';
import { readCanonicalPlaceVisibility } from './places/placeGovernance.js';

/** A saved ID grants no read access. Never expose stored image URLs here: gem
 * media has a separate moderation/asset delivery boundary. */
export async function savedGemPreviews(sc: any, viewerId: string, ids: string[]): Promise<Map<string, { title: string; coverUrl: null }>> {
  const previews = new Map<string, { title: string; coverUrl: null }>();
  if (!ids.length) return previews;
  const { data, error } = await sc.from('hidden_gems')
    .select('id,name,status,sensitivity_level,submitted_by,visibility,moderation_status,canonical_place_id')
    .in('id', ids);
  if (error || !Array.isArray(data)) throw new Error('Gem visibility could not be checked');
  let rows = data.filter(r => r.status === 'active' && mayDiscloseGemIdentity(r, viewerId)
    && (r.visibility === 'public' || r.submitted_by === viewerId)
    && (r.moderation_status == null || ['active', 'approved', 'visible'].includes(r.moderation_status)));
  const blocks = await blockedAmong(sc, viewerId, rows.map(r => r.submitted_by));
  if (!blocks.ok) throw new Error('Gem blocks could not be checked');
  rows = rows.filter(r => !blocks.blocked.has(r.submitted_by));
  rows = await excludePrivateAuthorPosts(rows, viewerId, sc, { authorKey: 'submitted_by' });
  const places = await readCanonicalPlaceVisibility(sc, rows.map(r => r.canonical_place_id).filter(Boolean));
  if (!places.ok) throw new Error('Gem place visibility could not be checked');
  for (const row of rows) {
    if ((!row.canonical_place_id || places.visibleIds.has(row.canonical_place_id)) && typeof row.name === 'string') {
      previews.set(row.id, { title: row.name, coverUrl: null });
    }
  }
  return previews;
}
