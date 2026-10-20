import type { SupabaseClient } from '@supabase/supabase-js';
import { decodeTranslationArtifact, eraseTranslationArtifact } from '../../lib/media/captions/translationArtifactStore.js';
import { withMediaCleanup } from './MediaCleanupTransport.js';

export class RetainedCaptionTranslationReconciler {
  private cursor: string | null = null;
  private scope = '';
  private busy = false;
  constructor(private readonly client: SupabaseClient) {}

  async runPass(options: { assetId?: string; ownerUserId?: string; limit?: number; signal?: AbortSignal; operationTimeoutMs?: number } = {}) {
    const limit = options.limit ?? 25;
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50
      || options.assetId !== undefined && !uuid.test(options.assetId) || options.ownerUserId !== undefined && !uuid.test(options.ownerUserId)) throw new Error('Invalid translation cleanup bounds');
    if (this.busy) throw new Error('Translation cleanup already running');
    this.busy = true;
    try {
      return await withMediaCleanup(this.client, async (sc, signal) => {
        const result = { schemaInstalled: false, scanned: 0, removed: 0, preserved: 0, unsettled: 0, failed: 0, pageExhausted: false };
        const marker = await sc.from('feature_flags').select('flag').eq('flag', 'media_caption_translation_enabled').maybeSingle();
        if (marker.error || marker.data === undefined) throw new Error('Translation cleanup schema unavailable');
        if (marker.data === null) return result;
        if (marker.data.flag !== 'media_caption_translation_enabled') throw new Error('Translation cleanup schema invalid');
        const scope = `${options.assetId ?? ''}:${options.ownerUserId ?? ''}`;
        if (scope !== this.scope) { this.cursor = null; this.scope = scope; }
        let query = sc.from('media_caption_translation_artifacts').select('*').order('id', { ascending: true }).limit(limit);
        if (options.assetId) query = query.eq('asset_id', options.assetId);
        if (options.ownerUserId) query = query.eq('owner_user_id', options.ownerUserId);
        if (this.cursor) query = query.gt('id', this.cursor);
        const listed = await query;
        if (listed.error || !Array.isArray(listed.data) || listed.data.length > limit) throw new Error('Translation retained inventory unavailable');
        result.schemaInstalled = true;
        for (const raw of listed.data) {
          signal.throwIfAborted();
          const artifact = decodeTranslationArtifact(raw);
          if ((this.cursor && artifact.id <= this.cursor) || options.assetId && artifact.asset_id !== options.assetId
            || options.ownerUserId && artifact.owner_user_id !== options.ownerUserId) throw new Error('Translation retained scope changed');
          this.cursor = artifact.id;
          result.scanned++;
          if (artifact.write_state === 'reserved' || artifact.write_state === 'dispatched') { result.unsettled++; continue; }
          try {
            if (await eraseTranslationArtifact(sc, artifact)) result.removed++;
            else result.preserved++;
          } catch { signal.throwIfAborted(); result.failed++; }
        }
        result.pageExhausted = listed.data.length < limit;
        if (result.pageExhausted) this.cursor = null;
        return result;
      }, options);
    } finally { this.busy = false; }
  }
}
