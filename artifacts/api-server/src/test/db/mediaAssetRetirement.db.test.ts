/** Canonical retirement + audit is atomic on the single designated PostgreSQL fixture. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { openPressedLayoverDb } from './pressedLayoverDb.js';
import { recordMediaAssetDetailed } from '../../lib/mediaAssets.js';
import { softDeleteMediaAsset } from '../../services/media/MediaLifecycleService.js';

describe('atomic canonical asset retirement', {skip: process.env.LOCAL_DB_URL ? false : 'independent sessions require LOCAL_DB_URL'}, () => {
  let db: Awaited<ReturnType<typeof openPressedLayoverDb>>, owner: string, stranger: string;
  const sessions: Client[] = [];
  before(async () => {
    db = await openPressedLayoverDb();
    owner = (await db.seedUser('retire-owner')).id; stranger = (await db.seedUser('retire-stranger')).id;
    await db.setFlag('media_canonical_enabled', true);
  });
  after(async () => { await Promise.all(sessions.map(client => client.end())); await db?.close(); });
  async function asset() {
    const path = `${owner}/${randomUUID()}.jpg`;
    const result = await recordMediaAssetDetailed(db.client, {ownerUserId:owner,storageBucket:'post-media',storagePath:path,publicUrl:`post-media/${path}`,mediaType:'image',mimeType:'image/jpeg',sizeBytes:100,width:64,height:48,sourceType:'user'});
    assert.ok(result.assetId, JSON.stringify(result)); return result.assetId;
  }
  const retire = (id: string, actor=owner) => db.client.rpc('retire_media_asset',{p_asset:id,p_actor:actor});
  const snapshot = (id: string) => db.query(`SELECT * FROM media_assets WHERE id='${id}'`);
  const events = (id: string) => db.query(`SELECT * FROM media_asset_lifecycle_events WHERE media_asset_id='${id}'`);
  it('refuses absent/foreign assets and browser roles without a retirement or audit', async () => {
    const id=await asset(), before=await snapshot(id);
    for (const [target, actor] of [[id,stranger],[randomUUID(),owner]]) {
      const result=await retire(target,actor); assert.equal(result.error,null);
      assert.deepEqual(result.data,{ok:false,alreadyDeleted:false,purgeScheduled:false});
    }
    assert.deepEqual(await snapshot(id),before);assert.deepEqual(await events(id),[]);
    const acl=await db.query<{role:string;allowed:boolean}>("SELECT role,has_function_privilege(role,'public.retire_media_asset(uuid,uuid)','EXECUTE') AS allowed FROM (VALUES('anon'),('authenticated'),('service_role')) r(role) ORDER BY role");
    assert.deepEqual(acl,[{role:'anon',allowed:false},{role:'authenticated',allowed:false},{role:'service_role',allowed:true}]);
    await assert.rejects(db.asUser(owner,`SELECT public.retire_media_asset('${id}','${owner}')`),/permission denied/);
  });
  it('an audit failure rolls the whole retirement back, including its exact previous processing state and version', async () => {
    const id=await asset(); await db.exec(`UPDATE media_assets SET processing_status='failed',processing_error='synthetic previous failure' WHERE id='${id}'`);
    const before=await snapshot(id);
    await db.exec(`CREATE FUNCTION public.test_refuse_retirement_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
      CREATE TRIGGER test_refuse_retirement_audit BEFORE INSERT ON public.media_asset_lifecycle_events FOR EACH ROW EXECUTE FUNCTION public.test_refuse_retirement_audit()`);
    try {
      const result=await softDeleteMediaAsset(db.client,id,owner);assert.deepEqual(result,{ok:false,alreadyDeleted:false,purgeScheduled:false});
      assert.deepEqual(await snapshot(id),before);assert.deepEqual(await events(id),[]);
    } finally { await db.exec('DROP TRIGGER test_refuse_retirement_audit ON public.media_asset_lifecycle_events; DROP FUNCTION public.test_refuse_retirement_audit()'); }
  });
  it('independent competing retirements commit one tombstone, one audit and one purge request', async () => {
    const id=await asset();assert.ok(db.databaseUrl);
    const a=new Client({connectionString:db.databaseUrl}),b=new Client({connectionString:db.databaseUrl});
    await a.connect();sessions.push(a);await b.connect();sessions.push(b);
    const firstPid=Number((await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid),secondPid=Number((await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    await a.query('BEGIN; SET LOCAL ROLE service_role');
    const first=(await a.query('SELECT public.retire_media_asset($1,$2) AS result',[id,owner])).rows[0].result;
    assert.deepEqual(first,{ok:true,alreadyDeleted:false,purgeScheduled:true});
    await b.query('SET ROLE service_role');
    const competing=b.query('SELECT public.retire_media_asset($1,$2) AS result',[id,owner]);
    try {
      let blocked=false;
      for(let n=0;n<100;n++) { if((await db.query<{blocked:boolean}>(`SELECT ${firstPid}=ANY(pg_blocking_pids(${secondPid})) AS blocked`))[0].blocked){blocked=true;break;} await new Promise(resolve=>setTimeout(resolve,20)); }
      assert.equal(blocked,true,'second backend must actually wait on the first retirement');
      await a.query('COMMIT');
      assert.deepEqual((await competing).rows[0].result,{ok:true,alreadyDeleted:true,purgeScheduled:false});
    } finally { await a.query('ROLLBACK'); await competing.catch(()=>{}); }
    const rows=await snapshot(id),audit=await events(id);
    assert.equal(rows[0].processing_status,'removed');assert.equal(rows[0].moderation_status,'owner_deleted');assert.equal(rows[0].purge_status,'pending');assert.ok(rows[0].deleted_at);assert.ok(rows[0].purge_requested_at);
    assert.equal(audit.length,1);assert.equal(audit[0].event_type,'soft_deleted');assert.equal(audit[0].actor_user_id,owner);
    const repeated=await softDeleteMediaAsset(db.client,id,owner);assert.deepEqual(repeated,{ok:true,alreadyDeleted:true,purgeScheduled:false});
    assert.deepEqual(await snapshot(id),rows);assert.deepEqual(await events(id),audit);
  });
});
