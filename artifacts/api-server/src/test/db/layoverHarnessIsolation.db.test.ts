import { test } from "node:test";
import assert from "node:assert/strict";
import { openPressedLayoverDb, PRESSED_SKIP_REASON, PRESSED_BACKEND } from "./pressedLayoverDb.js";
import { POSTCONDITION_AMENDMENTS } from "../../scripts/lib/postconditionAmendments.js";
import { openIsolatedPressedPostgres } from './pressedPostgres.js';
import { randomUUID } from 'node:crypto';

test("pressed handles isolate committed changes and retain explicit transaction rollback", {skip: PRESSED_SKIP_REASON}, async () => {
  const first = await openPressedLayoverDb();
  const second = await openPressedLayoverDb();
  try {
    await first.exec("CREATE TABLE public.pressed_isolation_probe(id integer PRIMARY KEY)");
    assert.equal(await second.hasTable("pressed_isolation_probe"), false);
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
    await second.exec(assertion);
  } finally { await first.close(); await second.close(); }
});
test('an omitted certified store removes its explicit dependency closure and preserves unrelated later features',{skip:PRESSED_SKIP_REASON},async()=>{
 const db=await openPressedLayoverDb({without:['2700']});
 try{
  assert.equal(await db.hasTable('layover_certified_computations'),false);assert.equal(await db.hasTable('layover_experience_plans'),false);
  assert.equal(await db.hasTable('layover_objective_facts'),true);assert.equal(await db.hasTable('layover_safe_return_links'),true);
  assert.ok(db.report?.variantExcluded.some(f=>f.startsWith('3898_')&&f.includes('dependency omitted:')));
  assert.ok(db.report?.variantExcluded.every(f=>f.includes('(dependency omitted:')));
 }finally{await db.close();}
});
test('different cold PostgreSQL template keys serialize cluster-wide role initialization',{skip:PRESSED_SKIP_REASON},async t=>{
 if(PRESSED_BACKEND!=='psql'){t.diagnostic('Cluster-global role concurrency is exercised on the PostgreSQL backend; PGlite owns separate clusters.');return;}
 const role=`pressed_probe_${randomUUID().replaceAll('-','')}`;let active=0,peak=0;
 const options={url:process.env['LOCAL_DB_URL']!,without:[],prelude:()=>'',key:async()=>randomUUID().replaceAll('-','').slice(0,24),replay:async(db:{exec(sql:string):Promise<unknown>},version:string)=>{
  active++;peak=Math.max(peak,active);
  try{await db.exec(`DO $probe$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN PERFORM pg_sleep(0.1);EXECUTE 'CREATE ROLE ${role}';END IF;END $probe$;`);}finally{active--;}
  return {engine:version,key:'',applied:0,excluded:[],variantExcluded:[],standIn:'none',seconds:0};
 }};
 const results=await Promise.allSettled([openIsolatedPressedPostgres(options),openIsolatedPressedPostgres(options)]);
 const opened=results.flatMap(r=>r.status==='fulfilled'?[r.value]:[]);
 try{for(const r of results)assert.equal(r.status,'fulfilled',r.status==='rejected'?String(r.reason):'');assert.equal(peak,1,'different templates must not concurrently run cluster role DDL');}
 finally{if(opened[0])await opened[0].engine.exec(`DROP ROLE IF EXISTS ${role}`);for(const result of opened)await result.engine.close();}
});
