import assert from 'node:assert/strict';
import{before,after,beforeEach,describe,test}from'node:test';
import{readFileSync}from'node:fs';
import{randomUUID}from'node:crypto';
import{VideoSegmentNativeCluster}from'./memoryVideoSegmentsPostgresFixture.js';
const bin=process.env.PORTAVA_TEST_POSTGRES_BIN;const cluster=bin?new VideoSegmentNativeCluster(bin):null;
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',C='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const T='11111111-1111-4111-8111-111111111111',U='22222222-2222-4222-8222-222222222222';let SA:string,SB:string;
async function sql(s:string){const c=cluster!.session();try{return await c.query(s+';');}finally{await c.close();}}
const literal=(v:unknown)=>`'${String(v).replaceAll("'","''")}'`;
function call(actor:string,trip:string,action:string,id:string,payload:object={}){return `SELECT trip_nearby_command('${actor}','${trip}',${literal(action)},'${id}',${literal(JSON.stringify(payload))}::jsonb)`;}
async function command(actor:string,trip:string,action:string,id:string,payload:object={}){return JSON.parse(await sql('SET ROLE service_role;'+call(actor,trip,action,id,payload)));}
const start=(actor=A,trip=T,id=SA)=>command(actor,trip,'start',id,{consentVersion:'trip-nearby-v1',durationMinutes:5});
const observe=(token:string,over:object={})=>command(A,T,'observe',SA,{token,proximity:'nearby',observedAt:new Date().toISOString(),...over});
describe('Trip nearby checkpoints: real PostgreSQL 17',{skip:!bin?'PORTAVA_TEST_POSTGRES_BIN required':false},()=>{
 before(async()=>{
  await cluster!.start();await sql(`DROP SCHEMA public CASCADE;CREATE SCHEMA public;ALTER ROLE service_role BYPASSRLS;
   CREATE TABLE profiles(id uuid PRIMARY KEY,account_status text DEFAULT 'active',handle text);
   CREATE TABLE user_account_states(user_id uuid REFERENCES profiles(id),state text,expires_at timestamptz);
   CREATE TABLE trips(id uuid PRIMARY KEY,owner_id uuid REFERENCES profiles(id),status text DEFAULT 'active');
   CREATE TABLE trip_members(trip_id uuid REFERENCES trips(id) ON DELETE CASCADE,user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,status text DEFAULT 'accepted',role text DEFAULT 'member',PRIMARY KEY(trip_id,user_id));
   CREATE TABLE trip_crew_location_preferences(trip_id uuid REFERENCES trips(id) ON DELETE CASCADE,user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,ghost_mode_enabled boolean DEFAULT false);
   CREATE TABLE circle_member_visibility_overrides(context_type text,context_id uuid,user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,target_user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,direction text,hidden boolean);
   CREATE TABLE blocks(blocker_id uuid,blocked_id uuid);CREATE TABLE feature_flags(flag text PRIMARY KEY,enabled boolean);
   GRANT USAGE ON SCHEMA public TO service_role,authenticated,anon;GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`);
  await sql(readFileSync(new URL('../migrations/4013_trip_nearby_checkpoints.sql',import.meta.url),'utf8'));
 });
 after(async()=>{await cluster?.close();});
 beforeEach(async()=>{SA=randomUUID();SB=randomUUID();await sql(`TRUNCATE profiles,blocks CASCADE;INSERT INTO profiles(id,handle) VALUES('${A}','a'),('${B}','b'),('${C}','c');INSERT INTO trips(id,owner_id) VALUES('${T}','${A}'),('${U}','${C}');INSERT INTO trip_members(trip_id,user_id) VALUES('${T}','${B}');UPDATE feature_flags SET enabled=true;`);});
 test('flag-off cannot enroll, and consent version or duration cannot be invented',async()=>{
  await sql('UPDATE feature_flags SET enabled=false');assert.equal((await start()).state,'disabled');assert.equal(await sql('SELECT count(*) FROM trip_nearby_sessions'),'0');await sql('UPDATE feature_flags SET enabled=true');
  await assert.rejects(command(A,T,'start',SA,{consentVersion:'old',durationMinutes:5}),/explicit bounded consent/);
  await assert.rejects(command(A,T,'start',SA,{consentVersion:'trip-nearby-v1',durationMinutes:16}),/explicit bounded consent/);
 });
 test('only accepted current trip members with active accounts may enroll',async()=>{
  assert.equal((await start(C,T,randomUUID())).state,'unavailable');await sql(`UPDATE trip_members SET status='invited'`);assert.equal((await start(B,T,SB)).state,'unavailable');
  await sql(`UPDATE trip_members SET status='accepted';INSERT INTO user_account_states VALUES('${B}','suspended',NULL)`);assert.equal((await start(B,T,SB)).state,'unavailable');
 });
 test('radio leases rotate opaque tokens, use same trip epoch and have no identity or coordinate payload',async()=>{
  const a=await start();const b=await start(B,T,SB);assert.equal(a.lease.serviceUuid,b.lease.serviceUuid);assert.match(a.lease.token,/^[a-f0-9]{64}$/);assert.notEqual(a.lease.token,b.lease.token);
  assert.ok(Date.parse(a.lease.expiresAt)-Date.parse(a.serverNow)<=60000);assert.equal(Object.keys(a.lease).sort().join(','),'characteristicUuid,expiresAt,serviceUuid,token');
  assert.notEqual(await sql(`SELECT token_hash FROM trip_nearby_sessions WHERE id='${SA}'`),a.lease.token);
  const next=await command(A,T,'renew',SA);assert.notEqual(next.lease.token,a.lease.token);
 });
 test('two opted peers exchange proximity without creating a coordinate',async()=>{
  await start();const b=await start(B,T,SB);assert.equal((await observe(b.lease.token)).accepted,true);
  const read=await command(A,T,'read',SA);assert.deepEqual(Object.keys(read.peers[0]).sort(),['expiresAt','handle','observedAt','proximity','userId']);assert.equal(read.peers[0].userId,B);assert.equal(read.peers[0].proximity,'nearby');
  assert.equal((await command(B,T,'read',SB)).peers.length,0,'an observation is not a reciprocal invented sighting');
 });
 test('cross-trip, self, stale and invented checkpoints are refused',async()=>{
  const a=await start();const c=await start(C,U,randomUUID());assert.equal((await observe(a.lease.token)).accepted,false);assert.equal((await observe(c.lease.token)).accepted,false);
  assert.equal((await observe('f'.repeat(64))).accepted,false);const b=await start(B,T,SB);assert.equal((await observe(b.lease.token,{observedAt:'2000-01-01T00:00:00Z'})).accepted,false);
  assert.equal(await sql('SELECT count(*) FROM trip_nearby_observations'),'0');
 });
 test('withdrawal erases the observation and blocks the old radio token',async()=>{
  await start();const b=await start(B,T,SB);await observe(b.lease.token);await command(B,T,'stop',SB);
  assert.equal((await command(A,T,'read',SA)).peers.length,0);assert.equal((await observe(b.lease.token)).accepted,false);
 });
 test('a stop before a late start prevents resurrection even with the flag off',async()=>{
  await sql('UPDATE feature_flags SET enabled=false');assert.equal((await command(A,T,'stop',SA)).state,'stopped');await sql('UPDATE feature_flags SET enabled=true');
  assert.equal((await start()).state,'unavailable');assert.equal(await sql('SELECT count(*) FROM trip_nearby_sessions'),'0');
 });
 test('membership withdrawal, blocks and account restriction retract already observed peers',async()=>{
  await start();const b=await start(B,T,SB);await observe(b.lease.token);await sql(`INSERT INTO blocks VALUES('${B}','${A}')`);assert.equal((await command(A,T,'read',SA)).peers.length,0);
  await sql(`DELETE FROM blocks;UPDATE trip_members SET status='removed'`);assert.equal((await command(A,T,'read',SA)).peers.length,0);
  await sql(`UPDATE trip_members SET status='accepted';INSERT INTO user_account_states VALUES('${B}','banned',NULL)`);assert.equal((await command(A,T,'read',SA)).peers.length,0);
 });
 test('an expired token or session is denied at read time without waiting for cleanup',async()=>{
  await start();const b=await start(B,T,SB);await sql(`UPDATE trip_nearby_sessions SET token_expires_at=now()-interval '1 second' WHERE id='${SB}'`);assert.equal((await observe(b.lease.token)).accepted,false);
  await sql(`UPDATE trip_nearby_sessions SET created_at=now()-interval '10 minutes',expires_at=now()-interval '5 minutes',token_expires_at=NULL WHERE id='${SA}'`);assert.equal((await command(A,T,'read',SA)).state,'unavailable');
 });
 test('Ghost Mode and directional trip hiding retract proximity without ending unrelated sessions',async()=>{
  await start();const b=await start(B,T,SB);await observe(b.lease.token);
  await sql(`INSERT INTO circle_member_visibility_overrides VALUES('trip','${T}','${B}','${A}','hide_me_from',true)`);
  assert.equal((await command(A,T,'read',SA)).peers.length,0);assert.equal((await observe(b.lease.token)).accepted,false);
  await sql(`DELETE FROM circle_member_visibility_overrides;INSERT INTO trip_crew_location_preferences VALUES('${T}','${B}',true)`);
  assert.equal((await command(A,T,'read',SA)).peers.length,0);assert.equal((await command(B,T,'renew',SB)).state,'unavailable');
 });
 test('another actor cannot read, renew or revoke a participant session',async()=>{
  await start();await start(B,T,SB);assert.equal((await command(B,T,'read',SA)).state,'unavailable');assert.equal((await command(B,T,'renew',SA)).state,'unavailable');await command(B,T,'stop',SA);assert.equal((await command(A,T,'read',SA)).state,'active');
 });
 test('direct client roles cannot read observations or invoke privileged enrollment',async()=>{
  await start();for(const role of['anon','authenticated']){await assert.rejects(sql(`SET ROLE ${role};SELECT * FROM trip_nearby_sessions`),/permission denied/);await assert.rejects(sql(`SET ROLE ${role};${call(A,T,'start',SA,{consentVersion:'trip-nearby-v1',durationMinutes:5})}`),/permission denied/);}
 });
 test('cleanup remains effective after feature disable and erasure cascades source identity',async()=>{
  await start();await start(B,T,SB);await sql(`UPDATE trip_nearby_sessions SET created_at=now()-interval '20 minutes',expires_at=now()-interval '10 minutes',token_expires_at=NULL;UPDATE feature_flags SET enabled=false;`);
  assert.ok(Number(await sql('SET ROLE service_role;SELECT purge_trip_nearby_expired(500)'))>=2);assert.equal(await sql('SELECT count(*) FROM trip_nearby_sessions'),'0');
  await sql('UPDATE feature_flags SET enabled=true');await start();await command(A,T,'stop',SA);await sql(`DELETE FROM trips WHERE owner_id='${A}';DELETE FROM profiles WHERE id='${A}'`);assert.equal(await sql('SELECT count(*) FROM trip_nearby_revocations'),'0');
 });
});
