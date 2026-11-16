/** Postcard source withdrawal and the real canonical writer on independent sessions of one fixture. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client, type QueryResult } from 'pg';
import { openPressedLayoverDb } from './pressedLayoverDb.js';
import { makeBridge, lit } from './postgrestSqlBridge.js';
import { recordMediaAssetDetailed, type RecordAssetInput } from '../../lib/mediaAssets.js';
import { _markPostgrestBackedForTest } from '../../lib/supabase.js';

function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }
const last = (result: QueryResult | QueryResult[]) => Array.isArray(result) ? result[result.length - 1]! : result;

describe('postcard canonical source lifecycle', { skip: process.env.LOCAL_DB_URL ? false : 'independent sessions require LOCAL_DB_URL' }, () => {
  let db: Awaited<ReturnType<typeof openPressedLayoverDb>>, owner: string;
  const sessions: Client[] = [];
  before(async () => {
    db = await openPressedLayoverDb(); owner = (await db.seedUser('postcard-canonical')).id;
    await db.setFlag('media_canonical_enabled', true);
    await db.setFlag('media_canonical_schema_fallback_enabled', false);
  });
  after(async () => { await Promise.all(sessions.map(client => client.end())); await db?.close(); });
  async function source(shared = false, upperCasePost = false) {
    const post = randomUUID(), media = randomUUID();
    const path = shared ? `${owner}/composer-shared-${media}.jpg` : `${owner}/${upperCasePost ? post.toUpperCase() : post}/${media}.jpg`;
    await db.exec(`INSERT INTO public.posts(id,author_id,content,visibility,status,post_status,postcard_draft_state,postcard_requested_visibility)
      VALUES('${post}','${owner}','synthetic postcard','private','active','draft','draft','public');
      INSERT INTO public.post_media(id,post_id,user_id,storage_bucket,storage_path,media_type,mime_type,processing_status)
      VALUES('${media}','${post}','${owner}','post-media','${path}','image','image/jpeg','ready')`);
    const input: RecordAssetInput = {ownerUserId:owner,storageBucket:'post-media',storagePath:path,publicUrl:`post-media/${path}`,mediaType:'image',mimeType:'image/jpeg',sizeBytes:100,width:64,height:48,sourceType:'user',capturedAt:'2026-03-04T03:06:07.000Z',preserveExisting:true};
    return {post,media,path,input};
  }
  type Source = Awaited<ReturnType<typeof source>>;
  async function connect() {
    const client = new Client({connectionString:db.databaseUrl!}); await client.connect(); sessions.push(client);
    await client.query("SET statement_timeout='10s'");
    const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    return {client,pid};
  }
  async function writer(afterInsert?: () => Promise<void>) {
    const {client,pid} = await connect();
    const bridge = makeBridge({
      query: async sql => (await client.query(sql)).rows,
      request: async (statements,role,claims) => {
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL ROLE ${role}; SELECT set_config('request.jwt.claims',${lit(JSON.stringify(claims))},true),set_config('request.jwt.claim.role',${lit(role)},true)`);
          let result: QueryResult | undefined;
          for (const statement of statements) result = last(await client.query(statement));
          if (statements.some(sql => /INSERT INTO.*media_assets/i.test(sql))) await afterInsert?.();
          await client.query('COMMIT');
          const value = result?.rows[0] ? Object.values(result.rows[0])[0] : null;
          return typeof value === 'string' ? value : JSON.stringify(value ?? null);
        } catch (error) { await client.query('ROLLBACK'); throw error; }
      },
    }, {url:`http://postcard-lifecycle-${pid}.invalid`,tokens:()=>({})});
    _markPostgrestBackedForTest(bridge.client);
    return {client:bridge.client,pid};
  }
  async function blocked(blocker: number, waiter: number) {
    for (let n=0;n<100;n++) {
      if ((await db.query<{blocked:boolean}>(`SELECT ${blocker}=ANY(pg_blocking_pids(${waiter})) AS blocked`))[0].blocked) return;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.fail('independent backend must actually wait on the conflicting source transaction');
  }
  const assets = (s: Source) => db.query(`SELECT * FROM media_assets WHERE storage_path=${lit(s.path)}`);
  const audit = (s: Source) => db.query(`SELECT e.* FROM media_asset_lifecycle_events e JOIN media_assets a ON a.id=e.media_asset_id WHERE a.storage_path=${lit(s.path)}`);
  function withdraw(client: Client, s: Source, mode: 'cancel'|'delete') {
    return mode === 'cancel' ? client.query('SELECT public.cancel_postcard_draft($1,$2)',[owner,s.post]) : client.query('DELETE FROM public.post_media WHERE id=$1',[s.media]);
  }
  async function assertRetired(s: Source) {
    const rows=await assets(s);assert.equal(rows.length,1);assert.equal(rows[0].moderation_status,'owner_deleted');assert.equal(rows[0].processing_status,'removed');assert.equal(rows[0].purge_status,'pending');assert.ok(rows[0].deleted_at);
    const events=await audit(s);assert.equal(events.length,1);assert.equal(events[0].event_type,'soft_deleted');
    const retry=await recordMediaAssetDetailed(db.client,s.input);assert.equal(retry.outcome,'failed');assert.equal(retry.assetId,null);
    assert.deepEqual(await assets(s),rows);assert.deepEqual(await audit(s),events);
    await assert.rejects(db.exec(`UPDATE media_assets SET moderation_status='active',processing_status='ready' WHERE id='${rows[0].id}'`),/postcard_asset_retired/);
    await assert.rejects(db.exec(`UPDATE media_assets SET deleted_at=NULL,moderation_status='active',processing_status='ready',purge_status='not_requested' WHERE id='${rows[0].id}'`),/postcard_asset_retired/);
  }
  for (const mode of ['cancel','delete'] as const) {
    it(`${mode} waits for a canonical insert, then retires exactly that committed asset`, {timeout:25_000}, async () => {
      const s=await source(),inserted=gate(),release=gate();
      const a=await writer(async()=>{inserted.open();await release.promise;}),b=await connect();
      const pending=recordMediaAssetDetailed(a.client,s.input);let withdrawal: Promise<unknown>|undefined;
      try {
        await Promise.race([inserted.promise,pending.then(r=>{throw new Error(`insert barrier missed: ${JSON.stringify(r)}`);})]);
        await b.client.query('BEGIN; SET LOCAL ROLE service_role');
        withdrawal=withdraw(b.client,s,mode);void withdrawal.catch(()=>{});
        await blocked(a.pid,b.pid);release.open();
        assert.ok((await pending).assetId);await withdrawal;await b.client.query('COMMIT');
      } finally {release.open();await pending;await b.client.query('ROLLBACK');await withdrawal?.catch(()=>{});}
      await assertRetired(s);
    });
    it(`canonical insert waits for ${mode} and refuses the withdrawn source`, {timeout:25_000}, async () => {
      const s=await source(),a=await connect(),b=await writer();let pending: ReturnType<typeof recordMediaAssetDetailed>|undefined;
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');await withdraw(a.client,s,mode);
        pending=recordMediaAssetDetailed(b.client,s.input);await blocked(a.pid,b.pid);
        await a.client.query('COMMIT');assert.equal((await pending).outcome,'failed');
      } finally {await a.client.query('ROLLBACK');await pending;}
      assert.deepEqual(await assets(s),[]);assert.deepEqual(await audit(s),[]);
    });
  }
  it('live postcard retries preserve ID/version/capture; pending, missing and foreign sources refuse canonical creation', async () => {
    const s=await source(),first=await recordMediaAssetDetailed(db.client,s.input);assert.ok(first.assetId);
    const initial=await assets(s),repeat=await recordMediaAssetDetailed(db.client,{...s.input,capturedAt:null});
    assert.equal(repeat.assetId,first.assetId);assert.equal(repeat.assetVersion,first.assetVersion);assert.equal(repeat.reused,true);assert.deepEqual(await assets(s),initial);
    const pending=await source();await db.exec(`UPDATE post_media SET processing_status='pending' WHERE id='${pending.media}'`);
    assert.equal((await recordMediaAssetDetailed(db.client,pending.input)).outcome,'failed');
    const missing={...s.input,storagePath:`${owner}/${randomUUID()}/${randomUUID()}.jpg`};assert.equal((await recordMediaAssetDetailed(db.client,missing)).outcome,'failed');
    const stranger=(await db.seedUser('postcard-foreign')).id;
    assert.equal((await recordMediaAssetDetailed(db.client,{...s.input,ownerUserId:stranger})).outcome,'failed');
  });
  it('parent soft deletion, cascading hard deletion and source path replacement retire owned postcard assets', async () => {
    for (const mode of ['soft','cascade','replace']) {
      const s=await source();assert.ok((await recordMediaAssetDetailed(db.client,s.input)).assetId);
      if(mode==='soft') await db.exec(`UPDATE posts SET status='deleted',deleted_at=now() WHERE id='${s.post}'`);
      else if(mode==='cascade') await db.exec(`DELETE FROM posts WHERE id='${s.post}'`);
      else await db.exec(`UPDATE post_media SET storage_path='${owner}/replacement-${randomUUID()}.jpg' WHERE id='${s.media}'`);
      await assertRetired(s);
    }
  });
  it('uppercase UUIDs in a valid route path cannot bypass source retirement or the late-write guard', async () => {
    const s=await source(false,true);assert.ok((await recordMediaAssetDetailed(db.client,s.input)).assetId);
    await db.exec(`SELECT public.cancel_postcard_draft('${owner}','${s.post}')`);await assertRetired(s);
    const missing=await source(false,true);await db.exec(`DELETE FROM post_media WHERE id='${missing.media}'`);
    assert.equal((await recordMediaAssetDetailed(db.client,missing.input)).outcome,'failed');assert.deepEqual(await assets(missing),[]);
    const acl=await db.query<{allowed:boolean}>(`SELECT has_function_privilege(role,fn,'EXECUTE') AS allowed FROM
      (VALUES('anon'),('authenticated')) roles(role) CROSS JOIN
      (VALUES('public.guard_postcard_canonical_asset()'),('public.retire_postcard_media_source()'),('public.retire_withdrawn_postcard_assets()')) functions(fn)`);
    assert.equal(acl.length,6);assert.ok(acl.every(r=>!r.allowed));
  });
  it('a repeated cancellation returns its durable receipt without rewriting cleanup or reviving the retired asset', async () => {
    const s=await source();assert.ok((await recordMediaAssetDetailed(db.client,s.input)).assetId);
    await db.exec(`SELECT public.cancel_postcard_draft('${owner}','${s.post}')`);await assertRetired(s);
    const postBefore=await db.query(`SELECT * FROM posts WHERE id='${s.post}'`),slotBefore=await db.query(`SELECT * FROM post_media WHERE id='${s.media}'`),assetBefore=await assets(s);
    for(let n=0;n<2;n++) {
      const result=await db.client.rpc('cancel_postcard_draft',{p_actor:owner,p_post:s.post});
      assert.equal(result.error,null);assert.deepEqual(result.data,{ok:true,absent:false});
    }
    assert.deepEqual(await db.query(`SELECT * FROM posts WHERE id='${s.post}'`),postBefore);
    assert.deepEqual(await db.query(`SELECT * FROM post_media WHERE id='${s.media}'`),slotBefore);
    assert.deepEqual(await assets(s),assetBefore);assert.equal((await audit(s)).length,1);
    await assert.rejects(db.exec(`UPDATE post_media SET processing_status='ready' WHERE id='${s.media}'`),/draft_cancelled|canonical_media_removal_is_terminal/);
  });
  it('audit failure rolls cancellation and hard deletion back along with the asset', async () => {
    const s=await source();assert.ok((await recordMediaAssetDetailed(db.client,s.input)).assetId);
    const initial=await assets(s);
    await db.exec(`CREATE FUNCTION public.test_postcard_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic postcard audit failure'; END $$;
      CREATE TRIGGER test_postcard_audit_failure BEFORE INSERT ON public.media_asset_lifecycle_events FOR EACH ROW EXECUTE FUNCTION public.test_postcard_audit_failure()`);
    try {
      await assert.rejects(db.exec(`SELECT public.cancel_postcard_draft('${owner}','${s.post}')`),/synthetic postcard audit failure/);
      await assert.rejects(db.exec(`DELETE FROM post_media WHERE id='${s.media}'`),/synthetic postcard audit failure/);
      assert.equal((await db.query(`SELECT postcard_draft_state FROM posts WHERE id='${s.post}'`))[0].postcard_draft_state,'draft');
      assert.equal((await db.query(`SELECT processing_status FROM post_media WHERE id='${s.media}'`))[0].processing_status,'ready');
      assert.deepEqual(await assets(s),initial);assert.deepEqual(await audit(s),[]);
    } finally {await db.exec('DROP TRIGGER test_postcard_audit_failure ON public.media_asset_lifecycle_events; DROP FUNCTION public.test_postcard_audit_failure()');}
  });
  it('withdrawing a post does not retire shared composer or official assets', async () => {
    const s=await source(true);assert.ok((await recordMediaAssetDetailed(db.client,s.input)).assetId);const initial=await assets(s);
    await db.exec(`SELECT public.cancel_postcard_draft('${owner}','${s.post}'); DELETE FROM post_media WHERE id='${s.media}'`);
    assert.deepEqual(await assets(s),initial);assert.deepEqual(await audit(s),[]);
  });
  it('the migration reconciliation retires old cancelled and missing sources once while keeping live and shared receipts', async () => {
    const withdrawn=await source(),missing=await source(),live=await source(),shared=await source(true);
    for(const s of [withdrawn,missing,live,shared]) assert.ok((await recordMediaAssetDetailed(db.client,s.input)).assetId);
    const liveBefore=await assets(live),sharedBefore=await assets(shared);
    // Recreate only the pre-4038 missing-retirement behavior in the leased
    // fixture, then restore both triggers before running the migration block.
    await db.exec(`ALTER TABLE posts DISABLE TRIGGER postcard_assets_withdrawn;
      ALTER TABLE post_media DISABLE TRIGGER postcard_media_source_retired;
      SELECT public.cancel_postcard_draft('${owner}','${withdrawn.post}');
      DELETE FROM post_media WHERE id='${missing.media}';
      ALTER TABLE post_media ENABLE TRIGGER postcard_media_source_retired;
      ALTER TABLE posts ENABLE TRIGGER postcard_assets_withdrawn`);
    assert.equal((await assets(withdrawn))[0].deleted_at,null);assert.equal((await assets(missing))[0].deleted_at,null);
    const migration=readFileSync(new URL('../../migrations/4038_postcard_canonical_lifecycle.sql',import.meta.url),'utf8');
    const start=migration.indexOf('DO $reconcile_postcard_assets$'),end=migration.indexOf('END;$reconcile_postcard_assets$;',start);
    assert.ok(start>=0 && end>start);const repair=migration.slice(start,end+'END;$reconcile_postcard_assets$;'.length);
    await db.exec(repair);await assertRetired(withdrawn);await assertRetired(missing);
    const retiredBefore=[await assets(withdrawn),await assets(missing)];await db.exec(repair);
    assert.deepEqual([await assets(withdrawn),await assets(missing)],retiredBefore);assert.equal((await audit(withdrawn)).length,1);assert.equal((await audit(missing)).length,1);
    assert.deepEqual(await assets(live),liveBefore);assert.deepEqual(await assets(shared),sharedBefore);
  });
  it('older-snapshot isolation refuses withdrawal instead of missing a concurrently committed asset', async () => {
    const s=await source(),a=await connect();
    try {await a.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await assert.rejects(async()=>{await withdraw(a.client,s,'cancel');await a.client.query('COMMIT');},/postcard_lifecycle_requires_read_committed/);}
    finally {await a.client.query('ROLLBACK');}
    assert.equal((await db.query(`SELECT postcard_draft_state FROM posts WHERE id='${s.post}'`))[0].postcard_draft_state,'draft');
  });
});
