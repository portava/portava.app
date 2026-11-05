import {Platform} from 'react-native';
export interface GifItem {id:string;url:string;stillUrl:string;title:string;width:number;height:number}
export interface GifPage {items:GifItem[];nextOffset:number|null}
export type GifResult<T>={ok:true;data:T}|{ok:false;error:'unconfigured'|'cancelled'|'unavailable'|'invalid'};
export interface GifRequest {signal?:AbortSignal;isCurrent:()=>boolean}
/** Public, platform-specific provider keys. No provider is selected by default. */
export function gifProviderKey():string|null {
 if(process.env.EXPO_PUBLIC_TELEGRAPH_GIF_PROVIDER!=='giphy')return null;
 const key=Platform.OS==='ios'?process.env.EXPO_PUBLIC_TELEGRAPH_GIPHY_IOS_KEY:Platform.OS==='android'?process.env.EXPO_PUBLIC_TELEGRAPH_GIPHY_ANDROID_KEY:process.env.EXPO_PUBLIC_TELEGRAPH_GIPHY_WEB_KEY;
 return key?.trim()||null;
}
export function validGifId(value:unknown):value is string{return typeof value==='string'&&/^[A-Za-z0-9]{1,128}$/.test(value);}
/** URLs come only from a fresh provider response, never from the message sender. */
export function providerMediaUrl(raw:unknown):string|null {
 if(typeof raw!=='string'||raw.length>4096)return null;
 try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/^media[0-9]*\.giphy\.com$/.test(u.hostname)?raw:null;}catch{return null;}
}
function item(raw:any):GifItem {
 const animated=raw?.images?.fixed_width,still=raw?.images?.fixed_width_still;
 const url=providerMediaUrl(animated?.url),stillUrl=providerMediaUrl(still?.url);
 const width=Number(animated?.width),height=Number(animated?.height);
 if(!validGifId(raw?.id)||!url||!stillUrl||url===stillUrl||!/(?:_s\.gif|\.(?:png|jpe?g))(?:[?#]|$)/i.test(stillUrl)||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>20000||height>20000)throw new Error('Invalid provider response');
 return {id:raw.id,url,stillUrl,width,height,title:typeof raw.title==='string'?raw.title.slice(0,300):'GIF'};
}
async function request<T>(path:string,params:URLSearchParams,context:GifRequest,decode:(data:any)=>T):Promise<GifResult<T>> {
 const key=gifProviderKey();if(!key)return {ok:false,error:'unconfigured'};
 if(context.signal?.aborted||!context.isCurrent())return {ok:false,error:'cancelled'};
 const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;let cancel=()=>{};
 const deadline=new Promise<never>((_,reject)=>{cancel=()=>{abort.abort();reject(new Error('cancelled'));};context.signal?.addEventListener('abort',cancel,{once:true});timer=setTimeout(()=>{abort.abort();reject(new Error('deadline'));},5000);});
 params.set('api_key',key);params.set('rating','g');
 try{
  const data=await Promise.race([deadline,(async()=>{const r=await fetch(`https://api.giphy.com/v1/gifs/${path}?${params}`,{signal:abort.signal,cache:'no-store',credentials:'omit'});if(!r.ok)throw new Error('Provider unavailable');return r.json();})()]);
  if(context.signal?.aborted||!context.isCurrent())return {ok:false,error:'cancelled'};
  return {ok:true,data:decode(data)};
 }catch{return {ok:false,error:context.signal?.aborted||!context.isCurrent()?'cancelled':'unavailable'};}
 finally{clearTimeout(timer!);context.signal?.removeEventListener('abort',cancel);}
}
export function searchGifs(query:string|null,offset:number,context:GifRequest):Promise<GifResult<GifPage>> {
 if((query!==null&&(!query.trim()||query.length>50))||!Number.isInteger(offset)||offset<0||offset>(query===null?499:4999))return Promise.resolve({ok:false,error:'invalid'});
 const params=new URLSearchParams({limit:'20',offset:String(offset)});if(query!==null)params.set('q',query);
 return request(query===null?'trending':'search',params,context,data=>{
  if(!Array.isArray(data?.data)||data.data.length>20)throw new Error('Invalid provider page');
  const items=data.data.map(item); // Preserve provider order; never mix or filter its results.
  const p=data.pagination;if(!Number.isInteger(p?.offset)||p.offset!==offset||!Number.isInteger(p?.count)||p.count!==items.length||!Number.isInteger(p?.total_count))throw new Error('Invalid provider pagination');
  const next=p.offset+p.count;return {items,nextOffset:items.length&&next<p.total_count&&next<=(query===null?499:4999)?next:null};
 });
}
export function resolveGif(id:string,context:GifRequest):Promise<GifResult<GifItem>> {
 if(!validGifId(id))return Promise.resolve({ok:false,error:'invalid'});
 return request(encodeURIComponent(id),new URLSearchParams(),context,data=>{const value=item(data?.data);if(value.id!==id||data.data.rating!=='g')throw new Error('Unavailable GIF');return value;});
}
