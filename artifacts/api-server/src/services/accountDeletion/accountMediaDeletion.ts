import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { validAssetId } from '../../lib/media/adaptive/types.js';
import { decodeTranslationArtifact } from '../../lib/media/captions/translationArtifactStore.js';
import { derivativeSchemaStatus } from '../media/DerivedMediaLifecycleService.js';
import { withMediaCleanup } from '../media/MediaCleanupTransport.js';
import { purgeWithdrawnAccountMedia } from '../media/MediaLifecycleService.js';
import { RetainedCaptionTranslationReconciler } from '../media/RetainedCaptionTranslationReconciler.js';
import { RetainedDubbingReconciler } from '../media/RetainedDubbingReconciler.js';

const identifier = z.string().refine(validAssetId);
const instant = z.string().refine(value => Number.isFinite(Date.parse(value)));
const path = z.string().min(1).max(2048).refine(value => !value.startsWith('/') && !value.includes('\\')
  && !value.includes('://') && !value.split('/').some(part => part === '..' || part === '.' || !part));
const sourceSchema = z.object({
  id: identifier, owner_user_id: identifier, uploader_user_id: identifier.nullable(), version: z.number().int().positive().safe(),
  storage_bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), storage_path: path, thumbnail_path: path.nullable(),
  media_type: z.enum(['image', 'video']), size_bytes: z.number().int().nonnegative().safe().nullable(),
  deleted_at: instant.nullable(), updated_at: instant, moderation_status: z.string().min(1), processing_status: z.string().min(1),
  purge_status: z.enum(['not_requested', 'pending', 'completed', 'failed']),
});
type Source = z.infer<typeof sourceSchema>;
const SOURCE_COLUMNS = 'id,owner_user_id,uploader_user_id,version,storage_bucket,storage_path,thumbnail_path,media_type,size_bytes,deleted_at,updated_at,moderation_status,processing_status,purge_status';
const SOURCE_PAGE = 25;
const SOURCE_PASSES = 4;
const RETAINED_LIMIT = 100;
const RETAINED = [
  { table: 'media_caption_translation_artifacts', marker: 'media_caption_translation_enabled' },
  { table: 'media_dubbing_artifacts', marker: 'media_dubbing_enabled' },
] as const;
type Options = { signal?: AbortSignal; timeoutMs?: number; operationTimeoutMs?: number; env?: NodeJS.ProcessEnv };

function unavailable(): never { throw new Error('Account Media cleanup unconfirmed; retry required'); }
function scopedSource(raw: unknown, userId: string): Source {
  const parsed = sourceSchema.safeParse(raw);
  if (!parsed.success || parsed.data.owner_user_id !== userId && parsed.data.uploader_user_id !== userId) return unavailable();
  return parsed.data;
}
function sameIdentity(left: Source, right: Source): boolean {
  return left.id === right.id && left.owner_user_id === right.owner_user_id && left.uploader_user_id === right.uploader_user_id
    && left.storage_bucket === right.storage_bucket && left.storage_path === right.storage_path && left.thumbnail_path === right.thumbnail_path
    && left.media_type === right.media_type && left.size_bytes === right.size_bytes;
}
async function markerInstalled(sc: SupabaseClient, flag: string): Promise<boolean> {
  const result = await sc.from('feature_flags').select('flag').eq('flag', flag).maybeSingle();
  if (result.error || result.data === undefined) return unavailable();
  if (result.data === null) return false;
  if (result.data.flag !== flag) return unavailable();
  return true;
}
async function retainedTables(sc: SupabaseClient): Promise<string[]> {
  const tables: string[] = [];
  for (const entry of RETAINED) if (await markerInstalled(sc, entry.marker)) tables.push(entry.table);
  return tables;
}
async function requireNoRows(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<void> {
  const result = await query;
  if (result.error || !Array.isArray(result.data) || result.data.length !== 0) unavailable();
}
async function requireBoolean(sc: SupabaseClient, name: string, args: Record<string, unknown>): Promise<void> {
  const result = await sc.rpc(name, args);
  if (result.error || result.data !== true) unavailable();
}
async function sourceBarrier(sc: SupabaseClient, source: Source, tables: string[]): Promise<void> {
  const installed = await markerInstalled(sc, 'media_derivative_jobs_enabled');
  if (!installed && tables.length) unavailable();
  if (installed) {
    const schema = await derivativeSchemaStatus(sc);
    if (!schema || tables.includes('media_dubbing_artifacts') && !schema.media_dubbing_artifacts) unavailable();
    await requireBoolean(sc, 'media_derivative_cancel_asset', { p_asset_id: source.id });
    if (schema.media_dubbing_artifacts) await requireBoolean(sc, 'media_dubbing_revoke', { p_asset: source.id, p_owner: source.owner_user_id });
  }
  if (tables.includes('media_caption_translation_artifacts')) {
    await requireBoolean(sc, 'media_caption_translation_revoke', { p_asset_id: source.id, p_owner_id: source.owner_user_id });
  }
  for (const table of tables) {
    const listed = await sc.from(table).select('*').eq('asset_id', source.id).order('id', { ascending: true }).limit(RETAINED_LIMIT + 1);
    if (listed.error || !Array.isArray(listed.data) || listed.data.length > RETAINED_LIMIT) unavailable();
    const seen = new Set<string>();
    for (const raw of listed.data) {
      if (table === 'media_caption_translation_artifacts') {
        const artifact = decodeTranslationArtifact(raw);
        if (artifact.owner_user_id !== source.owner_user_id || artifact.asset_id !== source.id || seen.has(artifact.id)
          || !['uploaded', 'never_dispatched'].includes(artifact.write_state)) unavailable();
        seen.add(artifact.id);
      } else {
        const artifact = z.object({ id: identifier, asset_id: identifier, owner_user_id: identifier,
          write_state: z.enum(['uploaded', 'aborted']), write_settled_at: instant }).safeParse(raw);
        if (!artifact.success || artifact.data.asset_id !== source.id || artifact.data.owner_user_id !== source.owner_user_id
          || seen.has(artifact.data.id)) unavailable();
        seen.add(artifact.data.id);
      }
    }
  }
}

function identityFilter<Builder extends { eq(column: string, value: string | number): Builder; is(column: string, value: null): Builder }>(query: Builder, source: Source): Builder {
  let filtered = query.eq('id', source.id).eq('owner_user_id', source.owner_user_id).eq('version', source.version)
    .eq('storage_bucket', source.storage_bucket).eq('storage_path', source.storage_path).eq('media_type', source.media_type)
    .eq('updated_at', source.updated_at).eq('purge_status', source.purge_status).eq('moderation_status', source.moderation_status)
    .eq('processing_status', source.processing_status);
  for (const column of ['uploader_user_id', 'thumbnail_path', 'deleted_at', 'size_bytes'] as const) {
    filtered = source[column] === null ? filtered.is(column, null) : filtered.eq(column, source[column]);
  }
  return filtered;
}

async function eraseSource(sc: SupabaseClient, userId: string, source: Source, tables: string[], options: Options): Promise<void> {
  const now = new Date().toISOString();
  const withdrawn = await identityFilter(sc.from('media_assets').update({ deleted_at: source.deleted_at ?? now,
    moderation_status: 'owner_deleted', processing_status: 'removed', purge_requested_at: now, purge_status: 'pending', updated_at: now }), source)
    .select(SOURCE_COLUMNS);
  if (withdrawn.error || !Array.isArray(withdrawn.data) || withdrawn.data.length !== 1) unavailable();
  const claim = scopedSource(withdrawn.data[0], userId);
  if (!sameIdentity(source, claim) || claim.version <= source.version || !claim.deleted_at || claim.moderation_status !== 'owner_deleted'
    || claim.processing_status !== 'removed' || claim.purge_status !== 'pending') unavailable();
  await sourceBarrier(sc, claim, tables);
  await purgeWithdrawnAccountMedia(sc, claim.id, claim.owner_user_id, { ...options, expectedVersion: claim.version });
  const read = await sc.from('media_assets').select(SOURCE_COLUMNS).eq('id', claim.id).maybeSingle();
  if (read.error) unavailable();
  const completed = scopedSource(read.data, userId);
  if (!sameIdentity(claim, completed) || completed.version <= claim.version || completed.purge_status !== 'completed'
    || completed.deleted_at !== claim.deleted_at || completed.moderation_status !== 'owner_deleted' || completed.processing_status !== 'removed') unavailable();
  for (const table of tables) await requireNoRows(sc.from(table).select('id').eq('asset_id', completed.id).limit(1));
  const removed = await identityFilter(sc.from('media_assets').delete(), completed).select(SOURCE_COLUMNS);
  if (removed.error || !Array.isArray(removed.data) || removed.data.length !== 1) unavailable();
  const receipt = scopedSource(removed.data[0], userId);
  if (Object.entries(completed).some(([key, value]) => Reflect.get(receipt, key) !== value)) unavailable();
}

async function assertEmpty(sc: SupabaseClient, userId: string): Promise<void> {
  await requireNoRows(sc.from('media_assets').select('id').or(`owner_user_id.eq.${userId},uploader_user_id.eq.${userId}`).limit(1));
  for (const table of await retainedTables(sc)) await requireNoRows(sc.from(table).select('id').eq('owner_user_id', userId).limit(1));
}

export async function assertAccountMediaEmpty(client: SupabaseClient, userId: string, options: Options = {}): Promise<void> {
  if (!validAssetId(userId)) unavailable();
  await withMediaCleanup(client, sc => assertEmpty(sc, userId), options).catch(unavailable);
}

export async function eraseAccountMedia(client: SupabaseClient, userId: string, options: Options = {}): Promise<number> {
  if (!validAssetId(userId)) unavailable();
  return withMediaCleanup(client, async (sc, signal) => {
    const tables = await retainedTables(sc);
    let cursor: string | undefined;
    let deleted = 0;
    for (let pass = 0; pass < SOURCE_PASSES; pass++) {
      let query = sc.from('media_assets').select(SOURCE_COLUMNS).or(`owner_user_id.eq.${userId},uploader_user_id.eq.${userId}`)
        .order('id', { ascending: true }).limit(SOURCE_PAGE);
      if (cursor) query = query.gt('id', cursor);
      const listed = await query;
      if (listed.error || !Array.isArray(listed.data) || listed.data.length > SOURCE_PAGE) unavailable();
      for (const raw of listed.data) {
        signal.throwIfAborted();
        const source = scopedSource(raw, userId);
        if (cursor && source.id <= cursor) unavailable();
        await eraseSource(sc, userId, source, tables, { ...options, signal });
        cursor = source.id;
        deleted++;
      }
      if (listed.data.length < SOURCE_PAGE) break;
    }
    for (const table of tables) {
      const witness = await sc.from(table).select('id').eq('owner_user_id', userId).limit(1);
      if (witness.error || !Array.isArray(witness.data) || witness.data.length > 1) unavailable();
      if (!witness.data.length) continue;
      const result = table === 'media_caption_translation_artifacts'
        ? await new RetainedCaptionTranslationReconciler(sc).runPass({ ownerUserId: userId, limit: 50, signal, operationTimeoutMs: options.operationTimeoutMs })
        : await new RetainedDubbingReconciler(sc).runPass({ ownerUserId: userId, limit: 50, signal, operationTimeoutMs: options.operationTimeoutMs });
      if (!result.schemaInstalled || result.failed || result.unsettled || result.preserved || !result.pageExhausted) unavailable();
    }
    await assertEmpty(sc, userId);
    return deleted;
  }, options).catch(unavailable);
}
