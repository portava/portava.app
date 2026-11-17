import { dispatchMemoryCommand } from "../../services/memory/MemoryDomainService.js";
import { prepareMemoryItemWrite } from "../../services/memory/memoryMediaBinding.js";
import { requireDerivativeErasure } from '../../lib/media/derivativeErasure.js';
import { reconcileMemoryMediaBinding, reviewUnboundMemoryReferences } from '../../services/memory/memoryMediaBinding.js';
/** Postcard source withdrawal and the real canonical writer on independent sessions of one fixture. */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client, type QueryResult } from 'pg';
import { openPressedLayoverDb } from './pressedLayoverDb.js';
import { cleanupSyntheticMedia, seedUser as seedLocalFixtureUser, deleteUser as deleteLocalFixtureUser } from './localDb.js';
import { makeBridge, lit } from './postgrestSqlBridge.js';
import { recordMediaAssetDetailed, type RecordAssetInput } from '../../lib/mediaAssets.js';
import { _markPostgrestBackedForTest } from '../../lib/supabase.js';
import { activateMediaRestoration, stageMediaRestorationCaption, abortMediaRestoration, copyMediaRestorationDependency, verifyMediaRestorationDependencies, copyMediaRestorationOriginal, prepareRetainedMediaRestoration, removeCopiedMediaOriginal, copyRetainedMediaOriginal, prepareRetainedMediaOriginal, purgeWithdrawnAccountMedia } from '../../services/media/MediaLifecycleService.js';
import { eraseAccountMedia } from '../../services/accountDeletion/accountMediaDeletion.js';
import { createDubbingStore } from '../../lib/media/dubbing/store.js';
import { MAX_CAPTION_ARTIFACT_BYTES, purgeAuthoredCaptionTracks } from '../../services/media/AuthoredCaptionsService.js';

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
  afterEach(async () => { await Promise.all(sessions.splice(0).map(client => client.end())); });
  async function source(shared = false, upperCasePost = false, options: {pending?: boolean; owner?: string} = {}) {
    const sourceOwner = options.owner ?? owner;
    const post = randomUUID(), media = randomUUID();
    const path = shared ? `${sourceOwner}/composer-shared-${media}.jpg` : `${sourceOwner}/${upperCasePost ? post.toUpperCase() : post}/${media}.jpg`;
    await db.exec(`INSERT INTO public.posts(id,author_id,content,visibility,status,post_status,postcard_draft_state,postcard_requested_visibility)
      VALUES('${post}','${sourceOwner}','synthetic postcard','private','active','draft','draft','public');
      INSERT INTO public.post_media(id,post_id,user_id,storage_bucket,storage_path,media_type,mime_type,processing_status)
      VALUES('${media}','${post}','${sourceOwner}','post-media','${path}','image','image/jpeg','${options.pending ? 'pending' : 'ready'}')`);
    const input: RecordAssetInput = {ownerUserId:sourceOwner,storageBucket:'post-media',storagePath:path,publicUrl:`post-media/${path}`,mediaType:'image',mimeType:'image/jpeg',sizeBytes:100,width:64,height:48,sourceType:'user',capturedAt:'2026-03-04T03:06:07.000Z',preserveExisting:true};
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
  function withdraw(client: Client, s: Source, mode: 'cancel'|'withdraw') {
    if (mode === 'withdraw') return client.query('SELECT public.withdraw_postcard_media($1,$2,$3,$4)',[owner,s.post,s.media,'pending']);
    return client.query('SELECT public.cancel_postcard_draft($1,$2)',[owner,s.post]);
  }
  async function assertRetired(s: Source) {
    const rows=await assets(s);assert.equal(rows.length,1);assert.equal(rows[0].moderation_status,'owner_deleted');assert.equal(rows[0].processing_status,'removed');assert.equal(rows[0].purge_status,'retained');assert.ok(rows[0].deleted_at);
    const events=await audit(s);assert.equal(events.length,1);assert.equal(events[0].event_type,'soft_deleted');
    const retry=await recordMediaAssetDetailed(db.client,s.input);assert.equal(retry.outcome,'failed');assert.equal(retry.assetId,null);
    assert.deepEqual(await assets(s),rows);assert.deepEqual(await audit(s),events);
    await assert.rejects(db.exec(`UPDATE media_assets SET moderation_status='active',processing_status='ready' WHERE id='${rows[0].id}'`),/postcard_asset_retired|media_permanent_deletion_requires_admin/);
    await assert.rejects(db.exec(`UPDATE media_assets SET deleted_at=NULL,moderation_status='active',processing_status='ready',purge_status='not_requested' WHERE id='${rows[0].id}'`),/postcard_asset_retired|media_permanent_deletion_requires_admin/);
  }
  for (const mode of ['cancel','withdraw'] as const) {
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
  it('direct deletion waits for a canonical insert, then refuses erasure without losing the committed asset', {timeout:25_000}, async () => {
    const s=await source(),inserted=gate(),release=gate();
    const a=await writer(async()=>{inserted.open();await release.promise;}),b=await connect();
    const pending=recordMediaAssetDetailed(a.client,s.input);let deletion:Promise<unknown>|undefined;
    try {
      await Promise.race([inserted.promise,pending.then(r=>{throw new Error(`insert barrier missed: ${JSON.stringify(r)}`);})]);
      await b.client.query('BEGIN; SET LOCAL ROLE service_role');
      deletion=b.client.query('DELETE FROM post_media WHERE id=$1',[s.media]);void deletion.catch(()=>{});
      await blocked(a.pid,b.pid);release.open();assert.ok((await pending).assetId);
      await assert.rejects(deletion,/postcard_permanent_deletion_requires_admin/);
    } finally {release.open();await pending;await b.client.query('ROLLBACK');await deletion?.catch(()=>{});}
    assert.equal((await assets(s))[0].deleted_at,null);assert.deepEqual(await audit(s),[]);
    assert.equal((await db.query(`SELECT id FROM post_media WHERE id='${s.media}'`)).length,1);
  });
  it('canonical insertion survives a rejected direct deletion on an independently locked source', {timeout:25_000}, async () => {
    const s=await source(),a=await connect(),b=await writer();let pending:ReturnType<typeof recordMediaAssetDetailed>|undefined;
    try {
      await a.client.query('BEGIN; SET LOCAL ROLE service_role');
      await a.client.query('SELECT id FROM post_media WHERE id=$1 FOR UPDATE',[s.media]);
      await a.client.query('SAVEPOINT rejected_delete');
      await assert.rejects(a.client.query('DELETE FROM post_media WHERE id=$1',[s.media]),/postcard_permanent_deletion_requires_admin/);
      await a.client.query('ROLLBACK TO SAVEPOINT rejected_delete');
      pending=recordMediaAssetDetailed(b.client,s.input);await blocked(a.pid,b.pid);
      await a.client.query('COMMIT');assert.ok((await pending).assetId);
    } finally {await a.client.query('ROLLBACK');await pending;}
    assert.equal((await assets(s))[0].deleted_at,null);assert.deepEqual(await audit(s),[]);
  });
  it('parent soft deletion retains assets; direct cascades and locator replacement preserve the complete source', async () => {
    const s=await source();assert.ok((await recordMediaAssetDetailed(db.client,s.input)).assetId);
    const before=await db.query(`SELECT * FROM post_media WHERE id='${s.media}'`);
    await assert.rejects(db.exec(`DELETE FROM posts WHERE id='${s.post}'`),/postcard_permanent_deletion_requires_admin/);
    for(const assignment of [`storage_path='${owner}/replacement.jpg'`,"storage_bucket='other'",`id='${randomUUID()}'`]) {
      await assert.rejects(db.exec(`UPDATE post_media SET ${assignment} WHERE id='${s.media}'`),/postcard_retention_identity_immutable/);
    }
    assert.deepEqual(await db.query(`SELECT * FROM post_media WHERE id='${s.media}'`),before);
    assert.equal((await assets(s))[0].deleted_at,null);
    await db.exec(`UPDATE posts SET status='deleted',deleted_at=now() WHERE id='${s.post}'`);await assertRetired(s);
    await assert.rejects(db.exec(`DELETE FROM posts WHERE id='${s.post}'`),/postcard_permanent_deletion_requires_admin/);
  });
  it('retained sources cannot be erased, while only service cleanup can remove uncompleted unregistered slots', async () => {
    const s=await source();await db.exec(`SELECT public.cancel_postcard_draft('${owner}','${s.post}')`);
    assert.ok((await db.query(`SELECT recovery_snapshot FROM post_media WHERE id='${s.media}'`))[0].recovery_snapshot);
    await assert.rejects(db.exec(`DELETE FROM post_media WHERE id='${s.media}'`),/postcard_permanent_deletion_requires_admin/);
    const raw=await source(false,false,{pending:true});
    // The current Data API grants already refuse client deletion. The service
    // path above separately proves the guard even when DELETE is granted.
    await assert.rejects(db.asUser(owner,`DELETE FROM post_media WHERE id='${raw.media}' RETURNING id`),/permission denied for table post_media/);
    await db.exec(`SET ROLE service_role; DELETE FROM post_media WHERE id='${raw.media}'; RESET ROLE`);
    assert.deepEqual(await db.query(`SELECT id FROM post_media WHERE id='${raw.media}'`),[]);
  });
  it('uppercase UUIDs in a valid route path cannot bypass source retirement or the late-write guard', async () => {
    const s=await source(false,true);assert.ok((await recordMediaAssetDetailed(db.client,s.input)).assetId);
    await db.exec(`SELECT public.cancel_postcard_draft('${owner}','${s.post}')`);await assertRetired(s);
    const missing=await source(false,true);assert.equal((await db.query(`SELECT public.withdraw_postcard_media('${owner}','${missing.post}','${missing.media}','pending') AS withdrawn`))[0].withdrawn,true);
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
  it('audit failure rolls cancellation and withdrawal back along with the asset', async () => {
    const s=await source();assert.ok((await recordMediaAssetDetailed(db.client,s.input)).assetId);
    const initial=await assets(s);
    await db.exec(`CREATE FUNCTION public.test_postcard_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic postcard audit failure'; END $$;
      CREATE TRIGGER test_postcard_audit_failure BEFORE INSERT ON public.media_asset_lifecycle_events FOR EACH ROW EXECUTE FUNCTION public.test_postcard_audit_failure()`);
    try {
      await assert.rejects(db.exec(`SELECT public.cancel_postcard_draft('${owner}','${s.post}')`),/synthetic postcard audit failure/);
      await assert.rejects(db.exec(`SELECT public.withdraw_postcard_media('${owner}','${s.post}','${s.media}','pending')`),/synthetic postcard audit failure/);
      assert.equal((await db.query(`SELECT postcard_draft_state FROM posts WHERE id='${s.post}'`))[0].postcard_draft_state,'draft');
      assert.equal((await db.query(`SELECT processing_status FROM post_media WHERE id='${s.media}'`))[0].processing_status,'ready');
      assert.deepEqual(await assets(s),initial);assert.deepEqual(await audit(s),[]);
    } finally {await db.exec('DROP TRIGGER test_postcard_audit_failure ON public.media_asset_lifecycle_events; DROP FUNCTION public.test_postcard_audit_failure()');}
  });
  it('withdrawing a post does not retire shared composer or official assets', async () => {
    const s=await source(true);assert.ok((await recordMediaAssetDetailed(db.client,s.input)).assetId);const initial=await assets(s);
    await db.exec(`SELECT public.cancel_postcard_draft('${owner}','${s.post}')`);
    await assert.rejects(db.exec(`DELETE FROM post_media WHERE id='${s.media}'`),/postcard_permanent_deletion_requires_admin/);
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
      ALTER TABLE post_media DISABLE TRIGGER postcard_retention_source_guard;
      SELECT public.cancel_postcard_draft('${owner}','${withdrawn.post}');
      DELETE FROM post_media WHERE id='${missing.media}';
      ALTER TABLE post_media ENABLE TRIGGER postcard_media_source_retired;
      ALTER TABLE post_media ENABLE TRIGGER postcard_retention_source_guard;
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
  it('retention requires explicit active admin authority, a matching generation and an atomic audit before purge', async () => {
    const s=await source();const first=await recordMediaAssetDetailed(db.client,s.input);assert.ok(first.assetId);
    const result=await db.client.rpc('retire_media_asset',{p_asset:first.assetId,p_actor:owner});
    assert.equal(result.error,null);assert.deepEqual(result.data,{ok:true,alreadyDeleted:false,purgeScheduled:false});
    const retained=(await assets(s))[0];assert.equal(retained.purge_status,'retained');assert.ok(retained.recovery_generation);assert.ok(retained.recovery_snapshot);
    assert.equal(retained.purge_requested_at,null);
    await assert.rejects(db.exec(`UPDATE media_assets SET purge_status='pending' WHERE id='${retained.id}'`),/media_permanent_deletion_requires_admin/);
    await assert.rejects(db.exec(`DELETE FROM media_assets WHERE id='${retained.id}'`),/media_permanent_deletion_requires_admin/);
    const admin=(await db.seedUser('media-retention-admin')).id;await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'`);
    const authorize=async(actor=admin,generation=String(retained.recovery_generation),reason='Reviewed permanent deletion')=>{
      const r=await db.client.rpc('authorize_media_permanent_deletion',{p_actor:actor,p_asset:retained.id,p_generation:generation,p_reason:reason});
      assert.equal(r.error,null,JSON.stringify(r));return r.data as any;
    };
    assert.equal((await authorize(owner)).error,'admin_required');assert.equal((await authorize(admin,randomUUID())).error,'retention_changed');
    assert.equal((await authorize(admin,String(retained.recovery_generation),' ')).error,'admin_required');
    await db.exec(`INSERT INTO user_account_states(user_id,state) VALUES('${admin}','suspended')`);
    assert.equal((await authorize()).error,'admin_required');
    await db.exec(`DELETE FROM user_account_states WHERE user_id='${admin}'`);
    await db.exec(`CREATE FUNCTION public.test_retention_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic retention audit failure'; END $$;
      CREATE TRIGGER test_retention_audit_failure BEFORE INSERT ON public.media_asset_lifecycle_events FOR EACH ROW EXECUTE FUNCTION public.test_retention_audit_failure()`);
    try {
      const rejected=await db.client.rpc('authorize_media_permanent_deletion',{p_actor:admin,p_asset:retained.id,p_generation:retained.recovery_generation,p_reason:'Review complete'});
      assert.ok(rejected.error);assert.deepEqual((await assets(s))[0],retained);
    } finally {await db.exec('DROP TRIGGER test_retention_audit_failure ON media_asset_lifecycle_events; DROP FUNCTION test_retention_audit_failure()');}
    assert.deepEqual(await authorize(),{ok:true,alreadyAuthorized:false});const claimed=(await assets(s))[0];assert.equal(claimed.purge_status,'pending');
    assert.deepEqual(await authorize(),{ok:true,alreadyAuthorized:true});assert.deepEqual((await assets(s))[0],claimed);
    const events=(await audit(s)).filter(e=>e.event_type==='permanent_deletion_authorized');assert.equal(events.length,1);assert.equal(events[0].actor_user_id,admin);
    const grants=await db.query<{allowed:boolean}>(`SELECT has_function_privilege(role,'public.authorize_media_permanent_deletion(uuid,uuid,uuid,text)','EXECUTE') AS allowed FROM (VALUES('anon'),('authenticated')) roles(role)`);
    assert.ok(grants.every(r=>!r.allowed));
  });

  it('active canonical assets cannot bypass retention through direct deletion or a fabricated purge state', async () => {
    const s=await source(true),first=await recordMediaAssetDetailed(db.client,s.input);assert.ok(first.assetId);
    const before=await assets(s);
    await assert.rejects(db.exec(`DELETE FROM media_assets WHERE id='${first.assetId}'`),/media_permanent_deletion_requires_admin/);
    for(const status of ['pending','failed','completed']) {
      await assert.rejects(db.exec(`UPDATE media_assets SET purge_status='${status}' WHERE id='${first.assetId}'`),/media_permanent_deletion_requires_admin/);
    }
    assert.deepEqual(await assets(s),before);assert.deepEqual(await audit(s),[]);
    await assert.rejects(db.asUser(owner,`DELETE FROM media_assets WHERE id='${first.assetId}' RETURNING id`),/permission denied for table media_assets/);
  });
  it('retained locator and generation protections survive authorization and the existing purge worker', async () => {
    const s=await source(true),first=await recordMediaAssetDetailed(db.client,s.input);assert.ok(first.assetId);
    await db.client.rpc('retire_media_asset',{p_asset:first.assetId,p_actor:owner});
    const retained=(await assets(s))[0];
    for(const assignment of [`storage_path='${owner}/replacement.jpg'`,"storage_bucket='other'",`thumbnail_path='${owner}/other-thumb.jpg'`,`uploader_user_id='${randomUUID()}'`]) {
      await assert.rejects(db.exec(`UPDATE media_assets SET ${assignment} WHERE id='${first.assetId}'`),/media_retention_identity_immutable/);
    }
    for(const assignment of ['recovery_generation=NULL',"recovery_snapshot='{}'::jsonb",'deleted_at=NULL']) {
      await assert.rejects(db.exec(`UPDATE media_assets SET ${assignment} WHERE id='${first.assetId}'`),/media_retention_generation_immutable/);
    }
    for(const assignment of ["mime_type='image/png'",'width=999',"public_url='https://example.invalid/replacement'"]) {
      await assert.rejects(db.exec(`UPDATE media_assets SET ${assignment} WHERE id='${first.assetId}'`),/media_retained_metadata_immutable/);
    }
    assert.deepEqual((await assets(s))[0],retained);
    const admin=(await db.seedUser('canonical-purge-admin')).id;await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'`);
    const authorized=await db.client.rpc('authorize_media_permanent_deletion',{p_actor:admin,p_asset:first.assetId,p_generation:retained.recovery_generation,p_reason:'Reviewed permanent media erasure'});
    assert.equal(authorized.error,null);assert.equal((authorized.data as any).ok,true);
    await assert.rejects(db.exec(`DELETE FROM media_assets WHERE id='${first.assetId}'`),/media_permanent_deletion_requires_admin/);
    await assert.rejects(db.exec(`UPDATE media_assets SET recovery_generation=NULL WHERE id='${first.assetId}'`),/media_retention_generation_immutable/);
    await assert.rejects(db.exec(`UPDATE media_assets SET purge_status='retained' WHERE id='${first.assetId}'`),/media_permanent_deletion_already_authorized/);
    const remove=db.client.storage.from,paths:string[]=[];
    const objects=new Set([s.path]);
    db.client.storage.from=(bucket:string)=>({
      info:async(path:string)=>objects.has(path)?{data:{id:randomUUID(),version:'original',bucketId:bucket,name:path,size:100},error:null}:{data:null,error:{status:404,statusCode:'NoSuchKey'}},
      remove:async(keys:string[])=>{paths.push(...keys);for(const path of keys)objects.delete(path);return {data:keys,error:null};},
    } as any);
    try {
      const pending=(await assets(s))[0];
      await purgeWithdrawnAccountMedia(db.client,first.assetId!,owner,{env:{},expectedVersion:Number(pending.version)});
    } finally {db.client.storage.from=remove;}
    const completed=(await assets(s))[0];assert.equal(completed.purge_status,'completed');assert.ok(paths.includes(s.path));
    assert.equal(completed.recovery_generation,retained.recovery_generation);
    assert.equal((await audit(s)).filter(e=>e.event_type==='permanent_deletion_authorized').length,1);
    assert.equal((await audit(s)).filter(e=>e.event_type==='purge_succeeded').length,1);
    await assert.rejects(db.exec(`DELETE FROM media_assets WHERE id='${first.assetId}'`),/media_permanent_deletion_requires_admin/);
    await assert.rejects(db.exec(`UPDATE media_assets SET purge_status='pending' WHERE id='${first.assetId}'`),/media_purge_completed/);
    assert.deepEqual((await assets(s))[0],completed);
  });

  it('legacy pending purges are held without fabricating retained source metadata, and cannot be requeued by an old writer', async () => {
    const s=await source();const first=await recordMediaAssetDetailed(db.client,s.input);assert.ok(first.assetId);
    await assert.rejects(db.exec(`UPDATE media_assets SET purge_status='pending' WHERE id='${first.assetId}'`),/media_permanent_deletion_requires_admin/);
    // Model a row left by the old deployment, restoring the guard before proof.
    await db.exec('ALTER TABLE media_assets DISABLE TRIGGER retained_media_purge_guard');
    try {await db.exec(`UPDATE media_assets SET deleted_at=now(),moderation_status='owner_deleted',processing_status='removed',purge_status='failed',purge_error='prior interrupted removal' WHERE id='${first.assetId}'`);}
    finally {await db.exec('ALTER TABLE media_assets ENABLE TRIGGER retained_media_purge_guard');}
    const migration=readFileSync(new URL('../../migrations/4041_media_recovery_retention.sql',import.meta.url),'utf8');
    const start=migration.indexOf('DO $hold_legacy_purges$'),end=migration.indexOf('END;$hold_legacy_purges$;',start);
    assert.ok(start>=0 && end>start);await db.exec(migration.slice(start,end+'END;$hold_legacy_purges$;'.length));
    const held=(await assets(s))[0];assert.equal(held.purge_status,'retained');assert.equal(held.recovery_snapshot,null);assert.ok(held.recovery_generation);assert.equal(held.purge_error,'prior interrupted removal');
    await db.exec(migration.slice(start,end+'END;$hold_legacy_purges$;'.length));assert.deepEqual((await assets(s))[0],held,'legacy hold is idempotent');
    const other=await source();const recorded=await recordMediaAssetDetailed(db.client,other.input);assert.ok(recorded.assetId);
    await db.client.rpc('retire_media_asset',{p_asset:recorded.assetId,p_actor:owner});
    const admin=(await db.seedUser('legacy-hold-admin')).id;await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'`);
    const generation=(await assets(other))[0].recovery_generation;
    const approval=await db.client.rpc('authorize_media_permanent_deletion',{p_actor:admin,p_asset:recorded.assetId,p_generation:generation,p_reason:'New explicit authorization'});assert.equal(approval.error,null);assert.equal((approval.data as any).ok,true);
    const approved=(await assets(other))[0];await db.exec(migration.slice(start,end+'END;$hold_legacy_purges$;'.length));
    assert.deepEqual((await assets(other))[0],approved,'legacy reconciliation must not revoke a new admin authorization');
    await assert.rejects(db.exec(`UPDATE media_assets SET purge_status='pending' WHERE id='${first.assetId}'`),/media_permanent_deletion_requires_admin/);
  });
  it('the existing admin-authorized account executor can erase retained media through its execution receipt', async () => {
    const user=(await db.seedUser('held-account-media')).id,admin=(await db.seedUser('held-account-admin')).id;
    await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'`);
    const accountSource=await source(false,false,{owner:user});
    await assert.rejects(db.exec(`DELETE FROM posts WHERE id='${accountSource.post}'`),/postcard_permanent_deletion_requires_admin/);
    const recorded=await recordMediaAssetDetailed(db.client,{ownerUserId:user,storageBucket:'post-media',storagePath:`${user}/retained-proof.jpg`,publicUrl:`post-media/${user}/retained-proof.jpg`,mediaType:'image',mimeType:'image/jpeg',sizeBytes:100,sourceType:'user'});
    assert.ok(recorded.assetId);
    assert.equal((await db.client.rpc('retire_media_asset',{p_asset:recorded.assetId,p_actor:user})).error,null);
    const remove=db.client.storage.from;const paths:string[]=[];
    const objects=new Set([`${user}/retained-proof.jpg`]);
    db.client.storage.from=(bucket:string)=>({
      info:async(path:string)=>objects.has(path)?{data:{id:randomUUID(),version:'original',bucketId:bucket,name:path,size:100},error:null}:{data:null,error:{status:404,statusCode:'NoSuchKey'}},
      remove:async(keys:string[])=>{paths.push(...keys);for(const path of keys)objects.delete(path);return {data:keys,error:null};},
    } as any);
    try {
      await assert.rejects(eraseAccountMedia(db.client,user,{env:{}}),/Account Media cleanup unconfirmed/);assert.equal(paths.length,0);
      const requested=await db.client.rpc('request_recoverable_account_deletion',{p_user:user});assert.equal(requested.error,null);
      const claimed=await db.client.rpc('claim_account_permanent_deletion',{p_protocol:1,p_actor:admin,p_user:user,p_generation:(requested.data as any).generation,p_token:randomUUID(),p_reason:'Explicit erasure proof'});
      assert.equal(claimed.error,null);assert.equal((claimed.data as any).ok,true);
      assert.equal(await eraseAccountMedia(db.client,user,{env:{}}),1);assert.ok(paths.includes(`${user}/retained-proof.jpg`));
      assert.deepEqual(await db.query(`SELECT id FROM media_assets WHERE id='${recorded.assetId}'`),[]);
      await db.exec(`DELETE FROM posts WHERE id='${accountSource.post}'`);
      assert.deepEqual(await db.query(`SELECT id FROM post_media WHERE id='${accountSource.media}'`),[]);
    } finally {db.client.storage.from=remove;}
  });

  it('synthetic teardown rejects foreign identities, rolls back failures, and restores both production guards', async () => {
    const user=seedLocalFixtureUser('retention-cleanup'),s=await source(false,false,{owner:user});
    const first=await recordMediaAssetDetailed(db.client,s.input);assert.ok(first.assetId);
    assert.equal((await db.query(`SELECT withdraw_postcard_media('${user}','${s.post}','${s.media}','pending') AS ok`))[0].ok,true);
    const guardState=()=>db.query(`SELECT tgname,tgenabled,pg_get_triggerdef(oid) AS definition,pg_get_functiondef(tgfoid) AS function
      FROM pg_trigger WHERE tgname IN ('postcard_retention_source_guard','retained_media_purge_guard') ORDER BY tgname`);
    const guards=await guardState(),assetBefore=await assets(s),sourceBefore=await db.query(`SELECT * FROM post_media WHERE id='${s.media}'`);
    assert.equal(guards.length,2);
    assert.throws(()=>cleanupSyntheticMedia([owner]),/seeded by this process/);
    await db.exec(`UPDATE auth.users SET email='unverified@example.invalid' WHERE id='${user}'`);
    assert.throws(()=>cleanupSyntheticMedia([user]),/requires existing synthetic identities/);
    await db.exec(`UPDATE auth.users SET email='retention-cleanup@local.test' WHERE id='${user}';
      CREATE FUNCTION test_fixture_cleanup_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic fixture cleanup failure'; END $$;
      CREATE TRIGGER test_fixture_cleanup_failure BEFORE DELETE ON post_media FOR EACH ROW EXECUTE FUNCTION test_fixture_cleanup_failure()`);
    try {assert.throws(()=>cleanupSyntheticMedia([user]),/synthetic fixture cleanup failure/);}
    finally {await db.exec('DROP TRIGGER test_fixture_cleanup_failure ON post_media; DROP FUNCTION test_fixture_cleanup_failure()');}
    assert.deepEqual(await guardState(),guards);assert.deepEqual(await assets(s),assetBefore);
    assert.deepEqual(await db.query(`SELECT * FROM post_media WHERE id='${s.media}'`),sourceBefore);
    cleanupSyntheticMedia([user]);
    assert.deepEqual(await assets(s),[]);assert.deepEqual(await db.query(`SELECT * FROM post_media WHERE id='${s.media}'`),[]);
    assert.deepEqual(await guardState(),guards);deleteLocalFixtureUser(user);
  });

  it('retained authored captions refuse the existing eraser until admin permanent authorization', async () => {
    const s=await source(true),first=await recordMediaAssetDetailed(db.client,{...s.input,mediaType:'video',mimeType:'video/mp4',durationMs:2000});assert.ok(first.assetId);
    const revision='a'.repeat(64),path=`manual-captions/${first.assetId}/v${first.assetVersion}-${revision}.json`;
    await db.exec(`INSERT INTO media_caption_manifests(asset_id,source_version,revision_key,object_path)
      VALUES('${first.assetId}',${first.assetVersion},'${revision}','${path}')`);
    const original=(await db.query(`SELECT * FROM media_caption_manifests WHERE asset_id='${first.assetId}'`))[0];
    const retired=await db.client.rpc('retire_media_asset',{p_asset:first.assetId,p_actor:owner});assert.equal(retired.error,null);
    const from=db.client.storage.from,bytes=new Set([path]),removed:string[]=[];
    db.client.storage.from=()=>({list:async()=>({data:[...bytes].map(key=>({name:key.split('/').at(-1)})),error:null}),
      remove:async(keys:string[])=>{keys.forEach(key=>bytes.delete(key));removed.push(...keys);return {data:keys,error:null};}} as any);
    try {
      await assert.rejects(purgeAuthoredCaptionTracks(db.client,first.assetId!),/Permanent derivative erasure authority unavailable/);
      assert.deepEqual(removed,[]);assert.ok(bytes.has(path));
      assert.deepEqual((await db.query(`SELECT * FROM media_caption_manifests WHERE asset_id='${first.assetId}'`))[0],original);
      const admin=(await db.seedUser('caption-retention-admin')).id;await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'`);
      const retained=(await assets(s))[0];
      const authorized=await db.client.rpc('authorize_media_permanent_deletion',{p_actor:admin,p_asset:first.assetId,p_generation:retained.recovery_generation,p_reason:'Explicit caption and source erasure'});
      assert.equal(authorized.error,null);assert.equal((authorized.data as {ok:boolean}).ok,true);
      await purgeAuthoredCaptionTracks(db.client,first.assetId!);
      assert.deepEqual(removed,[path]);assert.equal(bytes.size,0);
      assert.equal((await db.query(`SELECT object_path FROM media_caption_manifests WHERE asset_id='${first.assetId}'`))[0].object_path,null);
    } finally {db.client.storage.from=from;}
  });

  it('retained dubbing refuses owner and late-worker cleanup until admin permanent authorization', async () => {
    const s=await source(true),first=await recordMediaAssetDetailed(db.client,s.input);assert.ok(first.assetId);
    const id=randomUUID(),job=randomUUID(),token=randomUUID(),path=`synthetic-dubbing/${id}.wav`;
    await db.exec(`INSERT INTO media_dubbing_artifacts(id,asset_id,owner_user_id,job_id,lease_token,storage_bucket,storage_path,manifest,write_state,write_settled_at,cleanup_requested)
      VALUES('${id}','${first.assetId}','${owner}','${job}','${token}','synthetic-dubbing','${path}','{}','uploaded',now(),true)`);
    const original=(await db.query(`SELECT * FROM media_dubbing_artifacts WHERE id='${id}'`))[0];
    const retired=await db.client.rpc('retire_media_asset',{p_asset:first.assetId,p_actor:owner});assert.equal(retired.error,null);
    const from=db.client.storage.from,bytes=new Set([path]),removed:string[]=[];
    db.client.storage.from=()=>({remove:async(keys:string[])=>{keys.forEach(key=>bytes.delete(key));removed.push(...keys);return {data:keys,error:null};}} as any);
    try {
      const store=createDubbingStore(db.client,'synthetic-dubbing',{canRead:async()=>false,loadTranslatedSource:async()=>{throw new Error('Cleanup must not generate new audio');}});
      await store.eraseOwned(owner,first.assetId!);
      assert.deepEqual(removed,[]);assert.ok(bytes.has(path));
      const late=await db.client.rpc('media_dubbing_retire',{p_id:id,p_owner:null,p_job:job,p_token:token});assert.equal(late.error,null);assert.equal(late.data,null);
      const forget=await db.client.rpc('media_dubbing_forget',{p_id:id,p_owner:owner,p_job:null,p_token:null});assert.equal(forget.error,null);assert.equal(forget.data,false);
      assert.deepEqual((await db.query(`SELECT * FROM media_dubbing_artifacts WHERE id='${id}'`))[0],original);
      const admin=(await db.seedUser('dubbing-retention-admin')).id;await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'`);
      const retained=(await assets(s))[0];
      const authorized=await db.client.rpc('authorize_media_permanent_deletion',{p_actor:admin,p_asset:first.assetId,p_generation:retained.recovery_generation,p_reason:'Explicit dubbing and source erasure'});
      assert.equal(authorized.error,null);assert.equal((authorized.data as {ok:boolean}).ok,true);
      await store.eraseOwned(owner,first.assetId!);
      assert.deepEqual(removed,[path]);assert.equal(bytes.size,0);
      assert.deepEqual(await db.query(`SELECT * FROM media_dubbing_artifacts WHERE id='${id}'`),[]);
    } finally {db.client.storage.from=from;}
  });

  for (const operation of ['retire','forget'] as const) {
    it(`dubbing ${operation} waits for source withdrawal and then preserves its retained receipt`, {timeout:25_000}, async () => {
      const s=await source(true),first=await recordMediaAssetDetailed(db.client,s.input);assert.ok(first.assetId);
      const id=randomUUID(),job=randomUUID(),token=randomUUID();
      await db.exec(`INSERT INTO media_dubbing_artifacts(id,asset_id,owner_user_id,job_id,lease_token,storage_bucket,storage_path,manifest,write_state,write_settled_at,cleanup_requested)
        VALUES('${id}','${first.assetId}','${owner}','${job}','${token}','synthetic-dubbing','synthetic-dubbing/${id}.wav','{}','uploaded',now(),true)`);
      const original=(await db.query(`SELECT * FROM media_dubbing_artifacts WHERE id='${id}'`))[0];
      const a=await connect(),b=await connect();let cleanup:Promise<QueryResult>|undefined;
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');
        await a.client.query('SELECT public.retire_media_asset($1,$2)',[first.assetId,owner]);
        await b.client.query('SET ROLE service_role');
        cleanup=b.client.query(`SELECT public.media_dubbing_${operation}($1,$2,NULL,NULL) AS receipt`,[id,owner]);void cleanup.catch(()=>{});
        await blocked(a.pid,b.pid);
        await a.client.query('COMMIT');
        assert.equal((await cleanup).rows[0].receipt,operation==='retire' ? null : false);
      } finally {await a.client.query('ROLLBACK');await cleanup?.catch(()=>{});}
      assert.deepEqual((await db.query(`SELECT * FROM media_dubbing_artifacts WHERE id='${id}'`))[0],original);
      assert.equal((await assets(s))[0].purge_status,'retained');
    });
  }

  it('dubbing retirement preserves live-source consent cleanup and orphan cleanup without granting foreign authority', async () => {
    const s=await source(true),first=await recordMediaAssetDetailed(db.client,s.input);assert.ok(first.assetId);
    for (const assetId of [first.assetId!,randomUUID()]) {
      const id=randomUUID(),job=randomUUID(),token=randomUUID();
      await db.exec(`INSERT INTO media_dubbing_artifacts(id,asset_id,owner_user_id,job_id,lease_token,storage_bucket,storage_path,manifest,write_state,write_settled_at)
        VALUES('${id}','${assetId}','${owner}','${job}','${token}','synthetic-dubbing','synthetic-dubbing/${id}.wav','{}','uploaded',now())`);
      const denied=await db.client.rpc('media_dubbing_retire',{p_id:id,p_owner:randomUUID(),p_job:null,p_token:null});assert.equal(denied.error,null);assert.equal(denied.data,null);
      const stale=await db.client.rpc('media_dubbing_retire',{p_id:id,p_owner:null,p_job:job,p_token:randomUUID()});assert.equal(stale.error,null);assert.equal(stale.data,null);
      const allowed=await db.client.rpc('media_dubbing_retire',{p_id:id,p_owner:owner,p_job:null,p_token:null});assert.equal(allowed.error,null);assert.equal((allowed.data as {id:string}).id,id);
      const removed=await db.client.rpc('media_dubbing_forget',{p_id:id,p_owner:owner,p_job:null,p_token:null});assert.equal(removed.error,null);assert.equal(removed.data,true);
      const retry=await db.client.rpc('media_dubbing_forget',{p_id:id,p_owner:owner,p_job:null,p_token:null});assert.equal(retry.error,null);assert.equal(retry.data,true);
      assert.deepEqual(await db.query(`SELECT * FROM media_dubbing_artifacts WHERE id='${id}'`),[]);
    }
  });

  async function retainedOriginal(sourceOwner=owner,uploader?:string,thumbnail=false,shared=true,beforeRecord?:(s:Source)=>Promise<void>,beforeRetire?:(s:Source,id:string)=>Promise<void>) {
    const s=await source(shared,false,{owner:sourceOwner});if(thumbnail)s.input.thumbnailPath=`${s.path}.thumb.jpg`;
    await beforeRecord?.(s);
    const recorded=await recordMediaAssetDetailed(db.client,s.input);assert.ok(recorded.assetId);
    if (uploader) await db.exec(`UPDATE media_assets SET uploader_user_id='${uploader}' WHERE id='${recorded.assetId}'`);
    await beforeRetire?.(s,recorded.assetId!);
    const retired=await db.client.rpc('retire_media_asset',{p_asset:recorded.assetId,p_actor:sourceOwner});assert.equal(retired.error,null);
    const asset=(await assets(s))[0];
    return {s,id:recorded.assetId!,generation:String(asset.recovery_generation),objectId:randomUUID(),version:randomUUID()};
  }
  type RetainedOriginal = Awaited<ReturnType<typeof retainedOriginal>>;
  for(const shared of [false,true]) for(const first of ['source','retirement'] as const)
    it(`${shared?'shared':'postcard'} dependency ${first} first serializes with canonical-only retirement`,{timeout:25_000},async()=>{
      const s=await source(shared),recorded=await recordMediaAssetDetailed(db.client,s.input);assert.ok(recorded.assetId);
      const path=`${s.path}.feed.jpg`,a=await connect(),b=await connect();let waiting:Promise<QueryResult>|undefined;
      const change='UPDATE post_media SET feed_storage_path=$1 WHERE id=$2 RETURNING feed_storage_path';
      const retire='SELECT retire_media_asset($1,$2) AS receipt';
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
        if(first==='source') {
          assert.equal((await a.client.query(change,[path,s.media])).rowCount,1);
          waiting=b.client.query(retire,[recorded.assetId,owner]);void waiting.catch(()=>{});
          await blocked(a.pid,b.pid);await a.client.query('COMMIT');assert.equal((await waiting).rows[0].receipt.ok,true);
          assert.ok((await db.query(`SELECT path FROM media_permanent_purge_paths('${recorded.assetId}') path`)).some(row=>row.path===path));
        } else {
          assert.equal((await a.client.query(retire,[recorded.assetId,owner])).rows[0].receipt.ok,true);
          waiting=b.client.query(change,[path,s.media]);void waiting.catch(()=>{});
          await blocked(a.pid,b.pid);await a.client.query('COMMIT');await assert.rejects(waiting,/postcard_retained_dependency_immutable/);
          assert.equal((await db.query(`SELECT feed_storage_path FROM post_media WHERE id='${s.media}'`))[0].feed_storage_path,null);
        }
        assert.equal((await db.query(`SELECT deleted_at FROM post_media WHERE id='${s.media}'`))[0].deleted_at,null,'canonical-only retirement leaves source unwithdrawn');
        assert.equal((await assets(s))[0].purge_status,'retained');
      } finally {await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
    });

  it('owner thumbnail writes keep their active-source permission but cannot bypass retained dependency protection',async()=>{
    const s=await source(),recorded=await recordMediaAssetDetailed(db.client,s.input);assert.ok(recorded.assetId);
    const session=await connect(),path=`${s.path}.thumb.jpg`;
    const ownerUpdate=async(value:string)=>{
      await session.client.query('BEGIN');
      try {
        await session.client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",[owner]);
        await session.client.query('SET LOCAL ROLE authenticated');
        const result=await session.client.query('UPDATE post_media SET thumbnail_storage_path=$1 WHERE id=$2 RETURNING id',[value,s.media]);
        await session.client.query('COMMIT');return result;
      } catch(error) {await session.client.query('ROLLBACK');throw error;}
    };
    assert.equal((await ownerUpdate(path)).rowCount,1);
    await db.exec(`SELECT retire_media_asset('${recorded.assetId}','${owner}')`);
    await assert.rejects(ownerUpdate(`${path}.changed`),/postcard_retained_dependency_immutable/);
    assert.equal((await db.query(`SELECT thumbnail_storage_path FROM post_media WHERE id='${s.media}'`))[0].thumbnail_storage_path,path);
    for(const role of ['anon','authenticated'])assert.equal((await db.query(`SELECT has_function_privilege('${role}','guard_removed_media_legacy_publication()','EXECUTE') AS allowed`))[0].allowed,false);
  });

  it('retained dependency protection covers permanent purge, rejects stale snapshots and detects restored legacy behavior',async()=>{
    const r=await retainedOriginal(),path=`${r.s.path}.feed.jpg`,session=await connect();
    await authorizePurge(r);
    await assert.rejects(db.exec(`UPDATE post_media SET moderation_status='rejected',feed_storage_path=${lit(path)} WHERE id='${r.s.media}'`),/postcard_retained_dependency_immutable/);
    await session.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL ROLE service_role');
    try {await assert.rejects(session.client.query('UPDATE post_media SET feed_storage_path=$1 WHERE id=$2',[path,r.s.media]),/postcard_lifecycle_requires_read_committed/);}
    finally {await session.client.query('ROLLBACK');}
    assert.equal((await db.client.rpc('postcard_canonical_lifecycle_ready')).data,true);
    // Bounded negative control: restore the prior authoritative definition,
    // prove its rejected-source bypass, then roll back data and DDL together.
    await session.client.query('BEGIN');
    try {
      const original=readFileSync(new URL('../../migrations/4004_reported_content_audited_removal.sql',import.meta.url),'utf8');
      const definition=original.match(/CREATE FUNCTION public\.guard_removed_media_legacy_publication\(\)[\s\S]*?END \$legacy\$;/)![0]
        .replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION')
        .replace("IF NEW.moderation_status IS DISTINCT FROM 'rejected'", "IF NEW.deleted_at IS NULL AND NEW.moderation_status IS DISTINCT FROM 'rejected'");
      await session.client.query(definition);
      assert.equal((await session.client.query('SELECT postcard_canonical_lifecycle_ready() AS ready')).rows[0].ready,false);
      assert.equal((await session.client.query("UPDATE post_media SET moderation_status='rejected',feed_storage_path=$1 WHERE id=$2 RETURNING id",[path,r.s.media])).rowCount,1);
    } finally {await session.client.query('ROLLBACK');}
    assert.equal((await db.client.rpc('postcard_canonical_lifecycle_ready')).data,true);
    assert.equal((await db.query(`SELECT feed_storage_path FROM post_media WHERE id='${r.s.media}'`))[0].feed_storage_path,null);
  });

  const transferArgs=(r:RetainedOriginal)=>({p_asset:r.id,p_generation:r.generation,p_object_id:r.objectId,p_object_version:r.version,p_sha256:'a'.repeat(64),p_size:100});
  const transferReceipts=(r:RetainedOriginal)=>db.query(`SELECT * FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='retention_original_prepared'`);
  async function withOriginalStorage(r:RetainedOriginal,run:()=>Promise<void>,fault:'public'|'changed'|'short'|'oversize'|'missing'|'hung'|null=null) {
    const from=db.client.storage.from,getBucket=db.client.storage.getBucket;let reads=0,cancellations=0;
    db.client.storage.getBucket=async()=>({data:{id:'post-media',public:fault==='public'},error:null} as any);
    db.client.storage.from=()=>({
      info:async()=>({data:fault==='missing' ? null : {id:r.objectId,version:fault==='changed' && reads++>0 ? randomUUID() : r.version,bucketId:'post-media',name:r.s.path,size:100},error:fault==='missing' ? {message:'synthetic missing object'} : null}),
      download:()=>({asStream:()=>Promise.resolve({data:new ReadableStream<Uint8Array>({start(controller){if(fault==='hung')return;controller.enqueue(new Uint8Array(fault==='short' ? 99 : fault==='oversize' ? 101 : 100));controller.close();},cancel(){cancellations++;}}),error:null})}),
      copy:()=>{throw new Error('Preparation must not copy');},remove:()=>{throw new Error('Preparation must not remove');},
    } as any);
    try {await run();return cancellations;} finally {db.client.storage.from=from;db.client.storage.getBucket=getBucket;}
  }

  it('verified original preparation persists one generation-bound receipt without moving bytes or resetting retention', async () => {
    const r=await retainedOriginal(),before=(await assets(r.s))[0];
    await withOriginalStorage(r,async()=>{
      const first=await prepareRetainedMediaOriginal(db.client,r.id,r.generation);
      const retry=await prepareRetainedMediaOriginal(db.client,r.id,r.generation);
      assert.deepEqual(retry,first);assert.equal(first.sourcePath,r.s.path);assert.equal(first.size,100);
      assert.equal(first.retainedPath,`_retained/${r.id}/${r.generation}/original`);assert.match(first.sha256,/^[a-f0-9]{64}$/);
      assert.deepEqual((await transferReceipts(r))[0].details,{generation:r.generation,bucket:'post-media',sourcePath:r.s.path,retainedPath:first.retainedPath,objectId:r.objectId,objectVersion:r.version,sha256:first.sha256,size:100});
    });
    assert.equal((await transferReceipts(r)).length,1);assert.deepEqual((await assets(r.s))[0],before);
    const mismatch=await db.client.rpc('prepare_media_original_retention',{...transferArgs(r),p_object_version:'different-version'});
    assert.equal(mismatch.error,null);assert.equal((mismatch.data as {error:string}).error,'object_identity_changed');
    const stale=await db.client.rpc('prepare_media_original_retention',{...transferArgs(r),p_generation:randomUUID()});
    assert.equal(stale.error,null);assert.equal((stale.data as {error:string}).error,'retention_changed');
    for (const role of ['anon','authenticated']) {
      assert.equal((await db.query(`SELECT has_function_privilege('${role}','public.prepare_media_original_retention(uuid,uuid,uuid,text,text,bigint)','EXECUTE') AS allowed`))[0].allowed,false);
    }
  });
  for (const fault of ['public','changed','short','oversize','missing'] as const) {
    it(`original preparation refuses ${fault} storage evidence without a durable claim`,async()=>{
      const r=await retainedOriginal();
      await withOriginalStorage(r,async()=>{await assert.rejects(prepareRetainedMediaOriginal(db.client,r.id,r.generation),/bucket unavailable|changed|identity unavailable/);},fault);
      assert.deepEqual(await transferReceipts(r),[]);assert.equal((await assets(r.s))[0].purge_status,'retained');
    });
  }

  it('a lost preparation acknowledgment reconciles to the same durable receipt on retry',async()=>{
    const r=await retainedOriginal(),rpc=db.client.rpc;
    await withOriginalStorage(r,async()=>{
      db.client.rpc=(async(name:string,args:Record<string,unknown>)=>{
        const result=await rpc.call(db.client,name,args);
        return name==='prepare_media_original_retention' && !result.error ? {data:null,error:{message:'synthetic response lost after commit'}} : result;
      }) as typeof db.client.rpc;
      try {await assert.rejects(prepareRetainedMediaOriginal(db.client,r.id,r.generation),/preparation unconfirmed/);} finally {db.client.rpc=rpc;}
      const committed=await transferReceipts(r);assert.equal(committed.length,1);
      const retry=await prepareRetainedMediaOriginal(db.client,r.id,r.generation);
      assert.equal(retry.id,committed[0].id);assert.deepEqual(await transferReceipts(r),committed);
    });
  });

  it('a stalled original stream is cancelled and never creates a transfer claim',async()=>{
    const r=await retainedOriginal();
    const cancellations=await withOriginalStorage(r,async()=>{
      await assert.rejects(prepareRetainedMediaOriginal(db.client,r.id,r.generation,{operationTimeoutMs:100}),/queue_timeout/);
    },'hung');
    assert.equal(cancellations,1);assert.deepEqual(await transferReceipts(r),[]);
  });

  for (const winner of ['transfer','permanent-deletion'] as const) {
    it(`${winner} serializes against the competing media lifecycle command`,{timeout:25_000},async()=>{
      const r=await retainedOriginal(),admin=(await db.seedUser('transfer-admin')).id;await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'`);
      const a=await connect(),b=await connect();let loser:Promise<QueryResult>|undefined;
      const prepare=(client:Client)=>client.query('SELECT public.prepare_media_original_retention($1,$2,$3,$4,$5,$6) AS receipt',Object.values(transferArgs(r)));
      const authorize=(client:Client)=>client.query('SELECT public.authorize_media_permanent_deletion($1,$2,$3,$4) AS receipt',[admin,r.id,r.generation,'Reviewed permanent deletion']);
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
        assert.equal((await (winner==='transfer' ? prepare(a.client) : authorize(a.client))).rows[0].receipt.ok,true);
        loser=winner==='transfer' ? authorize(b.client) : prepare(b.client);void loser.catch(()=>{});
        await blocked(a.pid,b.pid);await a.client.query('COMMIT');
        assert.equal((await loser).rows[0].receipt.error,winner==='transfer' ? 'retention_transfer_pending' : 'retention_changed');
      } finally {await a.client.query('ROLLBACK');await loser?.catch(()=>{});}
      assert.equal((await transferReceipts(r)).length,winner==='transfer' ? 1 : 0);
      assert.equal((await assets(r.s))[0].purge_status,winner==='transfer' ? 'retained' : 'pending');
    });
  }

  it('account permanent deletion cannot claim an owner with a prepared object transfer',async()=>{
    const user=(await db.seedUser('transfer-account')).id,r=await retainedOriginal(user),admin=(await db.seedUser('transfer-account-admin')).id;
    await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'`);
    const prepared=await db.client.rpc('prepare_media_original_retention',transferArgs(r));assert.equal(prepared.error,null);assert.equal((prepared.data as {ok:boolean}).ok,true);
    const requested=await db.client.rpc('request_recoverable_account_deletion',{p_user:user});assert.equal(requested.error,null);
    const claimed=await db.client.rpc('claim_account_permanent_deletion',{p_protocol:1,p_actor:admin,p_user:user,p_generation:(requested.data as {generation:string}).generation,p_token:randomUUID(),p_reason:'Reviewed account erasure'});
    assert.equal(claimed.error,null);assert.equal((claimed.data as {error:string}).error,'retention_transfer_pending');
    assert.deepEqual(await db.query(`SELECT status,execution_started_at FROM user_deletion_requests WHERE user_id='${user}'`),[{status:'pending',execution_started_at:null}]);
    assert.equal((await transferReceipts(r)).length,1);assert.equal((await assets(r.s))[0].purge_status,'retained');
  });

  it('uploader account deletion and prepared transfer use the same barrier',async()=>{
    const uploader=(await db.seedUser('transfer-uploader')).id,r=await retainedOriginal(owner,uploader),admin=(await db.seedUser('transfer-uploader-admin')).id;
    await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'`);
    const prepared=await db.client.rpc('prepare_media_original_retention',transferArgs(r));assert.equal(prepared.error,null);assert.equal((prepared.data as {ok:boolean}).ok,true);
    const requested=await db.client.rpc('request_recoverable_account_deletion',{p_user:uploader});assert.equal(requested.error,null);
    const claimed=await db.client.rpc('claim_account_permanent_deletion',{p_protocol:1,p_actor:admin,p_user:uploader,p_generation:(requested.data as {generation:string}).generation,p_token:randomUUID(),p_reason:'Reviewed uploader erasure'});
    assert.equal(claimed.error,null);assert.equal((claimed.data as {error:string}).error,'retention_transfer_pending');
    assert.deepEqual(await db.query(`SELECT status,execution_started_at FROM user_deletion_requests WHERE user_id='${uploader}'`),[{status:'pending',execution_started_at:null}]);
  });

  it('a started account deletion refuses a new transfer even while its media is still retained',async()=>{
    const user=(await db.seedUser('transfer-started-account')).id,r=await retainedOriginal(user),admin=(await db.seedUser('transfer-started-admin')).id;
    await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'`);
    const requested=await db.client.rpc('request_recoverable_account_deletion',{p_user:user});assert.equal(requested.error,null);
    const claimed=await db.client.rpc('claim_account_permanent_deletion',{p_protocol:1,p_actor:admin,p_user:user,p_generation:(requested.data as {generation:string}).generation,p_token:randomUUID(),p_reason:'Reviewed account erasure'});
    assert.equal(claimed.error,null);assert.equal((claimed.data as {ok:boolean}).ok,true);
    const prepared=await db.client.rpc('prepare_media_original_retention',transferArgs(r));assert.equal(prepared.error,null);assert.equal((prepared.data as {error:string}).error,'permanent_deletion_started');
    assert.deepEqual(await transferReceipts(r),[]);
  });

  it('transfer and permanent-deletion commands reject snapshots that can miss a committed competing receipt',async()=>{
    const user=(await db.seedUser('transfer-isolation')).id,r=await retainedOriginal(user),admin=(await db.seedUser('transfer-isolation-admin')).id;
    await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'`);
    const requested=await db.client.rpc('request_recoverable_account_deletion',{p_user:user});assert.equal(requested.error,null);
    const session=await connect();
    const statements=[
      ['SELECT prepare_media_original_retention($1,$2,$3,$4,$5,$6)',Object.values(transferArgs(r))],
      ['SELECT authorize_media_permanent_deletion($1,$2,$3,$4)',[admin,r.id,r.generation,'Reviewed erasure']],
      ['SELECT claim_account_permanent_deletion($1,$2,$3,$4,$5,1)',[admin,user,(requested.data as {generation:string}).generation,randomUUID(),'Reviewed account erasure']],
    ] as const;
    for (const [sql,args] of statements) {
      await session.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL ROLE service_role');
      try {await assert.rejects(session.client.query(sql,[...args]),/media_recovery_requires_read_committed/);} finally {await session.client.query('ROLLBACK');}
    }
    assert.deepEqual(await transferReceipts(r),[]);assert.equal((await assets(r.s))[0].purge_status,'retained');
    assert.deepEqual(await db.query(`SELECT status FROM user_deletion_requests WHERE user_id='${user}'`),[{status:'pending'}]);
  });

  async function withCopyStorage(r:RetainedOriginal,run:(state:{objects:Map<string,{id:string;version:string;bytes:Uint8Array}>;copies:number;uploads:number;uploadMode:string;finishUpload:()=>void;removes:number;removedPaths:string[];purging:boolean;restorePath:string|null;dependencySource:string|null;beforeCopy:()=>Promise<void>;beforeDownload:(path:string)=>Promise<void>;removeMode:string;mode:string;complete:()=>void})=>Promise<void>) {
    const from=db.client.storage.from,getBucket=db.client.storage.getBucket;
    const objects=new Map([[r.s.path,{id:r.objectId,version:r.version,bytes:new Uint8Array(100)}]]);
    const target=`_retained/${r.id}/${r.generation}/original`;
    const state={objects,copies:0,uploads:0,uploadMode:'normal',finishUpload:()=>{},removes:0,removedPaths:[] as string[],purging:false,restorePath:null as string|null,dependencySource:null as string|null,beforeCopy:async()=>{},beforeDownload:async(_path:string)=>{},removeMode:'forbidden',mode:'normal',complete:()=>{const bytes=state.dependencySource?new Uint8Array(objects.get(state.dependencySource)!.bytes):new Uint8Array(100);if(state.mode==='corrupt')bytes[0]^=1;objects.set(state.restorePath??target,{id:randomUUID(),version:randomUUID(),bytes});}};
    db.client.storage.getBucket=async()=>({data:{id:'post-media',public:false},error:null} as any);
    db.client.storage.from=()=>({
      info:async(path:string)=>{const object=objects.get(path);return object ? {data:{id:object.id,version:object.version,bucketId:'post-media',name:path,size:object.bytes.length},error:null} : {data:null,error:{status:404,statusCode:'NoSuchKey',message:'Object not found'}};},
      download:(path:string)=>({asStream:async()=>{await state.beforeDownload(path);return {data:objects.has(path)?new ReadableStream<Uint8Array>({start(controller){controller.enqueue(objects.get(path)!.bytes);controller.close();}}):null,error:objects.has(path)?null:{message:'missing'}};}}),
      list:async(prefix:string,options:{limit?:number;offset?:number}={})=>({data:[...objects.keys()].filter(path=>path.startsWith(`${prefix}/`)).slice(options.offset??0,(options.offset??0)+(options.limit??100)).map(path=>({name:path.slice(prefix.length+1)})),error:null}),
      upload:async(path:string,bytes:Uint8Array,options:{upsert:boolean;contentType:string})=>{
        assert.equal(options.upsert,false);assert.equal(options.contentType,'application/json');assert.ok(path.startsWith(`manual-captions/${r.id}/`));
        state.uploads++;assert.ok(!objects.has(path));
        state.finishUpload=()=>{const stored=new Uint8Array(bytes);if(state.uploadMode==='corrupt')stored[0]^=1;objects.set(path,{id:randomUUID(),version:randomUUID(),bytes:stored});};
        if(state.uploadMode==='pending')return {data:null,error:{message:'uncertain upload'}};
        if(state.uploadMode==='hung')return new Promise(()=>{});
        state.finishUpload();if(state.uploadMode==='lost-response')throw new Error('lost upload response');
        return {data:{path},error:null};
      },
      copy:async(source:string,destination:string)=>{
        assert.equal(source,state.dependencySource??(state.restorePath?target:r.s.path));assert.equal(destination,state.restorePath??target);state.copies++;await state.beforeCopy();
        if(state.mode==='pending')return {data:null,error:{message:'synthetic outcome unknown'}};
        if(state.mode==='hung')return new Promise(()=>{});
        state.complete();if(state.mode==='lost-response')throw new Error('synthetic response lost after copy');
        return {data:{path:`post-media/${target}`},error:null};
      },
      remove:async(paths:string[])=>{
        assert.notEqual(state.removeMode,'forbidden','Copy phase must preserve original');
        if(!state.purging)assert.deepEqual(paths,[r.s.path]);
        else assert.ok(paths.length===1 && objects.has(paths[0]!), 'Purge removes one known fixture object');
        state.removes++;state.removedPaths.push(...paths);
        if(state.removeMode==='pending')return {data:null,error:{message:'synthetic outcome unknown'}};
        if(state.removeMode==='hung')return new Promise(()=>{});
        for(const path of paths)objects.delete(path);
        if(state.removeMode==='corrupt-copy')objects.get(target)!.bytes.fill(1);
        if(state.removeMode==='lost-response')throw new Error('synthetic response lost after removal');
        return {data:[],error:null};
      },
    } as any);
    try {await run(state);} finally {db.client.storage.from=from;db.client.storage.getBucket=getBucket;}
  }

  for(const mode of ['normal','lost-response']) {
    it(`copies a prepared original once and verifies bytes across ${mode} provider completion`,async()=>{
      const r=await retainedOriginal();
      await withCopyStorage(r,async state=>{
        state.mode=mode;const prepared=await prepareRetainedMediaOriginal(db.client,r.id,r.generation);
        const first=await copyRetainedMediaOriginal(db.client,r.id,r.generation);
        const again=await copyRetainedMediaOriginal(db.client,r.id,r.generation);
        assert.deepEqual(again,first);assert.equal(first.preparationId,prepared.id);assert.equal(first.sha256,prepared.sha256);assert.equal(state.copies,1);
        assert.deepEqual(state.objects.get(prepared.retainedPath)!.bytes,state.objects.get(r.s.path)!.bytes);
        assert.equal(state.objects.get(r.s.path)!.id,r.objectId);
        assert.equal((await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='retention_original_copied'`)).length,1);
      });
      assert.equal((await assets(r.s))[0].purge_status,'retained');
    });
  }

  it('an uncertain copy is never dispatched twice and reconciles a late destination',async()=>{
    const r=await retainedOriginal();
    await withCopyStorage(r,async state=>{
      state.mode='pending';await prepareRetainedMediaOriginal(db.client,r.id,r.generation);
      await assert.rejects(copyRetainedMediaOriginal(db.client,r.id,r.generation),/identity unavailable/);
      await assert.rejects(copyRetainedMediaOriginal(db.client,r.id,r.generation),/outcome unknown/);assert.equal(state.copies,1);
      assert.equal(state.objects.size,1);
      state.complete();const completed=await copyRetainedMediaOriginal(db.client,r.id,r.generation);
      assert.equal(completed.generation,r.generation);assert.equal(state.copies,1);assert.ok(state.objects.has(r.s.path));
    });
  });

  it('a corrupt retained copy is neither accepted nor overwritten, and leaves the original intact',async()=>{
    const r=await retainedOriginal();
    await withCopyStorage(r,async state=>{
      state.mode='corrupt';await prepareRetainedMediaOriginal(db.client,r.id,r.generation);
      for(let attempt=0;attempt<2;attempt++)await assert.rejects(copyRetainedMediaOriginal(db.client,r.id,r.generation),/integrity mismatch/);
      assert.equal(state.copies,1);assert.deepEqual(state.objects.get(r.s.path)!.bytes,new Uint8Array(100));
      assert.deepEqual(await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='retention_original_copied'`),[]);
    });
  });

  it('an occupied destination is not adopted without a prior dispatch receipt',async()=>{
    const r=await retainedOriginal();
    await withCopyStorage(r,async state=>{
      await prepareRetainedMediaOriginal(db.client,r.id,r.generation);state.complete();
      await assert.rejects(copyRetainedMediaOriginal(db.client,r.id,r.generation),/already occupied/);assert.equal(state.copies,0);
      assert.deepEqual(await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='retention_original_copy_started'`),[]);
    });
  });

  for (const phase of ['copy_started','copied']) {
    it(`lost ${phase} acknowledgment preserves dispatch authority and durable progress`,async()=>{
      const r=await retainedOriginal(),rpc=db.client.rpc;
      await withCopyStorage(r,async state=>{
        await prepareRetainedMediaOriginal(db.client,r.id,r.generation);
        db.client.rpc=(async(name:string,args:Record<string,unknown>)=>{
          const result=await rpc.call(db.client,name,args);
          return name==='advance_media_original_retention' && args.p_phase===phase && !result.error ? {data:null,error:{message:'synthetic receipt lost after commit'}} : result;
        }) as typeof db.client.rpc;
        try {await assert.rejects(copyRetainedMediaOriginal(db.client,r.id,r.generation),/unconfirmed/);} finally {db.client.rpc=rpc;}
        if(phase==='copy_started') {
          await assert.rejects(copyRetainedMediaOriginal(db.client,r.id,r.generation),/outcome unknown/);assert.equal(state.copies,0);
        } else {
          const saved=(await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='retention_original_copied'`))[0];
          const retry=await copyRetainedMediaOriginal(db.client,r.id,r.generation);assert.equal(retry.id,saved.id);assert.equal(state.copies,1);
        }
      });
    });
  }

  it('competing copy claims grant dispatch authority to exactly one database session',{timeout:25_000},async()=>{
    const r=await retainedOriginal();const prepared=await db.client.rpc('prepare_media_original_retention',transferArgs(r));assert.equal(prepared.error,null);
    const preparation=(prepared.data as {receipt:{id:string}}).receipt.id,token=randomUUID(),a=await connect(),b=await connect();let waiting:Promise<QueryResult>|undefined;
    try {
      await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
      const statement="SELECT advance_media_original_retention($1,$2,$3,'copy_started',$4) AS receipt";
      assert.equal((await a.client.query(statement,[r.id,r.generation,preparation,token])).rows[0].receipt.execute,true);
      waiting=b.client.query(statement,[r.id,r.generation,preparation,randomUUID()]);void waiting.catch(()=>{});
      await blocked(a.pid,b.pid);await a.client.query('COMMIT');
      assert.deepEqual((await waiting).rows[0].receipt,{ok:true,execute:false,token});
    } finally {await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
    assert.equal((await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='retention_original_copy_started'`)).length,1);
    for(const role of ['anon','authenticated'])assert.equal((await db.query(`SELECT has_function_privilege('${role}','advance_media_original_retention(uuid,uuid,uuid,text,uuid,uuid,text,text,bigint)','EXECUTE') AS allowed`))[0].allowed,false);
  });

  for(const mode of ['normal','lost-response']) {
    it(`removes the original once after verifying its retained copy across ${mode}`,async()=>{
      const r=await retainedOriginal();
      await withCopyStorage(r,async state=>{
        const prepared=await prepareRetainedMediaOriginal(db.client,r.id,r.generation);
        const copy=await copyRetainedMediaOriginal(db.client,r.id,r.generation);assert.equal(state.removes,0);
        state.removeMode=mode;
        const first=await removeCopiedMediaOriginal(db.client,r.id,r.generation);
        assert.equal(first.copyId,copy.id);assert.equal(first.preparationId,prepared.id);assert.equal(first.sourceAbsent,true);
        assert.deepEqual(await removeCopiedMediaOriginal(db.client,r.id,r.generation),first);
        assert.equal(state.removes,1);assert.equal(state.copies,1);assert.equal(state.objects.has(r.s.path),false);
        assert.equal(state.objects.has(prepared.retainedPath),true);
      });
    });
  }

  it('uncertain removal remains claimed and reconciles late completion without a second write',async()=>{
    const r=await retainedOriginal();
    await withCopyStorage(r,async state=>{
      await prepareRetainedMediaOriginal(db.client,r.id,r.generation);await copyRetainedMediaOriginal(db.client,r.id,r.generation);
      state.removeMode='pending';
      await assert.rejects(removeCopiedMediaOriginal(db.client,r.id,r.generation),/outcome unknown/);
      state.removeMode='normal';
      await assert.rejects(removeCopiedMediaOriginal(db.client,r.id,r.generation),/outcome unknown/);assert.equal(state.removes,1);
      state.objects.delete(r.s.path);
      assert.equal((await removeCopiedMediaOriginal(db.client,r.id,r.generation)).sourceAbsent,true);assert.equal(state.removes,1);
    });
  });

  it('bounds a hung removal and reconciles late provider completion without retrying it',async()=>{
    const r=await retainedOriginal();
    await withCopyStorage(r,async state=>{
      await prepareRetainedMediaOriginal(db.client,r.id,r.generation);await copyRetainedMediaOriginal(db.client,r.id,r.generation);
      state.removeMode='hung';
      await assert.rejects(removeCopiedMediaOriginal(db.client,r.id,r.generation,{operationTimeoutMs:100}),/outcome unknown/);
      assert.equal(state.removes,1);
      state.objects.delete(r.s.path);state.removeMode='normal';
      assert.equal((await removeCopiedMediaOriginal(db.client,r.id,r.generation)).sourceAbsent,true);assert.equal(state.removes,1);
    });
  });

  for(const phase of ['removal_started','removed']) {
    it(`reconciles lost ${phase} acknowledgement without redispatch`,async()=>{
      const r=await retainedOriginal();
      await withCopyStorage(r,async state=>{
        await prepareRetainedMediaOriginal(db.client,r.id,r.generation);await copyRetainedMediaOriginal(db.client,r.id,r.generation);
        state.removeMode='normal';const rpc=db.client.rpc;
        db.client.rpc=(async(name:string,args:any)=>{
          const result=await rpc.call(db.client,name,args);
          return name==='advance_media_original_retention' && args.p_phase===phase && !result.error ? {data:null,error:{message:'synthetic receipt lost after commit'}} : result;
        }) as typeof rpc;
        try {await assert.rejects(removeCopiedMediaOriginal(db.client,r.id,r.generation),/unconfirmed/);} finally {db.client.rpc=rpc;}
        if(phase==='removal_started') {
          await assert.rejects(removeCopiedMediaOriginal(db.client,r.id,r.generation),/outcome unknown/);assert.equal(state.removes,0);
        } else {
          const [saved]=await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='retention_original_removed'`);
          assert.equal((await removeCopiedMediaOriginal(db.client,r.id,r.generation)).id,saved.id);assert.equal(state.removes,1);
        }
      });
    });
  }

  for(const fault of ['no-copy','copy-missing','copy-corrupt','copy-replaced','original-replaced']) {
    it(`refuses removal before dispatch when ${fault}`,async()=>{
      const r=await retainedOriginal();
      await withCopyStorage(r,async state=>{
        const prepared=await prepareRetainedMediaOriginal(db.client,r.id,r.generation);
        if(fault!=='no-copy')await copyRetainedMediaOriginal(db.client,r.id,r.generation);
        if(fault==='copy-missing')state.objects.delete(prepared.retainedPath);
        if(fault==='copy-corrupt')state.objects.get(prepared.retainedPath)!.bytes.fill(1);
        if(fault==='copy-replaced')state.objects.get(prepared.retainedPath)!.id=randomUUID();
        if(fault==='original-replaced')state.objects.get(r.s.path)!.version=randomUUID();
        state.removeMode='normal';await assert.rejects(removeCopiedMediaOriginal(db.client,r.id,r.generation));
        assert.equal(state.removes,0);assert.equal(state.objects.has(r.s.path),true);
        assert.deepEqual(await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='retention_original_removal_started'`),[]);
      });
    });
  }

  it('refuses a success receipt if the retained copy changes during original removal',async()=>{
    const r=await retainedOriginal();
    await withCopyStorage(r,async state=>{
      await prepareRetainedMediaOriginal(db.client,r.id,r.generation);await copyRetainedMediaOriginal(db.client,r.id,r.generation);
      state.removeMode='corrupt-copy';await assert.rejects(removeCopiedMediaOriginal(db.client,r.id,r.generation),/integrity mismatch/);
      assert.equal(state.removes,1);assert.deepEqual(await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='retention_original_removed'`),[]);
    });
  });

  it('detects a recreated original after a success receipt without erasing it again',async()=>{
    const r=await retainedOriginal();
    await withCopyStorage(r,async state=>{
      await prepareRetainedMediaOriginal(db.client,r.id,r.generation);await copyRetainedMediaOriginal(db.client,r.id,r.generation);
      state.removeMode='normal';await removeCopiedMediaOriginal(db.client,r.id,r.generation);
      // Even the same provider identity cannot turn a durable receipt into a
      // promise that the path remains absent or authorize a second dispatch.
      state.objects.set(r.s.path,{id:r.objectId,version:r.version,bytes:new Uint8Array(100)});
      await assert.rejects(removeCopiedMediaOriginal(db.client,r.id,r.generation),/outcome unknown or source recreated/);
      assert.equal(state.removes,1);assert.equal(state.objects.has(r.s.path),true);
    });
  });

  it('does not treat a generic provider 404 as evidence of original absence',async()=>{
    const r=await retainedOriginal();
    await withCopyStorage(r,async state=>{
      await prepareRetainedMediaOriginal(db.client,r.id,r.generation);await copyRetainedMediaOriginal(db.client,r.id,r.generation);
      state.objects.delete(r.s.path);state.removeMode='normal';const from=db.client.storage.from;
      db.client.storage.from=(bucket:string)=>{
        const storage=from.call(db.client.storage,bucket),info=storage.info;
        storage.info=(async(path:string)=>path===r.s.path ? {data:null,error:{status:404,statusCode:'404',message:'proxy failure'}} : info.call(storage,path)) as typeof info;
        return storage;
      };
      try {await assert.rejects(removeCopiedMediaOriginal(db.client,r.id,r.generation),/identity unavailable/);} finally {db.client.storage.from=from;}
      assert.equal(state.removes,0);
      assert.deepEqual(await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='retention_original_removed'`),[]);
    });
  });

  it('competing removal claims serialize and bind the recorded copy and removal token',{timeout:25_000},async()=>{
    const r=await retainedOriginal();
    await withCopyStorage(r,async()=>{
      const prepared=await prepareRetainedMediaOriginal(db.client,r.id,r.generation),copy=await copyRetainedMediaOriginal(db.client,r.id,r.generation);
      const args=[r.id,r.generation,prepared.id,randomUUID(),copy.objectId,copy.objectVersion,copy.sha256,copy.size];
      const a=await connect(),b=await connect();let waiting:Promise<QueryResult>|undefined;
      const statement="SELECT advance_media_original_retention($1,$2,$3,'removal_started',$4,$5,$6,$7,$8) AS receipt";
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
        assert.equal((await a.client.query(statement,args)).rows[0].receipt.execute,true);
        waiting=b.client.query(statement,[...args.slice(0,3),randomUUID(),...args.slice(4)]);void waiting.catch(()=>{});
        await blocked(a.pid,b.pid);await a.client.query('COMMIT');
        assert.deepEqual((await waiting).rows[0].receipt,{ok:true,execute:false,token:args[3]});
      } finally {await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
      const wrongIdentity=await b.client.query(statement,[...args.slice(0,4),randomUUID(),...args.slice(5)]);
      assert.equal(wrongIdentity.rows[0].receipt.error,'retained_copy_changed');
      const wrongToken=await b.client.query(statement.replace("'removal_started'","'removed'"),[...args.slice(0,3),randomUUID(),...args.slice(4)]);
      assert.equal(wrongToken.rows[0].receipt.error,'removal_authority_changed');
      const wrongGeneration=await b.client.query(statement,[r.id,randomUUID(),...args.slice(2)]);
      assert.equal(wrongGeneration.rows[0].receipt.error,'retention_changed');
      assert.deepEqual(await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='retention_original_removed'`),[]);
    });
  });

  it('retention preserves authored video segment ranges and labels without exposing or rebasing them',async()=>{
    const path=`${owner}/retained-segments-${randomUUID()}.mp4`,memory=randomUUID(),item=randomUUID(),segment=randomUUID();
    const recorded=await recordMediaAssetDetailed(db.client,{ownerUserId:owner,storageBucket:'post-media',storagePath:path,
      publicUrl:`post-media/${path}`,mediaType:'video',mimeType:'video/mp4',sizeBytes:100,width:64,height:48,durationMs:10000,sourceType:'user'});
    assert.ok(recorded.assetId);
    await db.exec(`UPDATE media_assets SET processing_status='ready',moderation_status='approved' WHERE id='${recorded.assetId}';
      INSERT INTO memories(id,owner_id,title,visibility,state) VALUES('${memory}','${owner}','Retained ranges','only_me','published');
      INSERT INTO memory_items(id,memory_id,media_url,media_type) VALUES('${item}','${memory}','post-media/${path}','video/mp4')`);
    const initial=(await db.query(`SELECT * FROM media_assets WHERE id='${recorded.assetId}'`))[0];
    await db.exec(`INSERT INTO memory_video_segment_operations(id,memory_id,item_id,owner_id,asset_id) VALUES('${segment}','${memory}','${item}','${owner}','${recorded.assetId}');
      INSERT INTO memory_video_segments(id,memory_id,item_id,owner_id,asset_id,asset_version,duration_ms,start_ms,end_ms,label)
        VALUES('${segment}','${memory}','${item}','${owner}','${recorded.assetId}',${initial.version},10000,1200,3400,'My selected moment')`);
    await db.setFlag('memory_kernel_enabled',true);await db.setFlag('memory_video_segments_enabled',true);
    const command={contractVersion:1,operation:'list',ownerId:owner,memoryId:memory,itemId:item,
      source:{assetId:recorded.assetId,assetVersion:initial.version,durationMs:10000,storageBucket:'post-media',storagePath:path,itemMediaUrl:`post-media/${path}`}};
    const visible=await db.client.rpc('memory_video_segments_execute',{p_command:command});
    assert.equal(visible.data?.segments?.length,1,JSON.stringify(visible));
    const before=await db.query(`SELECT * FROM memory_video_segments WHERE id='${segment}'`);
    assert.equal((await db.client.rpc('retire_media_asset',{p_asset:recorded.assetId,p_actor:owner})).data?.ok,true);
    assert.deepEqual(await db.query(`SELECT * FROM memory_video_segments WHERE id='${segment}'`),before);
    await db.exec(`UPDATE media_assets SET purge_error='synthetic retained maintenance' WHERE id='${recorded.assetId}'`);
    assert.deepEqual(await db.query(`SELECT * FROM memory_video_segments WHERE id='${segment}'`),before);
    const retained=(await db.query(`SELECT * FROM media_assets WHERE id='${recorded.assetId}'`))[0];
    for(const version of [initial.version,retained.version])assert.equal((await db.client.rpc('memory_video_segments_execute',{p_command:{...command,source:{...command.source,assetVersion:version}}})).data?.reason,'not_found');
    const admin=(await db.seedUser('retained-segment-admin')).id;await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'`);
    assert.equal((await db.client.rpc('authorize_media_permanent_deletion',{p_actor:admin,p_asset:recorded.assetId,p_generation:retained.recovery_generation,p_reason:'Reviewed permanent deletion including authored ranges'})).data?.ok,true);
    assert.deepEqual(await db.query(`SELECT * FROM memory_video_segments WHERE id='${segment}'`),[]);
    assert.equal((await db.query(`SELECT id FROM memory_video_segment_operations WHERE id='${segment}'`)).length,1);
  });

  async function authorizePurge(r:RetainedOriginal) {
    const admin=(await db.seedUser('retained-purge-admin')).id;await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'`);
    const approved=await db.client.rpc('authorize_media_permanent_deletion',{p_actor:admin,p_asset:r.id,p_generation:r.generation,p_reason:'Reviewed permanent erasure'});
    assert.equal(approved.error,null);assert.equal((approved.data as any).ok,true,JSON.stringify(approved));
    return Number((await assets(r.s))[0].version);
  }
  it('derivative erasure requires the canonical permanent authority and exact reviewed source version',async()=>{
    const r=await retainedOriginal();
    const retained=(await assets(r.s))[0] as any;
    await assert.rejects(requireDerivativeErasure(db.client,retained),/authority unavailable/);
    await authorizePurge(r);
    await assert.rejects(requireDerivativeErasure(db.client,retained),/authority unavailable/);
    const current=(await assets(r.s))[0] as any;
    await assert.rejects(requireDerivativeErasure(db.client,{...current,storage_path:'another-object'}),/authority unavailable/);
    const before=await audit(r.s);
    await requireDerivativeErasure(db.client,current);
    assert.deepEqual(await audit(r.s),before);
    assert.deepEqual((await assets(r.s))[0],current);
  });

  async function runPurge(r:RetainedOriginal) {
    const asset=(await assets(r.s))[0];
    await purgeWithdrawnAccountMedia(db.client,r.id,String(asset.owner_user_id),{env:{},expectedVersion:Number(asset.version),operationTimeoutMs:1000});
  }

  it('derivative erasure refuses a disabled retention guard before requesting permanent authority',async()=>{
    const r=await retainedOriginal();await authorizePurge(r);
    const current=(await assets(r.s))[0] as any,before=await audit(r.s);
    const originalRpc=db.client.rpc.bind(db.client),calls:string[]=[];
    db.client.rpc=((name:string,args?:Record<string,unknown>)=>{calls.push(name);return originalRpc(name,args);}) as typeof db.client.rpc;
    await db.exec('ALTER TABLE public.media_assets DISABLE TRIGGER retained_media_purge_guard');
    try {
      await assert.rejects(requireDerivativeErasure(db.client,current),/authority unavailable/);
      assert.deepEqual(calls,['postcard_canonical_lifecycle_ready']);
      assert.deepEqual(await audit(r.s),before);assert.deepEqual((await assets(r.s))[0],current);
    } finally {
      await db.exec('ALTER TABLE public.media_assets ENABLE TRIGGER retained_media_purge_guard');
      db.client.rpc=originalRpc;
    }
    await requireDerivativeErasure(db.client,current);
    assert.deepEqual(await audit(r.s),before);assert.deepEqual((await assets(r.s))[0],current);
  });

  for(const mode of ['normal','lost-response']) {
    it(`permanent purge erases original, thumbnail and retained destination with ${mode}`,async()=>{
      const r=await retainedOriginal(owner,undefined,true);
      await withCopyStorage(r,async state=>{
        const prepared=await prepareRetainedMediaOriginal(db.client,r.id,r.generation);await copyRetainedMediaOriginal(db.client,r.id,r.generation);
        state.removeMode='normal';await removeCopiedMediaOriginal(db.client,r.id,r.generation);
        // An already issued upload may recreate the original. Explicit admin
        // erasure includes it as well as the service-owned retained copy.
        state.objects.set(r.s.path,{id:randomUUID(),version:randomUUID(),bytes:new Uint8Array(100)});
        state.objects.set(`${r.s.path}.thumb.jpg`,{id:randomUUID(),version:randomUUID(),bytes:new Uint8Array(30)});
        const version=await authorizePurge(r);state.purging=true;state.removeMode=mode;
        await runPurge(r);assert.equal(state.objects.size,0);
        const removed=state.removes;await runPurge(r);assert.equal(state.removes,removed);
        const asset=(await assets(r.s))[0];assert.equal(asset.purge_status,'completed');
        const events=await audit(r.s);assert.equal(events.filter(e=>e.event_type==='purge_object_started').length,3);
        assert.equal(events.filter(e=>e.event_type==='purge_object_absent').length,3);
        assert.equal(events.filter(e=>e.event_type==='purge_succeeded').length,1);
        assert.ok(state.removedPaths.includes(prepared.retainedPath));
        const again=await db.client.rpc('advance_media_object_purge',{p_asset:r.id,p_version:version,p_phase:'completed'});
        assert.equal(again.error,null);assert.equal((again.data as any).ok,true);
        assert.equal((await audit(r.s)).filter(e=>e.event_type==='purge_succeeded').length,1);
      });
    });
  }

  it('uncertain retained purge never repeats a provider write and reconciles eventual absence',async()=>{
    const r=await retainedOriginal();
    await withCopyStorage(r,async state=>{
      const prepared=await prepareRetainedMediaOriginal(db.client,r.id,r.generation);await copyRetainedMediaOriginal(db.client,r.id,r.generation);
      state.removeMode='normal';await removeCopiedMediaOriginal(db.client,r.id,r.generation);await authorizePurge(r);
      state.purging=true;state.removeMode='pending';
      await assert.rejects(runPurge(r),/outcome unknown/);assert.equal((await assets(r.s))[0].purge_status,'failed');
      state.removeMode='normal';const removes=state.removes;
      await assert.rejects(runPurge(r),/outcome unknown/);assert.equal(state.removes,removes);
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='purge_succeeded').length,0);
      state.objects.delete(prepared.retainedPath);await runPurge(r);assert.equal(state.removes,removes);
      assert.equal((await assets(r.s))[0].purge_status,'completed');
    });
  });

  it('the account executor reconciles committed purge after a lost acknowledgement without erasing again',async()=>{
    const user=(await db.seedUser('account-purge-reconcile')).id,admin=(await db.seedUser('account-purge-reviewer')).id;
    await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'`);const r=await retainedOriginal(user);
    await withCopyStorage(r,async state=>{
      await prepareRetainedMediaOriginal(db.client,r.id,r.generation);await copyRetainedMediaOriginal(db.client,r.id,r.generation);
      state.removeMode='normal';await removeCopiedMediaOriginal(db.client,r.id,r.generation);
      const request=await db.client.rpc('request_recoverable_account_deletion',{p_user:user});assert.equal(request.error,null);
      const claim=await db.client.rpc('claim_account_permanent_deletion',{p_protocol:1,p_actor:admin,p_user:user,p_generation:(request.data as any).generation,p_token:randomUUID(),p_reason:'Reviewed account erasure'});
      assert.equal(claim.error,null);assert.equal((claim.data as any).ok,true,'settled transfer permits explicit account erasure');
      state.purging=true;const rpc=db.client.rpc;
      db.client.rpc=(async(name:string,args:any)=>{
        const result=await rpc.call(db.client,name,args);
        return name==='advance_media_object_purge' && args.p_phase==='completed' && !result.error ? {data:null,error:{message:'synthetic lost completion'}} : result;
      }) as typeof rpc;
      try {await assert.rejects(eraseAccountMedia(db.client,user,{env:{}}),/Account Media cleanup unconfirmed/);} finally {db.client.rpc=rpc;}
      assert.equal((await assets(r.s))[0].purge_status,'completed');const removed=state.removes;
      assert.equal(await eraseAccountMedia(db.client,user,{env:{}}),1);assert.equal(state.removes,removed);assert.deepEqual(await assets(r.s),[]);
    });
  });

  it('completed purge rechecks actual absence and refuses recreated original bytes without another delete',async()=>{
    const r=await retainedOriginal();
    await withCopyStorage(r,async state=>{
      await authorizePurge(r);state.purging=true;state.removeMode='normal';await runPurge(r);
      state.objects.set(r.s.path,{id:randomUUID(),version:randomUUID(),bytes:new Uint8Array(100)});
      const removed=state.removes;await assert.rejects(runPurge(r),/object recreated/);assert.equal(state.removes,removed);
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='purge_succeeded').length,1);
    });
  });

  it('purge completion refuses missing absence evidence, arbitrary paths, stale versions and foreign callers',async()=>{
    const r=await retainedOriginal(),version=await authorizePurge(r);
    const invoke=async(args:Record<string,unknown>)=>{const result=await db.client.rpc('advance_media_object_purge',{p_asset:r.id,p_version:version,...args});assert.equal(result.error,null);return result.data as any;};
    assert.equal((await invoke({p_phase:'completed'})).error,'purge_objects_unverified');
    await assert.rejects(db.exec(`UPDATE media_assets SET purge_status='completed' WHERE id='${r.id}'`),/media_purge_objects_unverified/);
    assert.equal((await invoke({p_phase:'started',p_path:'unrelated/path',p_token:randomUUID()})).error,'purge_path_forbidden');
    assert.equal((await invoke({p_phase:'manifest',p_version:version+1})).error,'purge_source_changed');
    assert.equal((await invoke({p_phase:'absent',p_path:r.s.path,p_token:randomUUID()})).error,'purge_authority_changed');
    for(const role of ['anon','authenticated'])assert.equal((await db.query(`SELECT has_function_privilege('${role}','advance_media_object_purge(uuid,bigint,text,text,uuid)','EXECUTE') AS allowed`))[0].allowed,false);
    assert.equal((await assets(r.s))[0].purge_status,'pending');
  });

  it('competing permanent object claims grant one dispatch on actual database sessions',{timeout:25_000},async()=>{
    const r=await retainedOriginal(),version=await authorizePurge(r),a=await connect(),b=await connect(),token=randomUUID();let waiting:Promise<QueryResult>|undefined;
    const statement="SELECT advance_media_object_purge($1,$2,'started',$3,$4) AS receipt";
    try {
      await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
      assert.equal((await a.client.query(statement,[r.id,version,r.s.path,token])).rows[0].receipt.execute,true);
      waiting=b.client.query(statement,[r.id,version,r.s.path,randomUUID()]);void waiting.catch(()=>{});
      await blocked(a.pid,b.pid);await a.client.query('COMMIT');
      assert.deepEqual((await waiting).rows[0].receipt,{ok:true,execute:false,token});
    } finally {await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
  });

  for(const phase of ['started','absent','completed']) {
    it(`reconciles a lost permanent purge ${phase} receipt without another object removal`,async()=>{
      const r=await retainedOriginal();
      await withCopyStorage(r,async state=>{
        const version=await authorizePurge(r);state.purging=true;state.removeMode='normal';const rpc=db.client.rpc;
        db.client.rpc=(async(name:string,args:any)=>{
          const result=await rpc.call(db.client,name,args);
          return name==='advance_media_object_purge' && args.p_phase===phase && !result.error ? {data:null,error:{message:'synthetic lost acknowledgement'}} : result;
        }) as typeof rpc;
        try {await assert.rejects(runPurge(r),/unconfirmed/);} finally {db.client.rpc=rpc;}
        const removes=state.removes;
        if(phase==='started')await assert.rejects(runPurge(r),/outcome unknown/);
        else if(phase==='absent')await runPurge(r);
        else {
          const result=await db.client.rpc('advance_media_object_purge',{p_asset:r.id,p_version:version,p_phase:'completed'});
          assert.equal((result.data as any).ok,true);assert.equal((await assets(r.s))[0].purge_status,'completed');
        }
        assert.equal(state.removes,removes);
      });
    });
  }

  it('permanent completion and audit roll back together after verified absence',async()=>{
    const r=await retainedOriginal();
    await withCopyStorage(r,async state=>{
      await authorizePurge(r);state.purging=true;state.removeMode='normal';
      await db.exec(`CREATE FUNCTION public.test_purge_completion_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='purge_succeeded' THEN RAISE EXCEPTION 'synthetic completion audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_purge_completion_audit_failure BEFORE INSERT ON media_asset_lifecycle_events FOR EACH ROW EXECUTE FUNCTION test_purge_completion_audit_failure()`);
      try {await assert.rejects(runPurge(r),/completion unconfirmed/);} finally {await db.exec('DROP TRIGGER test_purge_completion_audit_failure ON media_asset_lifecycle_events; DROP FUNCTION test_purge_completion_audit_failure()');}
      assert.equal((await assets(r.s))[0].purge_status,'failed');assert.equal(state.objects.size,0);
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='purge_succeeded').length,0);
      const removes=state.removes;await runPurge(r);assert.equal(state.removes,removes);
      assert.equal((await assets(r.s))[0].purge_status,'completed');assert.equal((await audit(r.s)).filter(e=>e.event_type==='purge_succeeded').length,1);
    });
  });

  async function restorationSource(sourceOwner=owner, dependencies: "none"|"sidecars"|"alias"|"unresolved"|"foreign"|"unicode"|"long"="none") {
    const r=await retainedOriginal(sourceOwner,undefined,dependencies==='sidecars',false,async s=>{
    if(dependencies!=='none') {
      const thumbnail=dependencies==='long'?`${sourceOwner}/${'𐀀'.repeat(800)}.jpg`:dependencies==='unicode'?`${sourceOwner}/𐀀.jpg`:dependencies==='alias'?s.path:dependencies==='foreign'?`${randomUUID()}/foreign.jpg`:`${s.path}.thumb.jpg`;
      const feed=dependencies==='unicode'?`${sourceOwner}/.jpg`:dependencies==='sidecars'?`${s.path}.feed.jpg`:null;
      await db.exec(`UPDATE post_media SET thumbnail_storage_path=${dependencies==='unresolved'?'NULL':lit(thumbnail)},thumbnail_url=${lit(`post-media/${thumbnail}`)},
        feed_storage_path=${feed?lit(feed):'NULL'},feed_url=${feed?lit(`post-media/${feed}`):'NULL'} WHERE id='${s.media}'`);
    }
    }),admin=(await db.seedUser('restoration-reviewer')).id;
    await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'`);
    const withdrawn=await db.client.rpc('withdraw_postcard_media',{p_actor:sourceOwner,p_post:r.s.post,p_media:r.s.media,p_expected_moderation:'pending'});
    assert.equal(withdrawn.error,null);assert.equal(withdrawn.data,true);
    return {...r,admin};
  }
  async function settleRestorationOriginal(r:RetainedOriginal,state:{removeMode:string}) {
    await prepareRetainedMediaOriginal(db.client,r.id,r.generation);await copyRetainedMediaOriginal(db.client,r.id,r.generation);
    state.removeMode='normal';await removeCopiedMediaOriginal(db.client,r.id,r.generation);
  }
  const restorationArgs=(r:RetainedOriginal & {admin:string})=>({p_actor:r.admin,p_asset:r.id,p_generation:r.generation,p_reason:'Reviewed restoration'});
  const referenceReview=(r:RetainedOriginal & {admin:string})=>reviewUnboundMemoryReferences(db.client,r.id,{bucket:'post-media',path:r.s.path},r.admin);

  async function authoredRestorationSource(label='My selected moment',captionDeleted=false,mediaRef:(path:string)=>string=path=>`post-media/${path}`) {
    const memory=randomUUID(),item=randomUUID(),segment=randomUUID(),deletedSegment=randomUUID(),revision='a'.repeat(64);
    let version=0,captionPath='';let captionBytes:Uint8Array=new Uint8Array();
    await db.setFlag('memory_kernel_enabled',true);await db.setFlag('memory_video_segments_enabled',true);
    const r=await retainedOriginal(owner,undefined,false,false,async s=>{
      Object.assign(s.input,{mediaType:'video',mimeType:'video/mp4',durationMs:10000});
      await db.exec(`UPDATE post_media SET media_type='video',mime_type='video/mp4' WHERE id='${s.media}'`);
    },async(s,id)=>{
      await db.exec(`UPDATE media_assets SET processing_status='ready',moderation_status='approved' WHERE id='${id}';
        INSERT INTO memories(id,owner_id,title,visibility,state) VALUES('${memory}','${owner}','Authored recovery','only_me','published');
        INSERT INTO memory_items(id,memory_id,media_url,media_type) VALUES('${item}','${memory}',${lit(mediaRef(s.path))},'video/mp4')`);
      const asset=(await assets(s))[0];version=Number(asset.version);captionPath=`manual-captions/${id}/v${version}-${revision}.json`;
      captionBytes=Buffer.from(JSON.stringify({source:asset,consent:true,tracks:[
        {language:'en',sourceKind:'manual',aiLabel:null,revision:2,vtt:'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello 🌍\n'},
        {language:'fr',sourceKind:'translation',aiLabel:'AI translation · creator reviewed',revision:1,modelVersion:'reviewed-model',sourceLanguage:'en',vtt:'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nBonjour 🌍\n'}]}));
      assert.equal((await db.client.rpc('cas_media_caption_manifest',{p_asset_id:id,p_owner_id:owner,p_source:asset,p_expected_revision:'0'.repeat(64),p_revision:revision,p_object_path:captionPath})).data,true);
      if(captionDeleted) assert.equal((await db.client.rpc('cas_media_caption_manifest',{p_asset_id:id,p_owner_id:owner,p_source:asset,p_expected_revision:revision,p_revision:'d'.repeat(64),p_object_path:null})).data,true);
      assert.equal((await db.client.rpc('media_caption_asr_epoch',{p_asset_id:id,p_owner_id:owner})).error,null);
      await db.exec(`INSERT INTO media_dubbing_consents(asset_id,owner_user_id,target_language,source_version,caption_revision,translation_revision,consent_revision,previous_revision,opted_in,disclosure_version)
        VALUES('${id}','${owner}','en',${version},'${revision}','${'b'.repeat(64)}','${'c'.repeat(64)}','${'0'.repeat(64)}',true,'synthetic-dubbing-v1')`);
      for(const idSegment of [segment,deletedSegment]) {
        const created=await db.client.rpc('memory_video_segments_execute',{p_command:{contractVersion:1,operation:'create',ownerId:owner,memoryId:memory,itemId:item,
          source:{assetId:id,assetVersion:version,durationMs:10000,storageBucket:'post-media',storagePath:s.path,itemMediaUrl:mediaRef(s.path)},
          segment:{operationId:idSegment,assetId:id,assetVersion:version,startMs:1200,endMs:3400,label}}});
        assert.equal(created.error,null);assert.equal(created.data?.ok,true,JSON.stringify(created));
      }
      assert.equal((await db.client.rpc('memory_video_segments_execute',{p_command:{contractVersion:1,operation:'delete',ownerId:owner,memoryId:memory,itemId:item,segmentId:deletedSegment}})).data?.deleted,true);
    });
    const admin=(await db.seedUser('authored-review-admin')).id;await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'`);
    assert.equal((await db.client.rpc('withdraw_postcard_media',{p_actor:owner,p_post:r.s.post,p_media:r.s.media,p_expected_moderation:'pending'})).data,true);
    return {...r,admin,memory,item,segment,deletedSegment,revision,sourceVersion:version,captionPath,captionBytes};
  }

  it('atomic restoration moves canonical and source rows together and preserves current post privacy',async()=>{
    const r=await restorationSource();
    await db.exec(`UPDATE posts SET visibility='private',media_urls=ARRAY['post-media/${r.s.path}','https://example.invalid/other.jpg'] WHERE id='${r.s.post}'`);
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.restorePath=reservation.destinationPath;const copied=await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);
      const objects=[{receiptId:copied.id,path:reservation.destinationPath,objectId:copied.objectId,objectVersion:copied.objectVersion,sha256:copied.sha256,size:copied.size}];
      const args={p_actor:r.admin,p_asset:r.id,p_generation:r.generation,p_reservation:reservation.id,p_objects:objects};
      const result=await db.client.rpc('activate_media_restoration',args);assert.equal(result.error,null,JSON.stringify(result));assert.equal(result.data?.ok,true,JSON.stringify(result));
      const asset=(await db.query(`SELECT * FROM media_assets WHERE id='${r.id}'`))[0];
      assert.equal(asset.storage_path,reservation.destinationPath);assert.equal(asset.version,reservation.assetVersion+1);
      assert.equal(asset.deleted_at,null);assert.equal(asset.purge_status,'not_requested');assert.equal(asset.recovery_generation,null);
      const source=(await db.query(`SELECT * FROM post_media WHERE id='${r.s.media}'`))[0];
      assert.equal(source.storage_path,reservation.destinationPath);assert.equal(source.deleted_at,null);assert.equal(source.recovery_snapshot,null);
      const post=(await db.query(`SELECT visibility,media_urls FROM posts WHERE id='${r.s.post}'`))[0];
      assert.equal(post.visibility,'private');assert.deepEqual(post.media_urls,[`post-media/${reservation.destinationPath}`,'https://example.invalid/other.jpg']);
      assert.deepEqual((await db.client.rpc('activate_media_restoration',args)).data,result.data);
      assert.equal((await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_activated'`)).length,1);
      assert.equal((await db.query(`SELECT version FROM media_assets WHERE id='${r.id}'`))[0].version,asset.version);
      assert.ok(state.objects.has(reservation.retainedPath));assert.equal(state.objects.has(r.s.path),false);
    });
  });
  type ActivationState=Parameters<Parameters<typeof withCopyStorage>[1]>[0];
  async function withAuthoredActivation(run:(r:Awaited<ReturnType<typeof authoredRestorationSource>>,reservation:Awaited<ReturnType<typeof prepareRetainedMediaRestoration>>,state:ActivationState)=>Promise<void>) {
    const r=await authoredRestorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.objects.set(r.captionPath,{id:randomUUID(),version:randomUUID(),bytes:r.captionBytes});
      await stageMediaRestorationCaption(db.client,r.admin,r.id,r.generation,reservation.id);
      state.restorePath=reservation.destinationPath;await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);
      await run(r,reservation,state);
    });
  }
  async function activationSqlArgs(r:{id:string;generation:string;admin:string},reservation:Awaited<ReturnType<typeof prepareRetainedMediaRestoration>>) {
    const rows=await db.query<{id:string;details:{destinationPath?:string;objectId:string;objectVersion:string;sha256:string;size:number}}>(`SELECT id,details FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND details->>'reservationId'='${reservation.id}' AND event_type IN ('restoration_copied','restoration_dependency_copied','restoration_caption_written')`);
    const objects=rows.map(row=>({receiptId:row.id,path:row.details.destinationPath??reservation.destinationPath,objectId:row.details.objectId,objectVersion:row.details.objectVersion,sha256:row.details.sha256,size:row.details.size})).sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
    return [r.admin,r.id,r.generation,reservation.id,JSON.stringify(objects)];
  }
  it('atomic authored activation rebinds captions and existing Memory selections without reviving tombstones or consent',async()=>{
    await withAuthoredActivation(async(r,reservation,state)=>{
      const before=await db.query<{id:string;asset_version:number;[key:string]:unknown}>(`SELECT * FROM memory_video_segments WHERE asset_id='${r.id}' ORDER BY id`);
      const receipt=await activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id);
      assert.equal(receipt.version,reservation.assetVersion+1);
      const segments=await db.query(`SELECT * FROM memory_video_segments WHERE asset_id='${r.id}' ORDER BY id`);
      assert.deepEqual(segments,before.map(segment=>({...segment,asset_version:receipt.version})));
      assert.equal(segments.some(segment=>segment.id===r.deletedSegment),false);
      assert.equal((await db.query(`SELECT media_url FROM memory_items WHERE id='${r.item}'`))[0].media_url,`post-media/${reservation.destinationPath}`);
      assert.equal((await db.query(`SELECT visibility FROM memories WHERE id='${r.memory}'`))[0].visibility,'only_me');
      const manifest=(await db.query<{source_version:number;object_path:string}>(`SELECT source_version,object_path FROM media_caption_manifests WHERE asset_id='${r.id}'`))[0];
      assert.equal(manifest.source_version,receipt.version);assert.notEqual(manifest.object_path,r.captionPath);
      const caption=JSON.parse(Buffer.from(state.objects.get(manifest.object_path)!.bytes).toString('utf8'));
      assert.equal(caption.source.version,receipt.version);assert.equal(caption.source.storage_path,reservation.destinationPath);
      assert.deepEqual(caption.tracks,JSON.parse(Buffer.from(r.captionBytes).toString('utf8')).tracks);
      assert.equal((await db.query(`SELECT opted_in FROM media_dubbing_consents WHERE asset_id='${r.id}'`))[0].opted_in,false);
      assert.deepEqual(await activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id),receipt);
      assert.equal(state.uploads,1);assert.equal(state.copies,2);
      await assert.rejects(db.exec(`UPDATE media_assets SET storage_path='${owner}/reused.jpg' WHERE id='${r.id}'`),/restored_media_identity_requires_activation/);
      assert.equal((await db.query(`SELECT media_retention_transfer_settled('${r.id}','${r.generation}') AS settled`))[0].settled,true);
    });
  });
  for(const fault of ['source','caption','segment','audit','version'] as const) it(`${fault} failure rolls back the entire restoration and retries the same command`,async()=>{
    await withAuthoredActivation(async(r,reservation)=>{
      const snapshot=()=>db.query(`SELECT (SELECT to_jsonb(a) FROM media_assets a WHERE id='${r.id}') AS asset,(SELECT to_jsonb(s) FROM post_media s WHERE id='${r.s.media}') AS source,(SELECT to_jsonb(c) FROM media_caption_manifests c WHERE asset_id='${r.id}') AS caption,(SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM memory_video_segments v WHERE asset_id='${r.id}') AS segments,(SELECT to_jsonb(i) FROM memory_items i WHERE id='${r.item}') AS item`);
      const before=await snapshot();
      const table=fault==='source'?'post_media':fault==='caption'?'media_caption_manifests':fault==='segment'?'memory_video_segments':fault==='audit'?'media_asset_lifecycle_events':'media_assets';
      const operation=['caption','audit'].includes(fault)?'INSERT':'UPDATE';
      const condition=fault==='source'?"OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL":fault==='audit'?"NEW.event_type='restoration_activated'":fault==='version'?"OLD.purge_status='retained' AND NEW.purge_status='not_requested'":'true';
      const body=fault==='version'?'NEW.version:=NEW.version+1; RETURN NEW;':"RAISE EXCEPTION 'synthetic activation failure';";
      await db.exec(`CREATE FUNCTION public.test_activation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$; CREATE TRIGGER zz_test_activation_failure BEFORE ${operation} ON ${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION public.test_activation_failure()`);
      try {await assert.rejects(activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id),/activation unconfirmed/);}
      finally {await db.exec(`DROP TRIGGER zz_test_activation_failure ON ${table}; DROP FUNCTION public.test_activation_failure()`);}
      assert.deepEqual(await snapshot(),before);
      assert.equal((await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_activated'`)).length,0);
      assert.equal((await activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id)).version,reservation.assetVersion+1);
    });
  });
  for(const fault of ['missing','bytes','identity'] as const) it(`${fault} destination prevents activation before metadata changes`,async()=>{
    await withAuthoredActivation(async(r,reservation,state)=>{
      if(fault==='missing')state.objects.delete(reservation.destinationPath);
      if(fault==='bytes')state.objects.get(reservation.destinationPath)!.bytes[0]^=1;
      if(fault==='identity')state.objects.get(reservation.destinationPath)!.version=randomUUID();
      await assert.rejects(activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id),/identity unavailable|bytes changed|identity changed|changed during verification/);
      assert.equal((await assets(r.s))[0].purge_status,'retained');
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_activated').length,0);
    });
  });
  it('activation rejects missing object proofs and a revoked admin before any metadata changes',async()=>{
    await withAuthoredActivation(async(r,reservation)=>{
      const args={p_actor:r.admin,p_asset:r.id,p_generation:r.generation,p_reservation:reservation.id,p_objects:[]};
      const missing=await db.client.rpc('activate_media_restoration',args);
      assert.equal(missing.error,null);assert.equal(missing.data?.error,'restoration_objects_unverified');
      await db.exec(`UPDATE profiles SET role='user' WHERE id='${r.admin}'`);
      const revoked=await db.client.rpc('activate_media_restoration',args);
      assert.equal(revoked.error,null);assert.equal(revoked.data?.error,'admin_required');
      assert.equal((await assets(r.s))[0].purge_status,'retained');
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_activated').length,0);
    });
  });
  it('activation refuses a parent changed after review even when all physical copies are complete',async()=>{
    await withAuthoredActivation(async(r,reservation)=>{
      await db.exec(`UPDATE posts SET content='Changed after recovery review' WHERE id='${r.s.post}'`);
      await assert.rejects(activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id),/activation unconfirmed/);
      assert.equal((await assets(r.s))[0].purge_status,'retained');
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_activated').length,0);
    });
  });
  for(const format of ['bare','public','render','encoded','signed']) it(`activation refuses an unreviewed ${format} nonsegment Memory reference without rewriting it`,async()=>{
    await withAuthoredActivation(async(r,reservation)=>{
      const item=randomUUID(),origin=new URL(process.env.SUPABASE_URL!).origin;
      const url=format==='bare'?`post-media/${r.s.path}`:`${origin}/storage/v1/${format==='render'?'render/image':'object'}/${format==='signed'?'sign':'public'}/post-media/${format==='encoded'||format==='signed'?encodeURIComponent(r.s.path):r.s.path}${format==='signed'?'?token=expired':''}`;
      await db.exec(`INSERT INTO memory_items(id,memory_id,media_url,media_type) VALUES('${item}','${r.memory}',${lit(url)},'video/mp4')`);
      const before=await db.query(`SELECT * FROM memory_items WHERE id='${item}'`);
      await assert.rejects(activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id),/activation unconfirmed/);
      assert.deepEqual(await db.query(`SELECT * FROM memory_items WHERE id='${item}'`),before);
      assert.equal((await assets(r.s))[0].purge_status,'retained');
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_activated').length,0);
    });
  });

  it('restoration reference review fences a concurrent Memory insert and detects it after commit',{timeout:25_000},async()=>{
    await withAuthoredActivation(async(r,reservation)=>{
      const a=await connect(),b=await connect(),item=randomUUID();let insert:Promise<QueryResult>|undefined;
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');
        const result=await a.client.query('SELECT public.prepare_media_restoration($1,$2,$3,$4,$5) AS result',[r.admin,r.id,r.generation,reservation.reason,reservation.id]);
        assert.equal(result.rows[0].result.ok,true);
        insert=b.client.query('INSERT INTO memory_items(id,memory_id,media_url,media_type) VALUES($1,$2,$3,$4)',[item,r.memory,`${new URL(process.env.SUPABASE_URL!).origin}/storage/v1/object/sign/post-media/${encodeURIComponent(r.s.path)}?token=old`,'video/mp4']);void insert.catch(()=>{});
        await blocked(a.pid,b.pid);await a.client.query('COMMIT');await insert;
        await assert.rejects(activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id),/activation unconfirmed/);
        assert.equal((await assets(r.s))[0].purge_status,'retained');
        assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_activated').length,0);
      }finally{await a.client.query('ROLLBACK');await insert?.catch(()=>{});}
    });
  });
  it('restoration reference review refuses an active Memory writer without deadlocking or invalidating its receipt',{timeout:25_000},async()=>{
    await withAuthoredActivation(async(r,reservation)=>{
      const a=await connect(),before=await audit(r.s);
      try {
        await a.client.query('BEGIN');await a.client.query('SELECT id FROM memories WHERE id=$1 FOR UPDATE',[r.memory]);
        const result=await db.client.rpc('prepare_media_restoration',{...restorationArgs(r),p_reason:reservation.reason,p_reservation:reservation.id});
        assert.equal(result.error,null);assert.equal(result.data?.error,'restoration_memory_review_busy');assert.deepEqual(await audit(r.s),before);
      }finally{await a.client.query('ROLLBACK');}
      await activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id);
      assert.equal((await db.query(`SELECT purge_status FROM media_assets WHERE id='${r.id}'`))[0].purge_status,'not_requested');
    });
  });
  it('unbound reference snapshots stay inside the authorized private Memory boundary',async()=>{
    const r=await restorationSource();
    for(const signature of ['public.memory_unbound_reference_snapshot(uuid,uuid,uuid,integer)','memory_video_segments_private.unbound_reference_snapshot(uuid,uuid,uuid,integer)']) {
      for(const role of ['anon','authenticated'])assert.equal((await db.query(`SELECT has_function_privilege('${role}',${lit(signature)},'EXECUTE') AS allowed`))[0].allowed,false);
    }
    assert.equal((await db.query("SELECT has_table_privilege('service_role','memory_video_segment_operations','SELECT') AS allowed"))[0].allowed,false);
    const denied=await db.client.rpc('memory_unbound_reference_snapshot',{p_actor:owner,p_asset:r.id});assert.equal(denied.error,null);assert.equal(denied.data,null);
    const allowed=await db.client.rpc('memory_unbound_reference_snapshot',{p_actor:r.admin,p_asset:r.id});assert.equal(allowed.error,null);assert.equal(allowed.data?.ownerId,owner);
  });
  it('activation authority is service-only and exact transition receipts expire with their transaction',async()=>{
    for(const signature of ['public.activate_media_restoration(uuid,uuid,uuid,uuid,jsonb)','media_recovery_private.transition_allowed(text,jsonb,jsonb)',
      'memory_video_segments_private.restoration_item_changes(uuid,uuid,text)','memory_video_segments_private.rebind_restored(uuid,uuid,integer)']) {
      const rights=await db.query<{allowed:boolean}>(`SELECT has_function_privilege(role,${lit(signature)},'EXECUTE') AS allowed FROM (VALUES('anon'),('authenticated')) r(role)`);
      assert.ok(rights.every(row=>!row.allowed),signature);
    }
    await withAuthoredActivation(async(r,reservation)=>{
      const before=(await db.query(`SELECT to_jsonb(a) AS value FROM media_assets a WHERE id='${r.id}'`))[0].value;
      await activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id);
      const after=(await db.query(`SELECT to_jsonb(a) AS value FROM media_assets a WHERE id='${r.id}'`))[0].value;
      const [{allowed}]=await db.query<{allowed:boolean}>(`SELECT media_recovery_private.transition_allowed('media_assets',${lit(JSON.stringify(before))}::jsonb,${lit(JSON.stringify(after))}::jsonb) AS allowed`);
      assert.equal(allowed,false,'Committed receipt must not authorize another transaction');
    });
  });
  async function newItemMemory() {
    const id=randomUUID();
    await db.exec(`INSERT INTO memories(id,owner_id,title,visibility,state) VALUES('${id}','${owner}','Writer proof','only_me','published')`);
    return id;
  }
  async function addBoundItem(memory:string,write:Record<string,unknown>,key=randomUUID(),sc=db.client) {
    return dispatchMemoryCommand<Record<string,unknown>>({sc,commandType:'ADD_MEDIA',actorUserId:owner,memoryId:memory,
      idempotencyKey:key,payload:{write:{memory_id:memory,...write}}});
  }
  for(const kernel of [false,true]) {
    for(const format of ['bare','public','render','encoded'] as const) it(`Memory item writer binds ${format} source atomically with kernel ${kernel}`,async()=>{
      await db.setFlag('memory_kernel_enabled',kernel);
      const s=await source(),asset=await recordMediaAssetDetailed(db.client,s.input),memory=await newItemMemory();
      assert.ok(asset.assetId);
      const url=format==='bare'?`post-media/${s.path}`:
        `${process.env.SUPABASE_URL}/storage/v1/${format==='render'?'render/image':'object'}/public/post-media/${format==='encoded'?encodeURIComponent(s.path):s.path}`;
      await db.exec(`UPDATE posts SET media_urls=ARRAY[${lit(url)}] WHERE id='${s.post}'`);
      const result=await addBoundItem(memory,{media_url:url,caption:'Original caption',position:4,source_post_id:s.post});
      assert.equal(result.ok,true,JSON.stringify(result));if(!result.ok)return;
      assert.equal(result.duplicate,false);
      const items=await db.query(`SELECT * FROM memory_items WHERE memory_id='${memory}'`);
      assert.equal(items.length,1);assert.equal(items[0].media_asset_id,asset.assetId);assert.equal(items[0].media_url,url);
      assert.equal(items[0].caption,'Original caption');assert.equal(items[0].source_post_id,s.post);assert.equal(items[0].position,4);
      assert.equal((await db.query(`SELECT event_id FROM memory_domain_events WHERE memory_id='${memory}'`)).length,kernel?1:0);
    });
    it(`Memory item writer replays without a second row after source retirement with kernel ${kernel}`,async()=>{
      await db.setFlag('memory_kernel_enabled',kernel);
      const s=await source(),asset=await recordMediaAssetDetailed(db.client,s.input),memory=await newItemMemory(),key=randomUUID();
      const write={media_url:`post-media/${s.path}`,caption:'Stable original'};
      const first=await addBoundItem(memory,write,key);assert.equal(first.ok,true,JSON.stringify(first));if(!first.ok)return;
      await db.exec(`SELECT cancel_postcard_draft('${owner}','${s.post}')`);
      const second=await addBoundItem(memory,write,key);assert.equal(second.ok,true,JSON.stringify(second));if(!second.ok)return;
      assert.equal(second.duplicate,true);assert.deepEqual(second.body,first.body);
      assert.deepEqual(await db.query(`SELECT id,media_asset_id FROM memory_items WHERE memory_id='${memory}'`),[{id:first.body.id,media_asset_id:asset.assetId}]);
      assert.equal((await db.query(`SELECT event_id FROM memory_domain_events WHERE memory_id='${memory}'`)).length,kernel?1:0);
    });
    it(`Memory item writer refuses missing retired foreign and mismatched canonical sources with kernel ${kernel}`,async()=>{
      await db.setFlag('memory_kernel_enabled',kernel);
      const s=await source(),asset=await recordMediaAssetDetailed(db.client,s.input),memory=await newItemMemory();assert.ok(asset.assetId);
      const other=await db.seedUser('foreign-item-source'),foreign=await source(false,false,{owner:other.id});
      assert.ok((await recordMediaAssetDetailed(db.client,foreign.input)).assetId);
      for(const write of [{media_url:`post-media/${owner}/missing.jpg`},{media_url:`post-media/${foreign.path}`},
        {media_url:`post-media/${s.path}`,expected_asset_id:randomUUID()}]) {
        assert.equal((await addBoundItem(memory,write)).ok,false);
      }
      await db.exec(`SELECT cancel_postcard_draft('${owner}','${s.post}')`);
      assert.equal((await addBoundItem(memory,{media_url:`post-media/${s.path}`})).ok,false);
      assert.deepEqual(await db.query(`SELECT id FROM memory_items WHERE memory_id='${memory}'`),[]);
    });
    it(`Memory item writer preserves external HTTPS policy and discards supplied binding proof with kernel ${kernel}`,async()=>{
      await db.setFlag('memory_kernel_enabled',kernel);
      const s=await source(),asset=await recordMediaAssetDetailed(db.client,s.input),memory=await newItemMemory();assert.ok(asset.assetId);
      const result=await addBoundItem(memory,{media_url:'https://external.invalid/photo.jpg',source_ref:{bucket:'post-media',path:s.path},media_asset_id:asset.assetId});
      assert.equal(result.ok,true,JSON.stringify(result));
      assert.deepEqual(await db.query(`SELECT media_url,media_asset_id FROM memory_items WHERE memory_id='${memory}'`),[{media_url:'https://external.invalid/photo.jpg',media_asset_id:null}]);
    });
    it(`Memory item writer preserves candidate identity and expected asset with kernel ${kernel}`,async()=>{
      await db.setFlag('memory_kernel_enabled',kernel);
      const s=await source(),asset=await recordMediaAssetDetailed(db.client,s.input),memory=await newItemMemory(),item=randomUUID();assert.ok(asset.assetId);
      const result=await addBoundItem(memory,{id:item,media_url:`post-media/${s.path}`,expected_asset_id:asset.assetId});
      assert.equal(result.ok,true,JSON.stringify(result));
      assert.deepEqual(await db.query(`SELECT id,media_asset_id FROM memory_items WHERE memory_id='${memory}'`),[{id:item,media_asset_id:asset.assetId}]);
      assert.equal((await addBoundItem(memory,{id:item,media_url:`post-media/${s.path}`,expected_asset_id:randomUUID()})).ok,false,'An existing candidate item cannot acknowledge a different canonical source');
    });
  }
  it('Memory item writer rolls back its canonical binding when the kernel audit fails',async()=>{
    await db.setFlag('memory_kernel_enabled',true);
    const s=await source(),asset=await recordMediaAssetDetailed(db.client,s.input),memory=await newItemMemory();assert.ok(asset.assetId);
    await db.exec(`CREATE FUNCTION test_item_writer_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic item audit failure'; END $$;
      CREATE TRIGGER test_item_writer_audit_failure BEFORE INSERT ON memory_command_audit FOR EACH ROW WHEN (NEW.memory_id='${memory}') EXECUTE FUNCTION test_item_writer_audit_failure()`);
    try {
      assert.equal((await addBoundItem(memory,{media_url:`post-media/${s.path}`})).ok,false);
      for(const table of ['memory_items','memory_domain_events','memory_command_receipts'])assert.deepEqual(await db.query(`SELECT * FROM ${table} WHERE memory_id='${memory}'`),[]);
    }finally{await db.exec('DROP TRIGGER test_item_writer_audit_failure ON memory_command_audit; DROP FUNCTION test_item_writer_audit_failure()');}
  });
  it('Memory item writer readiness refuses disabled guards and direct client execution',async()=>{
    for(const fn of ['memory_item_source_ready()','insert_memory_media_item(uuid,uuid,jsonb)']) {
      const rights=await db.query<{allowed:boolean}>(`SELECT has_function_privilege(role,${lit(fn)},'EXECUTE') AS allowed FROM (VALUES('anon'),('authenticated')) r(role)`);
      assert.ok(rights.every(r=>!r.allowed));
    }
    const memory=await newItemMemory();assert.equal((await db.client.rpc('memory_item_source_ready')).data,true);
    await db.exec('ALTER TABLE memory_items DISABLE TRIGGER memory_items_media_binding_guard');
    try {
      assert.equal((await db.client.rpc('memory_item_source_ready')).data,false);
      const result=await addBoundItem(memory,{media_url:'https://external.invalid/photo.jpg'});
      assert.equal(result.ok,false);if(!result.ok&&'http' in result)assert.equal(result.http.code,'degraded_unavailable');
      assert.deepEqual(await db.query(`SELECT id FROM memory_items WHERE memory_id='${memory}'`),[]);
    }finally{await db.exec('ALTER TABLE memory_items ENABLE TRIGGER memory_items_media_binding_guard');}
    assert.equal((await db.client.rpc('memory_item_source_ready')).data,true);
  });
  for(const first of ['insert','retire'] as const) it(`Memory item writer serializes ${first} before the competing source operation`,{timeout:25_000},async()=>{
    const s=await source(),asset=await recordMediaAssetDetailed(db.client,s.input),memory=await newItemMemory(),a=await connect(),b=await connect();assert.ok(asset.assetId);
    const write=prepareMemoryItemWrite({media_url:`post-media/${s.path}`}),args=[owner,memory,JSON.stringify(write)];
    const insert='SELECT insert_memory_media_item($1,$2,$3::jsonb)';let pending:Promise<QueryResult>|undefined;
    try {
      await a.client.query('BEGIN; SET LOCAL ROLE service_role');
      if(first==='insert') {
        await a.client.query(insert,args);pending=withdraw(b.client,s,'cancel');void pending.catch(()=>{});
        await blocked(a.pid,b.pid);await a.client.query('COMMIT');await pending;
        assert.equal((await db.query(`SELECT id FROM memory_items WHERE memory_id='${memory}'`)).length,1);
      }else{
        await withdraw(a.client,s,'cancel');await a.client.query('SET CONSTRAINTS ALL IMMEDIATE');pending=b.client.query(insert,args);void pending.catch(()=>{});
        await Promise.race([blocked(a.pid,b.pid),pending.then(()=>{throw new Error('Competing insert completed before retirement committed');})]);await a.client.query('COMMIT');await assert.rejects(pending,/memory_media_source_unavailable/);
        assert.deepEqual(await db.query(`SELECT id FROM memory_items WHERE memory_id='${memory}'`),[]);
      }
      assert.equal((await assets(s))[0].purge_status,'retained');
    }finally{await a.client.query('ROLLBACK');await pending?.catch(()=>{});}
  });
  async function withMemoryItemRestoration(run:(r:Awaited<ReturnType<typeof restorationSource>> & {memory:string;item:string},state:ActivationState)=>Promise<void>,
    options:{reference?:(path:string)=>string;foreignOwner?:boolean;sourcePost?:boolean}={}) {
    const r=await restorationSource(),memory=randomUUID(),item=randomUUID();
    const memoryOwner=options.foreignOwner?(await db.seedUser('other-memory-owner')).id:owner;
    if(options.sourcePost)await db.exec(`UPDATE posts SET media_urls=ARRAY[${lit(options.reference?.(r.s.path)??`post-media/${r.s.path}`)}] WHERE id='${r.s.post}'`);
    await db.exec(`INSERT INTO memories(id,owner_id,title,visibility,state) VALUES('${memory}','${memoryOwner}','Ordinary Memory photo','only_me','published');
      INSERT INTO memory_items(id,memory_id,media_url,media_type,caption,position,visibility,source_post_id)
        VALUES('${item}','${memory}',${lit(options.reference?.(r.s.path)??`post-media/${r.s.path}`)},'image/jpeg','Keep my caption',3,'only_me',${options.sourcePost?lit(r.s.post):'NULL'})`);
    await withCopyStorage(r,async state=>{await settleRestorationOriginal(r,state);await run({...r,memory,item},state);});
  }
  const bindingArgs=(r:{admin:string;item:string;id:string;s:Source})=>({p_actor:r.admin,p_item:r.item,p_asset:r.id,p_url:`post-media/${r.s.path}`,p_bucket:'post-media',p_path:r.s.path,p_reason:'Reviewed historical Memory source'});
  for(const sourcePost of [false,true]) it(`ordinary Memory recovery preserves a bound image${sourcePost?' and its source post':''}`,async()=>{
    await withMemoryItemRestoration(async(r,state)=>{
      assert.deepEqual(await reconcileMemoryMediaBinding(db.client,r.admin,r.item,r.id,'Reviewed historical Memory source'),{itemId:r.item,assetId:r.id,alreadyBound:false});
      assert.equal((await reconcileMemoryMediaBinding(db.client,r.admin,r.item,r.id,'Reviewed historical Memory source')).alreadyBound,true);
      assert.equal((await db.query(`SELECT id FROM moderation_actions WHERE action_type='memory_media_source_bound' AND metadata->>'item_id'='${r.item}'`)).length,1);
      const before=(await db.query(`SELECT * FROM memory_items WHERE id='${r.item}'`))[0];
      const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      assert.equal(reservation.authored.memoryItems.length,1);assert.equal(reservation.authored.memoryBindings.length,0);
      state.restorePath=reservation.destinationPath;await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);
      const receipt=await activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id);
      assert.deepEqual((await db.query(`SELECT * FROM memory_items WHERE id='${r.item}'`))[0],{...before,media_url:`post-media/${receipt.destinationPath}`});
      assert.equal((await db.query(`SELECT visibility FROM memories WHERE id='${r.memory}'`))[0].visibility,'only_me');
      assert.equal((await db.query(`SELECT count(*) AS count FROM memory_video_segments WHERE item_id='${r.item}'`))[0].count,'0');
    },{sourcePost});
  });
  for(const format of ['public','render','encoded','signed']) it(`Memory binding reconciles an existing ${format} Storage reference`,async()=>{
    await withMemoryItemRestoration(async(r,state)=>{
      await assert.rejects(prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration'),/requires reconciliation/);
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_prepared').length,0);
      await reconcileMemoryMediaBinding(db.client,r.admin,r.item,r.id,'Reviewed historical Memory source');
      const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      assert.equal(reservation.authored.memoryItems[0].itemId,r.item);
      state.restorePath=reservation.destinationPath;await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);
      await activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id);
      assert.equal((await db.query(`SELECT media_asset_id FROM memory_items WHERE id='${r.item}'`))[0].media_asset_id,r.id);
    },{reference:path=>`${new URL(process.env.SUPABASE_URL!).origin}/storage/v1/${format==='render'?'render/image':'object'}/${format==='signed'?'sign':'public'}/post-media/${format==='encoded'||format==='signed'?encodeURIComponent(path):path}${format==='signed'?'?token=expired-review-token':''}`});
  });
  for(const fault of ['foreign-origin','different-path','different-bucket']) it(`Memory binding refuses ${fault} provenance without writing an audit or reference`,async()=>{
    await withMemoryItemRestoration(async(r)=>{
      await assert.rejects(reconcileMemoryMediaBinding(db.client,r.admin,r.item,r.id,'Reviewed source'),/binding source invalid/);
      assert.equal((await db.query(`SELECT media_asset_id FROM memory_items WHERE id='${r.item}'`))[0].media_asset_id,null);
      assert.equal((await db.query(`SELECT id FROM moderation_actions WHERE action_type='memory_media_source_bound' AND metadata->>'item_id'='${r.item}'`)).length,0);
    },{reference:path=>fault==='foreign-origin'?`https://foreign.invalid/storage/v1/object/public/post-media/${path}`:fault==='different-path'?`post-media/${owner}/other.jpg`:`profile-media/${path}`});
  });
  it('Memory binding refuses a foreign owner even when the stored key matches',async()=>{
    await withMemoryItemRestoration(async(r)=>{
      const result=await db.client.rpc('reconcile_memory_media_binding',bindingArgs(r));
      assert.equal(result.error,null);assert.equal(result.data?.error,'memory_media_source_changed');
      assert.equal((await db.query(`SELECT media_asset_id FROM memory_items WHERE id='${r.item}'`))[0].media_asset_id,null);
    },{foreignOwner:true});
  });
  it('Memory binding requires admin authority and cannot be assigned directly or reused after a URL replacement',async()=>{
    await withMemoryItemRestoration(async(r)=>{
      assert.equal((await db.client.rpc('reconcile_memory_media_binding',{...bindingArgs(r),p_actor:owner})).data?.error,'admin_required');
      await assert.rejects(db.exec(`UPDATE memory_items SET media_asset_id='${r.id}' WHERE id='${r.item}'`),/memory_media_binding_requires_review/);
      await reconcileMemoryMediaBinding(db.client,r.admin,r.item,r.id,'Reviewed source');
      await db.exec(`UPDATE memory_items SET media_url='https://example.invalid/replacement.jpg' WHERE id='${r.item}'`);
      assert.equal((await db.query(`SELECT media_asset_id FROM memory_items WHERE id='${r.item}'`))[0].media_asset_id,null);
      await assert.rejects(db.exec(`UPDATE memory_items SET media_asset_id='${r.id}' WHERE id='${r.item}'`),/memory_media_binding_requires_review/);
      for(const role of ['anon','authenticated'])assert.equal((await db.query(`SELECT has_function_privilege('${role}','public.reconcile_memory_media_binding(uuid,uuid,uuid,text,text,text,text)','EXECUTE') AS allowed`))[0].allowed,false);
    });
  });
  it('Memory binding audit and reference roll back together, then retry once',async()=>{
    await withMemoryItemRestoration(async(r)=>{
      await db.exec(`CREATE FUNCTION public.test_memory_binding_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic binding audit failure'; END $$;
        CREATE TRIGGER test_memory_binding_audit_failure BEFORE INSERT ON moderation_actions FOR EACH ROW WHEN (NEW.action_type='memory_media_source_bound') EXECUTE FUNCTION public.test_memory_binding_audit_failure()`);
      try {await assert.rejects(reconcileMemoryMediaBinding(db.client,r.admin,r.item,r.id,'Reviewed source'),/binding unconfirmed/);}
      finally {await db.exec('DROP TRIGGER test_memory_binding_audit_failure ON moderation_actions; DROP FUNCTION public.test_memory_binding_audit_failure()');}
      assert.equal((await db.query(`SELECT media_asset_id FROM memory_items WHERE id='${r.item}'`))[0].media_asset_id,null);
      assert.equal((await reconcileMemoryMediaBinding(db.client,r.admin,r.item,r.id,'Reviewed source')).alreadyBound,false);
      assert.equal((await db.query(`SELECT id FROM moderation_actions WHERE action_type='memory_media_source_bound' AND metadata->>'item_id'='${r.item}'`)).length,1);
    });
  });
  it('Memory binding lost acknowledgement reconciles the same source without another audit',async()=>{
    await withMemoryItemRestoration(async(r)=>{
      const rpc=db.client.rpc;db.client.rpc=(async(name:string,args:Record<string,unknown>)=>{const result=await rpc.call(db.client,name,args);return name==='reconcile_memory_media_binding'?{data:null,error:{message:'lost binding acknowledgement'}}:result;}) as typeof rpc;
      try {await assert.rejects(reconcileMemoryMediaBinding(db.client,r.admin,r.item,r.id,'Reviewed source'),/binding unconfirmed/);}finally{db.client.rpc=rpc;}
      assert.equal((await reconcileMemoryMediaBinding(db.client,r.admin,r.item,r.id,'Reviewed source')).alreadyBound,true);
      assert.equal((await db.query(`SELECT id FROM moderation_actions WHERE action_type='memory_media_source_bound' AND metadata->>'item_id'='${r.item}'`)).length,1);
    });
  });
  for(const change of ['privacy','caption','source']) it(`bound Memory recovery refuses ${change} changed after review`,async()=>{
    await withMemoryItemRestoration(async(r,state)=>{
      await reconcileMemoryMediaBinding(db.client,r.admin,r.item,r.id,'Reviewed source');
      const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.restorePath=reservation.destinationPath;await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);
      if(change==='privacy')await db.exec(`UPDATE memories SET visibility='friends_only' WHERE id='${r.memory}'`);
      if(change==='caption')await db.exec(`UPDATE memory_items SET caption='Changed after review' WHERE id='${r.item}'`);
      if(change==='source')await db.exec(`UPDATE memory_items SET media_url='https://example.invalid/another.jpg' WHERE id='${r.item}'`);
      const before=await db.query(`SELECT * FROM memory_items WHERE id='${r.item}'`);
      await assert.rejects(activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id),/activation unconfirmed/);
      assert.deepEqual(await db.query(`SELECT * FROM memory_items WHERE id='${r.item}'`),before);
      assert.equal((await assets(r.s))[0].purge_status,'retained');
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_activated').length,0);
    });
  });
  it('Memory binding permits same-owner reparenting but never transfers a source to another owner',async()=>{
    await withMemoryItemRestoration(async(r)=>{
      await reconcileMemoryMediaBinding(db.client,r.admin,r.item,r.id,'Reviewed source');
      const same=randomUUID(),foreign=randomUUID(),other=(await db.seedUser('foreign-memory-parent')).id;
      await db.exec(`INSERT INTO memories(id,owner_id,title,visibility,state) VALUES('${same}','${owner}','Same owner','only_me','published'),('${foreign}','${other}','Foreign owner','only_me','published');
        UPDATE memory_items SET memory_id='${same}' WHERE id='${r.item}'`);
      assert.equal((await db.query(`SELECT media_asset_id FROM memory_items WHERE id='${r.item}'`))[0].media_asset_id,r.id);
      await assert.rejects(db.exec(`UPDATE memory_items SET memory_id='${foreign}' WHERE id='${r.item}'`),/memory_media_binding_owner_changed/);
      assert.equal((await db.query(`SELECT memory_id FROM memory_items WHERE id='${r.item}'`))[0].memory_id,same);
    });
  });
  it('Memory binding readiness detects a disabled canonical reference guard',async()=>{
    assert.equal((await db.query('SELECT postcard_canonical_lifecycle_ready() AS ready'))[0].ready,true);
    await db.exec('BEGIN; ALTER TABLE memory_items DISABLE TRIGGER memory_items_media_binding_guard');
    try {assert.equal((await db.query('SELECT postcard_canonical_lifecycle_ready() AS ready'))[0].ready,false);}
    finally {await db.exec('ROLLBACK');}
    assert.equal((await db.query('SELECT postcard_canonical_lifecycle_ready() AS ready'))[0].ready,true);
  });
  for(const first of ['bind','edit'] as const) it(`Memory ${first} serializes source reconciliation with URL replacement`,{timeout:25_000},async()=>{
    await withMemoryItemRestoration(async(r)=>{
      const a=await connect(),b=await connect();let waiting:Promise<QueryResult>|undefined;
      const bind='SELECT reconcile_memory_media_binding($1,$2,$3,$4,$5,$6,$7) AS result',args=Object.values(bindingArgs(r));
      const edit=`UPDATE memory_items SET media_url='https://example.invalid/replacement.jpg' WHERE id='${r.item}'`;
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
        const initial=await a.client.query(first==='bind'?bind:edit,first==='bind'?args:[]);
        if(first==='bind')assert.equal(initial.rows[0].result.ok,true);else assert.equal(initial.rowCount,1);
        waiting=b.client.query(first==='bind'?edit:bind,first==='bind'?[]:args);void waiting.catch(()=>{});
        await blocked(a.pid,b.pid);await a.client.query('COMMIT');const result=await waiting;
        if(first==='bind')assert.equal(result.rowCount,1);else assert.equal(result.rows[0].result.error,'memory_media_source_changed');
        assert.equal((await db.query(`SELECT media_asset_id FROM memory_items WHERE id='${r.item}'`))[0].media_asset_id,null);
        assert.equal((await db.query(`SELECT id FROM moderation_actions WHERE action_type='memory_media_source_bound' AND metadata->>'item_id'='${r.item}'`)).length,first==='bind'?1:0);
      } finally {await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
    });
  });
  for(const first of ['bind','review'] as const) it(`Memory ${first} serializes source reconciliation with recovery review`,{timeout:25_000},async()=>{
    await withMemoryItemRestoration(async(r)=>{
      const a=await connect(),b=await connect();let waiting:Promise<QueryResult>|undefined;
      const bind='SELECT reconcile_memory_media_binding($1,$2,$3,$4,$5,$6,$7) AS result',bindArgs=Object.values(bindingArgs(r));
      const review='SELECT prepare_media_restoration($1,$2,$3,$4) AS result',reviewArgs=[r.admin,r.id,r.generation,'Reviewed restoration'];
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
        const initial=(await a.client.query(first==='bind'?bind:review,first==='bind'?bindArgs:reviewArgs)).rows[0].result;
        assert.equal(initial.ok,first==='bind');
        if(first==='review')assert.equal(initial.error,'restoration_memory_reference_review_changed');
        waiting=b.client.query(first==='bind'?review:bind,first==='bind'?reviewArgs:bindArgs);void waiting.catch(()=>{});
        await blocked(a.pid,b.pid);await a.client.query('COMMIT');const result=await waiting;
        assert.equal(result.rows[0].result.ok,first==='review');
        if(first==='bind')assert.equal(result.rows[0].result.error,'restoration_memory_reference_review_changed');
        const receipt=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
        assert.equal(receipt.authored.memoryItems[0].itemId,r.item);
      } finally {await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
    });
  });
  async function withPassportRestoration(run:(r:Awaited<ReturnType<typeof restorationSource>> & {passport:string},state:ActivationState)=>Promise<void>,
    options:{status?:string;reference?:(path:string)=>string;foreignOwner?:boolean;missing?:boolean}={}) {
    const r=await restorationSource(),passport=randomUUID();
    const passportOwner=options.foreignOwner?(await db.seedUser('other-passport-owner')).id:owner;
    if(!options.missing)await db.exec(`INSERT INTO passport_memories(id,user_id,title,status,visibility,photo_url,verification_level)
      VALUES('${passport}','${passportOwner}','Private trip memory',${lit(options.status??'active')},'private',${lit(options.reference?.(r.s.path)??`post-media/${r.s.path}`)},'unverified')`);
    await db.exec(`INSERT INTO media_attachments(media_asset_id,entity_type,entity_id,is_cover) VALUES('${r.id}','memory','${passport}',true)`);
    await withCopyStorage(r,async state=>{await settleRestorationOriginal(r,state);await run({...r,passport},state);});
  }
  for(const status of ['active','suggested','dismissed']) it(`Passport restoration preserves ${status} lifecycle, privacy and verification`,async()=>{
    await withPassportRestoration(async(r,state)=>{
      const before=(await db.query(`SELECT to_jsonb(p)-'updated_at' AS value FROM passport_memories p WHERE id='${r.passport}'`))[0].value as Record<string,unknown>;
      const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      assert.equal(reservation.authored.passportBindings.length,1);assert.equal(reservation.authored.passportBindings[0].id,r.passport);
      state.restorePath=reservation.destinationPath;await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);
      const receipt=await activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id);
      const after=(await db.query(`SELECT to_jsonb(p)-'updated_at' AS value FROM passport_memories p WHERE id='${r.passport}'`))[0].value;
      assert.deepEqual(after,{...before,photo_url:`post-media/${receipt.destinationPath}`});
      assert.deepEqual(await activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id),receipt);
      assert.equal((await db.query(`SELECT status FROM passport_memories WHERE id='${r.passport}'`))[0].status,status);
      await assert.rejects(db.exec(`SELECT media_recovery_private.rebind_passport('${r.id}','${reservation.id}')`),/restoration_passport_activation_required/);
      assert.ok((await db.query<{allowed:boolean}>(`SELECT has_function_privilege(role,'media_recovery_private.rebind_passport(uuid,uuid)','EXECUTE') AS allowed FROM (VALUES('anon'),('authenticated')) r(role)`)).every(row=>!row.allowed));
    },{status});
  });
  it('Passport shared references restore through one canonical activation and one physical copy',async()=>{
    await withPassportRestoration(async(r,state)=>{
      const second=randomUUID();
      await db.exec(`INSERT INTO passport_memories(id,user_id,title,status,visibility,photo_url) VALUES('${second}','${owner}','Another private reference','dismissed','private',${lit(`post-media/${r.s.path}`)});
        INSERT INTO media_attachments(media_asset_id,entity_type,entity_id) VALUES('${r.id}','memory','${second}')`);
      const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      assert.equal(reservation.authored.passportBindings.length,2);
      state.restorePath=reservation.destinationPath;await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);
      const receipt=await activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id);
      const parents=await db.query(`SELECT id,status,visibility,photo_url FROM passport_memories WHERE id IN ('${r.passport}','${second}')`);
      assert.equal(parents.length,2);assert.ok(parents.every(p=>p.photo_url===`post-media/${receipt.destinationPath}`&&p.visibility==='private'));
      assert.equal(parents.find(p=>p.id===second)?.status,'dismissed');assert.equal(state.copies,2,'one retention copy and one restoration copy');
      assert.equal((await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_activated'`)).length,1);
    });
  });
  for(const format of ['public','render','encoded']) it(`Passport restoration accepts existing ${format} storage references`,async()=>{
    await withPassportRestoration(async(r)=>{
      const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      assert.equal(reservation.authored.passportBindings[0].id,r.passport);
    },{reference:path=>`${new URL(process.env.SUPABASE_URL!).origin}/storage/v1/${format==='render'?'render/image':'object'}/public/post-media/${format==='encoded'?encodeURIComponent(path):path}`});
  });
  for(const fault of ['foreign-origin','different-path','different-bucket']) it(`Passport restoration refuses ${fault} provenance and permits abort`,async()=>{
    await withPassportRestoration(async(r,state)=>{
      await assert.rejects(prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration'),/Passport source invalid/);
      const reservation=(await audit(r.s)).find(e=>e.event_type==='restoration_prepared')!;assert.equal(typeof reservation.id,'string');
      await assert.rejects(copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,String(reservation.id)),/Passport source invalid/);
      await abortMediaRestoration(db.client,r.admin,r.id,r.generation,String(reservation.id),'Cancel invalid Passport source');
      assert.equal(state.copies,1);assert.equal((await assets(r.s))[0].purge_status,'retained');
    },{reference:path=>fault==='foreign-origin'?`https://foreign.invalid/storage/v1/object/public/post-media/${path}`:fault==='different-path'?`post-media/${owner}/other.jpg`:`profile-media/${path}`});
  });
  for(const fault of ['missing','foreign-owner']) it(`Passport restoration refuses a ${fault} canonical parent`,async()=>{
    await withPassportRestoration(async(r)=>{
      const result=await db.client.rpc('prepare_media_restoration',restorationArgs(r));
      assert.equal(result.error,null);assert.equal(result.data?.error,'restoration_passport_binding_unavailable');
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_prepared').length,0);
    },{missing:fault==='missing',foreignOwner:fault==='foreign-owner'});
  });
  for(const change of ["visibility='public'","status='dismissed'","photo_url='https://example.invalid/replaced.jpg'"]) it(`Passport restoration refuses a stale review after ${change}`,async()=>{
    await withPassportRestoration(async(r,state)=>{
      const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.restorePath=reservation.destinationPath;await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);
      await db.exec(`UPDATE passport_memories SET ${change} WHERE id='${r.passport}'`);
      const before=await db.query(`SELECT * FROM passport_memories WHERE id='${r.passport}'`);
      await assert.rejects(activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id),/activation unconfirmed/);
      assert.deepEqual(await db.query(`SELECT * FROM passport_memories WHERE id='${r.passport}'`),before);
      assert.equal((await assets(r.s))[0].purge_status,'retained');
    });
  });
  it('Passport rebind failure rolls back activation and retries the same reservation',async()=>{
    await withPassportRestoration(async(r,state)=>{
      const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.restorePath=reservation.destinationPath;await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);
      const before=await assets(r.s),parentBefore=await db.query(`SELECT * FROM passport_memories WHERE id='${r.passport}'`);
      await db.exec(`CREATE FUNCTION public.test_passport_rebind_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic Passport failure'; END $$;
        CREATE TRIGGER test_passport_rebind_failure BEFORE UPDATE ON passport_memories FOR EACH ROW WHEN (OLD.photo_url IS DISTINCT FROM NEW.photo_url) EXECUTE FUNCTION public.test_passport_rebind_failure()`);
      try {await assert.rejects(activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id),/activation unconfirmed/);}
      finally {await db.exec('DROP TRIGGER test_passport_rebind_failure ON passport_memories; DROP FUNCTION public.test_passport_rebind_failure()');}
      assert.deepEqual(await assets(r.s),before);assert.deepEqual(await db.query(`SELECT * FROM passport_memories WHERE id='${r.passport}'`),parentBefore);
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_activated').length,0);
      assert.equal((await activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id)).version,reservation.assetVersion+1);
    });
  });
  for(const first of ['review','change'] as const) it(`Passport ${first} serializes parent privacy with restoration review`,{timeout:25_000},async()=>{
    await withPassportRestoration(async(r)=>{
      const a=await connect(),b=await connect();let waiting:Promise<QueryResult>|undefined;
      const review='SELECT prepare_media_restoration($1,$2,$3,$4,NULL,$5::jsonb) AS result';
      const args=[r.admin,r.id,r.generation,'Reviewed restoration',JSON.stringify(await referenceReview(r))];
      const change=`UPDATE passport_memories SET visibility='public' WHERE id='${r.passport}'`;
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
        const initial=await a.client.query(first==='review'?review:change,first==='review'?args:[]);
        if(first==='review')assert.equal(initial.rows[0].result.ok,true);else assert.equal(initial.rowCount,1);
        waiting=b.client.query(first==='review'?change:review,first==='review'?[]:args);void waiting.catch(()=>{});
        await blocked(a.pid,b.pid);await a.client.query('COMMIT');const result=await waiting;
        if(first==='review') {
          assert.equal(result.rowCount,1);
          assert.equal((await db.client.rpc('prepare_media_restoration',restorationArgs(r))).data?.error,'restoration_review_changed');
        } else {
          assert.equal(result.rows[0].result.ok,true);
          const fingerprint=(await db.query(`SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') AS value FROM passport_memories p WHERE id='${r.passport}'`))[0].value;
          assert.equal(result.rows[0].result.receipt.authored.passportBindings[0].fingerprint,fingerprint);
        }
      } finally {await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
    });
  });
  for(const first of ['activation','change'] as const) it(`Passport ${first} serializes parent privacy with atomic activation`,{timeout:25_000},async()=>{
    await withPassportRestoration(async(r,state)=>{
      const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.restorePath=reservation.destinationPath;await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);
      const args=await activationSqlArgs(r,reservation),a=await connect(),b=await connect();let waiting:Promise<QueryResult>|undefined;
      const activate='SELECT activate_media_restoration($1,$2,$3,$4,$5::jsonb) AS result';
      const change=`UPDATE passport_memories SET visibility='public' WHERE id='${r.passport}'`;
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
        const initial=await a.client.query(first==='activation'?activate:change,first==='activation'?args:[]);
        if(first==='activation')assert.equal(initial.rows[0].result.ok,true);else assert.equal(initial.rowCount,1);
        waiting=b.client.query(first==='activation'?change:activate,first==='activation'?[]:args);void waiting.catch(()=>{});
        await blocked(a.pid,b.pid);await a.client.query('COMMIT');const result=await waiting;
        if(first==='activation')assert.equal(result.rowCount,1);else assert.equal(result.rows[0].result.error,'restoration_review_changed');
        const parent=(await db.query(`SELECT visibility,photo_url FROM passport_memories WHERE id='${r.passport}'`))[0];
        assert.equal(parent.visibility,'public');
        assert.equal(parent.photo_url,`post-media/${first==='activation'?reservation.destinationPath:r.s.path}`);
        assert.equal((await db.query(`SELECT purge_status FROM media_assets WHERE id='${r.id}'`))[0].purge_status,first==='activation'?'not_requested':'retained');
        assert.equal((await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_activated'`)).length,first==='activation'?1:0);
      } finally {await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
    });
  });
  it('activation reconciles a lost acknowledgement without incrementing the version again',async()=>{
    await withAuthoredActivation(async(r,reservation)=>{
      const rpc=db.client.rpc;db.client.rpc=(async(name:string,args:any)=>{const result=await rpc.call(db.client,name,args);return name==='activate_media_restoration'?{data:null,error:{message:'lost activation acknowledgement'}}:result;}) as typeof rpc;
      try {await assert.rejects(activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id),/activation unconfirmed/);}finally{db.client.rpc=rpc;}
      assert.equal((await activateMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id)).version,reservation.assetVersion+1);
      assert.equal((await db.query(`SELECT version FROM media_assets WHERE id='${r.id}'`))[0].version,reservation.assetVersion+1);
      assert.equal((await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_activated'`)).length,1);
    });
  });
  for(const first of ['activate','abort','competing-activation'] as const) it(`${first} serializes activation and cancellation on independent sessions`,{timeout:25_000},async()=>{
    await withAuthoredActivation(async(r,reservation)=>{
      const a=await connect(),b=await connect();let waiting:Promise<QueryResult>|undefined;
      const activate='SELECT activate_media_restoration($1,$2,$3,$4,$5::jsonb) AS result',args=await activationSqlArgs(r,reservation);
      const abort="SELECT cancel_media_restoration($1,$2,$3,$4,'Concurrent activation cancellation','request_abort') AS result",ids=args.slice(0,4);
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
        const initial=(await a.client.query(first==='abort'?abort:activate,first==='abort'?ids:args)).rows[0].result;assert.equal(initial.ok,true,JSON.stringify(initial));
        waiting=b.client.query(first==='activate'?abort:activate,first==='activate'?ids:args);void waiting.catch(()=>{});
        await blocked(a.pid,b.pid);await a.client.query('COMMIT');const result=(await waiting).rows[0].result;
        if(first==='activate')assert.equal(result.error,'retention_changed');
        else if(first==='abort')assert.equal(result.error,'restoration_aborting');
        else assert.deepEqual(result,initial);
      }finally{await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
    });
  });
  it('restoration review binds caption generation, revoked consent and authored Memory operations without republishing',async()=>{
    const r=await authoredRestorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);
      const before=await db.query(`SELECT * FROM memory_video_segments WHERE asset_id='${r.id}'`);
      const consents=await db.query(`SELECT * FROM media_dubbing_consents WHERE asset_id='${r.id}'`);assert.equal(consents[0].opted_in,false);
      const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      assert.equal(reservation.ownerId,owner);assert.equal(reservation.retiredVersion,r.sourceVersion);
      assert.equal(reservation.authored.caption?.object_path,r.captionPath);assert.equal(reservation.authored.caption?.source_version,r.sourceVersion);
      assert.equal(reservation.authored.memoryBindings.length,2);
      const live=reservation.authored.memoryBindings.find(b=>b.id===r.segment)!;
      assert.equal(live.segment?.label,'My selected moment');assert.equal(live.segment?.startMs,1200);assert.equal(live.segment?.endMs,3400);
      assert.equal(reservation.authored.memoryBindings.find(b=>b.id===r.deletedSegment)?.segment,null);
      assert.equal(reservation.authored.consents.dubbing[0]?.opted_in,false);
      assert.deepEqual(await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration'),reservation);
      assert.deepEqual(await db.query(`SELECT * FROM memory_video_segments WHERE asset_id='${r.id}'`),before);
      assert.deepEqual(await db.query(`SELECT * FROM media_dubbing_consents WHERE asset_id='${r.id}'`),consents);
      assert.equal((await assets(r.s))[0].purge_status,'retained');assert.equal(state.removes,1);
      for(const role of ['anon','authenticated'])assert.equal((await db.query(`SELECT has_function_privilege('${role}','memory_video_segments_private.review_retained(uuid,uuid,uuid)','EXECUTE') AS allowed`))[0].allowed,false);
      assert.equal((await db.query("SELECT has_table_privilege('service_role','memory_video_segments','SELECT') AS allowed"))[0].allowed,false);
      assert.equal((await db.query<{result:{error:string}}>(`SELECT memory_video_segments_private.review_retained('${owner}','${r.id}','${r.generation}') AS result`))[0].result.error,'admin_required');
      assert.equal((await db.query<{result:{error:string}}>(`SELECT memory_video_segments_private.review_retained('${r.admin}','${r.id}','${randomUUID()}') AS result`))[0].result.error,'retention_changed');
    });
  });
  for(const format of ['public','render','encoded'] as const) it(`authored recovery accepts existing ${format} Memory source URLs`,async()=>{
    const origin=new URL(process.env.SUPABASE_URL!).origin;
    const r=await authoredRestorationSource('Existing URL',false,path=>`${origin}/storage/v1/${format==='render'?'render/image':'object'}/public/post-media/${format==='encoded'?encodeURIComponent(path):path}?width=640`);
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);
      const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      assert.equal(reservation.authored.memoryBindings.find(b=>b.id===r.segment)?.segment?.label,'Existing URL');
      assert.match(reservation.authored.memoryBindings.find(b=>b.id===r.segment)!.itemMediaUrl!,/^http:/);
      assert.equal((await assets(r.s))[0].purge_status,'retained');
    });
  });
  for(const format of ['foreign-origin','different-path','different-bucket'] as const) it(`authored recovery refuses ${format} Memory source provenance`,async()=>{
    const origin=new URL(process.env.SUPABASE_URL!).origin;
    const r=await authoredRestorationSource('Wrong URL',false,path=>format==='foreign-origin'
      ?`https://foreign.invalid/storage/v1/object/public/post-media/${path}`
      :format==='different-path'?`post-media/${owner}/other.mp4`:`${origin}/storage/v1/object/public/profile-media/${path}`);
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);
      await assert.rejects(prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration'),/Memory source invalid/);
      const reservation=(await audit(r.s)).find(e=>e.event_type==='restoration_prepared')!;
      const reservationId=reservation.id;assert.ok(typeof reservationId==='string');
      await assert.rejects(copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservationId),/Memory source invalid/);
      await assert.rejects(verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,reservationId),/Memory source invalid/);
      await abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservationId,'Cancel invalid source provenance');
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_cancelled').length,1);
      assert.equal(state.copies,1);assert.equal((await assets(r.s))[0].purge_status,'retained');
    });
  });
  for(const change of ['insert','detach','visibility','relink'] as const) it(`attachment ${change} invalidates an existing recovery review`,async()=>{
    const r=await restorationSource(),attachment=randomUUID();
    await db.exec(`INSERT INTO media_attachments(id,media_asset_id,entity_type,entity_id) VALUES('${attachment}','${r.id}','post','${r.s.post}')`);
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);
      const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      assert.equal(reservation.authored.attachments.find(a=>a.id===attachment)?.entityId,r.s.post);
      if(change==='insert') {
        const passport=randomUUID();
        await db.exec(`INSERT INTO passport_memories(id,user_id,status,visibility,photo_url) VALUES('${passport}','${owner}','active','private',${lit(`post-media/${r.s.path}`)});
          INSERT INTO media_attachments(media_asset_id,entity_type,entity_id) VALUES('${r.id}','memory','${passport}')`);
      }
      if(change==='detach')await db.exec(`DELETE FROM media_attachments WHERE id='${attachment}'`);
      if(change==='visibility')await db.exec(`UPDATE media_attachments SET visibility_override='private' WHERE id='${attachment}'`);
      if(change==='relink')await db.exec(`UPDATE media_attachments SET entity_id='${randomUUID()}' WHERE id='${attachment}'`);
      assert.equal((await db.client.rpc('prepare_media_restoration',{...restorationArgs(r),p_reservation:reservation.id})).data?.error,'restoration_review_changed');
      await assert.rejects(copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id),/authority unconfirmed/);
      assert.equal(state.copies,1);assert.equal((await assets(r.s))[0].purge_status,'retained');
      await abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,'Cancel changed attachment review');
    });
  });
  for(const change of ['insert','detach','visibility'] as const) for(const first of ['review','change'] as const)
    it(`${first} serializes attachment ${change} with recovery review`,{timeout:25_000},async()=>{
      const r=await restorationSource(),attachment=randomUUID();
      if(change!=='insert')await db.exec(`INSERT INTO media_attachments(id,media_asset_id,entity_type,entity_id) VALUES('${attachment}','${r.id}','post','${r.s.post}')`);
      await withCopyStorage(r,async state=>{
        await settleRestorationOriginal(r,state);const a=await connect(),b=await connect();let waiting:Promise<QueryResult>|undefined;
        const review='SELECT prepare_media_restoration($1,$2,$3,$4,NULL,$5::jsonb) AS result';
        const mutation=change==='insert'?`INSERT INTO media_attachments(id,media_asset_id,entity_type,entity_id) VALUES('${attachment}','${r.id}','post','${r.s.post}')`
          :change==='detach'?`DELETE FROM media_attachments WHERE id='${attachment}'`:`UPDATE media_attachments SET visibility_override='private' WHERE id='${attachment}'`;
        const args=[r.admin,r.id,r.generation,'Reviewed restoration',JSON.stringify(await referenceReview(r))];
        try {
          await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
          const initial=await a.client.query(first==='review'?review:mutation,first==='review'?args:[]);
          if(first==='review')assert.equal(initial.rows[0].result.ok,true);else assert.equal(initial.rowCount,1);
          waiting=b.client.query(first==='review'?mutation:review,first==='review'?[]:args);void waiting.catch(()=>{});
          await blocked(a.pid,b.pid);await a.client.query('COMMIT');const result=await waiting;
          if(first==='review') {
            assert.equal(result.rowCount,1);
            assert.equal((await db.client.rpc('prepare_media_restoration',restorationArgs(r))).data?.error,'restoration_review_changed');
          } else {
            assert.equal(result.rows[0].result.ok,true);
            const binding=result.rows[0].result.receipt.authored.attachments.find((x:{id:string})=>x.id===attachment);
            if(change==='detach')assert.equal(binding,undefined);
            else {
              const rows=await db.query<{fingerprint:string}>(`SELECT encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex') AS fingerprint FROM media_attachments a WHERE id='${attachment}'`);
              assert.equal(binding.fingerprint,rows[0].fingerprint);
            }
          }
        } finally {await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
      });
    });
  it('authored review preserves the domain Unicode label limit without truncation',async()=>{
    const label='🌍'.repeat(160),r=await authoredRestorationSource(label);
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);
      const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      assert.equal(reservation.authored.memoryBindings.find(b=>b.id===r.segment)?.segment?.label,label);
    });
  });
  it('caption verification measures exact retained JSON and permits copy only after proof without granting consent',async()=>{
    const r=await authoredRestorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.objects.set(r.captionPath,{id:randomUUID(),version:randomUUID(),bytes:r.captionBytes});
      await assert.rejects(copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id),/authority unconfirmed/);
      assert.equal(state.copies,1);
      const proof=await verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,reservation.id);
      assert.equal(proof.authoredFingerprint,reservation.authoredFingerprint);
      assert.equal(proof.caption?.sourcePath,r.captionPath);assert.equal(proof.caption?.sourceVersion,r.sourceVersion);
      assert.equal(proof.caption?.sha256,createHash('sha256').update(r.captionBytes).digest('hex'));assert.equal(proof.caption?.size,r.captionBytes.length);
      assert.deepEqual(proof.caption?.tracks.map(t=>[t.language,t.sourceKind,t.revision]),[['en','manual',2],['fr','translation',1]]);
      assert.deepEqual(await verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,reservation.id),proof);
      state.restorePath=reservation.destinationPath;await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);
      assert.equal(state.objects.get(r.captionPath)!.bytes,r.captionBytes,'verification never rewrites the artifact');
      assert.equal((await db.query(`SELECT opted_in FROM media_dubbing_consents WHERE asset_id='${r.id}'`))[0].opted_in,false);
      assert.equal((await assets(r.s))[0].purge_status,'retained');assert.equal(state.removes,1);
    });
  });
  it('caption tombstone remains absent even when its previous artifact still exists',async()=>{
    const r=await authoredRestorationSource('My selected moment',true);
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);
      const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      assert.equal(reservation.authored.caption?.object_path,null);
      assert.equal(reservation.authored.caption?.revision_key,'d'.repeat(64));
      state.objects.set(r.captionPath,{id:randomUUID(),version:randomUUID(),bytes:r.captionBytes});
      state.beforeDownload=async path=>{assert.notEqual(path,r.captionPath,'an orphan must not replace the reviewed deletion marker');};
      const proof=await verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,reservation.id);
      assert.equal(proof.caption,null);
      const args={p_actor:r.admin,p_asset:r.id,p_generation:r.generation,p_reservation:reservation.id,p_objects:[]};
      assert.equal((await db.client.rpc('verify_media_restoration_dependencies',args)).data?.receipt.id,proof.id,'omitted proof and explicit null reconcile the same receipt');
      assert.equal((await db.client.rpc('verify_media_restoration_dependencies',{...args,p_caption:{sourcePath:r.captionPath}})).data?.error,'restoration_caption_invalid');
      state.restorePath=reservation.destinationPath;
      await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);
      assert.equal(state.objects.get(r.captionPath)!.bytes,r.captionBytes);
      assert.equal((await assets(r.s))[0].purge_status,'retained');
    });
  });
  for(const mode of ['normal','lost-response'] as const) it(`caption staging preserves authored tracks and reconciles ${mode} upload without publication`,async()=>{
    const r=await authoredRestorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.objects.set(r.captionPath,{id:randomUUID(),version:randomUUID(),bytes:r.captionBytes});state.uploadMode=mode;
      const manifest=await db.query(`SELECT * FROM media_caption_manifests WHERE asset_id='${r.id}'`);
      const receipt=await stageMediaRestorationCaption(db.client,r.admin,r.id,r.generation,reservation.id);
      const document=JSON.parse(Buffer.from(state.objects.get(receipt.destinationPath)!.bytes).toString('utf8'));
      assert.equal(document.source.version,reservation.assetVersion+1);assert.equal(document.source.storage_path,reservation.destinationPath);
      assert.deepEqual(document.tracks,JSON.parse(Buffer.from(r.captionBytes).toString('utf8')).tracks);
      assert.deepEqual(await stageMediaRestorationCaption(db.client,r.admin,r.id,r.generation,reservation.id),receipt);assert.equal(state.uploads,1);
      assert.deepEqual(await db.query(`SELECT * FROM media_caption_manifests WHERE asset_id='${r.id}'`),manifest);
      assert.equal((await db.query(`SELECT opted_in FROM media_dubbing_consents WHERE asset_id='${r.id}'`))[0].opted_in,false);
      assert.equal((await assets(r.s))[0].purge_status,'retained');assert.ok(state.objects.has(r.captionPath));
      state.purging=true;state.removeMode='normal';
      const cancelled=await abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,'Cancel staged captions');
      assert.ok(cancelled.paths.includes(receipt.destinationPath));assert.ok(!state.objects.has(receipt.destinationPath));assert.ok(state.objects.has(r.captionPath));
      assert.ok((await db.query<{path:string}>(`SELECT media_permanent_purge_paths('${r.id}') AS path`)).some(x=>x.path===receipt.destinationPath));
      assert.equal(state.uploads,1);
    });
  });
  for(const mode of ['pending','hung'] as const) it(`${mode} caption upload stays claimed until its exact file is observed`,async()=>{
    const r=await authoredRestorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.objects.set(r.captionPath,{id:randomUUID(),version:randomUUID(),bytes:r.captionBytes});state.uploadMode=mode;
      await assert.rejects(stageMediaRestorationCaption(db.client,r.admin,r.id,r.generation,reservation.id,{operationTimeoutMs:100,timeoutMs:500}),/identity unavailable|queue_timeout/);
      await assert.rejects(stageMediaRestorationCaption(db.client,r.admin,r.id,r.generation,reservation.id),/outcome unknown/);assert.equal(state.uploads,1);
      state.finishUpload();state.purging=true;state.removeMode='normal';
      const cancelled=await abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,'Abort settled caption transfer');
      assert.equal(cancelled.reservationId,reservation.id);assert.equal(state.uploads,1);assert.ok(state.objects.has(r.captionPath));
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_caption_written').length,1);
    });
  });
  for(const phase of ['caption_prepared','caption_started','caption_written'] as const) it(`lost ${phase} acknowledgement does not allocate or dispatch a replacement`,async()=>{
    const r=await authoredRestorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.objects.set(r.captionPath,{id:randomUUID(),version:randomUUID(),bytes:r.captionBytes});const rpc=db.client.rpc;
      db.client.rpc=(async(name:string,args:any)=>{const result=await rpc.call(db.client,name,args);return name==='advance_media_restoration_copy'&&args.p_phase===phase?{data:null,error:{message:'lost caption acknowledgement'}}:result;}) as typeof rpc;
      try {await assert.rejects(stageMediaRestorationCaption(db.client,r.admin,r.id,r.generation,reservation.id),/unconfirmed/);} finally {db.client.rpc=rpc;}
      if(phase==='caption_started') {
        await assert.rejects(stageMediaRestorationCaption(db.client,r.admin,r.id,r.generation,reservation.id),/outcome unknown/);assert.equal(state.uploads,0);
      } else {
        await stageMediaRestorationCaption(db.client,r.admin,r.id,r.generation,reservation.id);assert.equal(state.uploads,1);
      }
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_caption_prepared').length,1);
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_caption_started').length,1);
    });
  });
  it('corrupt staged caption bytes cannot be acknowledged or overwritten',async()=>{
    const r=await authoredRestorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.objects.set(r.captionPath,{id:randomUUID(),version:randomUUID(),bytes:r.captionBytes});state.uploadMode='corrupt';
      await assert.rejects(stageMediaRestorationCaption(db.client,r.admin,r.id,r.generation,reservation.id),/integrity mismatch/);
      await assert.rejects(stageMediaRestorationCaption(db.client,r.admin,r.id,r.generation,reservation.id),/integrity mismatch/);
      assert.equal(state.uploads,1);assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_caption_written').length,0);
    });
  });
  it('caption staging refuses a deletion marker without allocating a plan or upload',async()=>{
    const r=await authoredRestorationSource('Deleted caption',true);
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      await assert.rejects(stageMediaRestorationCaption(db.client,r.admin,r.id,r.generation,reservation.id),/caption unavailable/);
      assert.equal(state.uploads,0);assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_caption_prepared').length,0);
    });
  });
  it('an occupied caption destination cannot acquire an upload claim or be erased by abort',async()=>{
    const r=await authoredRestorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.objects.set(r.captionPath,{id:randomUUID(),version:randomUUID(),bytes:r.captionBytes});
      const revision=createHash('sha256').update(`restoration-caption:${reservation.id}`).digest('hex');
      const destination=`manual-captions/${r.id}/v${reservation.assetVersion+1}-${revision}.json`;
      const document=JSON.parse(Buffer.from(r.captionBytes).toString('utf8'));document.source={...reservation.authored.caption!.source,storage_path:reservation.destinationPath,version:reservation.assetVersion+1};
      state.objects.set(destination,{id:randomUUID(),version:randomUUID(),bytes:Buffer.from(JSON.stringify(document))});
      await assert.rejects(stageMediaRestorationCaption(db.client,r.admin,r.id,r.generation,reservation.id),/already occupied/);
      state.purging=true;state.removeMode='normal';
      await assert.rejects(abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,'Refuse unowned file'),/has no verified copy/);
      assert.equal(state.uploads,0);assert.ok(state.objects.has(destination));assert.equal(state.removes,1);
    });
  });
  it('caption reconciliation can outlive admin and URL review without granting another upload',async()=>{
    const origin=process.env.SUPABASE_URL!;
    const r=await authoredRestorationSource('URL provenance',false,path=>`${origin}/storage/v1/object/public/post-media/${path}`);
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.objects.set(r.captionPath,{id:randomUUID(),version:randomUUID(),bytes:r.captionBytes});state.uploadMode='pending';
      await assert.rejects(stageMediaRestorationCaption(db.client,r.admin,r.id,r.generation,reservation.id),/identity unavailable/);
      state.finishUpload();await db.exec(`UPDATE profiles SET role='user' WHERE id='${r.admin}'`);
      process.env.SUPABASE_URL='http://changed-origin.invalid';
      try {
        const receipt=await stageMediaRestorationCaption(db.client,r.admin,r.id,r.generation,reservation.id);
        assert.equal(receipt.reservationId,reservation.id);assert.equal(state.uploads,1);
        assert.equal((await assets(r.s))[0].purge_status,'retained');
      } finally {process.env.SUPABASE_URL=origin;}
    });
  });
  it('permanent purge removes a recreated staged caption after cancellation through the existing object owner',async()=>{
    const r=await authoredRestorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.objects.set(r.captionPath,{id:randomUUID(),version:randomUUID(),bytes:r.captionBytes});
      const staged=await stageMediaRestorationCaption(db.client,r.admin,r.id,r.generation,reservation.id);
      state.purging=true;state.removeMode='normal';await abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,'Cancel caption for permanent erasure');
      state.objects.set(staged.destinationPath,{id:randomUUID(),version:randomUUID(),bytes:new Uint8Array(23)});
      const before=state.removedPaths.length;await authorizePurge(r);await runPurge(r);
      assert.ok(state.removedPaths.slice(before).includes(staged.destinationPath));assert.ok(!state.objects.has(staged.destinationPath));
      assert.equal((await assets(r.s))[0].purge_status,'completed');
      const completion=(await audit(r.s)).find(e=>e.event_type==='purge_succeeded')!;
      assert.ok((completion.details as {paths:string[]}).paths.includes(staged.destinationPath));
    });
  });
  for(const first of ['claim','abort','competing-claim'] as const) it(`${first} serializes a prepared caption upload with recovery ownership`,{timeout:25_000},async()=>{
    const r=await authoredRestorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.objects.set(r.captionPath,{id:randomUUID(),version:randomUUID(),bytes:r.captionBytes});const rpc=db.client.rpc;
      db.client.rpc=(async(name:string,args:any)=>{const result=await rpc.call(db.client,name,args);return name==='advance_media_restoration_copy'&&args.p_phase==='caption_prepared'?{data:null,error:{message:'stop after durable preparation'}}:result;}) as typeof rpc;
      try {await assert.rejects(stageMediaRestorationCaption(db.client,r.admin,r.id,r.generation,reservation.id),/preparation unconfirmed/);} finally {db.client.rpc=rpc;}
      const a=await connect(),b=await connect();let waiting:Promise<QueryResult>|undefined;
      const claim='SELECT advance_media_restoration_copy($1,$2,$3,$4,\'caption_started\',$5,NULL,NULL,NULL,NULL,$6) AS result';
      const abort='SELECT cancel_media_restoration($1,$2,$3,$4,\'Concurrent caption abort\',\'request_abort\') AS result';
      const ids=[r.admin,r.id,r.generation,reservation.id],token=randomUUID(),args=[...ids,token,r.captionPath];
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
        const initial=(await a.client.query(first==='abort'?abort:claim,first==='abort'?ids:args)).rows[0].result;
        assert.equal(initial.ok,true);
        waiting=b.client.query(first==='claim'?abort:claim,first==='claim'?ids:[...ids,randomUUID(),r.captionPath]);void waiting.catch(()=>{});
        await blocked(a.pid,b.pid);await a.client.query('COMMIT');const result=(await waiting).rows[0].result;
        if(first==='abort')assert.equal(result.error,'restoration_aborting');
        else if(first==='claim'){assert.equal(result.ok,true);assert.equal(result.pending,true);}
        else {assert.equal(result.execute,false);assert.equal(result.token,token);}
        assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_caption_started').length,first==='abort'?0:1);
        assert.equal(state.uploads,0);
      } finally {await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
    });
  });
  for(const fault of ['missing','empty','oversize','json','utf8','source','consent','deleted','duplicate-language','timing'] as const)
    it(`caption verification refuses ${fault} before recording proof or copying`,async()=>{
      const r=await authoredRestorationSource();
      await withCopyStorage(r,async state=>{
        await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
        const document=JSON.parse(Buffer.from(r.captionBytes).toString('utf8'));
        if(fault==='source')document.source.version++;
        if(fault==='consent')document.consent=false;
        if(fault==='deleted')document.deleted=true;
        if(fault==='duplicate-language')document.tracks.push(document.tracks[0]);
        if(fault==='timing')document.tracks[0].vtt='WEBVTT\n\n00:00:00.000 --> 00:00:12.000\nToo late\n';
        const bytes=fault==='empty'?new Uint8Array():fault==='oversize'?new Uint8Array(MAX_CAPTION_ARTIFACT_BYTES+1)
          :fault==='json'?Buffer.from('{'):fault==='utf8'?new Uint8Array([0xff]):Buffer.from(JSON.stringify(document));
        if(fault!=='missing')state.objects.set(r.captionPath,{id:randomUUID(),version:randomUUID(),bytes});
        await assert.rejects(verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,reservation.id),/identity unavailable|size invalid|Invalid caption track|do not belong/);
        assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_dependencies_verified').length,0);
        assert.equal(state.copies,1);assert.equal(state.removes,1);
      });
    });
  for(const fault of ['object-changed','consent-revoked','hung'] as const) it(`caption ${fault} during verification cannot commit a stale receipt`,async()=>{
    const r=await authoredRestorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.objects.set(r.captionPath,{id:randomUUID(),version:randomUUID(),bytes:r.captionBytes});
      state.beforeDownload=async path=>{
        if(path!==r.captionPath)return;
        if(fault==='hung')await new Promise(()=>{});
        else if(fault==='object-changed')state.objects.get(path)!.version=randomUUID();
        else assert.equal((await db.client.rpc('media_caption_asr_revoke',{p_asset_id:r.id,p_owner_id:owner})).data,true);
      };
      await assert.rejects(verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,reservation.id,{operationTimeoutMs:100,timeoutMs:500}),/changed during verification|verification unconfirmed|timed out|deadline|queue_timeout/i);
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_dependencies_verified').length,0);
      assert.equal(state.copies,1);assert.equal(state.removes,1);
    });
  });
  it('caption proof reconciles a lost acknowledgement but never replaces previously measured bytes',async()=>{
    const r=await authoredRestorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.objects.set(r.captionPath,{id:randomUUID(),version:randomUUID(),bytes:r.captionBytes});const rpc=db.client.rpc;
      db.client.rpc=(async(name:string,args:any)=>{const result=await rpc.call(db.client,name,args);return name==='verify_media_restoration_dependencies'?{data:null,error:{message:'lost verification acknowledgement'}}:result;}) as typeof rpc;
      try {await assert.rejects(verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,reservation.id),/unconfirmed/);} finally {db.client.rpc=rpc;}
      const proof=await verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,reservation.id);
      const document=JSON.parse(Buffer.from(r.captionBytes).toString('utf8'));document.tracks[0].vtt=document.tracks[0].vtt.replace('Hello','Hallo');
      state.objects.set(r.captionPath,{id:randomUUID(),version:randomUUID(),bytes:Buffer.from(JSON.stringify(document))});
      await assert.rejects(verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,reservation.id),/verification unconfirmed/);
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_dependencies_verified').length,1);
      const receipt=await db.query<{sha256:string}>(`SELECT details#>>'{caption,sha256}' AS sha256 FROM media_asset_lifecycle_events WHERE id='${proof.id}'`);
      assert.equal(receipt[0]?.sha256,proof.caption?.sha256);
    });
  });
  it('SQL verification requires the reviewed caption manifest, bounded identities and track metadata',async()=>{
    const r=await authoredRestorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.objects.set(r.captionPath,{id:randomUUID(),version:randomUUID(),bytes:r.captionBytes});
      const proof=await verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,reservation.id);
      for(const caption of [null,{...proof.caption,sourcePath:`manual-captions/${randomUUID()}/other.json`},{...proof.caption,revisionKey:'0'.repeat(64)},
        {...proof.caption,sourceVersion:r.sourceVersion+1},{...proof.caption,extra:true},{...proof.caption,size:MAX_CAPTION_ARTIFACT_BYTES+1},
        {...proof.caption,tracks:[{...proof.caption!.tracks[0],sourceKind:'invented'}]},{...proof.caption,tracks:[proof.caption!.tracks[0],proof.caption!.tracks[0]]}]) {
        const result=await db.client.rpc('verify_media_restoration_dependencies',{p_actor:r.admin,p_asset:r.id,p_generation:r.generation,p_reservation:reservation.id,p_objects:[],p_caption:caption});
        assert.equal(result.error,null);assert.equal(result.data?.error,'restoration_caption_invalid');
      }
    });
  });
  for(const change of ['caption','consent','privacy','segment-delete'] as const) it(`changed ${change} invalidates authored review while explicit abort preserves retained data`,async()=>{
    const r=await authoredRestorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);
      const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      if(change==='caption')await db.exec(`UPDATE media_caption_manifests SET updated_at=updated_at+interval '1 second' WHERE asset_id='${r.id}'`);
      if(change==='consent')assert.equal((await db.client.rpc('media_caption_asr_revoke',{p_asset_id:r.id,p_owner_id:owner})).data,true);
      if(change==='privacy')await db.exec(`UPDATE memories SET visibility='friends_only' WHERE id='${r.memory}'`);
      if(change==='segment-delete')assert.equal((await db.client.rpc('memory_video_segments_execute',{p_command:{contractVersion:1,operation:'delete',ownerId:owner,memoryId:r.memory,itemId:r.item,segmentId:r.segment}})).data?.deleted,true);
      assert.equal((await db.client.rpc('prepare_media_restoration',{...restorationArgs(r),p_reservation:reservation.id})).data?.error,'restoration_review_changed');
      await assert.rejects(copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id),/authority unconfirmed/);
      assert.equal(state.copies,1);
      await abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,'Cancel stale authored review');
      assert.ok(state.objects.has(reservation.retainedPath));
      const next=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');assert.notEqual(next.id,reservation.id);
      if(change==='segment-delete')assert.equal(next.authored.memoryBindings.find(b=>b.id===r.segment)?.segment,null);
    });
  });
  for(const fault of ['caption-version','segment-version','operation-owner'] as const) it(`authored recovery refuses inconsistent ${fault} provenance`,async()=>{
    const r=await authoredRestorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);
      if(fault==='caption-version')await db.exec(`UPDATE media_caption_manifests SET source_version=source_version+1,object_path='manual-captions/${r.id}/v${r.sourceVersion+1}-${r.revision}.json' WHERE asset_id='${r.id}'`);
      if(fault==='segment-version')await db.exec(`UPDATE memory_video_segments SET asset_version=asset_version+1 WHERE id='${r.segment}'`);
      if(fault==='operation-owner') {
        const other=(await db.seedUser('wrong-segment-owner')).id;await db.exec(`UPDATE memory_video_segment_operations SET owner_id='${other}' WHERE id='${r.segment}'`);
      }
      const result=await db.client.rpc('prepare_media_restoration',restorationArgs(r));assert.equal(result.error,null);
      assert.equal(result.data?.error,fault==='caption-version'?'restoration_caption_unresolved':'restoration_memory_binding_changed');
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_prepared').length,0);
    });
  });
  for(const first of ['review','delete'] as const) it(`${first} serializes authored review against owner segment deletion`,{timeout:25_000},async()=>{
    const r=await authoredRestorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const a=await connect(),b=await connect();let waiting:Promise<QueryResult>|undefined;
      const review='SELECT prepare_media_restoration($1,$2,$3,$4,NULL,$5::jsonb) AS receipt',erase='SELECT memory_video_segments_execute($1::jsonb) AS receipt';
      const reviewArgs=[r.admin,r.id,r.generation,'Reviewed restoration',JSON.stringify(await referenceReview(r))];
      const eraseArgs=[JSON.stringify({contractVersion:1,operation:'delete',ownerId:owner,memoryId:r.memory,itemId:r.item,segmentId:r.segment})];
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
        const initial=(await a.client.query(first==='review'?review:erase,first==='review'?reviewArgs:eraseArgs)).rows[0].receipt;assert.equal(initial.ok,true);
        waiting=b.client.query(first==='review'?erase:review,first==='review'?eraseArgs:reviewArgs);void waiting.catch(()=>{});
        if(first==='delete') {
          const refused=(await waiting).rows[0].receipt;assert.equal(refused.ok,false);assert.equal(refused.error,'restoration_memory_review_busy');
          assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_prepared').length,0);
          await a.client.query('COMMIT');
          const fresh=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
          assert.equal(fresh.authored.memoryBindings.find(x=>x.id===r.segment)?.segment,null);
        } else {
          await blocked(a.pid,b.pid);await a.client.query('COMMIT');assert.equal((await waiting).rows[0].receipt.ok,true);
          assert.equal((await db.client.rpc('prepare_media_restoration',restorationArgs(r))).data?.error,'restoration_review_changed');
        }
      } finally {await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
    });
  });

  it('dependency manifest deduplicates canonical and source references and records measured bytes before copy',async()=>{
    const r=await restorationSource(owner,'sidecars');
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);
      const receipt=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      assert.equal(receipt.dependencies.length,2);
      assert.equal(receipt.dependencies.find(d=>d.sourcePath.endsWith('.thumb.jpg'))?.references.length,2);
      const args={...restorationArgs(r),p_reservation:receipt.id};
      assert.equal((await db.client.rpc('advance_media_restoration_copy',{p_actor:r.admin,p_asset:r.id,p_generation:r.generation,p_reservation:receipt.id,p_phase:'copy_started',p_token:randomUUID()})).data?.error,'restoration_dependencies_unverified');
      for(const dependency of receipt.dependencies)state.objects.set(dependency.sourcePath,{id:randomUUID(),version:randomUUID(),bytes:new Uint8Array(17).fill(4)});
      const before=await assets(r.s),copies=state.copies,removes=state.removes;
      const verified=await verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,receipt.id);
      assert.equal(verified.objects.length,2);assert.ok(verified.objects.every(o=>o.size===17 && /^[a-f0-9]{64}$/.test(o.sha256)));
      assert.deepEqual(await verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,receipt.id),verified);
      assert.deepEqual(await assets(r.s),before);assert.equal(state.copies,copies);assert.equal(state.removes,removes);
      for(const role of ['anon','authenticated'])assert.equal((await db.query(`SELECT has_function_privilege('${role}','verify_media_restoration_dependencies(uuid,uuid,uuid,uuid,jsonb,jsonb)','EXECUTE') AS allowed`))[0].allowed,false);
      assert.equal((await db.client.rpc('cancel_media_restoration',args)).data?.ok,true);
      await assert.rejects(verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,receipt.id),/unconfirmed/);
    });
  });

  it('Unicode dependency filenames use the same canonical ordering in SQL and streamed verification',async()=>{
    const r=await restorationSource(owner,'unicode');
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const receipt=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      for(const dependency of receipt.dependencies)state.objects.set(dependency.sourcePath,{id:randomUUID(),version:randomUUID(),bytes:new Uint8Array(13)});
      const verified=await verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,receipt.id);
      assert.deepEqual(verified.objects.map(o=>o.sourcePath),receipt.dependencies.map(d=>d.sourcePath));
      assert.deepEqual(await verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,receipt.id),verified);
    });
  });

  for(const fault of ['missing','empty'])it(`${fault} required dependency never yields a verification receipt or dispatch`,async()=>{
    const r=await restorationSource(owner,'sidecars');
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const receipt=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      for(const dependency of receipt.dependencies)state.objects.set(dependency.sourcePath,{id:randomUUID(),version:randomUUID(),bytes:new Uint8Array(23)});
      const last=receipt.dependencies.at(-1)!.sourcePath;
      if(fault==='missing')state.objects.delete(last);else state.objects.get(last)!.bytes=new Uint8Array(0);
      await assert.rejects(verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,receipt.id));
      assert.deepEqual(await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_dependencies_verified'`),[]);
      assert.equal(state.copies,1);
    });
  });

  it('dependency receipt refuses omitted, duplicate, extra and changed objects without replacing verified identities',async()=>{
    const r=await restorationSource(owner,'sidecars');
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const receipt=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      for(const dependency of receipt.dependencies)state.objects.set(dependency.sourcePath,{id:randomUUID(),version:randomUUID(),bytes:new Uint8Array(23)});
      const verified=await verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,receipt.id);
      const args={p_actor:r.admin,p_asset:r.id,p_generation:r.generation,p_reservation:receipt.id};
      for(const objects of [[],[verified.objects[0],verified.objects[0]],[...verified.objects,{...verified.objects[0],sourcePath:'unreviewed'}],verified.objects.map(o=>({...o,extra:true}))]) {
        assert.equal((await db.client.rpc('verify_media_restoration_dependencies',{...args,p_objects:objects})).data?.error,'restoration_dependencies_invalid');
      }
      state.objects.get(receipt.dependencies[0]!.sourcePath)!.version=randomUUID();
      await assert.rejects(verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,receipt.id),/unconfirmed/);
      const rows=await db.query(`SELECT id,details FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_dependencies_verified'`);
      assert.equal(rows.length,1);assert.equal(rows[0].id,verified.id);assert.deepEqual((rows[0].details as any).objects,verified.objects);
    });
  });

  for(const fault of ['lost-ack','review-changed'])it(`dependency verification handles ${fault} without a replacement operation`,async()=>{
    const r=await restorationSource(owner,'sidecars');
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const receipt=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      for(const dependency of receipt.dependencies)state.objects.set(dependency.sourcePath,{id:randomUUID(),version:randomUUID(),bytes:new Uint8Array(19)});
      const original=db.client.rpc;
      db.client.rpc=(async(name:string,args:any)=>{
        if(name!=='verify_media_restoration_dependencies')return original.call(db.client,name,args);
        if(fault==='review-changed')await db.exec(`UPDATE posts SET content='changed after measuring dependencies' WHERE id='${r.s.post}'`);
        const result=await original.call(db.client,name,args);
        return fault==='lost-ack'?{data:null,error:new Error('synthetic lost verification acknowledgement')}:result;
      }) as any;
      try {await assert.rejects(verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,receipt.id),/unconfirmed/);}
      finally {db.client.rpc=original;}
      const rows=await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_dependencies_verified'`);
      if(fault==='review-changed')assert.deepEqual(rows,[]);
      else {
        const verified=await verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,receipt.id);assert.equal(rows[0].id,verified.id);
        state.restorePath=receipt.destinationPath;
        assert.equal((await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,receipt.id)).reservationId,receipt.id);
        assert.equal(state.copies,2);
      }
    });
  });

  it('an original used as thumbnail is measured from its retained copy without reviving the old key',async()=>{
    const r=await restorationSource(owner,'alias');
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const receipt=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      assert.equal(state.objects.has(r.s.path),false);
      const verified=await verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,receipt.id);
      assert.equal(verified.objects.length,1);assert.equal(verified.objects[0]!.sourcePath,r.s.path);assert.equal(verified.objects[0]!.objectId,receipt.objectId);
      assert.equal(state.copies,1);assert.equal(state.objects.has(r.s.path),false);
    });
  });

  for(const fault of ['unresolved','foreign'] as const)it(`${fault} dependency locator refuses reservation`,async()=>{
    const r=await restorationSource(owner,fault);
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);
      assert.equal((await db.client.rpc('prepare_media_restoration',restorationArgs(r))).data?.error,'restoration_dependency_unresolved');
      assert.deepEqual(await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_prepared'`),[]);
    });
  });

  const dependencyDestination=(r:RetainedOriginal,reservationId:string,path:string)=>`_recovered/${r.id}/${reservationId}/objects/${createHash('sha256').update(path,'utf8').digest('hex')}`;
  for(const kind of ['sidecars','alias','long'] as const) it(`permanent purge accounts for ${kind} sources and cancelled reservation destinations`,async()=>{
    const r=await restorationSource(owner,kind);
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);
      const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      const cancelled=await db.client.rpc('cancel_media_restoration',{...restorationArgs(r),p_reservation:reservation.id,p_reason:'Cancel unstarted restoration'});
      assert.equal(cancelled.error,null);assert.equal(cancelled.data?.ok,true);
      const expected=[...new Set([r.s.path,reservation.retainedPath,reservation.destinationPath,
        ...reservation.dependencies.map(d=>d.sourcePath),
        ...reservation.dependencies.filter(d=>d.sourcePath!==r.s.path).map(d=>dependencyDestination(r,reservation.id,d.sourcePath))])].sort();
      assert.deepEqual((await db.query(`SELECT path FROM media_permanent_purge_paths('${r.id}') path`)).map(row=>row.path).sort(),expected);
      // Reserved keys may contain orphaned bytes. Cancellation does not remove
      // their cleanup obligation or allow an old manifest to overlook them.
      for(const path of expected)state.objects.set(path,{id:randomUUID(),version:randomUUID(),bytes:new Uint8Array(13)});
      await authorizePurge(r);state.purging=true;state.removeMode='normal';const offset=state.removedPaths.length;
      await runPurge(r);assert.equal(state.objects.size,0);
      assert.deepEqual(state.removedPaths.slice(offset).sort(),expected);
      const completion=(await audit(r.s)).find(e=>e.event_type==='purge_succeeded')!;
      assert.deepEqual((completion.details as any).paths.slice().sort(),expected);
      // Historical success never grants another deletion of a recreated key.
      state.objects.set(reservation.destinationPath,{id:randomUUID(),version:randomUUID(),bytes:new Uint8Array(13)});
      const removals=state.removes;await assert.rejects(runPurge(r),/object recreated/);assert.equal(state.removes,removals);
    });
  });

  it('purge includes source feed and thumbnail even without a canonical thumbnail or restoration review',async()=>{
    const r=await retainedOriginal(owner,undefined,false,false,async s=>{
      await db.exec(`UPDATE post_media SET thumbnail_storage_path=${lit(`${s.path}.poster.jpg`)},feed_storage_path=${lit(`${s.path}.feed.jpg`)} WHERE id='${s.media}'`);
    });
    await withCopyStorage(r,async state=>{
      assert.equal((await assets(r.s))[0].thumbnail_path,null);
      const expected=[r.s.path,`${r.s.path}.poster.jpg`,`${r.s.path}.feed.jpg`].sort();
      for(const path of expected)state.objects.set(path,{id:randomUUID(),version:randomUUID(),bytes:new Uint8Array(15)});
      await authorizePurge(r);state.purging=true;state.removeMode='normal';await runPurge(r);
      assert.deepEqual(state.removedPaths.sort(),expected);assert.equal(state.objects.size,0);
    });
  });

  for(const fault of ['unresolved','foreign'] as const) it(`purge refuses ${fault} dependency provenance before any object removal`,async()=>{
    const r=await restorationSource(owner,fault);
    await withCopyStorage(r,async state=>{
      await authorizePurge(r);state.purging=true;state.removeMode='normal';
      await assert.rejects(runPurge(r),/manifest unavailable/);assert.equal(state.removes,0);
      assert.equal((await assets(r.s))[0].purge_status,'failed');
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='purge_succeeded').length,0);
    });
  });

  it('purge retains historical generation locators instead of filtering them to the current generation',async()=>{
    const r=await retainedOriginal(),priorGeneration=randomUUID(),preparationId=randomUUID(),copyId=randomUUID();
    const oldPath=`_retained/${r.id}/${priorGeneration}/original`;
    // Synthetic settled historical receipts, not a second lifecycle writer.
    await db.exec(`INSERT INTO media_asset_lifecycle_events(id,media_asset_id,actor_user_id,event_type,details)
      VALUES('${preparationId}','${r.id}','${owner}','retention_original_prepared',${lit(JSON.stringify({generation:priorGeneration,bucket:'post-media',sourcePath:r.s.path,retainedPath:oldPath}))}::jsonb),
      ('${copyId}','${r.id}','${owner}','retention_original_copied',${lit(JSON.stringify({generation:priorGeneration,preparationId}))}::jsonb),
      (gen_random_uuid(),'${r.id}','${owner}','retention_original_removed',${lit(JSON.stringify({generation:priorGeneration,preparationId,copyId,sourceAbsent:true}))}::jsonb)`);
    await withCopyStorage(r,async state=>{
      state.objects.set(oldPath,{id:randomUUID(),version:randomUUID(),bytes:new Uint8Array(14)});
      await authorizePurge(r);state.purging=true;state.removeMode='normal';await runPurge(r);
      assert.deepEqual(state.removedPaths.sort(),[oldPath,r.s.path].sort());assert.equal(state.objects.size,0);
    });
  });

  for(const phase of ['retention_original_prepared','restoration_prepared']) it(`unsettled historical ${phase} blocks current content and account deletion`,async()=>{
    const user=(await db.seedUser('historical-transfer-owner')).id,r=await restorationSource(user),priorGeneration=randomUUID();
    await db.exec(`INSERT INTO media_asset_lifecycle_events(media_asset_id,actor_user_id,event_type,details)
      VALUES('${r.id}','${user}',${lit(phase)},${lit(JSON.stringify({generation:priorGeneration}))}::jsonb)`);
    const approved=await db.client.rpc('authorize_media_permanent_deletion',restorationArgs(r));
    assert.equal(approved.error,null);assert.equal(approved.data?.error,'retention_transfer_pending');
    const request=await db.client.rpc('request_recoverable_account_deletion',{p_user:user});assert.equal(request.error,null);
    const claim=await db.client.rpc('claim_account_permanent_deletion',{p_protocol:1,p_actor:r.admin,p_user:user,p_generation:request.data?.generation,p_token:randomUUID(),p_reason:'Reviewed deletion'});
    assert.equal(claim.error,null);assert.equal(claim.data?.error,'retention_transfer_pending');
    assert.equal((await assets(r.s))[0].purge_status,'retained');
    assert.equal((await db.query(`SELECT status FROM user_deletion_requests WHERE user_id='${user}'`))[0].status,'pending');
  });

  it('a pending dependency copy remains inventoried and blocks cancellation and permanent deletion',async()=>{
    await dependencyCopyFixture(async(r,state,reservation)=>{
      const path=reservation.dependencies[0]!.sourcePath;
      state.dependencySource=path;state.restorePath=dependencyDestination(r,reservation.id,path);state.mode='pending';
      await assert.rejects(copyMediaRestorationDependency(db.client,r.admin,r.id,r.generation,reservation.id,path),/identity unavailable/);
      const paths=(await db.query(`SELECT path FROM media_permanent_purge_paths('${r.id}') path`)).map(row=>row.path);
      assert.ok(paths.includes(state.restorePath));assert.ok(paths.includes(path));assert.ok(paths.includes(reservation.retainedPath));
      const cancelled=await db.client.rpc('cancel_media_restoration',{...restorationArgs(r),p_reservation:reservation.id});
      assert.equal(cancelled.data?.error,'restoration_transfer_pending');
      const approved=await db.client.rpc('authorize_media_permanent_deletion',restorationArgs(r));
      assert.equal(approved.data?.error,'retention_transfer_pending');assert.equal(state.removes,1);
      assert.equal(state.objects.has(reservation.retainedPath),true);
    });
  });

  async function dependencyCopyFixture(run:(r:Awaited<ReturnType<typeof restorationSource>>,state:Parameters<Parameters<typeof withCopyStorage>[1]>[0],reservation:Awaited<ReturnType<typeof prepareRetainedMediaRestoration>>)=>Promise<void>,alias:boolean|"long"=false) {
    const r=await restorationSource(owner,alias===true?'alias':alias==='long'?'long':'sidecars');
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      if(alias!==true)for(const dependency of reservation.dependencies)state.objects.set(dependency.sourcePath,{id:randomUUID(),version:randomUUID(),bytes:new Uint8Array(29).fill(7)});
      await verifyMediaRestorationDependencies(db.client,r.admin,r.id,r.generation,reservation.id);
      await run(r,state,reservation);
    });
  }
  it('long UTF8 dependency paths use bounded durable operation keys',async()=>{
    await dependencyCopyFixture(async(r,state,reservation)=>{
      const path=reservation.dependencies[0]!.sourcePath;assert.ok(Buffer.byteLength(path)>2704);
      state.dependencySource=path;state.restorePath=dependencyDestination(r,reservation.id,path);
      const copied=await copyMediaRestorationDependency(db.client,r.admin,r.id,r.generation,reservation.id,path);
      assert.ok(Buffer.byteLength(copied.destinationPath)<256);assert.equal(copied.sourcePath,path);
      assert.deepEqual(await copyMediaRestorationDependency(db.client,r.admin,r.id,r.generation,reservation.id,path),copied);assert.equal(state.copies,2);
    },'long');
  });
  const abortReason='Reviewed cancellation without releasing retained originals';
  for(const kind of ['normal','lost-response','alias'] as const) it(`admin abort cleans each settled destination once across ${kind}`,async()=>{
    await dependencyCopyFixture(async(r,state,reservation)=>{
      const expected=new Set<string>();state.restorePath=reservation.destinationPath;
      await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);expected.add(reservation.destinationPath);
      for(const d of reservation.dependencies) {
        if(d.sourcePath!==r.s.path) {state.dependencySource=d.sourcePath;state.restorePath=dependencyDestination(r,reservation.id,d.sourcePath);}
        const copy=await copyMediaRestorationDependency(db.client,r.admin,r.id,r.generation,reservation.id,d.sourcePath);expected.add(copy.destinationPath);
      }
      state.purging=true;state.removeMode=kind==='lost-response'?'lost-response':'normal';const offset=state.removedPaths.length,copies=state.copies;
      const receipt=await abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,abortReason);
      assert.deepEqual(new Set(state.removedPaths.slice(offset)),expected);assert.equal(state.copies,copies);
      assert.ok(state.objects.has(reservation.retainedPath));
      for(const d of reservation.dependencies)if(d.sourcePath!==r.s.path)assert.ok(state.objects.has(d.sourcePath));
      const removals=state.removes;assert.deepEqual(await abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,abortReason),receipt);assert.equal(state.removes,removals);
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_cancelled').length,1);
      assert.equal((await assets(r.s))[0].purge_status,'retained');
      await authorizePurge(r);
    },kind==='alias');
  });
  it('abort fences new work while an unknown copy reconciles later without redispatch',async()=>{
    await dependencyCopyFixture(async(r,state,reservation)=>{
      const d=reservation.dependencies[0]!;state.dependencySource=d.sourcePath;state.restorePath=dependencyDestination(r,reservation.id,d.sourcePath);state.mode='pending';
      await assert.rejects(copyMediaRestorationDependency(db.client,r.admin,r.id,r.generation,reservation.id,d.sourcePath),/identity unavailable/);
      const copies=state.copies,removals=state.removes;
      await assert.rejects(abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,abortReason),/outcome unknown/);
      assert.equal(state.copies,copies);assert.equal(state.removes,removals);
      assert.equal((await db.client.rpc('prepare_media_restoration',restorationArgs(r))).data?.error,'restoration_aborting');
      await assert.rejects(copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id),/authority unconfirmed/);
      assert.equal((await db.client.rpc('authorize_media_permanent_deletion',restorationArgs(r))).data?.error,'retention_transfer_pending');
      state.complete();state.purging=true;state.removeMode='normal';state.mode='normal';
      await abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,abortReason);
      assert.equal(state.copies,copies);assert.equal(state.removes,removals+1);assert.ok(state.objects.has(reservation.retainedPath));
    });
  });
  for(const phase of ['request_abort','removal_started','absent','cancel'] as const) it(`lost abort ${phase} acknowledgement reconciles without another dispatch`,async()=>{
    await dependencyCopyFixture(async(r,state,reservation)=>{
      state.restorePath=reservation.destinationPath;await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);
      state.purging=true;state.removeMode='normal';const rpc=db.client.rpc;
      db.client.rpc=(async(name:string,args:any)=>{
        const result=await rpc.call(db.client,name,args);
        return name==='cancel_media_restoration' && args.p_phase===phase && !result.error ? {data:null,error:{message:'synthetic lost abort acknowledgement'}} : result;
      }) as typeof rpc;
      try {await assert.rejects(abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,abortReason),/unconfirmed/);} finally {db.client.rpc=rpc;}
      // Lost claim acknowledgement for an absent reserved key has no physical
      // write; its subsequent observed absence safely settles that same claim.
      const copies=state.copies;await abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,abortReason);
      assert.equal(state.copies,copies);assert.equal(state.removes,2);assert.ok(state.objects.has(reservation.retainedPath));
    });
  });
  it('unknown abort removal never repeats and only observed absence permits cancellation',async()=>{
    await dependencyCopyFixture(async(r,state,reservation)=>{
      state.restorePath=reservation.destinationPath;await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);
      state.purging=true;state.removeMode='pending';
      await assert.rejects(abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,abortReason),/outcome unknown/);
      const removes=state.removes;state.removeMode='normal';
      await assert.rejects(abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,abortReason),/outcome unknown/);assert.equal(state.removes,removes);
      assert.equal((await db.client.rpc('authorize_media_permanent_deletion',restorationArgs(r))).data?.error,'retention_transfer_pending');
      state.objects.delete(reservation.destinationPath);
      await abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,abortReason);assert.equal(state.removes,removes);
    });
  });
  it('a lost cleanup claim for an existing copy stays held without granting a replacement removal',async()=>{
    await dependencyCopyFixture(async(r,state,reservation)=>{
      state.restorePath=reservation.destinationPath;await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);
      state.purging=true;const rpc=db.client.rpc;
      db.client.rpc=(async(name:string,args:any)=>{const result=await rpc.call(db.client,name,args);
        return name==='cancel_media_restoration' && args.p_phase==='removal_started' ? {data:null,error:{message:'lost claim'}} : result;}) as typeof rpc;
      try {await assert.rejects(abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,abortReason),/authority unconfirmed/);} finally {db.client.rpc=rpc;}
      const removes=state.removes;await assert.rejects(abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,abortReason),/outcome unknown/);
      assert.equal(state.removes,removes);assert.ok(state.objects.has(reservation.destinationPath));assert.ok(state.objects.has(reservation.retainedPath));
    },true);
  });
  for(const first of ['copy','abort'] as const) it(`${first} serializes new copy dispatch against the durable abort fence`,{timeout:25_000},async()=>{
    await dependencyCopyFixture(async(r,_state,reservation)=>{
      const a=await connect(),b=await connect();let waiting:Promise<QueryResult>|undefined;
      const copy="SELECT advance_media_restoration_copy($1,$2,$3,$4,'copy_started',$5) AS receipt";
      const abort="SELECT cancel_media_restoration($1,$2,$3,$4,$5,'request_abort') AS receipt";
      const args=[r.admin,r.id,r.generation,reservation.id];
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
        const initial=await a.client.query(first==='copy'?copy:abort,[...args,first==='copy'?randomUUID():abortReason]);assert.equal(initial.rows[0].receipt.ok,true);
        waiting=b.client.query(first==='copy'?abort:copy,[...args,first==='copy'?abortReason:randomUUID()]);void waiting.catch(()=>{});
        await blocked(a.pid,b.pid);await a.client.query('COMMIT');const result=(await waiting).rows[0].receipt;
        if(first==='copy'){assert.equal(result.ok,true);assert.equal(result.pending,true);}
        else assert.equal(result.error,'restoration_aborting');
        assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_copy_started').length,first==='copy'?1:0);
      } finally {await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
    });
  });
  it('abort authority refuses foreign actors, changed reviews, retained paths and missing cleanup evidence',async()=>{
    await dependencyCopyFixture(async(r,_state,reservation)=>{
      const args={...restorationArgs(r),p_reservation:reservation.id,p_reason:abortReason};
      const invoke=async(extra:Record<string,unknown>)=>{const result=await db.client.rpc('cancel_media_restoration',{...args,...extra});assert.equal(result.error,null);return result.data as any;};
      assert.equal((await invoke({p_phase:'request_abort',p_actor:owner})).error,'admin_required');
      assert.equal((await invoke({p_phase:'request_abort'})).ok,true);
      assert.equal((await invoke({p_phase:'request_abort',p_reason:'Changed review'})).error,'restoration_review_changed');
      assert.equal((await invoke({p_phase:'cancel'})).error,'restoration_cleanup_pending');
      assert.equal((await invoke({p_phase:'removal_started',p_path:reservation.retainedPath,p_token:randomUUID()})).error,'restoration_cleanup_path_forbidden');
      const token=randomUUID();assert.equal((await invoke({p_phase:'removal_started',p_path:reservation.destinationPath,p_token:token})).execute,true);
      assert.equal((await invoke({p_phase:'absent',p_path:reservation.destinationPath,p_token:randomUUID()})).error,'restoration_cleanup_authority_changed');
      await db.exec(`UPDATE profiles SET role='user' WHERE id='${r.admin}'`);
      assert.equal((await invoke({p_phase:'absent',p_path:reservation.destinationPath,p_token:token})).ok,true,'physical reconciliation may outlive role');
      assert.equal((await invoke({p_phase:'cancel'})).error,'admin_required');
      assert.equal((await invoke({p_phase:'removal_started',p_path:reservation.destinationPath,p_token:token})).error,'admin_required');
    });
  });
  it('competing abort cleanup sessions share one removal claim',{timeout:25_000},async()=>{
    await dependencyCopyFixture(async(r,_state,reservation)=>{
      const args=[r.admin,r.id,r.generation,reservation.id,abortReason];
      assert.equal((await db.client.rpc('cancel_media_restoration',{...restorationArgs(r),p_reservation:reservation.id,p_reason:abortReason,p_phase:'request_abort'})).data?.ok,true);
      const a=await connect(),b=await connect(),token=randomUUID();let waiting:Promise<QueryResult>|undefined;
      const claim="SELECT cancel_media_restoration($1,$2,$3,$4,$5,'removal_started',$6,$7) AS receipt";
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
        const first=(await a.client.query(claim,[...args,reservation.destinationPath,token])).rows[0].receipt;assert.equal(first.execute,true);
        waiting=b.client.query(claim,[...args,reservation.destinationPath,randomUUID()]);void waiting.catch(()=>{});
        await blocked(a.pid,b.pid);await a.client.query('COMMIT');
        assert.deepEqual((await waiting).rows[0].receipt,{ok:true,execute:false,token,abortId:first.abortId});
      } finally {await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_cleanup_started').length,1);
    });
  });
  for(const first of ['cancel','purge'] as const) it(`${first} serializes final abort cancellation with permanent deletion`,{timeout:25_000},async()=>{
    await dependencyCopyFixture(async(r,state,reservation)=>{
      const args={...restorationArgs(r),p_reservation:reservation.id,p_reason:abortReason};
      const requested=await db.client.rpc('cancel_media_restoration',{...args,p_phase:'request_abort'});assert.equal(requested.data?.ok,true);
      for(const path of requested.data.paths) {
        assert.equal(state.objects.has(path),false,'observe no unstarted destination in this synthetic provider');
        const token=randomUUID();assert.equal((await db.client.rpc('cancel_media_restoration',{...args,p_phase:'removal_started',p_path:path,p_token:token})).data?.execute,true);
        assert.equal((await db.client.rpc('cancel_media_restoration',{...args,p_phase:'absent',p_path:path,p_token:token})).data?.ok,true);
      }
      const a=await connect(),b=await connect();let waiting:Promise<QueryResult>|undefined;
      const cancel="SELECT cancel_media_restoration($1,$2,$3,$4,$5) AS receipt",purge="SELECT authorize_media_permanent_deletion($1,$2,$3,$4) AS receipt";
      const cancelArgs=[r.admin,r.id,r.generation,reservation.id,abortReason],purgeArgs=[r.admin,r.id,r.generation,'Reviewed permanent deletion after abort'];
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
        const initial=(await a.client.query(first==='cancel'?cancel:purge,first==='cancel'?cancelArgs:purgeArgs)).rows[0].receipt;
        if(first==='cancel')assert.equal(initial.ok,true);else assert.equal(initial.error,'retention_transfer_pending');
        waiting=b.client.query(first==='cancel'?purge:cancel,first==='cancel'?purgeArgs:cancelArgs);void waiting.catch(()=>{});
        await blocked(a.pid,b.pid);await a.client.query('COMMIT');assert.equal((await waiting).rows[0].receipt.ok,true);
        assert.equal((await assets(r.s))[0].purge_status,first==='cancel'?'pending':'retained');
        assert.ok(state.objects.has(reservation.retainedPath));assert.equal(state.removes,1);
      } finally {await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
    });
  });
  it('cancelled abort refuses recreated destinations without deleting them again',async()=>{
    await dependencyCopyFixture(async(r,state,reservation)=>{
      const result=await abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,abortReason);
      state.objects.set(reservation.destinationPath,{id:randomUUID(),version:randomUUID(),bytes:new Uint8Array(100)});
      const removes=state.removes;await assert.rejects(abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,abortReason),/destination recreated/);
      assert.equal(state.removes,removes);assert.equal((await audit(r.s)).filter(e=>e.id===result.id).length,1);
    });
  });
  it('abort refuses an unverified occupied key and preserves the retained source if cleanup corrupts it',async()=>{
    await dependencyCopyFixture(async(r,state,reservation)=>{
      state.objects.set(reservation.destinationPath,{id:randomUUID(),version:randomUUID(),bytes:new Uint8Array(100)});
      await assert.rejects(abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,abortReason),/no verified copy/);assert.equal(state.removes,1);
      assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_cancelled').length,0);
    });
    await dependencyCopyFixture(async(r,state,reservation)=>{
      state.restorePath=reservation.destinationPath;await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);
      state.purging=true;state.removeMode='corrupt-copy';
      await assert.rejects(abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,abortReason),/integrity mismatch/);
      assert.ok(state.objects.has(reservation.retainedPath));assert.equal((await audit(r.s)).filter(e=>e.event_type==='restoration_cancelled').length,0);
    });
  });
  it('failed abort cancellation audit keeps the barrier and retries without re-erasing destinations',async()=>{
    await dependencyCopyFixture(async(r,state,reservation)=>{
      state.restorePath=reservation.destinationPath;await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);state.purging=true;
      await db.exec(`CREATE FUNCTION test_abort_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic abort audit failure'; END $$;
        CREATE TRIGGER test_abort_audit_failure BEFORE INSERT ON media_asset_lifecycle_events FOR EACH ROW WHEN (NEW.event_type='restoration_cancelled') EXECUTE FUNCTION test_abort_audit_failure()`);
      try {await assert.rejects(abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,abortReason),/cancellation unconfirmed/);}
      finally {await db.exec('DROP TRIGGER test_abort_audit_failure ON media_asset_lifecycle_events; DROP FUNCTION test_abort_audit_failure()');}
      assert.equal((await db.client.rpc('authorize_media_permanent_deletion',restorationArgs(r))).data?.error,'retention_transfer_pending');
      const removes=state.removes;await abortMediaRestoration(db.client,r.admin,r.id,r.generation,reservation.id,abortReason);assert.equal(state.removes,removes);
    });
  });
  for(const mode of ['normal','lost-response'])it(`dependency copies share one engine and preserve all references across ${mode}`,async()=>{
    await dependencyCopyFixture(async(r,state,reservation)=>{
      const before=await assets(r.s);state.mode=mode;
      for(const dependency of reservation.dependencies) {
        state.dependencySource=dependency.sourcePath;state.restorePath=dependencyDestination(r,reservation.id,dependency.sourcePath);
        const copied=await copyMediaRestorationDependency(db.client,r.admin,r.id,r.generation,reservation.id,dependency.sourcePath);
        assert.equal(copied.reusedOriginal,false);assert.equal(copied.sourcePath,dependency.sourcePath);assert.equal(copied.destinationPath,state.restorePath);
        assert.notEqual(copied.objectId,state.objects.get(dependency.sourcePath)!.id);
        assert.deepEqual(state.objects.get(state.restorePath)!.bytes,state.objects.get(dependency.sourcePath)!.bytes);
        assert.deepEqual(await copyMediaRestorationDependency(db.client,r.admin,r.id,r.generation,reservation.id,dependency.sourcePath),copied);
      }
      assert.equal(state.copies,1+reservation.dependencies.length);assert.equal(state.removes,1);assert.deepEqual(await assets(r.s),before);
      assert.equal((await db.client.rpc('cancel_media_restoration',{...restorationArgs(r),p_reservation:reservation.id})).data?.error,'restoration_transfer_pending');
      assert.equal((await db.client.rpc('authorize_media_permanent_deletion',restorationArgs(r))).data?.error,'retention_transfer_pending');
      assert.equal(state.objects.has(r.s.path),false);
    });
  });
  for(const mode of ['pending','hung'])it(`${mode} dependency writes reconcile without a second dispatch`,async()=>{
    await dependencyCopyFixture(async(r,state,reservation)=>{
      const path=reservation.dependencies[0]!.sourcePath;state.dependencySource=path;state.restorePath=dependencyDestination(r,reservation.id,path);state.mode=mode;
      const run=()=>copyMediaRestorationDependency(db.client,r.admin,r.id,r.generation,reservation.id,path,{operationTimeoutMs:30,timeoutMs:1000});
      await assert.rejects(run());assert.equal(state.copies,2);await assert.rejects(run());assert.equal(state.copies,2);
      state.complete();assert.equal((await run()).sourcePath,path);assert.equal(state.copies,2);
    });
  });
  for(const phase of ['copy_started','copied'])it(`lost dependency ${phase} acknowledgement keeps one durable operation`,async()=>{
    await dependencyCopyFixture(async(r,state,reservation)=>{
      const path=reservation.dependencies[0]!.sourcePath;state.dependencySource=path;state.restorePath=dependencyDestination(r,reservation.id,path);
      const original=db.client.rpc;let lost=false;
      db.client.rpc=(async(name:string,args:any)=>{
        const result=await original.call(db.client,name,args);
        if(!lost && name==='advance_media_restoration_copy' && args.p_source_path===path && args.p_phase===phase){lost=true;return {data:null,error:new Error('synthetic lost dependency phase acknowledgement')};}
        return result;
      }) as any;
      try {await assert.rejects(copyMediaRestorationDependency(db.client,r.admin,r.id,r.generation,reservation.id,path));}finally {db.client.rpc=original;}
      const count=state.copies;if(phase==='copy_started'){assert.equal(count,1);await assert.rejects(copyMediaRestorationDependency(db.client,r.admin,r.id,r.generation,reservation.id,path));state.complete();}
      const copied=await copyMediaRestorationDependency(db.client,r.admin,r.id,r.generation,reservation.id,path);assert.equal(copied.sourcePath,path);assert.equal(state.copies,count);
      assert.equal((await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_dependency_copied'`)).length,1);
    });
  });
  for(const fault of ['source-changed','occupied','cancelled','admin-revoked','unreviewed'])it(`${fault} dependency refuses a new provider dispatch`,async()=>{
    await dependencyCopyFixture(async(r,state,reservation)=>{
      let path=reservation.dependencies[0]!.sourcePath;state.dependencySource=path;state.restorePath=dependencyDestination(r,reservation.id,path);
      if(fault==='source-changed')state.objects.get(path)!.bytes[0]^=1;
      if(fault==='occupied')state.complete();
      if(fault==='cancelled')assert.equal((await db.client.rpc('cancel_media_restoration',{...restorationArgs(r),p_reservation:reservation.id})).data?.ok,true);
      if(fault==='admin-revoked')await db.exec(`UPDATE profiles SET role='user' WHERE id='${r.admin}'`);
      if(fault==='unreviewed')path=`${owner}/not-reviewed.jpg`;
      await assert.rejects(copyMediaRestorationDependency(db.client,r.admin,r.id,r.generation,reservation.id,path));assert.equal(state.copies,1);
      assert.deepEqual(await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_dependency_copy_started'`),[]);
    });
  });
  it('corrupt dependency copy cannot be acknowledged or overwritten',async()=>{
    await dependencyCopyFixture(async(r,state,reservation)=>{
      const path=reservation.dependencies[0]!.sourcePath;state.dependencySource=path;state.restorePath=dependencyDestination(r,reservation.id,path);state.mode='corrupt';
      await assert.rejects(copyMediaRestorationDependency(db.client,r.admin,r.id,r.generation,reservation.id,path),/integrity mismatch/);
      state.mode='normal';await assert.rejects(copyMediaRestorationDependency(db.client,r.admin,r.id,r.generation,reservation.id,path),/integrity mismatch/);assert.equal(state.copies,2);
      assert.deepEqual(await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_dependency_copied'`),[]);
    });
  });
  it('a late dependency outcome remains reconcilable after review revocation without authorizing another object',async()=>{
    await dependencyCopyFixture(async(r,state,reservation)=>{
      const path=reservation.dependencies[0]!.sourcePath;state.dependencySource=path;state.restorePath=dependencyDestination(r,reservation.id,path);
      state.beforeCopy=async()=>{await db.exec(`UPDATE profiles SET role='user' WHERE id='${r.admin}'; UPDATE posts SET content='changed during dependency copy' WHERE id='${r.s.post}'`);};
      const copied=await copyMediaRestorationDependency(db.client,r.admin,r.id,r.generation,reservation.id,path);
      assert.deepEqual(await copyMediaRestorationDependency(db.client,r.admin,r.id,r.generation,reservation.id,path),copied);
      const second=reservation.dependencies[1]!.sourcePath;state.dependencySource=second;state.restorePath=dependencyDestination(r,reservation.id,second);
      await assert.rejects(copyMediaRestorationDependency(db.client,r.admin,r.id,r.generation,reservation.id,second));assert.equal(state.copies,2);
      assert.equal((await assets(r.s))[0].purge_status,'retained');
    });
  });
  it('an original dependency alias reuses its existing restoration receipt and bytes',async()=>{
    await dependencyCopyFixture(async(r,state,reservation)=>{
      state.restorePath=reservation.destinationPath;
      const original=await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);
      const copied=await copyMediaRestorationDependency(db.client,r.admin,r.id,r.generation,reservation.id,r.s.path);
      assert.equal(copied.reusedOriginal,true);assert.equal(copied.id,original.id);assert.equal(copied.objectId,original.objectId);assert.equal(copied.destinationPath,reservation.destinationPath);assert.equal(state.copies,2);
      assert.deepEqual(await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_dependency_copy_started'`),[]);
    },true);
  });
  it('competing dependency claims serialize one dispatch and keep cancellation blocked',{timeout:25_000},async()=>{
    await dependencyCopyFixture(async(r,_state,reservation)=>{
      const path=reservation.dependencies[0]!.sourcePath,a=await connect(),b=await connect(),token=randomUUID();let waiting:Promise<QueryResult>|undefined;
      const sql="SELECT advance_media_restoration_copy($1,$2,$3,$4,'copy_started',$5,p_source_path=>$6) AS receipt",args=[r.admin,r.id,r.generation,reservation.id,token,path];
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
        const first=(await a.client.query(sql,args)).rows[0].receipt;assert.equal(first.execute,true,JSON.stringify(first));
        waiting=b.client.query(sql,[...args.slice(0,4),randomUUID(),path]);void waiting.catch(()=>{});await blocked(a.pid,b.pid);await a.client.query('COMMIT');
        const second=(await waiting).rows[0].receipt;assert.equal(second.execute,false);assert.equal(second.token,token);assert.equal(second.destinationPath,first.destinationPath);
      } finally {await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
      assert.equal((await db.client.rpc('cancel_media_restoration',{...restorationArgs(r),p_reservation:reservation.id})).data?.error,'restoration_transfer_pending');
      const objects=(await db.client.from('media_asset_lifecycle_events').select('details').eq('media_asset_id',r.id).eq('event_type','restoration_dependencies_verified').maybeSingle()).data!.details.objects;
      const expected=objects.find((o:any)=>o.sourcePath===path);
      const completion={p_actor:r.admin,p_asset:r.id,p_generation:r.generation,p_reservation:reservation.id,p_source_path:path,p_phase:'copied',p_token:token,p_object_id:expected.objectId,p_object_version:expected.objectVersion,p_sha256:expected.sha256,p_size:expected.size};
      assert.equal((await db.client.rpc('advance_media_restoration_copy',completion)).data?.error,'restoration_copy_identity_changed');
      assert.equal((await db.client.rpc('advance_media_restoration_copy',{...completion,p_token:randomUUID()})).data?.error,'restoration_copy_authority_changed');
    });
  });

  it('restoration reservation preserves IDs and hidden state, is idempotent, and uses a new key after cancellation',async()=>{
    const r=await restorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);
      const before=await assets(r.s),sourceBefore=await db.query(`SELECT * FROM post_media WHERE id='${r.s.media}'`);
      const receipt=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      assert.equal(receipt.sources[0]!.id,r.s.media);assert.equal(receipt.parents[0]!.id,r.s.post);
      assert.equal(receipt.destinationPath,`_recovered/${r.id}/${receipt.id}/original.jpg`);
      assert.deepEqual(await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration'),receipt);
      assert.equal(state.copies,1);assert.equal(state.removes,1);assert.equal(state.objects.has(receipt.destinationPath),false);
      assert.deepEqual(await assets(r.s),before);assert.deepEqual(await db.query(`SELECT * FROM post_media WHERE id='${r.s.media}'`),sourceBefore);
      const held=await db.client.rpc('authorize_media_permanent_deletion',{...restorationArgs(r),p_reason:'Reviewed permanent deletion'});
      assert.equal((held.data as any).error,'retention_transfer_pending');
      const cancel={...restorationArgs(r),p_reservation:receipt.id,p_reason:'Cancel unused reservation'};
      const cancelled=await db.client.rpc('cancel_media_restoration',cancel);assert.equal(cancelled.error,null);assert.equal((cancelled.data as any).ok,true);
      assert.deepEqual((await db.client.rpc('cancel_media_restoration',cancel)).data,cancelled.data);
      const next=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      assert.notEqual(next.id,receipt.id);assert.notEqual(next.destinationPath,receipt.destinationPath);
      await db.client.rpc('cancel_media_restoration',{...cancel,p_reservation:next.id});
      assert.equal((await db.client.rpc('authorize_media_permanent_deletion',{...restorationArgs(r),p_reason:'Reviewed permanent deletion'})).data?.ok,true);
    });
  });

  it('a shared original requires every attachment withdrawn and reserves all existing source identities',async()=>{
    const s=await source(true),post=randomUUID(),media=randomUUID(),admin=(await db.seedUser('shared-restore-admin')).id;
    await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}';
      INSERT INTO posts(id,author_id,content,visibility,status) VALUES('${post}','${owner}','shared restore fixture','private','active');
      INSERT INTO post_media(id,post_id,user_id,storage_bucket,storage_path,media_type,mime_type,processing_status)
        VALUES('${media}','${post}','${owner}','post-media','${s.path}','image','image/jpeg','ready')`);
    await db.exec(`UPDATE post_media SET feed_storage_path='${s.path}.feed.jpg',feed_url='post-media/${s.path}.feed.jpg' WHERE id IN ('${s.media}','${media}')`);
    const recorded=await recordMediaAssetDetailed(db.client,s.input);assert.ok(recorded.assetId);
    await db.client.rpc('retire_media_asset',{p_asset:recorded.assetId,p_actor:owner});
    const r={s,id:recorded.assetId!,generation:String((await assets(s))[0].recovery_generation),objectId:randomUUID(),version:randomUUID(),admin};
    assert.equal((await db.client.rpc('withdraw_postcard_media',{p_actor:owner,p_post:s.post,p_media:s.media,p_expected_moderation:'pending'})).data,true);
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);
      assert.equal((await db.client.rpc('prepare_media_restoration',restorationArgs(r))).data?.error,'restoration_source_unavailable');
      assert.equal((await db.client.rpc('withdraw_postcard_media',{p_actor:owner,p_post:post,p_media:media,p_expected_moderation:'pending'})).data,true);
      const receipt=await prepareRetainedMediaRestoration(db.client,admin,r.id,r.generation,'Reviewed restoration');
      assert.deepEqual(receipt.sources.map(row=>row.id).sort(),[s.media,media].sort());
      assert.deepEqual(receipt.parents.map(row=>row.id).sort(),[s.post,post].sort());
      assert.equal(receipt.dependencies.length,1);assert.equal(receipt.dependencies[0]!.sourcePath,`${s.path}.feed.jpg`);
      assert.deepEqual(receipt.dependencies[0]!.references.map(ref=>ref.id).sort(),[s.media,media].sort());
      assert.equal((await db.query(`SELECT id FROM post_media WHERE storage_path='${s.path}'`)).length,2);
    });
  });

  it('a failed cancellation audit retains the restoration barrier and the original reservation',async()=>{
    const r=await restorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const receipt=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      await db.exec(`CREATE FUNCTION public.test_restore_cancel_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='restoration_cancelled' THEN RAISE EXCEPTION 'synthetic cancellation audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_restore_cancel_audit_failure BEFORE INSERT ON media_asset_lifecycle_events FOR EACH ROW EXECUTE FUNCTION test_restore_cancel_audit_failure()`);
      try {
        const result=await db.client.rpc('cancel_media_restoration',{...restorationArgs(r),p_reservation:receipt.id,p_reason:'Cancel review'});assert.ok(result.error);
      } finally {await db.exec('DROP TRIGGER test_restore_cancel_audit_failure ON media_asset_lifecycle_events; DROP FUNCTION test_restore_cancel_audit_failure()');}
      assert.equal((await db.client.rpc('authorize_media_permanent_deletion',restorationArgs(r))).data?.error,'retention_transfer_pending');
      assert.deepEqual(await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration'),receipt);
      assert.deepEqual(await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_cancelled'`),[]);
    });
  });

  it('restoration refuses unauthorized or stale reviews and a changed parent without resetting the existing reservation',async()=>{
    const r=await restorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);
      for(const args of [{...restorationArgs(r),p_actor:owner},{...restorationArgs(r),p_reason:' '},{...restorationArgs(r),p_generation:randomUUID()}]) {
        const result=await db.client.rpc('prepare_media_restoration',args);assert.equal(result.error,null);assert.equal((result.data as any).ok,false);
      }
      const receipt=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      const changedReason=await db.client.rpc('prepare_media_restoration',{...restorationArgs(r),p_reason:'Different review'});
      assert.equal((changedReason.data as any).error,'restoration_review_changed');
      await db.exec(`UPDATE posts SET content='changed while under review' WHERE id='${r.s.post}'`);
      assert.equal((await db.client.rpc('prepare_media_restoration',restorationArgs(r))).data?.error,'restoration_review_changed');
      const receipts=await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_prepared'`);
      assert.deepEqual(receipts,[{id:receipt.id}]);
      for(const role of ['anon','authenticated']) for(const fn of ['prepare_media_restoration(uuid,uuid,uuid,text,uuid,jsonb)','cancel_media_restoration(uuid,uuid,uuid,uuid,text,text,text,uuid)']) {
        assert.equal((await db.query(`SELECT has_function_privilege('${role}','${fn}','EXECUTE') AS allowed`))[0].allowed,false);
      }
    });
  });

  it('restoration requires settled copy receipts, withdrawn source provenance and actual retained bytes',async()=>{
    const r=await restorationSource();
    await withCopyStorage(r,async state=>{
      assert.equal((await db.client.rpc('prepare_media_restoration',restorationArgs(r))).data?.error,'retained_original_unverified');
      await settleRestorationOriginal(r,state);state.objects.clear();
      await assert.rejects(prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration'),/identity unavailable/);
      assert.deepEqual(await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_prepared'`),[]);
    });
    const live=await retainedOriginal();
    assert.equal((await db.client.rpc('prepare_media_restoration',{p_actor:r.admin,p_asset:live.id,p_generation:live.generation,p_reason:'Reviewed restoration'})).data?.error,'restoration_source_unavailable');
  });

  it('a lost restoration acknowledgement returns the same persisted reservation without storage writes',async()=>{
    const r=await restorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const rpc=db.client.rpc;
      db.client.rpc=(async(name:string,args:any)=>{const result=await rpc.call(db.client,name,args);return name==='prepare_media_restoration' && !result.error?{data:null,error:{message:'synthetic lost receipt'}}:result;}) as typeof rpc;
      try {await assert.rejects(prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration'),/unconfirmed/);} finally {db.client.rpc=rpc;}
      const [saved]=await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_prepared'`);
      assert.equal((await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration')).id,saved.id);
      assert.equal(state.copies,1);assert.equal(state.removes,1);
    });
  });

  for(const first of ['restore','purge']) it(`${first} serializes against the other content lifecycle decision`,{timeout:25_000},async()=>{
    const r=await restorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const a=await connect(),b=await connect();let waiting:Promise<QueryResult>|undefined;
      const args=[r.admin,r.id,r.generation,'Reviewed restoration'];
      const restore={text:"SELECT prepare_media_restoration($1,$2,$3,$4,NULL,$5::jsonb) AS receipt",values:[...args,JSON.stringify(await referenceReview(r))]},purge={text:"SELECT authorize_media_permanent_deletion($1,$2,$3,$4) AS receipt",values:args};
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
        assert.equal((await a.client.query(first==='restore'?restore:purge)).rows[0].receipt.ok,true);
        waiting=b.client.query(first==='restore'?purge:restore);void waiting.catch(()=>{});
        await blocked(a.pid,b.pid);await a.client.query('COMMIT');
        assert.equal((await waiting).rows[0].receipt.error,first==='restore'?'retention_transfer_pending':'retention_changed');
      } finally {await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
    });
  });

  for(const first of ['restore','account']) it(`${first} serializes restoration against account permanent deletion`,{timeout:25_000},async()=>{
    const user=(await db.seedUser('restore-account-race')).id,r=await restorationSource(user);
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);
      const request=await db.client.rpc('request_recoverable_account_deletion',{p_user:user});assert.equal(request.error,null);
      const a=await connect(),b=await connect();let waiting:Promise<QueryResult>|undefined;
      const restore={text:'SELECT prepare_media_restoration($1,$2,$3,$4,NULL,$5::jsonb) AS receipt',values:[r.admin,r.id,r.generation,'Reviewed restoration',JSON.stringify(await referenceReview(r))]};
      const account={text:'SELECT claim_account_permanent_deletion($1,$2,$3,$4,$5,1) AS receipt',values:[r.admin,user,(request.data as any).generation,randomUUID(),'Reviewed account erasure']};
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
        assert.equal((await a.client.query(first==='restore'?restore:account)).rows[0].receipt.ok,true);
        waiting=b.client.query(first==='restore'?account:restore);void waiting.catch(()=>{});
        await blocked(a.pid,b.pid);await a.client.query('COMMIT');
        assert.equal((await waiting).rows[0].receipt.error,first==='restore'?'retention_transfer_pending':'permanent_deletion_started');
      } finally {await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
    });
  });

  for(const mode of ['normal','lost-response']) it(`copies restoration original once into its reserved private key across ${mode}`,async()=>{
    const r=await restorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      const before=await assets(r.s),sources=await db.query(`SELECT * FROM post_media WHERE id='${r.s.media}'`);
      state.restorePath=reservation.destinationPath;state.mode=mode;
      const copied=await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);
      assert.equal(copied.reservationId,reservation.id);assert.notEqual(copied.objectId,reservation.objectId);
      assert.deepEqual(await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id),copied);
      assert.equal(state.copies,2);assert.equal(state.removes,1);assert.equal(state.objects.has(r.s.path),false);
      assert.equal(state.objects.has(reservation.retainedPath),true);assert.equal(state.objects.has(reservation.destinationPath),true);
      assert.deepEqual(await assets(r.s),before);assert.deepEqual(await db.query(`SELECT * FROM post_media WHERE id='${r.s.media}'`),sources);
      assert.equal((await db.client.rpc('cancel_media_restoration',{...restorationArgs(r),p_reservation:reservation.id})).data?.error,'restoration_transfer_pending');
      assert.equal((await db.client.rpc('authorize_media_permanent_deletion',restorationArgs(r))).data?.error,'retention_transfer_pending');
    });
  });

  for(const mode of ['pending','hung']) it(`reconciles ${mode} restoration copy without redispatch`,async()=>{
    const r=await restorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.restorePath=reservation.destinationPath;state.mode=mode;
      await assert.rejects(copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id,{operationTimeoutMs:100}),/identity unavailable/);
      await assert.rejects(copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id),/outcome unknown/);assert.equal(state.copies,2);
      state.mode='normal';state.complete();
      assert.equal((await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id)).reservationId,reservation.id);assert.equal(state.copies,2);
    });
  });

  for(const phase of ['copy_started','copied']) it(`lost restoration ${phase} acknowledgement preserves its durable operation`,async()=>{
    const r=await restorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.restorePath=reservation.destinationPath;const rpc=db.client.rpc;
      db.client.rpc=(async(name:string,args:any)=>{const result=await rpc.call(db.client,name,args);return name==='advance_media_restoration_copy' && args.p_phase===phase && !result.error ? {data:null,error:{message:'synthetic lost receipt'}}:result;}) as typeof rpc;
      try {await assert.rejects(copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id),/unconfirmed/);} finally {db.client.rpc=rpc;}
      const copies=state.copies;
      if(phase==='copy_started')await assert.rejects(copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id),/outcome unknown/);
      else {
        const [saved]=await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_copied'`);
        assert.equal((await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id)).id,saved.id);
      }
      assert.equal(state.copies,copies);
    });
  });

  it('corrupt restoration bytes are not acknowledged or overwritten by a retry',async()=>{
    const r=await restorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.restorePath=reservation.destinationPath;state.mode='corrupt';
      for(let attempt=0;attempt<2;attempt++)await assert.rejects(copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id),/integrity mismatch/);
      assert.equal(state.copies,2);assert.equal(state.objects.has(reservation.retainedPath),true);
      assert.deepEqual(await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_copied'`),[]);
    });
  });

  for(const fault of ['occupied','cancelled','review-changed','admin-revoked']) it(`refuses restoration dispatch when ${fault} without allocating another reservation`,async()=>{
    const r=await restorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      state.restorePath=reservation.destinationPath;
      if(fault==='occupied')state.complete();
      if(fault==='cancelled')assert.equal((await db.client.rpc('cancel_media_restoration',{...restorationArgs(r),p_reservation:reservation.id})).data?.ok,true);
      if(fault==='review-changed')await db.exec(`UPDATE posts SET content='changed review' WHERE id='${r.s.post}'`);
      if(fault==='admin-revoked')await db.exec(`UPDATE profiles SET role='user' WHERE id='${r.admin}'`);
      await assert.rejects(copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id));assert.equal(state.copies,1);
      assert.equal((await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_prepared'`)).length,1);
      assert.deepEqual(await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_copy_started'`),[]);
    });
  });

  it('records an authorized physical copy after review revocation but does not activate or renew authority',async()=>{
    const r=await restorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      const before=await assets(r.s);state.restorePath=reservation.destinationPath;
      state.beforeCopy=async()=>{await db.exec(`UPDATE posts SET content='review changed during provider write' WHERE id='${r.s.post}'; UPDATE profiles SET role='user' WHERE id='${r.admin}'`);};
      const result=await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id);
      assert.equal(result.reservationId,reservation.id);assert.deepEqual(await assets(r.s),before);
      assert.equal((await db.client.rpc('prepare_media_restoration',restorationArgs(r))).data?.error,'admin_required');
      assert.deepEqual(await copyMediaRestorationOriginal(db.client,r.admin,r.id,r.generation,reservation.id),result);assert.equal(state.copies,2);
    });
  });

  for(const first of ['copy','cancel']) it(`${first} serializes restoration dispatch and cancellation`,{timeout:25_000},async()=>{
    const r=await restorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      const a=await connect(),b=await connect();let waiting:Promise<QueryResult>|undefined;
      const copy={text:"SELECT advance_media_restoration_copy($1,$2,$3,$4,'copy_started',$5) AS receipt",values:[r.admin,r.id,r.generation,reservation.id,randomUUID()]};
      const cancel={text:'SELECT cancel_media_restoration($1,$2,$3,$4,$5) AS receipt',values:[r.admin,r.id,r.generation,reservation.id,'Cancel unused review']};
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
        assert.equal((await a.client.query(first==='copy'?copy:cancel)).rows[0].receipt.ok,true);
        waiting=b.client.query(first==='copy'?cancel:copy);void waiting.catch(()=>{});await blocked(a.pid,b.pid);await a.client.query('COMMIT');
        assert.equal((await waiting).rows[0].receipt.error,first==='copy'?'restoration_transfer_pending':'restoration_review_changed');
      } finally {await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
      assert.equal((await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${r.id}' AND event_type='restoration_prepared'`)).length,1);
    });
  });

  it('competing restoration copy claims grant one dispatch and refuse mismatched completion',{timeout:25_000},async()=>{
    const r=await restorationSource();
    await withCopyStorage(r,async state=>{
      await settleRestorationOriginal(r,state);const reservation=await prepareRetainedMediaRestoration(db.client,r.admin,r.id,r.generation,'Reviewed restoration');
      const a=await connect(),b=await connect(),token=randomUUID();let waiting:Promise<QueryResult>|undefined;
      const statement="SELECT advance_media_restoration_copy($1,$2,$3,$4,'copy_started',$5) AS receipt",args=[r.admin,r.id,r.generation,reservation.id,token];
      try {
        await a.client.query('BEGIN; SET LOCAL ROLE service_role');await b.client.query('SET ROLE service_role');
        assert.equal((await a.client.query(statement,args)).rows[0].receipt.execute,true);
        waiting=b.client.query(statement,[...args.slice(0,4),randomUUID()]);void waiting.catch(()=>{});await blocked(a.pid,b.pid);await a.client.query('COMMIT');
        assert.deepEqual((await waiting).rows[0].receipt,{ok:true,execute:false,token});
      } finally {await a.client.query('ROLLBACK');await waiting?.catch(()=>{});}
      const completion={...restorationArgs(r),p_reservation:reservation.id,p_phase:'copied',p_token:token,p_object_id:reservation.objectId,p_object_version:'changed',p_sha256:reservation.sha256,p_size:reservation.size};
      const {p_reason:unused,...input}=completion;void unused;
      assert.equal((await db.client.rpc('advance_media_restoration_copy',input)).data?.error,'restoration_copy_identity_changed');
      assert.equal((await db.client.rpc('advance_media_restoration_copy',{...input,p_token:randomUUID()})).data?.error,'restoration_copy_authority_changed');
      for(const role of ['anon','authenticated'])assert.equal((await db.query(`SELECT has_function_privilege('${role}','advance_media_restoration_copy(uuid,uuid,uuid,uuid,text,uuid,uuid,text,text,bigint,text)','EXECUTE') AS allowed`))[0].allowed,false);
    });
  });

  for(const namespace of ['_retained','_recovered','manual-captions']) it(`${namespace} Storage policy protects reads and writes even with another permissive policy, and readiness detects drift`,async()=>{
    const session=await connect(),retained=`${namespace}/${randomUUID()}/${randomUUID()}/original`,ordinary=`${owner}/ordinary-${randomUUID()}.jpg`;
    await session.client.query('BEGIN');
    try {
      await session.client.query(`INSERT INTO storage.objects(id,bucket_id,name) VALUES(gen_random_uuid(),'post-media',$1),(gen_random_uuid(),'post-media',$2)`,[retained,ordinary]);
      await session.client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated; CREATE POLICY test_retention_permissive ON storage.objects FOR ALL TO anon,authenticated USING(true) WITH CHECK(true)');
      for(const role of ['anon','authenticated']) {
        await session.client.query(`SET LOCAL ROLE ${role}`);
        assert.equal((await session.client.query('SELECT id FROM storage.objects WHERE name=$1',[retained])).rowCount,0);
        assert.equal((await session.client.query('SELECT id FROM storage.objects WHERE name=$1',[ordinary])).rowCount,1);
        assert.equal((await session.client.query('DELETE FROM storage.objects WHERE name=$1',[retained])).rowCount,0);
        assert.equal((await session.client.query('UPDATE storage.objects SET name=$1 WHERE name=$2',[`${owner}/escaped.jpg`,retained])).rowCount,0);
        for(const statement of [
          {sql:"INSERT INTO storage.objects(id,bucket_id,name) VALUES(gen_random_uuid(),'post-media',$1)",args:[`${retained}-planted`]},
          {sql:'UPDATE storage.objects SET name=$1 WHERE name=$2',args:[`${retained}-renamed`,ordinary]},
        ]) {
          await session.client.query('SAVEPOINT denied_write');
          await assert.rejects(session.client.query(statement.sql,statement.args),/row-level security/);
          await session.client.query('ROLLBACK TO SAVEPOINT denied_write');
        }
      }
      await session.client.query('SET LOCAL ROLE postgres');
      assert.equal((await session.client.query('SELECT public.postcard_canonical_lifecycle_ready() AS ready')).rows[0].ready,true);
      await session.client.query('ALTER POLICY media_retention_namespace ON storage.objects USING(true) WITH CHECK(true)');
      assert.equal((await session.client.query('SELECT public.postcard_canonical_lifecycle_ready() AS ready')).rows[0].ready,false);
    } finally {await session.client.query('ROLLBACK');}
    assert.equal((await db.client.rpc('postcard_canonical_lifecycle_ready')).data,true);
  });

  it('settled translation outputs remain retained until the same source receives admin permanent authority', async () => {
    const s=await source(),first=await recordMediaAssetDetailed(db.client,s.input);assert.ok(first.assetId);
    const artifact=randomUUID(),token=randomUUID(),version=first.assetVersion;
    await db.exec(`INSERT INTO media_caption_translation_artifacts(id,write_token,asset_id,owner_user_id,source_version,kind,storage_path,intent,write_state,write_settled_at)
      VALUES('${artifact}','${token}','${first.assetId}','${owner}',${version},'publication','manual-captions/${first.assetId}/v${version}-retention-proof.json','{"output_revision":"retention-proof"}','uploaded',now())`);
    const before=(await db.query(`SELECT to_jsonb(a) AS receipt FROM media_caption_translation_artifacts a WHERE id='${artifact}'`))[0].receipt;
    await db.client.rpc('retire_media_asset',{p_asset:first.assetId,p_actor:owner});
    const refused=await db.client.rpc('media_caption_translation_artifact_retire',{p_expected:before});assert.equal(refused.error,null);assert.equal(refused.data,null);
    assert.deepEqual((await db.query(`SELECT to_jsonb(a) AS receipt FROM media_caption_translation_artifacts a WHERE id='${artifact}'`))[0].receipt,before);
    const admin=(await db.seedUser('translation-retention-admin')).id;await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'`);
    const retained=(await assets(s))[0];
    const authorized=await db.client.rpc('authorize_media_permanent_deletion',{p_actor:admin,p_asset:first.assetId,p_generation:retained.recovery_generation,p_reason:'Remove retained translation with its source'});
    assert.equal(authorized.error,null);assert.equal((authorized.data as any).ok,true);
    const allowed=await db.client.rpc('media_caption_translation_artifact_retire',{p_expected:before});assert.equal(allowed.error,null);assert.ok((allowed.data as any)?.retirement_token);
  });

});
