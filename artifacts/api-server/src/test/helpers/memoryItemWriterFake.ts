/** Transport model for the shared Memory item RPCs. PostgreSQL lifecycle,
 * permissions, constraints and concurrency are tested in the reusable DB suite. */
const queues=new WeakMap<Function,Map<string,Promise<unknown>>>();
export async function memoryItemWriterFake(sc:any,name:string,args:any):Promise<any|null> {
  if(name!=='insert_memory_media_item')return name==='memory_item_source_ready'?{data:true,error:null}:null;
  // Model the RPC's Memory row lock for overlapping transport requests.
  let locks=queues.get(sc.from);if(!locks){locks=new Map();queues.set(sc.from,locks);}
  const key=args.p_memory,previous=locks.get(key)??Promise.resolve();
  const next=previous.then(()=>insert(sc,name,args));locks.set(key,next.catch(()=>{}));
  return next;
}
async function insert(sc:any,name:string,args:any):Promise<any|null> {
  if(name==='memory_item_source_ready')return {data:true,error:null};
  if(name!=='insert_memory_media_item')return null;
  const write=args.p_write;
  const found=await sc.from('memory_items').select('*').eq('id',write.id).maybeSingle();
  if(found.error)return found;
  if(found.data)return {data:{item:found.data,duplicate:true},error:null};
  let asset:any=null;
  if(write.source_ref){
    const result=await sc.from('media_assets').select('*').eq('storage_bucket',write.source_ref.bucket).eq('storage_path',write.source_ref.path).maybeSingle();
    if(result.error)return result;asset=result.data;
  }
  if(write.expected_asset_id&&asset?.id!==write.expected_asset_id)return {data:null,error:{message:'memory_media_source_changed'}};
  const result=await sc.from('memory_items').insert({id:write.id,memory_id:args.p_memory,media_url:write.media_url,
    media_type:write.media_type??'image/jpeg',caption:write.caption??null,position:write.position??0,
    source_post_id:write.source_post_id??null,media_asset_id:asset?.id??null}).select('*').single();
  return result.error?result:{data:{item:result.data,duplicate:false},error:null};
}
