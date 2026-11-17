import { installMediaDeliveryFixture } from "../helpers/mediaDeliveryFixture.js";
/** Account recovery and permanent deletion contend on one existing receipt. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Client, type QueryResult } from 'pg';
import express from 'express';
import { createServer, type Server } from 'node:http';
import adminRouter from '../../routes/admin.js';
import profileRouter from '../../routes/profile.js';
import mediaFileRouter from '../../routes/mediaFile.js';
import {recordMediaAssetDetailed} from '../../lib/mediaAssets.js';
import {eraseAccountMedia} from '../../services/accountDeletion/accountMediaDeletion.js';
import {_clearMediaAccessCache} from '../../lib/mediaAccess.js';
import { _setTestClient } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { executeAccountDeletion, reconcileAccountDeletion } from '../../services/accountDeletion/AccountDeletionService.js';
import { openPressedLayoverDb, PRESSED_SKIP_REASON } from './pressedLayoverDb.js';

describe('account recovery authority', { skip: PRESSED_SKIP_REASON }, () => {
  let db: Awaited<ReturnType<typeof openPressedLayoverDb>>, admin: string, adminToken: string, server: Server, base: string;
  const sessions: Client[] = [];
  before(async () => {
    db = await openPressedLayoverDb(); const staff = await db.seedUser('recovery-admin'); admin = staff.id; adminToken = staff.token;
    await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'`); _setTestClient(db.client, true);
    const app = express(); app.use((req, _res, next) => { req.log = logger; next(); }); app.use(express.json()); app.use(adminRouter); app.use(profileRouter); app.use(mediaFileRouter);
    server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); _setTestClient(null, false); await Promise.all(sessions.map(s => s.end())); await db?.close(); });
  async function http(method: string, path: string, token: string, payload?: unknown) {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
    const body = z.object({ scheduledAt: z.string().nullable().optional(), recoveryGeneration: z.string().uuid().optional(), recovered: z.boolean().optional(), accountStatus: z.string().optional(), requests: z.array(z.object({ user_id: z.string().nullable(), recovery_verified: z.boolean(), deletion_request_id: z.string().uuid(), can_reconcile: z.boolean() }).passthrough()).optional() }).passthrough().parse(await r.json());
    return { status: r.status, body };
  }
  const rpc = async (name: string, args: Record<string, unknown>) => { const r = await db.client.rpc(name, args); assert.equal(r.error, null, JSON.stringify(r)); return r.data as any; };
  async function source() {
    const user = (await db.seedUser('recoverable-owner')).id;
    const request = await rpc('request_recoverable_account_deletion', { p_user: user }); assert.equal(request.ok, true, JSON.stringify(request));
    return { user, generation: String(request.generation), request };
  }
  const restore = (s: { user: string; generation: string }, actor = s.user) => rpc('recover_deleted_account', { p_actor: actor, p_user: s.user, p_generation: s.generation, p_reason: 'Synthetic recovery proof' });
  const claim = (s: { user: string; generation: string }, actor: string | null = admin) => rpc('claim_account_permanent_deletion', { p_actor: actor, p_user: s.user, p_generation: s.generation, p_token: randomUUID(), p_reason: 'Synthetic permanent deletion proof', p_protocol: 1 });
  const state = (user: string) => db.query(`SELECT status,requested_at,recovery_generation,execution_started_at,execution_token FROM user_deletion_requests WHERE user_id='${user}'`);

  async function withMediaDelivery(run:(signed:string[])=>Promise<void>){
    const from=db.client.storage.from,signed:string[]=[];_clearMediaAccessCache();
    const previousUrl=process.env.SUPABASE_URL;process.env.SUPABASE_URL='https://synthetic-recovery-storage.example.test';
    const restoreDelivery=installMediaDeliveryFixture(read=>signed.push(`${read.bucket}/${read.path}`));
    db.client.storage.from=((bucket:string)=>({...from.call(db.client.storage,bucket),
      createSignedUrl:async()=>{throw new Error('Provider signing must be retired');},
      info:async()=>({data:null,error:{status:404,statusCode:'NoSuchKey',message:'Synthetic erased object'}}),
      remove:async()=>({data:[],error:null}),
    })) as typeof from;
    try{await run(signed);}finally{restoreDelivery();if(previousUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=previousUrl;db.client.storage.from=from;_clearMediaAccessCache();}
  }
  const mediaStatus=async(token:string,bucket:string,path:string)=>(await fetch(`${base}/media/file/${bucket}/${path}?viewer=${db.tokens[token]}`,{headers:{authorization:`Bearer ${token}`},redirect:'manual'})).status;
  it('account deletion stops new byte delivery before and after canonical media erasure, including a warm avatar cache',async()=>{
    const owner=await db.seedUser('media-erasure-viewer'),path=`${owner.id}/previous.jpg`,avatar=`avatars/${owner.id}/avatar.jpg`;
    await db.setFlag('media_canonical_enabled',true);await db.setFlag('media_canonical_schema_fallback_enabled',false);
    const asset=await recordMediaAssetDetailed(db.client,{ownerUserId:owner.id,storageBucket:'post-media',storagePath:path,publicUrl:`post-media/${path}`,mediaType:'image',mimeType:'image/jpeg',sizeBytes:100,sourceType:'user'});assert.ok(asset.assetId);
    await withMediaDelivery(async signed=>{
      assert.equal(await mediaStatus(owner.token,'post-media',path),200);assert.equal(await mediaStatus(owner.token,'profile-media',avatar),200);
      const request=await rpc('request_recoverable_account_deletion',{p_user:owner.id});
      const afterRequest=await mediaStatus(owner.token,'post-media',path),avatarAfterRequest=await mediaStatus(owner.token,'profile-media',avatar);
      const c=await claim({user:owner.id,generation:request.generation});assert.equal(c.ok,true);
      const erased=await eraseAccountMedia(db.client,owner.id);assert.equal(erased,1);
      assert.deepEqual(await db.query(`SELECT id FROM media_assets WHERE id='${asset.assetId}'`),[]);
      assert.deepEqual(await db.query(`SELECT id FROM media_asset_lifecycle_events WHERE media_asset_id='${asset.assetId}'`),[]);
      const issued=signed.length,afterErasure=await mediaStatus(owner.token,'post-media',path);
      const batch=await fetch(`${base}/media/sign`,{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'application/json'},body:JSON.stringify({urls:[`post-media/${path}`,`profile-media/${avatar}`]})});
      const result=await batch.json() as {signed:Record<string,string|null>};
      assert.deepEqual([afterRequest,avatarAfterRequest,afterErasure],[403,403,403]);
      assert.equal(batch.status,200);assert.deepEqual(result.signed,{[`post-media/${path}`]:null,[`profile-media/${avatar}`]:null});assert.equal(signed.length,issued);
      assert.equal((await restore({user:owner.id,generation:request.generation},admin)).error,'permanent_deletion_started');
    });
  });
  it('legacy active profiles with started permanent deletion cannot read media',async()=>{
    const owner=await db.seedUser('legacy-media-erasure'),path=`${owner.id}/previous.jpg`;
    await db.exec(`INSERT INTO user_deletion_requests(user_id,status,execution_started_at) VALUES('${owner.id}','failed',clock_timestamp())`);
    await withMediaDelivery(async signed=>{assert.equal(await mediaStatus(owner.token,'post-media',path),403);assert.equal(signed.length,0);});
  });
  it('explicit owner recovery restores media eligibility without bypassing the recovery command',async()=>{
    const owner=await db.seedUser('media-owner-recovery'),path=`${owner.id}/preview.jpg`;
    await withMediaDelivery(async()=>{
      assert.equal(await mediaStatus(owner.token,'post-media',path),200);
      const request=await rpc('request_recoverable_account_deletion',{p_user:owner.id});
      assert.equal(await mediaStatus(owner.token,'post-media',path),403);
      assert.equal((await http('GET','/me/account-status',owner.token)).status,200);
      assert.equal((await restore({user:owner.id,generation:request.generation})).ok,true);
      assert.equal(await mediaStatus(owner.token,'post-media',path),200);
    });
  });

  it('missing account snapshot schema denies fresh byte delivery even with warm avatar authority',async()=>{
    const owner=await db.seedUser('missing-media-account-snapshot'),path=`avatars/${owner.id}/avatar.jpg`;
    await withMediaDelivery(async signed=>{
      assert.equal(await mediaStatus(owner.token,'profile-media',path),200);
      await db.exec('ALTER FUNCTION account_recovery_status(uuid) RENAME TO test_unavailable_account_recovery_status');
      try {const issued=signed.length;assert.equal(await mediaStatus(owner.token,'profile-media',path),403);assert.equal(signed.length,issued);}
      finally {await db.exec('ALTER FUNCTION test_unavailable_account_recovery_status(uuid) RENAME TO account_recovery_status');}
      assert.equal(await mediaStatus(owner.token,'profile-media',path),200);
    });
  });
  it('media account snapshot refuses missing profiles and current restrictions, including legacy deactivation rows',async()=>{
    const owner=await db.seedUser('media-account-snapshot');
    assert.equal(await rpc('account_recovery_status',{p_user:randomUUID()}),null);
    const read=()=>rpc('account_recovery_status',{p_user:owner.id});
    assert.equal((await read()).mediaAccessAllowed,true);
    for(const restriction of ['banned','suspended','deactivated']){
      await db.exec(`INSERT INTO user_account_states(user_id,state,reason) VALUES('${owner.id}','${restriction}','Synthetic media account restriction')`);
      assert.equal((await read()).mediaAccessAllowed,false);
      await db.exec(`UPDATE user_account_states SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id='${owner.id}' AND state='${restriction}'`);
      assert.equal((await read()).mediaAccessAllowed,true);
    }
  });
  it('deletion hides the profile without a purge deadline; retries preserve the recovery clock and generation', async () => {
    const s = await source(), before = await state(s.user);
    assert.equal(s.request.scheduledAt, null);
    assert.deepEqual(await db.query(`SELECT account_status FROM profiles WHERE id='${s.user}'`), [{ account_status: 'deactivated' }]);
    assert.deepEqual(await rpc('request_recoverable_account_deletion', { p_user: s.user }), s.request);
    assert.deepEqual(await state(s.user), before);
    const dates = await db.query<{ days: number }>(`SELECT extract(epoch FROM ('${s.request.selfRecoverableUntil}'::timestamptz-requested_at))/86400 AS days FROM user_deletion_requests WHERE user_id='${s.user}'`);
    assert.equal(Number(dates[0].days), 90);
  });
  it('owner recovery is atomic and idempotent; a new deletion generation rejects stale recovery', async () => {
    const s = await source(); assert.equal((await restore(s)).ok, true);
    assert.equal((await restore(s)).alreadyRecovered, true);
    assert.deepEqual(await db.query(`SELECT account_status FROM profiles WHERE id='${s.user}'`), [{ account_status: 'active' }]);
    assert.equal((await db.query(`SELECT id FROM moderation_actions WHERE target_user_id='${s.user}' AND action_type='deleted_profile_recovered'`)).length, 1);
    const next = await rpc('request_recoverable_account_deletion', { p_user: s.user }); assert.notEqual(next.generation, s.generation);
    assert.equal((await restore(s)).error, 'deletion_changed');
  });
  it('owner recovery expires at 90 days; admin recovery remains available indefinitely', async () => {
    const s = await source(); await db.exec(`UPDATE user_deletion_requests SET requested_at=clock_timestamp()-interval '90 days' WHERE user_id='${s.user}'`);
    assert.equal((await restore(s)).error, 'self_recovery_expired');
    await db.exec(`UPDATE user_deletion_requests SET requested_at=clock_timestamp()-interval '10 years' WHERE user_id='${s.user}'`);
    assert.equal((await restore(s, admin)).ok, true);
  });
  it('an admin restores the profile without lifting a ban or widening privacy', async () => {
    const user = (await db.seedUser('private-recovery')).id;
    await db.exec(`INSERT INTO profile_privacy_settings(user_id,allow_profile_discovery) VALUES('${user}',false) ON CONFLICT(user_id) DO UPDATE SET allow_profile_discovery=false;
      INSERT INTO user_account_states(user_id,state,reason) VALUES('${user}','banned','independent sanction')`);
    const r = await rpc('request_recoverable_account_deletion', { p_user: user }); const s = { user, generation: r.generation };
    assert.equal((await restore(s)).error, 'recovery_forbidden'); assert.equal((await restore(s, admin)).ok, true);
    assert.deepEqual(await db.query(`SELECT state,expires_at FROM user_account_states WHERE user_id='${user}'`), [{ state: 'banned', expires_at: null }]);
    assert.deepEqual(await db.query(`SELECT allow_profile_discovery FROM profile_privacy_settings WHERE user_id='${user}'`), [{ allow_profile_discovery: false }]);
  });
  it('audit failure rolls restoration and permanent authorization back with their profile/request state', async () => {
    const s = await source(), initial = await state(s.user);
    await db.exec(`CREATE FUNCTION public.test_recovery_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic recovery audit failure'; END $$;
      CREATE TRIGGER test_recovery_audit_failure BEFORE INSERT ON moderation_actions FOR EACH ROW EXECUTE FUNCTION public.test_recovery_audit_failure()`);
    try {
      for (const sql of [`SELECT public.recover_deleted_account('${admin}','${s.user}','${s.generation}','test')`, `SELECT public.claim_account_permanent_deletion('${admin}','${s.user}','${s.generation}','${randomUUID()}','test',1)`]) await assert.rejects(db.exec(sql), /synthetic recovery audit failure/);
      assert.deepEqual(await state(s.user), initial);
      assert.deepEqual(await db.query(`SELECT account_status FROM profiles WHERE id='${s.user}'`), [{ account_status: 'deactivated' }]);
    } finally { await db.exec('DROP TRIGGER test_recovery_audit_failure ON moderation_actions; DROP FUNCTION public.test_recovery_audit_failure()'); }
  });
  it('only an explicit admin claim can start permanent deletion; partial failure never reopens recovery', async () => {
    const s = await source(); assert.equal((await claim(s, null)).error, 'admin_permanent_deletion_required'); assert.equal((await claim(s, s.user)).error, 'admin_permanent_deletion_required');
    const c = await claim(s); assert.equal(c.ok, true); assert.equal((await claim(s)).error, 'deletion_not_claimable');
    assert.equal((await restore(s, admin)).error, 'permanent_deletion_started');
    assert.equal(await rpc('finish_account_deletion_attempt', { p_request: c.requestId, p_token: randomUUID(), p_success: false }), false);
    assert.equal(await rpc('finish_account_deletion_attempt', { p_request: c.requestId, p_token: c.token, p_success: false }), true);
    assert.equal((await restore(s, admin)).error, 'permanent_deletion_started');
    assert.equal((await claim(s)).ok, true);
  });
  it('legacy pending requests are not assumed intact; client roles cannot call the service commands', async () => {
    const user = (await db.seedUser('legacy-recovery')).id;
    await db.exec(`INSERT INTO user_deletion_requests(user_id,status,scheduled_at) VALUES('${user}','pending',NULL)`);
    const r = (await db.query<{ recovery_generation: string }>(`SELECT recovery_generation FROM user_deletion_requests WHERE user_id='${user}'`))[0];
    assert.equal((await restore({ user, generation: r.recovery_generation }, admin)).error, 'legacy_recovery_unverified');
    for (const fn of ['reactivate_deactivated_account_admin(uuid,uuid,uuid,text)','account_recovery_status(uuid)','set_account_self_deactivation(uuid)','reactivate_self_deactivated_account(uuid)','lock_recoverable_account_identity(uuid)','request_recoverable_account_deletion(uuid)','recover_deleted_account(uuid,uuid,uuid,text)','claim_account_permanent_deletion(uuid,uuid,uuid,uuid,text)','claim_account_permanent_deletion(uuid,uuid,uuid,uuid,text,integer)','finish_account_deletion_attempt(uuid,uuid,boolean)']) {
      const rows = await db.query<{ allowed: boolean }>(`SELECT has_function_privilege(role,'public.${fn}','EXECUTE') AS allowed FROM (VALUES('anon'),('authenticated')) r(role)`); assert.ok(rows.every(r => !r.allowed));
    }
  });
  it('mounted owner/admin routes enforce the same recovery window and refuse the old reactivation bypass', async () => {
    const owner = await db.seedUser('mounted-recovery');
    const held = await http('POST', '/me/delete-request', owner.token); assert.equal(held.status, 200, JSON.stringify(held)); assert.equal(held.body.scheduledAt, null);
    const current = await http('GET', '/me/delete-request', owner.token); assert.equal(current.status, 200); assert.equal(current.body.recoveryGeneration, held.body.recoveryGeneration);
    await db.exec(`UPDATE user_deletion_requests SET requested_at=clock_timestamp()-interval '91 days' WHERE user_id='${owner.id}'`);
    assert.equal((await http('DELETE', '/me/delete-request', owner.token)).status, 409);
    assert.equal((await http('POST', '/me/reactivate', owner.token)).status, 409);
    await assert.rejects(db.exec(`UPDATE profiles SET account_status='active' WHERE id='${owner.id}'`), /profile_requires_authorized_recovery/);
    const forbidden = await http('POST', `/admin/deletion-requests/${owner.id}/recover`, owner.token, { generation: held.body.recoveryGeneration, reason: 'Unauthorized restore' }); assert.equal(forbidden.status, 403);
    const queue = await http('GET', '/admin/deletion-requests', adminToken); assert.equal(queue.status, 200); assert.ok(queue.body.requests?.some((r) => r.user_id === owner.id && r.recovery_verified));
    const restored = await http('POST', `/admin/deletion-requests/${owner.id}/recover`, adminToken, { generation: held.body.recoveryGeneration, reason: 'Admin approved profile recovery' }); assert.equal(restored.status, 200, JSON.stringify(restored)); assert.equal(restored.body.recovered, true);
    const next = await http('POST', '/me/delete-request', owner.token); assert.equal(next.status, 200);
    const self = await http('DELETE', '/me/delete-request', owner.token); assert.equal(self.status, 200, JSON.stringify(self)); assert.equal(self.body.accountStatus, 'active');
  });
  it('personal deactivation has a separate one-year window, no duplicate clock reset, and preserves privacy', async () => {
    const owner = await db.seedUser('self-deactivation');
    await db.exec(`INSERT INTO profile_privacy_settings(user_id,allow_profile_discovery) VALUES('${owner.id}',false) ON CONFLICT(user_id) DO UPDATE SET allow_profile_discovery=false`);
    const first = await http('POST', '/me/deactivate', owner.token); assert.equal(first.status, 200, JSON.stringify(first));
    const before = await db.query(`SELECT created_at,set_by FROM user_account_states WHERE user_id='${owner.id}' AND state='deactivated'`);
    assert.equal((await http('POST', '/me/deactivate', owner.token)).status, 200); assert.deepEqual(await db.query(`SELECT created_at,set_by FROM user_account_states WHERE user_id='${owner.id}' AND state='deactivated'`), before);
    await db.exec(`UPDATE user_account_states SET created_at=clock_timestamp()-interval '11 months' WHERE user_id='${owner.id}' AND state='deactivated'`);
    assert.equal((await http('POST', '/me/reactivate', owner.token)).status, 200);
    assert.deepEqual(await db.query(`SELECT allow_profile_discovery FROM profile_privacy_settings WHERE user_id='${owner.id}'`), [{ allow_profile_discovery: false }]);
    assert.equal((await http('POST', '/me/deactivate', owner.token)).status, 200);
    await db.exec(`UPDATE user_account_states SET created_at=clock_timestamp()-interval '1 year' WHERE user_id='${owner.id}' AND state='deactivated'`);
    assert.equal((await http('POST', '/me/reactivate', owner.token)).status, 409);
    assert.equal((await http('POST', '/me/deactivate', owner.token)).status, 200);
    assert.equal((await http('POST', '/me/reactivate', owner.token)).status, 409, 'repeated deactivation cannot reset the expired clock');
    await assert.rejects(db.exec(`UPDATE profiles SET account_status='active' WHERE id='${owner.id}'`), /profile_requires_authorized_reactivation/);
    assert.deepEqual(await db.query(`SELECT account_status FROM profiles WHERE id='${owner.id}'`), [{ account_status: 'deactivated' }]);
  });
  it('a deletion cannot be changed into personal deactivation to bypass the 90-day window', async () => {
    const owner = await db.seedUser('deletion-not-deactivation'); assert.equal((await http('POST', '/me/delete-request', owner.token)).status, 200);
    await db.exec(`UPDATE user_deletion_requests SET requested_at=clock_timestamp()-interval '91 days' WHERE user_id='${owner.id}'`);
    assert.equal((await http('POST', '/me/deactivate', owner.token)).status, 409); assert.equal((await http('POST', '/me/reactivate', owner.token)).status, 409);
    assert.deepEqual(await db.query(`SELECT id FROM user_account_states WHERE user_id='${owner.id}' AND state='deactivated'`), []);
  });
  it('the signed-in gate receives distinct server deadlines, including leap-year anniversaries', async () => {
    const owner = await db.seedUser('gate-deadlines');
    assert.equal((await http('GET', '/me/account-status', owner.token)).body.accountStatus, 'active');
    await http('POST', '/me/deactivate', owner.token);
    const personal = await http('GET', '/me/account-status', owner.token); assert.equal(personal.status, 200, JSON.stringify(personal));
    assert.equal(personal.body.accountStatus, 'deactivated'); assert.equal(personal.body.selfRecoverableUntil, null); assert.equal(typeof personal.body.reactivateUntil, 'string');
    await db.exec(`UPDATE user_account_states SET created_at='2024-02-29T12:00:00Z' WHERE user_id='${owner.id}' AND state='deactivated'`);
    const leap = await http('GET', '/me/account-status', owner.token); assert.equal(Date.parse(String(leap.body.reactivateUntil)), Date.parse('2025-02-28T12:00:00Z'));
    const deleted = await http('POST', '/me/delete-request', owner.token); assert.equal(deleted.status, 200);
    const held = await http('GET', '/me/account-status', owner.token); assert.equal(held.body.accountStatus, 'pending_deletion'); assert.equal(held.body.reactivateUntil, null); assert.equal(typeof held.body.selfRecoverableUntil, 'string'); assert.equal(held.body.deletionScheduledAt, null);
    await claim({ user: owner.id, generation: String(deleted.body.recoveryGeneration) });
    const erasing = await http('GET', '/me/account-status', owner.token); assert.equal(erasing.body.accountStatus, 'pending_deletion'); assert.equal(erasing.body.selfRecoverableUntil, null);
  });
  it('self-reactivation preserves independent restrictions and restores the original discovery preference', async () => {
    const owner = await db.seedUser('reactivation-restrictions');
    await rpc('set_account_self_deactivation', { p_user: owner.id });
    await db.exec(`INSERT INTO user_account_states(user_id,state,reason) VALUES('${owner.id}','suspended','independent restriction')`);
    assert.equal((await rpc('reactivate_self_deactivated_account', { p_user: owner.id })).error, 'recovery_forbidden');
    assert.deepEqual(await db.query(`SELECT account_status FROM profiles WHERE id='${owner.id}'`), [{ account_status: 'deactivated' }]);
    await db.exec(`UPDATE user_account_states SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id='${owner.id}' AND state='suspended'`);
    assert.equal((await rpc('reactivate_self_deactivated_account', { p_user: owner.id })).ok, true);
    assert.deepEqual(await db.query(`SELECT allow_profile_discovery FROM profile_privacy_settings WHERE user_id='${owner.id}'`), [{ allow_profile_discovery: true }]);
    assert.equal((await db.query(`SELECT id FROM user_account_states WHERE user_id='${owner.id}' AND state='suspended'`)).length, 1);
  });
  it('authenticated clients cannot rewrite recovery clocks, cancel requests directly or clear personal deactivation', async () => {
    const owner = await db.seedUser('client-recovery-boundary'); await rpc('set_account_self_deactivation', { p_user: owner.id });
    const deletion = await rpc('request_recoverable_account_deletion', { p_user: owner.id });
    for (const statement of [
      `UPDATE user_deletion_requests SET requested_at=clock_timestamp(),status='cancelled' WHERE user_id='${owner.id}'`,
      `UPDATE user_account_states SET created_at=clock_timestamp() WHERE user_id='${owner.id}'`,
      `DELETE FROM user_account_states WHERE user_id='${owner.id}'`,
    ]) await db.exec(`BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${owner.id}',true); DO $probe$ DECLARE affected bigint; BEGIN ${statement}; GET DIAGNOSTICS affected=ROW_COUNT; IF affected<>0 THEN RAISE EXCEPTION 'client changed recovery authority'; END IF; EXCEPTION WHEN insufficient_privilege THEN NULL; END $probe$; COMMIT;`);
    assert.equal((await state(owner.id))[0].status, 'pending'); assert.equal((await restore({ user: owner.id, generation: deletion.generation })).ok, true);
    assert.deepEqual(await db.query(`SELECT account_status FROM profiles WHERE id='${owner.id}'`), [{ account_status: 'deactivated' }]);
  });
  it('the actual deletion service refuses automated erasure before any database or Storage access', async () => {
    const s = await source(); let access = 0;
    const forbiddenClient = new Proxy({}, { get() { access++; throw new Error('automated deletion accessed a data store'); } });
    const result = await executeAccountDeletion(forbiddenClient, s.user, { actorId: null, reason: 'Scheduled deletion' });
    assert.equal(result.ok, false); assert.equal(access, 0); assert.equal((await state(s.user))[0].status, 'pending');
    assert.equal((await restore(s, admin)).ok, true);
  });
  it('admins recover admin-deactivated profiles after any duration without lifting sanctions', async () => {
    const owner = await db.seedUser('admin-deactivated'); const stateId = randomUUID();
    await db.exec(`UPDATE profiles SET account_status='deactivated' WHERE id='${owner.id}';
      INSERT INTO user_account_states(id,user_id,state,set_by,created_at) VALUES('${stateId}','${owner.id}','deactivated','${admin}',clock_timestamp()-interval '5 years');
      INSERT INTO profile_privacy_settings(user_id,allow_profile_discovery) VALUES('${owner.id}',false) ON CONFLICT(user_id) DO UPDATE SET allow_profile_discovery=false`);
    await assert.rejects(db.exec(`UPDATE profiles SET account_status='active' WHERE id='${owner.id}'`), /profile_requires_authorized_reactivation/);
    assert.equal((await http('POST', '/me/reactivate', owner.token)).status, 409);
    assert.equal((await http('GET', '/me/account-status', owner.token)).body.reactivateUntil, null);
    const body = { deactivationId: stateId, reason: 'Admin approved deactivation recovery' };
    assert.equal((await http('POST', `/admin/users/${owner.id}/reactivate-profile`, owner.token, body)).status, 403);
    await db.exec(`INSERT INTO user_account_states(user_id,state,reason) VALUES('${owner.id}','banned','independent restriction')`);
    const response = await http('POST', `/admin/users/${owner.id}/reactivate-profile`, adminToken, body); assert.equal(response.status, 200, JSON.stringify(response));
    assert.equal((await http('POST', `/admin/users/${owner.id}/reactivate-profile`, adminToken, body)).status, 200);
    assert.deepEqual(await db.query(`SELECT account_status FROM profiles WHERE id='${owner.id}'`), [{ account_status: 'active' }]);
    assert.deepEqual(await db.query(`SELECT state,expires_at FROM user_account_states WHERE user_id='${owner.id}'`), [{ state: 'banned', expires_at: null }]);
    assert.deepEqual(await db.query(`SELECT allow_profile_discovery FROM profile_privacy_settings WHERE user_id='${owner.id}'`), [{ allow_profile_discovery: false }]);
    assert.equal((await db.query(`SELECT id FROM moderation_actions WHERE target_user_id='${owner.id}' AND action_type='deactivated_profile_reactivated'`)).length, 1);
  });
  it('admin reactivation handles expired personal deactivation but refuses stale state and deletion requests', async () => {
    const owner = await db.seedUser('admin-expired-personal'); await rpc('set_account_self_deactivation', { p_user: owner.id });
    const [{ id: stateId }] = await db.query<{ id: string }>(`SELECT id FROM user_account_states WHERE user_id='${owner.id}' AND state='deactivated'`);
    await db.exec(`UPDATE user_account_states SET created_at=clock_timestamp()-interval '2 years' WHERE id='${stateId}'`);
    const body = { deactivationId: stateId, reason: 'Owner requested admin assistance' };
    assert.equal((await http('POST', `/admin/users/${owner.id}/reactivate-profile`, adminToken, body)).status, 200);
    await rpc('set_account_self_deactivation', { p_user: owner.id });
    assert.equal((await http('POST', `/admin/users/${owner.id}/reactivate-profile`, adminToken, body)).status, 409);
    const [{ id: current }] = await db.query<{ id: string }>(`SELECT id FROM user_account_states WHERE user_id='${owner.id}' AND state='deactivated'`);
    await rpc('request_recoverable_account_deletion', { p_user: owner.id });
    assert.equal((await http('POST', `/admin/users/${owner.id}/reactivate-profile`, adminToken, { ...body, deactivationId: current })).status, 409);
  });
  it('admin deactivation recovery and its audit roll back together', async () => {
    const owner = await db.seedUser('admin-deactivation-audit'); await rpc('set_account_self_deactivation', { p_user: owner.id });
    const [{ id }] = await db.query<{ id: string }>(`SELECT id FROM user_account_states WHERE user_id='${owner.id}' AND state='deactivated'`);
    await db.exec(`CREATE FUNCTION public.test_admin_reactivation_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$; CREATE TRIGGER test_admin_reactivation_audit_failure BEFORE INSERT ON moderation_actions FOR EACH ROW EXECUTE FUNCTION public.test_admin_reactivation_audit_failure()`);
    try {
      await assert.rejects(db.exec(`SELECT public.reactivate_deactivated_account_admin('${admin}','${owner.id}','${id}','Review complete')`), /synthetic audit failure/);
      assert.deepEqual(await db.query(`SELECT account_status FROM profiles WHERE id='${owner.id}'`), [{ account_status: 'deactivated' }]);
      assert.equal((await db.query(`SELECT id FROM user_account_states WHERE id='${id}'`)).length, 1);
    } finally { await db.exec('DROP TRIGGER test_admin_reactivation_audit_failure ON moderation_actions; DROP FUNCTION public.test_admin_reactivation_audit_failure()'); }
  });
  function executionClient(user: string, authFailure?: string) {
    return new Proxy(db.client, { get(target, property) {
      if (property === 'storage') return { getBucket: async (id: string) => ({ data: { id, public: false }, error: null }), from: () => ({ list: async () => ({ data: [], error: null }), remove: async () => { throw new Error('Empty account must not erase an unseeded Storage object'); } }) };
      if (property === 'auth') return { admin: { deleteUser: async (id: string) => { assert.equal(id, user); if (authFailure) return { data: null, error: { message: authFailure } }; await db.exec(`DELETE FROM auth.users WHERE id='${user}'`); return { data: {}, error: null }; } } };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  it('old API claim signatures and unsupported protocols cannot begin erasure', async () => {
    const s=await source(), before=await state(s.user);
    const args={p_actor:admin,p_user:s.user,p_generation:s.generation,p_token:randomUUID(),p_reason:'Synthetic old client'};
    assert.deepEqual(await rpc('claim_account_permanent_deletion',args),{ok:false,error:'deletion_protocol_required'});
    assert.deepEqual(await rpc('claim_account_permanent_deletion',{...args,p_protocol:2}),{ok:false,error:'deletion_protocol_required'});
    assert.deepEqual(await state(s.user),before);
  });
  it('partial terminal-schema rollout refuses before the claim or any account erase', async () => {
    const s = await source(), before = await state(s.user);
    await db.exec('ALTER FUNCTION public.account_deletion_terminal_ready() RENAME TO test_missing_terminal_ready');
    try {
      const result=await executeAccountDeletion(executionClient(s.user),s.user,{actorId:admin,generation:s.generation,reason:'Synthetic partial rollout'});
      assert.equal(result.ok,false); assert.deepEqual(await state(s.user),before);
      assert.equal((await db.query(`SELECT id FROM auth.users WHERE id='${s.user}'`)).length,1);
      assert.deepEqual(result.steps.map(step=>step.step),['authorize_permanent_deletion']);
    } finally {await db.exec('ALTER FUNCTION public.test_missing_terminal_ready() RENAME TO account_deletion_terminal_ready');}
    assert.equal(await rpc('account_deletion_terminal_ready',{}),true);
  });
  it('the actual permanent-deletion executor commits a terminal receipt and erases the sign-in identity', async () => {
    const s = await source();
    const client = executionClient(s.user);
    const result = await executeAccountDeletion(client, s.user, { actorId: admin, generation: s.generation, reason: 'Synthetic explicit permanent deletion' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(await db.query(`SELECT id FROM auth.users WHERE id='${s.user}'`), []);
    assert.deepEqual(await db.query(`SELECT account_status FROM profiles WHERE id='${s.user}'`), [], 'canonical auth deletion cascades the profile');
    assert.deepEqual(await db.query(`SELECT status,user_id FROM user_deletion_requests WHERE recovery_generation='${s.generation}'`), [{ status: 'completed', user_id: null }]);
    assert.equal((await restore(s, admin)).ok, false);
  });
  it('an unconfirmed Auth response retains the dispatch claim and cannot authorize a retry', async () => {
    const s = await source(), options = { actorId: admin, generation: s.generation, reason: 'Synthetic administrator-approved erasure' };
    let dispatches = 0;
    const underlying = executionClient(s.user, 'synthetic unknown Auth outcome');
    const client = new Proxy(underlying, { get(target, property) {
      if (property === 'auth') return { admin: { deleteUser: async (id: string) => { dispatches++; return underlying.auth.admin.deleteUser(id); } } };
      return Reflect.get(target, property);
    } });
    const failed = await executeAccountDeletion(client, s.user, options); assert.equal(failed.ok, false);
    const request = (await state(s.user))[0]!; assert.equal(request.status, 'executing'); assert.ok(request.execution_token);
    assert.equal((await restore(s, admin)).error, 'permanent_deletion_started');
    assert.equal((await executeAccountDeletion(client, s.user, options)).ok, false); assert.equal(dispatches, 1);
    const receipt = (await db.query(`SELECT deletion_request_id,execution_subject_id FROM user_deletion_requests WHERE recovery_generation='${s.generation}'`))[0]!;
    assert.equal(receipt.execution_subject_id, s.user);
    assert.deepEqual(await reconcileAccountDeletion(db.client, String(receipt.deletion_request_id), options), { ok: false, error: 'auth_deletion_unsettled' });
    assert.equal(await rpc('finish_account_deletion_attempt', { p_request: receipt.deletion_request_id, p_token: request.execution_token, p_success: false }), false);
    assert.equal((await state(s.user))[0]!.status, 'executing');
  });
  it('a lost Auth acknowledgement settles the exact receipt from absence without another erase', async () => {
    const s = await source(), options = { actorId: admin, generation: s.generation, reason: 'Synthetic lost Auth response' };
    let dispatches = 0;
    const underlying = executionClient(s.user);
    const client = new Proxy(underlying, { get(target, property) {
      if (property === 'auth') return { admin: { deleteUser: async (id: string) => { dispatches++; await underlying.auth.admin.deleteUser(id); throw new Error('Synthetic lost Auth acknowledgement'); } } };
      return Reflect.get(target, property);
    } });
    const outcome = await executeAccountDeletion(client, s.user, options); assert.equal(outcome.ok, true, JSON.stringify(outcome)); assert.equal(dispatches, 1);
    const [receipt] = await db.query(`SELECT deletion_request_id,status,user_id,execution_subject_id FROM user_deletion_requests WHERE recovery_generation='${s.generation}'`);
    assert.equal(receipt!.status, 'completed'); assert.equal(receipt!.user_id, null); assert.equal(receipt!.execution_subject_id, null);
    assert.deepEqual(await reconcileAccountDeletion(db.client, String(receipt!.deletion_request_id), options), { ok: true, completed: true, alreadyCompleted: true });
    assert.equal(dispatches, 1);
  });
  it('lost dispatch preparation acknowledgement stays held and never sends Auth deletion', async () => {
    const s = await source(), underlying = executionClient(s.user); let dispatches = 0;
    const client = new Proxy(underlying, { get(target, property) {
      if (property === 'auth') return { admin: { deleteUser: async () => { dispatches++; throw new Error('Must not dispatch'); } } };
      if (property === 'rpc') return async (name: string, args: Record<string, unknown>) => { const result = await db.client.rpc(name,args); if (name === 'prepare_account_auth_deletion') throw new Error('Synthetic lost dispatch receipt'); return result; };
      return Reflect.get(target, property);
    } });
    const result = await executeAccountDeletion(client, s.user, { actorId: admin, generation: s.generation, reason: 'Synthetic dispatch acknowledgement loss' });
    assert.equal(result.ok, false); assert.equal(dispatches, 0); assert.equal((await state(s.user))[0]!.status, 'executing'); assert.equal((await claim(s)).ok, false);
  });
  it('admin result reconciliation addresses a receipt after the profile FK is erased and records one audit', async () => {
    const s = await source(), underlying = executionClient(s.user); let dispatches = 0;
    const client = new Proxy(underlying, { get(target, property) {
      if (property === 'auth') return { admin: { deleteUser: async (id: string) => { dispatches++; return underlying.auth.admin.deleteUser(id); } } };
      if (property === 'rpc') return async (name: string, args: Record<string, unknown>) => name === 'settle_account_auth_deletion' ? { data: null, error: { message: 'Synthetic completion unavailable' } } : db.client.rpc(name,args);
      return Reflect.get(target, property);
    } });
    const result = await executeAccountDeletion(client, s.user, { actorId: admin, generation: s.generation, reason: 'Synthetic interruption after Auth erase' }); assert.equal(result.ok,false);
    const [receipt] = await db.query(`SELECT deletion_request_id,status,user_id,execution_subject_id,execution_token FROM user_deletion_requests WHERE recovery_generation='${s.generation}'`);
    assert.equal(receipt!.status,'executing'); assert.equal(receipt!.user_id,null); assert.equal(receipt!.execution_subject_id,s.user);
    const path = `/admin/deletion-requests/${receipt!.deletion_request_id}/reconcile`, body = { generation: s.generation, reason: 'Verify interrupted deletion result' };
    const listed = await http('GET','/admin/deletion-requests',adminToken);
    const row = (listed.body.requests as unknown as Record<string,unknown>[]).find(row=>row.deletion_request_id===receipt!.deletion_request_id)!;
    assert.equal(row.can_reconcile,true); assert.equal(row.user_id,null); assert.equal(row.execution_subject_id,undefined); assert.equal(row.execution_token,undefined);
    assert.equal((await http('POST',path,adminToken,{...body,generation:randomUUID()})).status,409);
    const ordinary = await db.seedUser('nonadmin-reconciler'); assert.equal((await http('POST',path,ordinary.token,body)).status,403);
    assert.equal((await http('POST',path,adminToken,body)).status,200); assert.equal((await http('POST',path,adminToken,body)).status,200);
    assert.equal(dispatches,1);
    const audits = await db.query(`SELECT metadata FROM moderation_actions WHERE action_type='account_permanent_deletion_reconciled' AND metadata->>'deletion_request_id'='${receipt!.deletion_request_id}'`);
    assert.equal(audits.length,1); assert.equal(JSON.stringify(audits).includes(s.user),false);
  });
  it('a lost completion acknowledgement is reconciled without another Auth call or audit', async () => {
    const s = await source(), underlying = executionClient(s.user); let dispatches = 0;
    const options = { actorId: admin, generation: s.generation, reason: 'Synthetic lost completion acknowledgement' };
    const client = new Proxy(underlying, { get(target,property) {
      if (property === 'auth') return {admin:{deleteUser:async(id:string)=>{dispatches++;return underlying.auth.admin.deleteUser(id);}}};
      if (property === 'rpc') return async(name:string,args:Record<string,unknown>)=>{ const result=await db.client.rpc(name,args); if(name==='settle_account_auth_deletion'||name==='finish_account_deletion_attempt') throw new Error('Synthetic lost completion acknowledgement'); return result; };
      return Reflect.get(target,property);
    } });
    const result=await executeAccountDeletion(client,s.user,options); assert.equal(result.ok,false); assert.equal(dispatches,1);
    const [receipt]=await db.query(`SELECT deletion_request_id,status,execution_subject_id FROM user_deletion_requests WHERE recovery_generation='${s.generation}'`);
    assert.equal(receipt!.status,'completed'); assert.equal(receipt!.execution_subject_id,null);
    assert.deepEqual(await reconcileAccountDeletion(db.client,String(receipt!.deletion_request_id),options),{ok:true,completed:true,alreadyCompleted:true});
    assert.deepEqual(await db.query(`SELECT count(*)::int AS count FROM moderation_actions WHERE action_type='account_permanent_deletion_reconciled' AND metadata->>'deletion_request_id'='${receipt!.deletion_request_id}'`),[{count:1}]);
  });
  async function terminalReceipt() {
    const s = await source(), c = await claim(s);
    const args = { p_actor: admin, p_request: c.requestId, p_token: c.token, p_generation: s.generation,
      p_deleted: {}, p_tombstoned: {}, p_policy: 'synthetic-policy', p_worker: 'synthetic-worker' };
    assert.equal(await rpc('prepare_account_auth_deletion',args),true);
    return { ...s, c, args, options: { actorId: admin, generation: s.generation, reason: 'Verify terminal result' } };
  }
  it('terminal completion and its anonymous audit roll back together; other actions still require a target', async () => {
    const s = await terminalReceipt(); await db.exec(`DELETE FROM auth.users WHERE id='${s.user}'`);
    await assert.rejects(db.exec(`INSERT INTO moderation_actions(target_user_id,performed_by,action_type,reason) VALUES(NULL,'${admin}','permanent_ban','Must refuse')`),/moderation_actions_terminal_target/);
    await db.exec(`CREATE FUNCTION public.test_terminal_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action_type='account_permanent_deletion_reconciled' THEN RAISE EXCEPTION 'synthetic terminal audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_terminal_audit_failure BEFORE INSERT ON moderation_actions FOR EACH ROW EXECUTE FUNCTION public.test_terminal_audit_failure()`);
    try {
      assert.equal((await reconcileAccountDeletion(db.client,s.c.requestId,s.options)).ok,false);
      assert.deepEqual(await db.query(`SELECT status,execution_subject_id FROM user_deletion_requests WHERE deletion_request_id='${s.c.requestId}'`),[{status:'executing',execution_subject_id:s.user}]);
    } finally { await db.exec('DROP TRIGGER test_terminal_audit_failure ON moderation_actions; DROP FUNCTION public.test_terminal_audit_failure()'); }
    assert.equal((await reconcileAccountDeletion(db.client,s.c.requestId,s.options)).ok,true);
  });
  it('terminal reconciliation requires current admin authority and rejects an unfenced legacy receipt', async () => {
    const s = await terminalReceipt(); await db.exec(`DELETE FROM auth.users WHERE id='${s.user}'; UPDATE profiles SET role='user' WHERE id='${admin}'`);
    try { assert.deepEqual(await reconcileAccountDeletion(db.client,s.c.requestId,s.options),{ok:false,error:'admin_reconciliation_required'}); }
    finally { await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'`); }
    assert.equal((await reconcileAccountDeletion(db.client,s.c.requestId,s.options)).ok,true);
    const legacy = await source(), c = await claim(legacy);
    await db.exec(`DELETE FROM auth.users WHERE id='${legacy.user}'`);
    assert.deepEqual(await reconcileAccountDeletion(db.client,c.requestId,{...s.options,generation:legacy.generation}),{ok:false,error:'terminal_dispatch_unverified'});
    for (const role of ['anon','authenticated']) for (const fn of ['prepare_account_auth_deletion(uuid,uuid,uuid,uuid,jsonb,jsonb,text,text)','settle_account_auth_deletion(uuid,uuid,uuid,text)']) {
      assert.deepEqual(await db.query(`SELECT has_function_privilege('${role}','public.${fn}','EXECUTE') AS allowed`),[{allowed:false}]);
    }
  });
  it('a terminal fence never expires into another dispatch; a late Auth commit can then settle', async () => {
    const s = await terminalReceipt();
    await db.exec(`UPDATE user_deletion_requests SET execution_started_at=clock_timestamp()-interval '2 years' WHERE deletion_request_id='${s.c.requestId}'`);
    assert.equal(await rpc('prepare_account_auth_deletion',s.args),false); assert.equal((await claim(s)).ok,false);
    assert.deepEqual(await reconcileAccountDeletion(db.client,s.c.requestId,s.options),{ok:false,error:'auth_deletion_unsettled'});
    await db.exec(`DELETE FROM auth.users WHERE id='${s.user}'`);
    assert.equal((await reconcileAccountDeletion(db.client,s.c.requestId,s.options)).ok,true);
  });
  it('two independent terminal reconciliation sessions complete once and preserve one audit', { timeout: 25_000 }, async () => {
    const s = await terminalReceipt(); await db.exec(`DELETE FROM auth.users WHERE id='${s.user}'`);
    const a = new Client({connectionString:db.databaseUrl!}), b = new Client({connectionString:db.databaseUrl!}); sessions.push(a,b); await Promise.all([a.connect(),b.connect()]);
    const sql = `SELECT public.settle_account_auth_deletion('${admin}','${s.c.requestId}','${s.generation}','Concurrent result verification') AS result`;
    const results = await Promise.all([a.query(sql),b.query(sql)]);
    assert.deepEqual(results.map(r=>r.rows[0].result.alreadyCompleted).sort(),[false,true]);
    assert.deepEqual(await db.query(`SELECT count(*)::int AS count FROM moderation_actions WHERE action_type='account_permanent_deletion_reconciled' AND metadata->>'deletion_request_id'='${s.c.requestId}'`),[{count:1}]);
  });
  for (const winner of ['restore', 'delete'] as const) it(`${winner} commits first and the other independent session refuses`, { skip: !process.env.LOCAL_DB_URL, timeout: 25_000 }, async () => {
    const s = await source(); const a = new Client({ connectionString: db.databaseUrl! }), b = new Client({ connectionString: db.databaseUrl! }); sessions.push(a, b); await Promise.all([a.connect(), b.connect()]);
    const pidA = Number((await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid), pidB = Number((await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const restoreSql = `SELECT public.recover_deleted_account('${admin}','${s.user}','${s.generation}','concurrent proof') AS result`;
    const claimSql = `SELECT public.claim_account_permanent_deletion('${admin}','${s.user}','${s.generation}','${randomUUID()}','concurrent proof',1) AS result`;
    let pending: Promise<QueryResult> | undefined;
    try {
      await a.query("BEGIN; SET LOCAL ROLE service_role; SET LOCAL statement_timeout='10s'");
      assert.equal((await a.query(winner === 'restore' ? restoreSql : claimSql)).rows[0].result.ok, true);
      await b.query("SET ROLE service_role; SET statement_timeout='10s'"); pending = b.query(winner === 'restore' ? claimSql : restoreSql); void pending.catch(() => {});
      let waited = false;
      for (let n = 0; n < 100; n++) { if ((await db.query<{ blocked: boolean }>(`SELECT ${pidA}=ANY(pg_blocking_pids(${pidB})) AS blocked`))[0].blocked) { waited = true; break; } await new Promise(r => setTimeout(r, 20)); }
      assert.equal(waited, true, 'independent backend must actually wait on the authority transaction');
      await a.query('COMMIT'); const result = await pending; assert.equal((result as any).rows[0].result.ok, false);
    } finally { await a.query('ROLLBACK'); await pending?.catch(() => {}); }
  });
});
