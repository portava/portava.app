import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openPressedLayoverDb, PRESSED_SKIP_REASON, PRESSED_BACKEND } from "./pressedLayoverDb.js";
import { POSTCONDITION_AMENDMENTS } from "../../scripts/lib/postconditionAmendments.js";
import { openIsolatedPressedPostgres } from './pressedPostgres.js';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { openSnapshotLease } from './pressedSnapshot.js';
import { appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe("pressed handles isolate committed changes and retain explicit transaction rollback", {skip: PRESSED_SKIP_REASON}, ()=>{it("pressed handles isolate committed changes and retain explicit transaction rollback", async () => {
  const first = await openPressedLayoverDb();
  let second: Awaited<ReturnType<typeof openPressedLayoverDb>> | undefined;
  try {
    await first.exec("CREATE TABLE public.pressed_isolation_probe(id integer PRIMARY KEY)");
    if (PRESSED_BACKEND === "psql") await assert.rejects(openPressedLayoverDb(), /already leased/);
    await first.exec("BEGIN; INSERT INTO public.pressed_isolation_probe VALUES(1)");
    assert.equal((await first.query("SELECT id FROM public.pressed_isolation_probe")).length, 1);
    await first.exec("ROLLBACK");
    assert.equal((await first.query("SELECT id FROM public.pressed_isolation_probe")).length, 0);
    const owner=await first.seedUser('harness_scope');
    await first.exec('BEGIN; INSERT INTO public.pressed_isolation_probe VALUES(2)');
    await assert.rejects(first.asUser(owner.id,'SELECT 1'),/Pressed request refused inside an explicit transaction/);
    assert.equal((await first.query('SELECT id FROM public.pressed_isolation_probe')).length,1,'refusal preserves caller transaction');
    await first.exec('ROLLBACK');
    assert.equal((await first.query('SELECT id FROM public.pressed_isolation_probe')).length,0,'nested request must not commit the caller mutation');
    await first.exec('BEGIN');await assert.rejects(first.exec('SELECT 1/0'));
    await assert.rejects(first.asUser(owner.id,'SELECT 1'),/Pressed request refused inside an explicit transaction/);await first.exec('ROLLBACK');
    const [context]=await first.asUser<{role:string;sub:string}>(owner.id,"SELECT current_setting('role') AS role,auth.uid()::text AS sub");assert.equal(context.role,'authenticated');assert.equal(context.sub,owner.id);
    await assert.rejects(first.asUser(owner.id,'SELECT 1/0'));
    const [restored]=await first.query<{role:string;sub:string|null}>("SELECT current_setting('role') AS role,auth.uid()::text AS sub");assert.equal(restored.role,'none');assert.equal(restored.sub,null);
    const assertion = POSTCONDITION_AMENDMENTS.find((row) => row.file === "2764_trip_kernel_stage_family.sql")?.reassert;
    assert.ok(assertion, "kernel chain-end assertion missing");
    await first.exec(assertion);
    const [{definition}] = await first.query<{definition: string}>("SELECT pg_get_functiondef('public.trip_kernel_execute'::regproc) AS definition");
    await first.exec(definition.replace("WHEN 'RECORD_FLIGHT_STATUS' THEN 'engine'", "WHEN 'RECORD_FLIGHT_STATUS' THEN 'member'"));
    await assert.rejects(first.exec(assertion), /expected 5 engine-capability commands, found 4/);
    await first.close();
    second = await openPressedLayoverDb();
    assert.equal(await second.hasTable("pressed_isolation_probe"), false, "committed fixture objects do not survive release");
    await second.exec(assertion);
  } finally { await first.close(); await second?.close(); }
});});
describe('an omitted certified store removes its explicit dependency closure and preserves unrelated later features',{skip:PRESSED_SKIP_REASON},()=>{it('an omitted certified store removes its explicit dependency closure and preserves unrelated later features',async()=>{
 const db=await openPressedLayoverDb({without:['2700']});
 try{
  assert.equal(await db.hasTable('layover_certified_computations'),false);assert.equal(await db.hasTable('layover_experience_plans'),false);
  assert.equal(await db.hasTable('layover_objective_facts'),true);assert.equal(await db.hasTable('layover_safe_return_links'),true);
  assert.ok(db.report?.variantExcluded.some(f=>f.startsWith('3898_')&&f.includes('dependency omitted:')));
  assert.ok(db.report?.variantExcluded.every(f=>f.includes('(dependency omitted:')));
 }finally{await db.close();}
});});
describe('one reusable PostgreSQL fixture refuses competing whole-database replays',{skip:PRESSED_SKIP_REASON},()=>{it('a second lease cannot run cluster role DDL while another fixture is open',async t=>{
 if(PRESSED_BACKEND!=='psql'){t.diagnostic('Exclusive PostgreSQL lease is specific to the PostgreSQL backend.');return;}
 const role=`pressed_probe_${randomUUID().replaceAll('-','')}`;let calls=0;
 const options={url:process.env['LOCAL_DB_URL']!,without:[],prelude:()=>'',key:async()=>randomUUID().replaceAll('-','').slice(0,24),replay:async(db:{exec(sql:string):Promise<unknown>},version:string)=>{
  calls++;await db.exec(`CREATE ROLE ${role}`);
  return {engine:version,key:'',applied:0,excluded:[],variantExcluded:[],standIn:'none',schedulerRegistration:'not-executed-in-isolated-clone' as const,seconds:0};
 }};
 const first=await openIsolatedPressedPostgres(options);
 try{await assert.rejects(openIsolatedPressedPostgres(options),/already leased/);assert.equal(calls,1,'the rejected fixture must not replay or change roles');}
 finally{await first.engine.exec(`DROP ROLE IF EXISTS ${role}`);await first.engine.close();}
});});

describe('reusable fixture failure recovery', {skip: PRESSED_SKIP_REASON}, () => {it('failed replay restores committed baseline data and never publishes a partial cache', async t => {
 if (PRESSED_BACKEND !== 'psql') {t.diagnostic('PostgreSQL snapshot recovery only.'); return;}
 const url=process.env['LOCAL_DB_URL']!;
 const observer=new Client({connectionString:url});await observer.connect();
 const probe=`pressed_recovery_${randomUUID().replaceAll('-','')}`;
 const key=randomUUID().replaceAll('-','').slice(0,24);let calls=0;
 try {
  await observer.query(`CREATE TABLE public.${probe}(value text); INSERT INTO public.${probe} VALUES ('baseline')`);
  const options={url,without:[],prelude:()=>'',key:async()=>key,replay:async(db:{exec(sql:string):Promise<unknown>})=>{
   calls++;await db.exec('CREATE TABLE public.pressed_partial_replay(id integer)');throw new Error('injected replay failure');
  }};
  const user=randomUUID();
  await observer.query('INSERT INTO auth.users(id) VALUES ($1)',[user]);
  try {
   await assert.rejects(openIsolatedPressedPostgres(options), /containing user fixtures/);
   assert.equal(calls,0,'populated target must be refused before replay');
   assert.equal((await observer.query('SELECT id FROM auth.users WHERE id=$1',[user])).rowCount,1,'refusal must preserve existing rows');
  } finally {await observer.query('DELETE FROM auth.users WHERE id=$1',[user]);}
  for(let attempt=0;attempt<2;attempt++) {
   await assert.rejects(openIsolatedPressedPostgres(options),/injected replay failure/);
   assert.deepEqual((await observer.query(`SELECT value FROM public.${probe}`)).rows,[{value:'baseline'}]);
   assert.equal((await observer.query("SELECT to_regclass('public.pressed_partial_replay') AS relation")).rows[0].relation,null);
  }
  assert.equal(calls,2,'failed variants must replay again, never reuse a partial cache');
  const identity=(await observer.query('SELECT current_database() AS name,system_identifier::text AS cluster FROM pg_control_system()')).rows[0];
  const root=join(process.env.PRESSED_SNAPSHOT_ROOT || tmpdir(),'portava-pressed-snapshots',`${identity.cluster}-${identity.name}`);
  const lease=await openSnapshotLease(observer,new URL(url));
  try {
   await lease.cache(key,{engine:'test',key,applied:0,excluded:[],variantExcluded:[],standIn:'none',schedulerRegistration:'not-executed-in-isolated-clone',seconds:0});
   appendFileSync(join(root,`${key}.dump`),'injected corruption');
   await assert.rejects(lease.cached(key),/checksum mismatch/);
   assert.deepEqual((await observer.query(`SELECT value FROM public.${probe}`)).rows,[{value:'baseline'}],'bad checksum must be rejected before clearing baseline');
  } finally {
   rmSync(join(root,`${key}.dump`),{force:true});rmSync(join(root,`${key}.json`),{force:true});await lease.restore();
  }
 } finally {await observer.query(`DROP TABLE IF EXISTS public.${probe}`);await observer.end();}
});});
