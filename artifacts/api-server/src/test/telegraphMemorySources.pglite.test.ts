import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const A='aaaaaaaa-0000-4000-8000-000000000001', B='bbbbbbbb-0000-4000-8000-000000000002';
const T='cccccccc-0000-4000-8000-000000000003', M='dddddddd-0000-4000-8000-000000000004';
const M2='dddddddd-0000-4000-8000-000000000005';
let db: PGlite;
before(async()=>{
  db=new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE memories(id uuid PRIMARY KEY,owner_id uuid,state text,visibility text);
    CREATE TABLE message_threads(id uuid PRIMARY KEY);
    CREATE TABLE messages(id uuid PRIMARY KEY,thread_id uuid,sender_id uuid,created_at timestamptz,sequence bigint,deleted_at timestamptz,unsent_at timestamptz,ciphertext text);
    CREATE TABLE message_thread_members(thread_id uuid,user_id uuid,left_at timestamptz,visible_from_at timestamptz,visible_from_sequence bigint,visible_until_sequence bigint);
    CREATE TABLE blocks(blocker_id uuid,blocked_id uuid);
    CREATE TABLE saved_messages(user_id uuid,message_id uuid,PRIMARY KEY(user_id,message_id));
    CREATE TABLE receipts(key text PRIMARY KEY,result jsonb);
    CREATE TABLE events(id uuid);
    -- The existing kernel is independently certified. This transaction fixture
    -- models its canonical row/event/receipt writes so wrapper rollback is real.
    CREATE FUNCTION memory_kernel_execute(p_command jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE r jsonb; mid uuid:=gen_random_uuid(); BEGIN
      SELECT result INTO r FROM receipts WHERE key=p_command->>'idempotency_key';
      IF FOUND THEN RETURN r || '{"duplicate":true}'::jsonb; END IF;
      INSERT INTO memories VALUES(mid,(p_command->>'actor_user_id')::uuid,'draft','only_me');
      INSERT INTO events VALUES(mid);
      r:=jsonb_build_object('ok',true,'memory_id',mid,'result',jsonb_build_object('id',mid),'contract_version',1);
      INSERT INTO receipts VALUES(p_command->>'idempotency_key',r); RETURN r;
    END; $$;`);
  await db.exec(readFileSync(new URL('../migrations/4015_telegraph_memory_sources.sql',import.meta.url),'utf8'));
});
after(async()=>{await db?.close();});
beforeEach(async()=>{
  await db.exec(`TRUNCATE telegraph_memory_sources,memories,messages,message_threads,message_thread_members,blocks,saved_messages,receipts,events CASCADE;
    INSERT INTO message_threads VALUES('${T}');
    INSERT INTO messages(id,thread_id,sender_id,created_at,sequence) VALUES('${M}','${T}','${B}','2026-11-05T12:00Z',5),('${M2}','${T}','${B}','2026-11-05T13:00Z',6);
    INSERT INTO message_thread_members(thread_id,user_id) VALUES('${T}','${A}');`);
});
const command=(key='same',source=M)=>({type:'CREATE_MEMORY',actor_user_id:A,idempotency_key:key,payload:{telegraph_source_message_id:source,write:{state:'draft',visibility:'only_me'}}});
async function execute(value=command()) { return (await db.query<{result:{ok:boolean;memory_id:string;duplicate?:boolean}}>('SELECT telegraph_memory_draft_execute($1::jsonb) AS result',[JSON.stringify(value)])).rows[0].result; }
async function count(table:string){return Number((await db.query<{n:string}>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);}
describe('4015 atomic private Memory references in PostgreSQL',()=>{
  it('writes one Memory, source, saved entry, event and receipt in one transaction',async()=>{
    const result=await execute();assert.equal(result.ok,true);
    for(const table of ['memories','telegraph_memory_sources','saved_messages','events','receipts'])assert.equal(await count(table),1);
    const columns=(await db.query<{column_name:string}>("SELECT column_name FROM information_schema.columns WHERE table_name='telegraph_memory_sources' ORDER BY ordinal_position")).rows.map(x=>x.column_name);
    assert.deepEqual(columns,['memory_id','message_id','created_at']);
  });
  it('retries preserve the same Memory and one source',async()=>{const first=await execute();const again=await execute();assert.equal(again.memory_id,first.memory_id);assert.equal(await count('memories'),1);assert.equal(await count('saved_messages'),1);});
  it('a removed source refuses even an otherwise successful replay',async()=>{await execute();await db.exec(`UPDATE messages SET unsent_at=now() WHERE id='${M}'`);await assert.rejects(execute(),/message_unavailable/);assert.equal(await count('memories'),1);});
  it('failed source linkage rolls back the delegated kernel writes',async()=>{
    await db.exec(`CREATE FUNCTION reject_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'source write failed'; END; $$;
      CREATE TRIGGER reject_source BEFORE INSERT ON telegraph_memory_sources FOR EACH ROW EXECUTE FUNCTION reject_source();`);
    try {await assert.rejects(execute(),/source write failed/);for(const table of ['memories','events','receipts','saved_messages'])assert.equal(await count(table),0);}
    finally{await db.exec('DROP TRIGGER reject_source ON telegraph_memory_sources; DROP FUNCTION reject_source();');}
  });
  it('a key cannot switch an existing draft to a different message',async()=>{await execute();await assert.rejects(execute(command('same',M2)),/memory_source_mismatch/);assert.equal((await db.query<{message_id:string}>('SELECT message_id FROM telegraph_memory_sources')).rows[0].message_id,M);});
  it('departure and history bounds refuse before any Memory is created',async()=>{
    for(const patch of ["left_at=now()","visible_from_at='2026-11-06'",'visible_from_sequence=6','visible_until_sequence=4']){
      await db.exec(`UPDATE message_thread_members SET left_at=null,visible_from_at=null,visible_from_sequence=null,visible_until_sequence=null; UPDATE message_thread_members SET ${patch};`);
      await assert.rejects(execute(),/message_unavailable/);assert.equal(await count('memories'),0);
    }
  });
  it('the author can save their own pre-window message while still a member',async()=>{await db.exec(`UPDATE messages SET sender_id='${A}' WHERE id='${M}'; UPDATE message_thread_members SET visible_from_sequence=6`);assert.equal((await execute()).ok,true);});
  it('a missing sequence cannot pass a known sequence boundary',async()=>{await db.exec(`UPDATE messages SET sequence=null WHERE id='${M}'; UPDATE message_thread_members SET visible_from_sequence=1`);await assert.rejects(execute(),/message_unavailable/);assert.equal(await count('memories'),0);});
  it('either direction of block refuses without a draft',async()=>{for(const pair of [[A,B],[B,A]]){await db.exec('TRUNCATE blocks');await db.query('INSERT INTO blocks VALUES($1,$2)',pair);await assert.rejects(execute(),/message_unavailable/);}assert.equal(await count('memories'),0);});
  it('encrypted sources and non-private commands are refused',async()=>{
    const c=command();c.payload.write.visibility='public';await assert.rejects(execute(c),/invalid_telegraph_memory_command/);
    await db.exec(`UPDATE messages SET ciphertext='opaque' WHERE id='${M}'`);await assert.rejects(execute(),/message_unavailable/);
  });
  it('deleting a source keeps only an unavailable link; deleting the Memory removes it',async()=>{const r=await execute();await db.query('DELETE FROM messages WHERE id=$1',[M]);assert.equal((await db.query<{message_id:null}>('SELECT message_id FROM telegraph_memory_sources')).rows[0].message_id,null);await db.query('DELETE FROM memories WHERE id=$1',[r.memory_id]);assert.equal(await count('telegraph_memory_sources'),0);});
  it('ordinary database users cannot read the source table or invoke its writer',async()=>{
    for(const role of ['anon','authenticated']){await db.exec(`SET ROLE ${role}`);try{await assert.rejects(db.query('SELECT * FROM telegraph_memory_sources'),/permission denied/);await assert.rejects(execute(),/permission denied/);}finally{await db.exec('RESET ROLE');}}
  });
});
