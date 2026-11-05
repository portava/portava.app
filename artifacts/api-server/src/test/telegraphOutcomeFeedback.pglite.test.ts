import {before,after,beforeEach,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const A='aaaaaaaa-0000-4000-8000-000000000001',B='bbbbbbbb-0000-4000-8000-000000000001',T='cccccccc-0000-4000-8000-000000000001',P='dddddddd-0000-4000-8000-000000000001';
let db:PGlite;
before(async()=>{
 db=new PGlite();await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE TABLE feature_flags(flag text PRIMARY KEY,enabled boolean,metadata jsonb);
 CREATE TABLE meetups(id uuid PRIMARY KEY,creator_id uuid,chat_thread_id uuid,status text,starts_at timestamptz,ends_at timestamptz);
 CREATE TABLE message_thread_members(thread_id uuid,user_id uuid,left_at timestamptz,visible_from_at timestamptz);
 CREATE TABLE meetup_invites(meetup_id uuid,user_id uuid,status text);
 CREATE TABLE blocks(blocker_id uuid,blocked_id uuid);`);
 await db.exec(readFileSync(new URL('../migrations/4017_telegraph_outcome_feedback.sql',import.meta.url),'utf8'));
});
after(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec(`TRUNCATE auth.users,meetups,message_thread_members,meetup_invites,blocks,telegraph_outcome_feedback CASCADE;
 UPDATE feature_flags SET enabled=true,metadata='{"retention_days":30}';INSERT INTO auth.users VALUES('${A}'),('${B}');
 INSERT INTO meetups VALUES('${P}','${A}','${T}','confirmed',now()-interval '2 hours',now()-interval '1 hour');
 INSERT INTO message_thread_members(thread_id,user_id) VALUES('${T}','${A}'),('${T}','${B}');INSERT INTO meetup_invites VALUES('${P}','${B}','going');`);});
async function context(actor=A){return (await db.query<{r:{enabled:boolean;response:string|null;retentionDays:number}}>('SELECT telegraph_outcome_context($1,$2,$3) r',[T,P,actor])).rows[0].r;}
async function save(response='met',actor=A){return db.query('SELECT telegraph_record_outcome($1,$2,$3,$4)',[T,P,actor,response]);}
async function count(){return Number((await db.query<{n:string}>('SELECT count(*) n FROM telegraph_outcome_feedback')).rows[0].n);}
describe('4017 private self-reported coordination outcomes',()=>{
 it('requires both activation and an explicit bounded retention choice',async()=>{
  for(const metadata of ['{}','{"retention_days":0}','{"retention_days":366}','{"retention_days":"junk"}']){await db.query('UPDATE feature_flags SET metadata=$1',[metadata]);assert.equal((await context()).enabled,false);await assert.rejects(save(),/outcome_disabled/);}
  await db.exec("UPDATE feature_flags SET enabled=false,metadata='{\"retention_days\":30}'");assert.equal((await context()).enabled,false);
 });
 it('a read writes nothing and returns only the caller’s answer',async()=>{assert.equal((await context()).response,null);assert.equal(await count(),0);await save();assert.equal((await context()).response,'met');assert.equal((await context(B)).response,null);});
 it('retries and changes remain one response and do not extend its expiry',async()=>{await save();const first=(await db.query<{expires_at:string}>('SELECT expires_at FROM telegraph_outcome_feedback')).rows[0].expires_at;await save();await save('did_not_meet');assert.equal(await count(),1);assert.equal((await context()).response,'did_not_meet');assert.deepEqual((await db.query<{expires_at:string}>('SELECT expires_at FROM telegraph_outcome_feedback')).rows[0].expires_at,first);});
 it('refuses future, draft, cancelled, stale and foreign plans',async()=>{
  for(const patch of ["ends_at=now()+interval '1 hour'","status='draft'","status='cancelled'","ends_at=now()-interval '31 days'","chat_thread_id=null"]){await db.exec('BEGIN');await db.exec(`UPDATE meetups SET ${patch}`);await assert.rejects(save(),/outcome_unavailable/);await db.exec('ROLLBACK');}
 });
 it('refuses departed, uninvited, blocked and pre-history participants',async()=>{
  for(const sql of [`UPDATE message_thread_members SET left_at=now() WHERE user_id='${B}'`,'DELETE FROM meetup_invites',`INSERT INTO blocks VALUES('${A}','${B}')`,`UPDATE message_thread_members SET visible_from_at=now() WHERE user_id='${B}'`]){await db.exec('BEGIN');await db.exec(sql);await assert.rejects(save('met',B),/outcome_unavailable/);await db.exec('ROLLBACK');}
 });
 it('never accepts an inferred or unrecognized outcome',async()=>{for(const value of ['confirmed','going','verified',''])await assert.rejects(save(value),/invalid_outcome_response/);assert.equal(await count(),0);});
 it('suppresses small samples and labels aggregates as self-reported, not verified attendance',async()=>{await save();const result=(await db.query<{r:{suppressed:boolean;reportedMet:number|null;verifiedAttendance:boolean;evidence:string}}>('SELECT telegraph_outcome_summary() r')).rows[0].r;assert.equal(result.suppressed,true);assert.equal(result.reportedMet,null);assert.equal(result.verifiedAttendance,false);assert.equal(result.evidence,'self_reported');});
 it('aggregates cross-instance durable responses without returning participant or plan ids',async()=>{
  for(let i=0;i<10;i++){const id=`eeeeeeee-0000-4000-8000-${String(i).padStart(12,'0')}`;await db.query('INSERT INTO auth.users VALUES($1)',[id]);await db.query("INSERT INTO telegraph_outcome_feedback(plan_id,user_id,response,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[P,id,i<7?'met':'did_not_meet']);}
  const result=(await db.query<{r:{suppressed:boolean;reportedMet:number;reportedDidNotMeet:number;sampleSize:number}}>('SELECT telegraph_outcome_summary() r')).rows[0].r;assert.deepEqual([result.suppressed,result.reportedMet,result.reportedDidNotMeet,result.sampleSize],[false,7,3,10]);assert.ok(!JSON.stringify(result).includes(P));assert.ok(!JSON.stringify(result).includes('eeeeeeee'));
 });
 it('expired responses stop contributing before the bounded purge runs',async()=>{await save();await db.exec("UPDATE telegraph_outcome_feedback SET expires_at=now()-interval '1 second'");assert.equal((await context()).response,null);assert.equal((await db.query<{n:number}>('SELECT telegraph_purge_outcome_feedback() n')).rows[0].n,1);assert.equal(await count(),0);});
 it('account and plan deletion erase responses through foreign keys',async()=>{await save();await db.query('DELETE FROM auth.users WHERE id=$1',[A]);assert.equal(await count(),0);await save('met',B);await db.query('DELETE FROM meetups WHERE id=$1',[P]);assert.equal(await count(),0);});
 it('ordinary users cannot inspect answers or invoke service-only writers and summaries',async()=>{for(const role of ['anon','authenticated']){await db.exec(`SET ROLE ${role}`);try{await assert.rejects(db.query('SELECT * FROM telegraph_outcome_feedback'),/permission denied/);await assert.rejects(save(),/permission denied/);await assert.rejects(db.query('SELECT telegraph_outcome_summary()'),/permission denied/);}finally{await db.exec('RESET ROLE');}}});
});
