import {before, after, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {readFileSync} from 'node:fs';
import {openPressedLayoverDb, PRESSED_SKIP_REASON} from './pressedLayoverDb.js';
import {executeMemoryCommand} from '../../lib/memoryCommandBus.js';
import {confirmCandidate} from '../../services/memory/episodeCandidates.js';

describe('candidate origin through the existing canonical Memory kernel', {skip:PRESSED_SKIP_REASON}, () => {
  let db: Awaited<ReturnType<typeof openPressedLayoverDb>>;
  let owner:string, other:string;
  const priorConfirmed=randomUUID(), priorImported=randomUUID(), priorUnrelated=randomUUID();
  const migration=()=>readFileSync(new URL('../../migrations/4036_memory_candidate_source_origin.sql',import.meta.url),'utf8');
  before(async()=>{
    db=await openPressedLayoverDb({without:['4036']});owner=(await db.seedUser('origin-owner')).id;other=(await db.seedUser('origin-other')).id;
    const id=await episode('confirmed');
    await db.exec(`INSERT INTO public.memories(id,owner_id,title,state,visibility,source_mode) VALUES
      ('${priorConfirmed}','${owner}','Known candidate','published','only_me','USER_CREATED'),
      ('${priorImported}','${owner}','Legacy candidate','published','only_me','LEGACY_IMPORTED'),
      ('${priorUnrelated}','${owner}','Manual history','published','only_me','USER_CREATED');
      INSERT INTO public.memory_evidence(episode_id,user_id,truth_level,source_class,source_table,source_id,source_ref,observed_at,weight) VALUES
      ('${id}','${owner}','asserted','explicit','memories','${priorConfirmed}','{"confirmed_by":"owner"}',now(),1),
      ('${id}','${owner}','asserted','explicit','memories','${priorImported}','{"confirmed_by":"owner"}',now(),1)`);
    await db.exec(migration());
    await db.setFlag('memory_kernel_enabled',true);
  });
  after(async()=>{await db?.close();});
  async function episode(state='candidate', actor=owner) {
    const id=randomUUID();
    await db.exec(`INSERT INTO public.memory_episodes(id,user_id,episode_kind,summary,started_at,ended_at,detection_reason,detector_version,detection_digest,significance,significance_basis,state,visibility)
      VALUES('${id}','${actor}','activity','Synthetic suggestion',now()-interval '2 days',now()-interval '2 days'+interval '1 hour','media_cluster',1,'${id}',0.8,'user_affirmed','${state}','private')`);
    return id;
  }
  const keep=(id:string)=>confirmCandidate(db.client,{ownerId:owner,episodeId:id,title:null,idempotencyKey:randomUUID(),now:new Date()});
  const command=(id:string,actor=owner)=>({commandId:randomUUID(),memoryId:null,actorUserId:actor,idempotencyKey:`memory-candidate:${id}`,type:'CREATE_MEMORY' as const,payload:{candidate_episode_id:id,to_state:'ACTIVE',visibility:'only_me',write:{title:'Synthetic origin',state:'published',visibility:'only_me',source_mode:'SUGGESTED'}}});
  const origin=async(id:string)=>(await db.query<{source_mode:string}>(`SELECT source_mode FROM public.memories WHERE id='${id}'`))[0]?.source_mode;

  it('migration corrects proven candidate defaults once and preserves imported or unrelated histories',async()=>{
    assert.equal(await origin(priorConfirmed),'SUGGESTED');assert.equal(await origin(priorImported),'LEGACY_IMPORTED');assert.equal(await origin(priorUnrelated),'USER_CREATED');
    const events=await db.query(`SELECT event_id FROM public.memory_domain_events WHERE memory_id='${priorConfirmed}'`);assert.equal(events.length,1);
    await db.exec(migration());
    assert.deepEqual(await db.query(`SELECT event_id FROM public.memory_domain_events WHERE memory_id='${priorConfirmed}'`),events);
  });

  it('candidate create stores suggested origin in the same transaction as its event; manual create keeps its default',async()=>{
    const id=await episode('confirmed');const result=await executeMemoryCommand(db.client,command(id));assert.ok(result.ok,JSON.stringify(result));
    assert.equal(await origin(result.memoryId!),'SUGGESTED');
    const same=await db.query<{same:boolean}>(`SELECT m.xmin=e.xmin AS same FROM public.memories m JOIN public.memory_domain_events e ON e.memory_id=m.id WHERE m.id='${result.memoryId}'`);
    assert.deepEqual(same,[{same:true}]);
    const manual=await executeMemoryCommand(db.client,{...command(id),idempotencyKey:randomUUID(),payload:{to_state:'ACTIVE',write:{title:'Manual',state:'published',visibility:'only_me'}}});
    assert.ok(manual.ok,JSON.stringify(manual));assert.equal(await origin(manual.memoryId!),'USER_CREATED');
  });
  it('the real confirmation service preserves origin and one Memory on retry',async()=>{
    const id=await episode();const first=await keep(id);assert.ok(first.ok&&first.state==='confirmed',JSON.stringify(first));
    assert.equal(await origin(first.memoryId),'SUGGESTED');
    const second=await keep(id);assert.ok(second.ok&&second.state==='confirmed',JSON.stringify(second));assert.equal(second.memoryId,first.memoryId);
    assert.equal((await db.query(`SELECT id FROM public.memories WHERE id='${first.memoryId}'`)).length,1);
  });
  it('an unavailable deployment contract refuses before claiming the candidate',async()=>{
    const id=await episode();
    await db.exec('ALTER FUNCTION public.memory_candidate_origin_ready() RENAME TO origin_ready_test_hidden');
    try {const result=await keep(id);assert.ok(!result.ok&&result.reason==='unavailable',JSON.stringify(result));}
    finally {await db.exec('ALTER FUNCTION public.origin_ready_test_hidden() RENAME TO memory_candidate_origin_ready');}
    assert.deepEqual(await db.query(`SELECT state FROM public.memory_episodes WHERE id='${id}'`),[{state:'candidate'}]);
    assert.equal((await db.query(`SELECT id FROM public.memory_evidence WHERE episode_id='${id}'`)).length,0);
  });
  it('foreign or rejected episodes cannot label a Memory as suggested',async()=>{
    for (const id of [await episode('confirmed',other),await episode('rejected')]) {
      const result=await executeMemoryCommand(db.client,command(id));assert.ok(!result.ok,JSON.stringify(result));
      assert.equal((await db.query(`SELECT idempotency_key FROM public.memory_command_receipts WHERE idempotency_key='memory-candidate:${id}'`)).length,0);
    }
  });
  it('an explicitly linked old confirmation is reconciled once through the command writer',async()=>{
    const id=await episode('confirmed'), memory=randomUUID();
    await db.exec(`INSERT INTO public.memories(id,owner_id,title,state,visibility) VALUES('${memory}','${owner}','Old suggestion','published','only_me');
      INSERT INTO public.memory_evidence(episode_id,user_id,truth_level,source_class,source_table,source_id,source_ref,observed_at,weight)
      VALUES('${id}','${owner}','asserted','explicit','memories','${memory}','{"confirmed_by":"owner"}',now(),1)`);
    const result=await keep(id);assert.ok(result.ok&&result.state==='confirmed',JSON.stringify(result));assert.equal(result.memoryId,memory);assert.equal(await origin(memory),'SUGGESTED');
    assert.ok((await keep(id)).ok);
    assert.equal((await db.query(`SELECT idempotency_key FROM public.memory_command_receipts WHERE idempotency_key='memory-candidate-origin:${id}'`)).length,1);
  });
  it('origin correction refuses an unrelated Memory and never overwrites an imported origin',async()=>{
    const id=await episode('confirmed'), memory=randomUUID();
    await db.exec(`INSERT INTO public.memories(id,owner_id,title,state,visibility,source_mode) VALUES('${memory}','${owner}','Imported','published','only_me','LEGACY_IMPORTED')`);
    const result=await executeMemoryCommand(db.client,{...command(id),type:'UPDATE_MEMORY',memoryId:memory,idempotencyKey:randomUUID(),payload:{candidate_episode_id:id,patch:{source_mode:'SUGGESTED'}}});
    assert.ok(!result.ok,JSON.stringify(result));assert.equal(await origin(memory),'LEGACY_IMPORTED');
  });
  it('independent database sessions replay one candidate create with the same origin',async()=>{
    assert.ok(db.databaseUrl);const id=await episode('confirmed');const a=new Client({connectionString:db.databaseUrl}),b=new Client({connectionString:db.databaseUrl});
    await a.connect();await b.connect();
    const envelope=(c:ReturnType<typeof command>)=>({command_id:c.commandId,memory_id:null,actor_user_id:c.actorUserId,idempotency_key:c.idempotencyKey,type:c.type,payload:c.payload});
    try {
      await a.query('SET ROLE service_role');await b.query('SET ROLE service_role');
      const results=await Promise.all([a,b].map(c=>c.query('SELECT public.memory_kernel_execute($1::jsonb) AS result',[JSON.stringify(envelope(command(id)))])));
      const receipts=results.map(r=>r.rows[0].result);assert.ok(receipts.every(r=>r.ok),JSON.stringify(receipts));assert.equal(receipts[0].memory_id,receipts[1].memory_id);
      assert.equal(await origin(receipts[0].memory_id),'SUGGESTED');assert.equal(receipts.filter(r=>r.duplicate).length,1);
    } finally {await a.end();await b.end();}
  });
  it('the deployment probe is read-only and not client executable',async()=>{
    const probe=await db.client.rpc('memory_candidate_origin_ready');assert.equal(probe.data,true);assert.equal(probe.error,null);
    await assert.rejects(db.asUser(owner,'SELECT public.memory_candidate_origin_ready()'),/permission denied/);
    const grants=await db.query(`SELECT has_function_privilege('anon','public.memory_candidate_origin_ready()','EXECUTE') AS anon, has_function_privilege('service_role','public.memory_candidate_origin_ready()','EXECUTE') AS service`);
    assert.deepEqual(grants,[{anon:false,service:true}]);
  });
});
