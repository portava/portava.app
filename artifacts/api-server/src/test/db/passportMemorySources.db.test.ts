import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import express from 'express';
import { _setTestClient } from '../../lib/http.js';
import { _setTestServiceClient } from '../../lib/supabase.js';
import { openPressedLayoverDb, PRESSED_SKIP_REASON, PRESSED_BACKEND } from './pressedLayoverDb.js';
import { loadPassportMemoryPeople } from '../../services/passport/PassportMemoryPeople.js';

describe('Passport private Memory association on the canonical schema', { skip: PRESSED_SKIP_REASON }, () => {
  let db: Awaited<ReturnType<typeof openPressedLayoverDb>>;
  let owner: string, stranger: string, ownerToken: string, strangerToken: string;
  const scrapbook = randomUUID(), other = randomUUID(), first = randomUUID(), second = randomUUID(), foreign = randomUUID();
  const q = (s: string | null) => s === null ? 'NULL' : `'${s}'::uuid`;
  const command = (actor: string, target: string, source: string | null, expected: string | null) =>
    `SELECT public.passport_memory_source_set(${q(actor)},${q(target)},${q(source)},${q(expected)}) AS result`;
  const set = async (actor: string, target: string, source: string | null, expected: string | null) => (await db.query<{result: {ok: boolean; reason?: string; memoryId?: string|null}}>(command(actor,target,source,expected)))[0]!.result;
  before(async () => {
    db = await openPressedLayoverDb();
    const ownUser = await db.seedUser('passport-source-owner'), otherUser = await db.seedUser('passport-source-other');
    owner=ownUser.id;ownerToken=ownUser.token;stranger=otherUser.id;strangerToken=otherUser.token;
    await db.exec(`INSERT INTO public.passport_memories(id,user_id,status,visibility) VALUES('${scrapbook}','${owner}','active','public'),('${other}','${stranger}','active','public');
      INSERT INTO public.memories(id,owner_id,title,state,visibility) VALUES('${first}','${owner}','First','published','only_me'),('${second}','${owner}','Second','published','only_me'),('${foreign}','${stranger}','Other','published','only_me')`);
  });
  after(async () => { await db?.close(); });

  it('one owner choice is idempotent; foreign owners and stale replacements cannot change it', async () => {
    assert.deepEqual(await set(owner,scrapbook,first,null),{ok:true,memoryId:first});
    assert.deepEqual(await set(owner,scrapbook,first,null),{ok:true,memoryId:first});
    assert.equal((await db.query('SELECT * FROM public.passport_memory_sources')).length,1);
    assert.deepEqual(await set(stranger,scrapbook,foreign,first),{ok:false,reason:'not_found'});
    assert.deepEqual(await set(owner,scrapbook,foreign,first),{ok:false,reason:'not_found'});
    assert.deepEqual(await set(owner,other,first,null),{ok:false,reason:'not_found'});
    assert.deepEqual(await set(owner,scrapbook,second,null),{ok:false,reason:'conflict'});
    assert.deepEqual(await set(owner,scrapbook,second,first),{ok:true,memoryId:second});
    assert.deepEqual(await set(owner,scrapbook,null,first),{ok:false,reason:'conflict'});
    assert.deepEqual(await set(owner,scrapbook,null,second),{ok:true,memoryId:null});
    assert.deepEqual(await set(owner,scrapbook,null,second),{ok:true,memoryId:null});
  });
  it('public scrapbook visibility never exposes or grants writes to its private association', async () => {
    await set(owner,scrapbook,first,null);
    await db.exec('BEGIN; SET LOCAL ROLE anon');
    try {
      assert.equal((await db.query(`SELECT id FROM public.passport_memories WHERE id='${scrapbook}'`)).length,1);
      await assert.rejects(db.query('SELECT * FROM public.passport_memory_sources'), /permission denied/);
    } finally { await db.exec('ROLLBACK'); }
    await assert.rejects(db.asUser(owner,'SELECT * FROM public.passport_memory_sources'), /permission denied/);
    await assert.rejects(db.asUser(owner,command(owner,scrapbook,second,first)), /permission denied/);
    const [{allowed}] = await db.query<{allowed:boolean}>("SELECT has_table_privilege('service_role','public.passport_memory_sources','INSERT,UPDATE,DELETE') AS allowed");
    assert.equal(allowed,false,'service writes must use the single validated command');
    const rpc = await db.client.rpc('passport_memory_source_set',{p_actor:owner,p_passport_memory:scrapbook,p_memory:first,p_expected_memory:first});
    assert.equal(rpc.error,null);assert.deepEqual(rpc.data,{ok:true,memoryId:first});
  });
  it('fresh projections distinguish unlinked, revoked source, and unreadable ownership; merge follows the canonical stable ID', async () => {
    let result = await loadPassportMemoryPeople(db.client,owner,[scrapbook]);
    assert.equal(result.get(scrapbook)?.state,'ready');
    assert.equal((await loadPassportMemoryPeople(db.client,stranger,[scrapbook])).get(scrapbook)?.state,'unavailable');
    await db.exec(`UPDATE public.memories SET state='deleted' WHERE id='${first}'`);
    result = await loadPassportMemoryPeople(db.client,owner,[scrapbook]);
    assert.deepEqual(result.get(scrapbook),{state:'unavailable',sourceId:first});
    assert.deepEqual(await set(owner,scrapbook,first,first),{ok:false,reason:'not_found'});
    await db.exec(`INSERT INTO public.memory_id_redirects(old_memory_id,new_memory_id,owner_id,reason) VALUES('${first}','${second}','${owner}','merged')`);
    result = await loadPassportMemoryPeople(db.client,owner,[scrapbook]);
    assert.deepEqual(result.get(scrapbook),{state:'ready',sourceId:first,resolvedSourceId:second,participants:[],anonymousCount:0});
    await set(owner,scrapbook,null,first);
    assert.deepEqual((await loadPassportMemoryPeople(db.client,owner,[scrapbook])).get(scrapbook),{state:'unlinked'});
    await db.exec(`DELETE FROM public.memory_id_redirects WHERE old_memory_id='${first}'; UPDATE public.memories SET state='published' WHERE id='${first}'`);
  });
  it('independent competing commands serialize and a late stale choice loses', async t => {
    if(PRESSED_BACKEND!=='psql'){t.diagnostic('Independent sessions require PostgreSQL');return;}
    const databaseUrl=db.databaseUrl;assert.ok(databaseUrl);
    const a = new Client({connectionString:databaseUrl}), b = new Client({connectionString:databaseUrl});
    await a.connect(); await b.connect();
    try {
      await a.query('BEGIN'); await a.query(command(owner,scrapbook,first,null));
      const pending = b.query(command(owner,scrapbook,second,null));
      await a.query('COMMIT');
      assert.deepEqual((await pending).rows[0].result,{ok:false,reason:'conflict'});
      assert.deepEqual((await db.query('SELECT memory_id FROM public.passport_memory_sources')),[{memory_id:first}]);
    } finally { await a.query('ROLLBACK');await a.end();await b.end(); }
  });
  it('consent, names and bidirectional blocking are read again rather than copied into Passport', async () => {
    const participant = (await db.seedUser('passport-participant')).id;
    await db.exec(`INSERT INTO public.memory_tags(memory_id,tagged_user_id,status) VALUES('${first}','${participant}','approved');
      INSERT INTO public.profile_privacy_settings(user_id,show_real_name) VALUES('${participant}',true) ON CONFLICT(user_id) DO UPDATE SET show_real_name=true`);
    const read = async () => {
      const result = (await loadPassportMemoryPeople(db.client,owner,[scrapbook])).get(scrapbook);
      assert.equal(result?.state,'ready');assert.ok(result?.state==='ready');return result;
    };
    assert.equal((await read()).participants[0]?.name,'passport-participant');
    await db.exec(`UPDATE public.profile_privacy_settings SET show_real_name=false WHERE user_id='${participant}'`);
    assert.equal((await read()).participants[0]?.name,null);
    await db.exec(`UPDATE public.memory_tags SET status='removed' WHERE memory_id='${first}' AND tagged_user_id='${participant}'`);
    assert.deepEqual((await read()).participants,[]);
    await db.exec(`UPDATE public.memory_tags SET status='approved' WHERE memory_id='${first}' AND tagged_user_id='${participant}'; INSERT INTO public.blocks(blocker_id,blocked_id) VALUES('${participant}','${owner}')`);
    assert.deepEqual((await read()).participants,[]);
    await db.exec(`DELETE FROM public.blocks WHERE blocker_id='${participant}' AND blocked_id='${owner}'`);
    assert.equal((await read()).participants[0]?.userId,participant);
    const fault = (r:{target:string}) => r.target==='memory_tags' ? {status:503,body:{message:'injected unreadable tags'}} : null;
    db.bridge.faults.push(fault);
    try {assert.equal((await loadPassportMemoryPeople(db.client,owner,[scrapbook])).get(scrapbook)?.state,'unavailable');}
    finally {db.bridge.faults.splice(db.bridge.faults.indexOf(fault),1);}
  });
  it('hard erasure removes the association rather than retaining a detached private identity', async () => {
    await db.exec(`DELETE FROM public.memories WHERE id='${first}'`);
    assert.equal((await db.query('SELECT * FROM public.passport_memory_sources')).length,0);
    await set(owner,scrapbook,second,null);
    await db.exec(`DELETE FROM public.passport_memories WHERE id='${scrapbook}'`);
    assert.equal((await db.query('SELECT * FROM public.passport_memory_sources')).length,0);
  });
  it('the real owner API authenticates writes and returns live private projections without caching', async () => {
    const {default:router}=await import('../../routes/passportStamps.js');
    _setTestClient(db.client,true);_setTestServiceClient(db.client);
    await db.setFlags({passport_memories_enabled:true});
    await db.exec(`INSERT INTO public.passport_memories(id,user_id,status) VALUES('${scrapbook}','${owner}','active')`);
    const app=express();app.use(express.json());app.use((req:any,_res,next)=>{req.log={error(){},warn(){},info(){},debug(){}};next();});app.use('/api',router);
    const server=await new Promise<import('node:http').Server>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    const base=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/me/passport/memories`;
    const link=(token:string)=>fetch(`${base}/${scrapbook}/source`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({memoryId:second,expectedMemoryId:null})});
    try {
      assert.equal((await fetch(`${base}/people`)).status,401);
      assert.equal((await link(strangerToken)).status,404);
      const saved=await link(ownerToken);assert.equal(saved.status,200);assert.deepEqual(await saved.json(),{memoryId:second});
      const read=await fetch(`${base}/people`,{headers:{authorization:`Bearer ${ownerToken}`}});
      assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'private, no-store');
      const body=await read.json() as any;assert.equal(body.memories[0].people.sourceId,second);assert.equal(body.memories[0].people.state,'ready');
      const fault=(r:{target:string})=>r.target==='passport_memories'?{status:503,body:{message:'injected failure'}}:null;
      db.bridge.faults.push(fault);
      try {assert.equal((await fetch(base,{headers:{authorization:`Bearer ${ownerToken}`}})).status,503);}
      finally {db.bridge.faults.splice(db.bridge.faults.indexOf(fault),1);}
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));_setTestClient(null,false);_setTestServiceClient(null);}
  });
});
