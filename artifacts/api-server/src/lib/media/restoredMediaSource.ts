import type {SupabaseClient} from '@supabase/supabase-js';
import {validAssetId,validVersion} from './adaptive/types.js';
import {isRestrictionRowInForce,pickRestriction} from '../accountStateGate.js';

export interface RestoredMediaSource {assetId:string;ownerId:string;sourcePath:string;version:number;}

/** A reserved key proves nothing. Reuse the committed activation receipt and
 * current canonical row to resolve identity; callers still decide audience.
 * No allow cache: retirement, sanctions and reference removal apply per read. */
export async function readRestoredMediaSource(sc:SupabaseClient,bucket:string,path:string):Promise<RestoredMediaSource|null>{
 const parts=path.split('/'),assetId=parts[1],reservationId=parts[2];
 if(bucket!=='post-media'||parts[0]!=='_recovered'||!validAssetId(assetId)||!validAssetId(reservationId)
   ||parts.length<4||parts.some(part=>!part||part==='.'||part==='..')||/[\\%?#]/.test(path))return null;
 try{
  const current=await sc.from('media_assets').select('id,owner_user_id,storage_bucket,storage_path,thumbnail_path,version,deleted_at,purge_status,moderation_status,processing_status').eq('id',assetId).maybeSingle();
  const asset=current.data;
  if(current.error!==null||!asset||asset.id!==assetId||!validAssetId(asset.owner_user_id)||asset.storage_bucket!==bucket
    ||typeof asset.storage_path!=='string'||!asset.storage_path.startsWith(`_recovered/${assetId}/${reservationId}/`)
    ||!/^original\.(jpg|png|webp|heic|heif|mp4|mov|webm)$/.test(asset.storage_path.split('/')[3]??'')||asset.storage_path.split('/').length!==4
    ||!validVersion(asset.version)||asset.deleted_at!==null||asset.purge_status!=='not_requested'
    ||asset.processing_status!=='ready'||!['active','approved','limited','flagged'].includes(asset.moderation_status))return null;
  const activation=await sc.from('media_asset_lifecycle_events').select('id,details').eq('media_asset_id',assetId)
    .eq('event_type','restoration_activated').eq('details->>reservationId',reservationId).maybeSingle();
  const receipt=activation.data?.details;
  if(activation.error!==null||!validAssetId(activation.data?.id)||!receipt||receipt.reservationId!==reservationId
    ||receipt.bucket!==bucket||receipt.destinationPath!==asset.storage_path||receipt.version!==asset.version
    ||!Array.isArray(receipt.objects)||receipt.objects.filter((object:unknown)=>object&&typeof object==='object'&&'path' in object&&object.path===path).length!==1)return null;
  const profile=await sc.from('profiles').select('id,account_status,user_account_states!user_account_states_user_id_fkey(state,expires_at)').eq('id',asset.owner_user_id).maybeSingle();
  if(profile.error!==null||!profile.data||profile.data.id!==asset.owner_user_id||profile.data.account_status!=='active'
    ||!Array.isArray(profile.data.user_account_states)||pickRestriction(profile.data.user_account_states,Date.now()).kind!=='none'
    ||profile.data.user_account_states.some(row=>row?.state==='deactivated'&&isRestrictionRowInForce(row.expires_at,Date.now())))return null;
  if(path!==asset.storage_path&&path!==asset.thumbnail_path){
   const sources=await sc.from('post_media').select('storage_path,thumbnail_storage_path,feed_storage_path,deleted_at')
     .eq('storage_bucket',bucket).eq('storage_path',asset.storage_path).limit(50);
   if(sources.error!==null||!Array.isArray(sources.data)||sources.data.length>=50
     ||!sources.data.some(row=>row.deleted_at===null&&(row.thumbnail_storage_path===path||row.feed_storage_path===path)))return null;
  }
  return {assetId,ownerId:asset.owner_user_id,sourcePath:asset.storage_path,version:asset.version};
 }catch{return null;}
}

/** Old originals and reviewed sidecars never regain URL authority after a
 * recovery reservation. Existing lifecycle receipts are the only tombstone. */
export async function recoveryPathStillUsable(sc:SupabaseClient,bucket:string,path:string):Promise<boolean>{
 try{
  const responses=await Promise.all([
   sc.from('media_asset_lifecycle_events').select('id').eq('event_type','retention_original_prepared')
    .contains('details',{bucket,sourcePath:path}).limit(1),
   sc.from('media_asset_lifecycle_events').select('id').eq('event_type','restoration_prepared')
    .contains('details',{dependencies:[{bucket,sourcePath:path}]}).limit(1),
  ]);
  return responses.every(response=>response.error===null&&Array.isArray(response.data)&&response.data.length===0);
 }catch{return false;}
}
