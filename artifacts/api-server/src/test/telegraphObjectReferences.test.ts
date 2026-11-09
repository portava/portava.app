import { negotiateStoredMessageRows, decoratePlatformReads } from '../services/telegraph/platformReadDecorations.js';
import { makeFakeClient } from './telegraphCertificationHarness.js';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { encodeObjectReference, decodeObjectReference } from '../services/telegraph/objectReference.js';
import { prepareLegacyCardWrite } from '../services/telegraph/legacyCardWrite.js';
import { buildPortavaObjectBody, parsePortavaObjectRow } from '../services/telegraph/shareables.js';
import { applySharedCardTruth } from '../services/telegraph/sharedCardTruth.js';
import { sameSendPayload } from '../services/telegraphReliability.js';
import { coalescingClient } from '../services/telegraph/coalescedReads.js';
const ID = '11111111-0000-4000-8000-000000000001';
const body = JSON.stringify({sourceId:`db/${ID}`,sourceType:'place',title:'old snapshot'});
describe('versioned canonical references', () => {
  it('round trips known sources and rejects corrupt or future pointers', () => {
    const ref = {objectType:'PLACE' as const,objectId:ID};
    assert.deepEqual(decodeObjectReference(encodeObjectReference(ref)),ref);
    for (const value of ['portava-object.v2:PLACE:x','portava-object.v1:FUTURE:x','portava-object.v1:PLACE:%','portava-object.v1:PLACE:%00','portava-object.v1:PLACE:'+'x'.repeat(201)]) assert.equal(decodeObjectReference(value),null);
  });
  it('reads 3936 trigger references and withholds altered source identities', () => {
    for (const kind of ['POST', 'MEDIA'] as const) {
      const source = buildPortavaObjectBody(kind, ID);
      assert.deepEqual(parsePortavaObjectRow({ body: source, content_ref: `portava:${kind}:${ID}` }), source);
      for (const contentRef of [`portava:PLACE:${ID}`, `portava:${kind}:different`, `portava:${kind}:%2F`]) {
        assert.equal(parsePortavaObjectRow({ body: source, content_ref: contentRef }), null);
      }
    }
    assert.equal(decodeObjectReference('portava:FUTURE:one'), null);
    assert.equal(decodeObjectReference('portava:POST:' + 'a'.repeat(129)), null);
  });
  it('renders the pointer actually stored by the 3936 trigger and clears it on retraction', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE ROLE anon;
        CREATE ROLE authenticated;
        CREATE TABLE public.feature_flags (flag text PRIMARY KEY, enabled boolean);
        INSERT INTO public.feature_flags VALUES ('telegraph_message_kernel_enabled', true);
        CREATE TABLE public.messages (id uuid PRIMARY KEY, content_ref text, body text, msg_type text, deleted_at timestamptz, unsent_at timestamptz);
      `);
      await db.exec(readFileSync(new URL('../migrations/3936_telegraph_message_content_ref.sql', import.meta.url), 'utf8'));
      const object = buildPortavaObjectBody('POST', ID);
      const { rows } = await db.query<{ body: string; content_ref: string }>(
        'INSERT INTO messages(id,body,msg_type,content_ref) VALUES($1,$2,$3,$4) RETURNING body,content_ref',
        [ID, JSON.stringify(object), 'portava_object', encodeObjectReference(object)],
      );
      assert.equal(rows[0]!.content_ref, `portava:POST:${ID}`);
      assert.deepEqual(parsePortavaObjectRow(rows[0]!), object);
      const retracted = await db.query<{ content_ref: string | null }>('UPDATE messages SET unsent_at = now() WHERE id = $1 RETURNING content_ref', [ID]);
      assert.equal(retracted.rows[0]!.content_ref, null);
    } finally {
      await db.close();
    }
  });
  it('stamps legacy writes and normalizes their canonical pointer while leaving plain text alone', () => {
    const prepared=prepareLegacyCardWrite({body,msg_type:'system',subtype:'discovery_card'});
    assert.equal(JSON.parse(prepared.body!).cardSchemaVersion,1);
    assert.deepEqual(decodeObjectReference(prepared.contentRef),{objectType:'PLACE',objectId:ID});
    assert.deepEqual(prepareLegacyCardWrite({body:'hello',msg_type:'text'}),{body:'hello',contentRef:null});
  });
  it('an old unversioned send replays after stamping, while a changed source still conflicts', () => {
    const stored={id:'id',thread_id:'thread',sender_id:'viewer',created_at:'now',ciphertext:null,deleted_at:null,body,msg_type:'system',subtype:'discovery_card'};
    const sent={body:prepareLegacyCardWrite({body,msg_type:'system',subtype:'discovery_card'}).body,ciphertext:null,msgType:'system',subtype:'discovery_card',replyToId:null};
    assert.equal(sameSendPayload(stored,sent),true);
    assert.equal(sameSendPayload(stored,{...sent,body:sent.body!.replace(ID,'22222222-0000-4000-8000-000000000002')}),false);
  });
  it('old object rows remain readable; new references must agree with their body', () => {
    const object=buildPortavaObjectBody('PLACE',ID);
    assert.deepEqual(parsePortavaObjectRow({body:JSON.stringify(object)}),object);
    assert.deepEqual(parsePortavaObjectRow({body:object,content_ref:encodeObjectReference(object)}),object);
    for (const content_ref of [encodeObjectReference({objectType:'POST',objectId:ID}),'portava-object.v2:PLACE:'+ID,encodeObjectReference({objectType:'PLACE',objectId:'different'})]) assert.equal(parsePortavaObjectRow({body:object,content_ref}),null);
  });
  it('an explicit contradictory pointer is withheld even with schema negotiation off', async () => {
    const client=makeFakeClient({feature_flags:[]});
    const row={id:'message',msg_type:'portava_object',body:JSON.stringify(buildPortavaObjectBody('PLACE',ID,'private caption')),content_ref:encodeObjectReference({objectType:'POST',objectId:ID})};
    const [stored]=await negotiateStoredMessageRows(client,[row]);assert.equal(stored.msg_type,'text');assert.ok(!stored.body.includes('private caption'));
    const messages=[{id:row.id,body:row.body,msgType:row.msg_type}];await decoratePlatformReads(client,[row],messages,{});assert.equal(messages[0].msgType,'text');assert.ok(!messages[0].body.includes('private caption'));
  });
  it('mismatched and future legacy cards are withheld without querying any source', async () => {
    let reads=0;const client={from(){reads++;throw new Error('must not read');}} as any;
    const rows=[
      {id:'a',thread_id:'thread',msg_type:'system',subtype:'discovery_card',body,content_ref:encodeObjectReference({objectType:'POST',objectId:ID})},
      {id:'b',thread_id:'thread',msg_type:'system',subtype:'discovery_card',body:JSON.stringify({...JSON.parse(body),cardSchemaVersion:2})},
      {id:'d',thread_id:'thread',msg_type:'highlight_reply',subtype:ID,body:JSON.stringify({cardSchemaVersion:2,caption:'future secret'})},
      {id:'c',thread_id:'thread',msg_type:'text',subtype:null,body:JSON.stringify({type:'meetup_card',meetupId:ID,cardSchemaVersion:2,title:'future secret'})}
    ];
    const result=await applySharedCardTruth(client,'viewer',rows);
    assert.equal(reads,0);for(const truth of result.truth.values())assert.equal(truth.state,'withheld');
    assert.equal(result.truth.size,4);assert.ok(!JSON.stringify(result.rows).includes('future secret'));assert.ok(!JSON.stringify(result.rows).includes('old snapshot'));
  });
});
describe('bounded canonical query coalescing',()=>{
  function fixture(mode:string='ok'){
    let reads=0;const rows=[{id:'a',moderation_status:'visible'},{id:'b',moderation_status:'withheld'}];
    const client={from(){let ids:string[]=[];const q={select(){return q;},in(_c:string,v:string[]){ids=v;return q;},limit(){return q;},then(resolve:any){reads++;const hits=rows.filter(r=>ids.includes(r.id));return Promise.resolve({data:mode==='duplicate'?[hits[0],hits[0]]:hits,error:mode==='error'?new Error('unreadable'):null,count:mode==='truncated'?3:hits.length}).then(resolve);}};return q;}};
    return {client:coalescingClient(client),reads:()=>reads,rows};
  }
  const read=(client:any,id:string)=>client.from('places').select('id, moderation_status',{count:'exact'}).in('id',[id]).limit(2);
  it('batches concurrent checks and rechecks later requests after moderation changes',async()=>{
    const f=fixture();const [a,b]=await Promise.all([read(f.client,'a'),read(f.client,'b')]);assert.equal(f.reads(),1);assert.equal(a.count,1);assert.deepEqual(b.data,[{id:'b',moderation_status:'withheld'}]);
    f.rows[0].moderation_status='withheld';assert.equal((await read(f.client,'a')).data[0].moderation_status,'withheld');assert.equal(f.reads(),2);
  });
  for(const mode of ['truncated','duplicate','error'])it(`refuses every caller on ${mode} batch`,async()=>{
    const f=fixture(mode);const result=await Promise.all([read(f.client,'a'),read(f.client,'b')]);for(const r of result){assert.ok(r.error);assert.equal(r.data,null);}
  });
});
