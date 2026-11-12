import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import collectionsRouter from '../routes/collections.js';
import { _setTestClient } from '../lib/http.js';
import { _setTestServiceClient } from '../lib/supabase.js';
import { makeFailClosedClient, type FakeClientSpec } from './helpers/failClosedSupabase.js';
const ME='10000000-0000-4000-8000-000000000001', OTHER='10000000-0000-4000-8000-000000000002';
const GEM='20000000-0000-4000-8000-000000000001', COL='30000000-0000-4000-8000-000000000001';
const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).log={error(){},warn(){}};next();});app.use('/api',collectionsRouter);
const server=createServer(app); await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${(server.address() as any).port}/api`;
after(async()=>{_setTestClient(null,false);_setTestServiceClient(null);await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));});
function setup(patch:Record<string,unknown>={},extra:FakeClientSpec={}){
 const inserted:Record<string,any[]>={};
 const rows={ collections:[{id:COL,owner_id:ME,is_default:true}],collection_items:[{id:GEM,collection_id:COL,entity_id:GEM,entity_type:'gem',saved_at:'2026-11-01'}],hidden_gem_saves:[{user_id:ME,gem_id:GEM,saved_at:'2026-11-01'}], hidden_gems:[{id:GEM,name:'Secret beach',status:'active',sensitivity_level:'public',visibility:'public',moderation_status:'approved',submitted_by:OTHER,canonical_place_id:null,...patch}],profiles:[{id:OTHER,is_private:false}],blocks:[],...extra.rows};
 const db=makeFailClosedClient({...extra,rows,users:{token:ME},inserted});_setTestClient(db,true);_setTestServiceClient(db);return inserted;
}
async function call(path:string,method='GET',body?:unknown){const response=await fetch(base+path,{method,headers:{Authorization:'Bearer token','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json() as { items: Array<{ title: string | null; coverUrl: string | null }>; gems: Array<{ id: string; title: string | null }>; nextCursor: string | null }};}
test('gem previews and legacy list are readable when current source allows them',async()=>{
 setup(); const p=await call(`/users/me/collections/${COL}/items`);assert.equal(p.status,200,JSON.stringify(p.body));assert.equal(p.body.items[0].title,'Secret beach');assert.equal(p.body.items[0].coverUrl,null);
 const saved=await call('/users/me/saved-gems');assert.equal(saved.body.gems[0].title,'Secret beach');
 const written=await call('/saves','POST',{entity_type:'gem',entity_id:GEM,collection_id:COL});assert.equal(written.status,200);
});
test('saved references never leak currently protected, removed, private or moderated sources',async()=>{
 for(const patch of [{sensitivity_level:'protected'},{status:'removed'},{visibility:'private'},{moderation_status:'withheld'}]){
  setup(patch);const p=await call(`/users/me/collections/${COL}/items`);assert.equal(p.body.items[0].title,null);const saved=await call('/users/me/saved-gems');assert.equal(saved.body.gems[0].title,null);
  assert.equal((await call('/saves','POST',{entity_type:'gem',entity_id:GEM,collection_id:COL})).status,404);
 }
});
test('block and canonical place moderation revoke previews; unknown reads fail closed',async()=>{
 setup({}, {rows:{blocks:[{blocker_id:OTHER,blocked_id:ME}]}});assert.equal((await call('/users/me/saved-gems')).body.gems[0].title,null);
 setup({canonical_place_id:'place'}, {rows:{places:[{id:'place',moderation_status:'withheld',merged_into_place_id:null}]}});assert.equal((await call('/users/me/saved-gems')).body.gems[0].title,null);
 setup({}, {failOn:c=>c.table==='blocks'?{message:'down'}:null});assert.equal((await call('/users/me/saved-gems')).status,503);
 setup({}, {failOn:c=>c.table==='collections'?{message:'down'}:null});assert.notEqual((await call(`/users/me/saves?entity_type=gem&entity_id=${GEM}`)).status,200);
});
test('wrong-owner and malformed collection targets never silently save to default',async()=>{
 const writes=setup({}, {rows:{collections:[{id:COL,owner_id:OTHER}]}});
 assert.equal((await call('/saves','POST',{entity_type:'gem',entity_id:GEM,collection_id:COL})).status,404);
 assert.equal((await call('/saves','POST',{entity_type:'gem',entity_id:GEM,collection_id:'bad'})).status,400);
 assert.equal(writes.collection_items?.length ?? 0,0);
});
test('legacy gem list pages every bookmark without exposing another account saves',async()=>{
 const ids=Array.from({length:42},(_,i)=>`40000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
 setup({}, {rows:{hidden_gem_saves:[...ids.map(gem_id=>({gem_id,user_id:ME,saved_at:'2026-11-01'})),{gem_id:'50000000-0000-4000-8000-000000000001',user_id:OTHER,saved_at:'2026-11-01'}]}});
 const first=await call('/users/me/saved-gems');assert.equal(first.body.gems.length,40);assert.equal(first.body.nextCursor,ids[39]);
 const second=await call(`/users/me/saved-gems?before=${first.body.nextCursor}`);assert.deepEqual(second.body.gems.map(g=>g.id),ids.slice(40));assert.equal(second.body.nextCursor,null);
 assert.equal((await call('/users/me/saved-gems?before=bad')).status,400);
});
