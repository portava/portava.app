import { randomUUID } from 'node:crypto';
import { appStorageUrlInfo } from '../../lib/mediaUrl.js';
import { authorizeMediaAccess } from '../../lib/mediaAccess.js';
import { verifyUploadedBytes, guardUploadRequest, MEDIA_SIZE_LIMITS } from '../../lib/mediaPipeline.js';
import { processImage, makeThumbnail } from '../../lib/mediaProcessing.js';
import { stripVideoLocationMetadata } from '../../lib/videoMetadata.js';
import { forwardAttachmentsOf } from './forwardAttachmentShape.js';
import { resolveShareProjections } from './shareables.js';
import type { ForwardSource } from './forwarding.js';
import { logger } from '../../lib/logger.js';

/** Every source read is authorized before downloading; no external URL fetches.
 * Paths are journaled before upload and the SQL commit rechecks the source and
 * audience after processing. An uncertain commit leaves its journal intact. */
export async function copyForwardAttachments(sc: any, input: { source: ForwardSource; targetThreadId: string; actorId: string; requestId?: string }) {
  const attachments = forwardAttachmentsOf(input.source);
  if (!attachments?.length) throw new Error('attachment_unavailable');
  const gate=await guardUploadRequest(sc,input.actorId);
  if (!gate.ok) throw new Error(gate.failure.message);
  const [author]=await resolveShareProjections(sc,input.actorId,input.source.thread_id,[{objectType:'PROFILE',objectId:input.source.sender_id}]);
  if(!author?.available)throw new Error('attachment_unavailable');
  const refs=attachments.map(asset=>appStorageUrlInfo(asset.url));
  for(const ref of refs){
    if(!ref || ref.bucket!=='post-media' || !(await authorizeMediaAccess(sc,input.actorId,ref.bucket,ref.path))) throw new Error('attachment_unavailable');
  }
  const id=randomUUID();
  const prep=await sc.rpc('telegraph_prepare_media_forward',{p_id:id,p_request:input.requestId??randomUUID(),p_source:input.source.id,p_target:input.targetThreadId,p_actor:input.actorId,p_asset_count:attachments.length,p_source_snapshot:[input.source.body??null,input.source.media_url??null,input.source.media_type??null,input.source.msg_type??null,input.source.subtype??null]});
  if(prep.error || !prep.data) throw new Error('attachment_prepare_failed');
  if(prep.data.outcome==='replay') return {outcome:'forwarded',messageId:String(prep.data.id),createdAt:null,replay:true,capability:prep.data.capability};
  if(prep.data.outcome!=='prepared' || prep.data.id!==id) throw new Error('attachment_forward_in_progress');
  const bucket=sc.storage.from('post-media');
  const assets:Array<{url:string;mediaType:'image'|'video';thumbnailUrl:string|null}>=[];
  let commitStarted=false;
  let uploadUncertain=false;
  let totalBytes=0;
  try{
    for(let i=0;i<attachments.length;i++){
      const ref=refs[i]!;
      const downloaded=await bucket.download(ref.path);
      if(downloaded.error || !downloaded.data || downloaded.data.size>MEDIA_SIZE_LIMITS[attachments[i].mediaType]) throw new Error('attachment_download_failed');
      totalBytes+=downloaded.data.size;
      if(totalBytes>100*1024*1024) throw new Error('attachment_batch_too_large');
      const raw=Buffer.from(await downloaded.data.arrayBuffer());
      const verified=verifyUploadedBytes(raw,attachments[i].mediaType);
      if(!verified.ok) throw new Error('attachment_invalid');
      let buffer=raw,mime=verified.value.mime,thumbnail:Buffer|null=null;
      if(verified.value.kind==='image'){
        const image=await processImage(raw,verified.value);buffer=image.buffer;mime=image.mime;
        thumbnail=(await makeThumbnail(buffer)).buffer;
      }else{
        const stripped=stripVideoLocationMetadata(raw,verified.value);
        if(!stripped.ok)throw new Error('attachment_metadata_unreadable');
        buffer=stripped.buffer;
      }
      const path=`${input.actorId}/telegraph-forwards/${id}/${i}`;
      uploadUncertain=true;
      const stored=await bucket.upload(path,buffer,{contentType:mime,upsert:false});
      if(stored.error)throw new Error('attachment_upload_failed');
      uploadUncertain=false;
      let thumbnailUrl:string|null=null;
      if(thumbnail){
        const thumbPath=`${path}.thumb.jpg`;
        uploadUncertain=true;
        const thumb=await bucket.upload(thumbPath,thumbnail,{contentType:'image/jpeg',upsert:false});
        if(thumb.error)throw new Error('attachment_upload_failed');
        uploadUncertain=false;
        thumbnailUrl=`post-media/${thumbPath}`;
      }
      assets.push({url:`post-media/${path}`,mediaType:attachments[i].mediaType,thumbnailUrl});
    }
    // Do not publish media whose author or bytes were revoked while copying.
    const [currentAuthor]=await resolveShareProjections(sc,input.actorId,input.source.thread_id,[{objectType:'PROFILE',objectId:input.source.sender_id}]);
    if(!currentAuthor?.available)throw new Error('attachment_unavailable');
    for(const ref of refs)if(!(await authorizeMediaAccess(sc,input.actorId,ref!.bucket,ref!.path)))throw new Error('attachment_unavailable');
    const album=assets.length>1;
    commitStarted=true;
    const result=await sc.rpc('telegraph_finish_media_forward',{p_id:id,
      p_body:album?JSON.stringify({kind:'MEDIA_ALBUM',envelopeVersion:'1',schema:'media_album.v1',payload:{assets}}):'',
      p_msg_type:album?'media_album':'media',p_media_url:album?null:assets[0].url,
      p_media_type:album?null:assets[0].mediaType,p_thumbnail:album?null:assets[0].thumbnailUrl});
    if(result.error || result.data?.outcome!=='forwarded'){
      if(result.error?.code==='P0001')commitStarted=false; // explicit transaction rollback
      throw new Error('attachment_commit_failed');
    }
    return {...result.data,replay:false};
  }catch(err){
    // A timed-out upload or commit can finish remotely after its reply is lost.
    // Retain its inaccessible paths until the delayed sweep; never orphan them.
    if(!commitStarted&&!uploadUncertain){
      try {
        const removed=await bucket.remove(prep.data.paths);
        if(!removed.error)await sc.from('telegraph_forward_media_jobs').delete().eq('id',id).eq('state','preparing');
      } catch { /* Deadline or cleanup failure: the durable journal remains. */ }
    }
    throw err;
  }
}

export async function sweepForwardMedia(sc:any){
  const claimed=await sc.rpc('telegraph_claim_forward_media_cleanup');
  if(claimed.error || !Array.isArray(claimed.data))throw new Error('forward_media_cleanup_unavailable');
  let removed=0;
  for(const job of claimed.data){
    // Treat stored paths as data: only this journal's own namespace is deletable.
    const prefix=`${job.forwarder_id}/telegraph-forwards/${job.id}/`;
    if(!Array.isArray(job.storage_paths) || !job.storage_paths.every((path:unknown)=>typeof path==='string'&&path.startsWith(prefix)&&!path.includes('..')))throw new Error('invalid_forward_cleanup_path');
    const result=await sc.storage.from('post-media').remove(job.storage_paths);
    if(result.error)throw new Error('forward_media_cleanup_failed');
    const deleted=await sc.from('telegraph_forward_media_jobs').delete().eq('id',job.id).eq('state','abandoned');
    if(deleted.error)throw new Error('forward_media_cleanup_record_failed');
    removed++;
  }
  if(removed)logger.info({removed},'Removed abandoned or revoked Telegraph media copies');
  return removed;
}
