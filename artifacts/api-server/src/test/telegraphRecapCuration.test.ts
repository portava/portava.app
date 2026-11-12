import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { _setTestClient } from '../lib/http.js';
import router from '../routes/telegraphMemory.js';
import { readMemoryMessageSource } from '../services/telegraph/memorySource.js';
import { makeFakeClient, startRouter } from './telegraphCertificationHarness.js';
const A='aaaaaaaa-0000-4000-8000-000000000001', B='bbbbbbbb-0000-4000-8000-000000000002';
const T='cccccccc-0000-4000-8000-000000000003', M='dddddddd-0000-4000-8000-000000000004';
const D='eeeeeeee-0000-4000-8000-000000000005', P='ffffffff-0000-4000-8000-000000000006';
const at='2026-10-05T18:30:00Z';
function seed() { return {
  feature_flags:[{flag:'telegraph_structured_schemas_enabled',enabled:true},{flag:'memory_kernel_enabled',enabled:true},{flag:'telegraph_forwarding_enabled',enabled:true}],
  memories:[{id:D,owner_id:A,state:'draft'}], telegraph_memory_sources:[{memory_id:D,message_id:M}],
  message_threads:[{id:T,thread_type:'direct',status:'active'}],
  message_thread_members:[{thread_id:T,user_id:A,left_at:null,visible_from_at:null,visible_from_sequence:null,visible_until_sequence:null}],
  messages:[{id:M,thread_id:T,sender_id:B,body:'private caption',created_at:at,msg_type:'media',subtype:null,media_type:'image',media_url:'post-media/b/photo.jpg',deleted_at:null,unsent_at:null,ciphertext:null,sequence:3}],
  profiles:[{id:A,account_status:'active',handle:'a'},{id:B,account_status:'active',handle:'b'}], blocks:[] as Array<Record<string,unknown>>,
  meetups:[{id:P,creator_id:B,chat_thread_id:T,status:'confirmed',starts_at:'2026-10-05T18:00:00Z',ends_at:'2026-10-05T20:00:00Z'}],
  meetup_invites:[{meetup_id:P,user_id:A,status:'going'},{meetup_id:P,user_id:B,status:'going'}],
}; }
const source = (db: ReturnType<typeof seed>, viewer=A, options?: Parameters<typeof makeFakeClient>[1]) => readMemoryMessageSource(makeFakeClient(db,options) as unknown as SupabaseClient,viewer,D);
interface ChoicesResponse { wrote?: string; choices: { items: Array<{messageId:string}>; people: Array<{userId:string}>; preview: {messageId:string} | null } }
async function get(db: ReturnType<typeof seed>, query:string,viewer=A) {
  const client=makeFakeClient(db); _setTestClient(client as unknown as SupabaseClient,true);
  const h=await startRouter(router);
  try { const res=await fetch(`${h.base}/threads/${T}/recap${query}`,{headers:{Authorization:`Bearer ${viewer}`}}); return {status:res.status,body:await res.json() as ChoicesResponse}; }
  finally { await h.close(); }
}
afterEach(()=>_setTestClient(null,false));
describe('Recap choices and private Memory references',()=>{
  it('a source resolves current media without copying its caption',async()=>{
    const value=await source(seed()); assert.equal(value?.messageId,M); assert.equal(value?.body,null); assert.equal(value?.media[0]?.url,'post-media/b/photo.jpg');
  });
  it('publishing a Memory does not give another viewer its private source',async()=>{
    const db=seed();db.memories[0].state='published';assert.equal(await source(db,B),null);
  });
  it('removed and unsent sources retain no payload',async()=>{
    for(const field of ['deleted_at','unsent_at'] as const) { const db=seed(); Object.assign(db.messages[0],{[field]:at}); assert.equal(await source(db),null); }
  });
  it('a departed member and a narrowed history window lose the reference',async()=>{
    for(const patch of [{left_at:at},{visible_from_at:'2026-10-06T00:00:00Z'},{visible_from_sequence:4}]) {
      const db=seed();Object.assign(db.message_thread_members[0],patch);assert.equal(await source(db),null);
    }
  });
  it('a block in either direction and an inactive author withhold the source',async()=>{
    for(const block of [{blocker_id:A,blocked_id:B},{blocker_id:B,blocked_id:A}]) { const db=seed();db.blocks.push(block);assert.equal(await source(db),null); }
    const db=seed();db.profiles[1].account_status='deleted';assert.equal(await source(db),null);
  });
  it('an unknown future envelope cannot expose its payload through a Memory',async()=>{
    const db=seed();Object.assign(db.messages[0],{msg_type:'future_kind',body:'secret future payload'});
    const value=await source(db);assert.ok(!JSON.stringify(value).includes('secret future payload'));assert.deepEqual(value?.media,[]);
  });
  it('curation lists only references from the completed window and performs no save',async()=>{
    const result=await get(seed(),'?curation=photos');assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal(result.body.wrote,'nothing');assert.equal(result.body.choices.items[0].messageId,M);
    assert.ok(!JSON.stringify(result.body.choices).includes('private caption'));assert.ok(!JSON.stringify(result.body.choices).includes('photo.jpg'));
  });
  it('a preview needs an explicit current-session source selection',async()=>{
    const result=await get(seed(),`?curation=memory&sourceMessageId=${M}`);assert.equal(result.status,200,JSON.stringify(result.body));assert.ok(result.body.choices.preview);assert.equal(result.body.choices.preview.messageId,M);
    const outside=await get(seed(),`?curation=memory&sourceMessageId=${D}`);assert.equal(outside.body.choices.preview,null);
  });
  it('people selection includes only currently visible participants and excludes self',async()=>{
    const result=await get(seed(),'?curation=people');assert.equal(result.status,200,JSON.stringify(result.body));assert.deepEqual(result.body.choices.people.map((p:{userId:string})=>p.userId),[B]);
    const db=seed();db.blocks.push({blocker_id:B,blocked_id:A});const blocked=await get(db,'?curation=people');assert.deepEqual(blocked.body.choices.people,[]);
  });
  it('unknown selection modes and non-members cannot read choices',async()=>{
    assert.equal((await get(seed(),'?curation=all')).status,400);assert.equal((await get(seed(),'?curation=memory',B)).status,403);
  });
});
