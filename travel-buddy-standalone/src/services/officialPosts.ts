import { messagingOwnerToken, type MessagingOwnerRequest } from './messagingOwnerRequest.ts';

export async function createOfficialPost(body: Record<string, unknown>, owner: MessagingOwnerRequest): Promise<{ok:true;postId:string}|{ok:false;error:string}> {
  const abort = new AbortController(); const timeout = setTimeout(() => abort.abort(), 20000);
  try {
    const token = await messagingOwnerToken(owner);
    if (!token || !owner.isCurrent()) return {ok:false,error:'Your signed-in session changed. Reopen the editor.'};
    const response = await fetch(`${process.env.EXPO_PUBLIC_API_BASE_URL ?? ''}/api/admin/portava/posts`, {
      method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify(body), signal:abort.signal,
    });
    const result=await response.json();
    if (!owner.isCurrent()) return {ok:false,error:'Your signed-in session changed. Reopen the editor.'};
    if(!response.ok) return {ok:false,error:typeof result?.message==='string'?result.message:'The post could not be saved. Try again.'};
    if(typeof result?.post?.id!=='string' || !/^[0-9a-f-]{36}$/i.test(result.post.id)) return {ok:false,error:'The saved post could not be confirmed. Retry this submission.'};
    return {ok:true,postId:result.post.id};
  } catch { return {ok:false,error:'Could not connect. Retry this submission.'}; }
  finally {clearTimeout(timeout);}
}
