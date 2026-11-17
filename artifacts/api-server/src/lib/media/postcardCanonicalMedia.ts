/** Postcard completion under media_canonical_enabled composes the existing
 * canonical and moderation owners. It checks the read-only lifecycle proof
 * before the shared mediaSchemaCapability column probe or any completion write. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { casUpdateMediaAsset } from '../mediaAssets.js';
import { probeCanonicalAssetSchema } from './mediaSchemaCapability.js';
import { completeAutomatedCanonicalModeration } from '../../services/media/MediaModerationService.js';
import { logger } from '../logger.js';

export async function postcardCanonicalReady(sc: SupabaseClient): Promise<boolean> {
  try {
    const result=await sc.rpc('postcard_canonical_lifecycle_ready');
    if(result.error || result.data!==true) {
      logger.warn({err:result.error}, 'Postcard capture completion refused: migration4038 lifecycle protection could not be verified');
      return false;
    }
    return (await probeCanonicalAssetSchema(sc)).state==='present';
  } catch(error) {
    logger.warn({err:error}, 'Postcard capture readiness could not be read');
    return false;
  }
}

export interface PostcardMediaSource {
  user_id: string; storage_bucket: string; storage_path: string;
  processing_status: string; moderation_status: string;
  width?: number|null; height?: number|null; mime_type?: string; file_size_bytes?: number|null;
}

/** A ready retry reads its receipt; staged completion never rewrites capture or provenance. */
export async function finishPostcardCanonicalMedia(sc: SupabaseClient, source: PostcardMediaSource, measured = false): Promise<'complete'|'missing'|'reprocess'|'unavailable'> {
  const read=()=>sc.from('media_assets').select('id,owner_user_id,version,processing_status,moderation_status,deleted_at,purge_status')
    .eq('storage_bucket',source.storage_bucket).eq('storage_path',source.storage_path).maybeSingle();
  const first=await read();if(first.error)return 'unavailable';if(!first.data)return 'missing';
  let row=first.data;
  const usable=()=>row.owner_user_id===source.user_id && !row.deleted_at && row.purge_status==='not_requested' && !['removed','owner_deleted'].includes(row.moderation_status);
  if(source.processing_status!=='ready' || !usable())return 'unavailable';
  if(row.processing_status==='ready')return 'complete';
  if(row.processing_status==='processing' && !measured)return 'reprocess';
  if(!['uploaded','processing'].includes(row.processing_status))return 'unavailable';
  // Version 1 is the original upload hold. A later moderation decision owns
  // its newer version and must not be undone by a completion retry.
  if(row.version===1 && row.moderation_status==='limited') {
    const decision=source.moderation_status==='approved' ? 'approve' : source.moderation_status==='rejected' ? 'reject' : 'flag';
    const result=await completeAutomatedCanonicalModeration(sc,{bucket:source.storage_bucket,path:source.storage_path,decision,hold:{assetId:row.id,version:row.version}});
    if(result!=='applied')return 'unavailable';
    const refreshed=await read();if(refreshed.error || !refreshed.data)return 'unavailable';row=refreshed.data;
    if(!usable() || !['uploaded','processing'].includes(row.processing_status))return 'unavailable';
  }
  if(!source.width || !source.height)return 'unavailable';
  const result=await casUpdateMediaAsset(sc,row.id,row.version,{processing_status:'ready',width:source.width,height:source.height,
    ...(source.mime_type ? {mime_type:source.mime_type} : {}),
    ...(typeof source.file_size_bytes==='number' ? {size_bytes:source.file_size_bytes} : {}),updated_at:new Date().toISOString()});
  return result==='written' ? 'complete' : 'unavailable';
}
