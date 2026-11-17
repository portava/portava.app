import { fetchOwnedApi } from './ownedApiRequest.ts';
import type { MessagingOwnerRequest } from './messagingOwnerRequest.ts';

export type MemoryPeople = { state: 'unlinked' } | { state: 'unavailable'; sourceId?: string } | {
  state: 'ready'; sourceId: string; resolvedSourceId: string;
  participants: { userId: string; rung: 'NAMED' | 'PROFILE_LINKED' | 'CREW_ONLY'; name: string | null; handle: string | null }[];
  anonymousCount: number;
};
export type PeopleMemory = { id: string; title: string | null; people: MemoryPeople };
type Result<T> = { ok: true; data: T } | { ok: false; message: string };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
export function parseMemoryPeople(value: any): MemoryPeople {
  if (value?.state === 'unlinked') return { state: 'unlinked' };
  if (value?.state === 'unavailable') return { state: 'unavailable', ...(uuid(value.sourceId) ? { sourceId: value.sourceId } : {}) };
  if (value?.state !== 'ready' || !uuid(value.sourceId) || !uuid(value.resolvedSourceId) || !Array.isArray(value.participants)
    || !Number.isSafeInteger(value.anonymousCount) || value.anonymousCount < 0
    || value.participants.some((p:any) => !uuid(p?.userId) || !['NAMED','PROFILE_LINKED','CREW_ONLY'].includes(p.rung)
      || !(p.name === null || typeof p.name === 'string') || !(p.handle === null || typeof p.handle === 'string'))) return { state: 'unavailable' };
  return { state: 'ready', sourceId: value.sourceId, resolvedSourceId: value.resolvedSourceId, anonymousCount: value.anonymousCount,
    participants: value.participants.map((p:any) => ({ userId:p.userId,rung:p.rung,name:p.rung==='NAMED'?p.name:null,handle:p.handle })) };
}
async function request(path:string, owner:MessagingOwnerRequest, body?:object): Promise<Result<any>> {
  try {
    const response=await fetchOwnedApi(`/api${path}`,{owner,method:body?'POST':'GET',...(body?{body}:{})});
    const data=await response.json();
    if(!owner.isCurrent())return {ok:false,message:'Your signed-in session changed. Reopen People.'};
    if(!response.ok)return {ok:false,message:typeof data?.message==='string'?data.message:'People could not be loaded. Try again.'};
    return {ok:true,data};
  }catch{return {ok:false,message:'The result could not be confirmed. Refresh before trying again.'};}
}
export async function loadPassportPeople(owner:MessagingOwnerRequest):Promise<Result<PeopleMemory[]>> {
  const result=await request('/me/passport/memories/people',owner);
  if(!result.ok)return result;
  if(!Array.isArray(result.data?.memories)||result.data.memories.some((r:any)=>!uuid(r?.id)))return {ok:false,message:'People could not be loaded. Try again.'};
  return {ok:true,data:result.data.memories.map((r:any)=>({id:r.id,title:typeof r.title==='string'?r.title:null,people:parseMemoryPeople(r.people)}))};
}
export async function setPassportMemorySource(owner:MessagingOwnerRequest, id:string, memoryId:string|null, expectedMemoryId:string|null):Promise<Result<null>> {
  const result=await request(`/me/passport/memories/${encodeURIComponent(id)}/source`,owner,{memoryId,expectedMemoryId});
  if(!result.ok)return result;
  return result.data?.memoryId===memoryId ? {ok:true,data:null} : {ok:false,message:'The link could not be confirmed. Refresh before trying again.'};
}
