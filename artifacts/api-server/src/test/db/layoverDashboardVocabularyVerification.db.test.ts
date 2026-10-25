/** L175/L192 independent HTTP/catalog probes with isolated, deliberately broken controls. */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import type { Server } from "node:http";
import express from "express";
import ts from "typescript";
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp, type Reply } from "./pressedLayoverApp.js";
let db: PressedDb, app: PressedApp, owner: PressedUser, other: PressedUser;
const realNow=Date.now;let now=Math.floor(realNow()/60000)*60000+10000;
const vocabulary:Record<string,readonly string[]>={
 flight_type:["domestic","international"],comfort_level:["safe_only","moderate","adventurous"],status:["active","returning","completed","cancelled","expired"],
 state:["DETECTED","NEEDS_INFO","EVALUATING","AIRPORT_ONLY","LANDSIDE_AVAILABLE","PLAN_SELECTED","EXECUTING","RETURN_SOON","RETURN_NOW","RETURNING","AIRPORT_REENTERED","BOARDING","COMPLETED","DISRUPTED","CANCELLED","ABANDONED","EXPIRED"],
 connection_type:["single_booking","separate_bookings","unknown"],detected_source:["manual","trip_itinerary"],confidence_band:["HIGH","MEDIUM","LOW","INSUFFICIENT"],
};
async function certified(reply:Reply,sid:string){
 assert.equal(reply.status,200,reply.raw);assert.equal(reply.body.ok,true);
 assert.match(reply.body.persisted?.state??"",/^(recorded|already_recorded|active_snapshot)$/,"dashboard must disclose a stored evaluation");
 const rows=await db.query<{snapshot_id:string;input_hash:string}>(`SELECT snapshot_id,input_hash FROM public.layover_certified_computations WHERE session_id='${sid}'`);
 assert.equal(rows.length,1,"dashboard must publish exactly one stored computation");assert.equal(reply.body.snapshotId,rows[0]!.snapshot_id);
 assert.equal(reply.body.certification.inputHash,rows[0]!.input_hash);return rows[0]!.snapshot_id;
}
async function invalidVocabularyRejected(column:string){
 await assert.rejects(db.exec(`INSERT INTO public.layover_sessions(user_id,arrival_time,departure_time,${column}) VALUES('${owner.id}',now(),now()+interval '5 hours','__not_a_spec_value__')`),/check constraint|23514/i,`${column} must reject an invented value`);
}
/** Transpile only a copied router and resolve its imports to the original modules. No worktree file is mutated. */
async function brokenDashboardRouter(){
 const sourcePath=fileURLToPath(new URL("../../routes/airport.ts",import.meta.url)),original=readFileSync(sourcePath,"utf8");
 const call="await evaluateLayoverFeasibility(sc, user.id, session.id, { nowMs, loaded: { session, airport } })";
 assert.equal(original.split(call).length-1,1,"exact dashboard evaluate call must exist");
 const mutant=original.replace(call,'({ ok: true, record: certifySessionFeasibility(airport, session, { nowMs, entry: await sessionEntry(sc, airport, session) }), storage: { stored: false, reason: "persistence_disabled" } })');
 let output=ts.transpileModule(mutant,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,esModuleInterop:true}}).outputText;
 const parsed=ts.createSourceFile("airport-mutant.mjs",output,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),require=createRequire(sourcePath),edits:Array<{start:number;end:number;text:string}>=[];
 const visit=(node:ts.Node)=>{
  if(ts.isStringLiteral(node)&&((ts.isImportDeclaration(node.parent)||ts.isExportDeclaration(node.parent))||ts.isCallExpression(node.parent)&&node.parent.expression.kind===ts.SyntaxKind.ImportKeyword)){
   const spec=node.text;if(!spec.startsWith("node:")){
    let destination:string;
    if(spec.startsWith(".")){destination=resolve(dirname(sourcePath),spec);if(!existsSync(destination)&&destination.endsWith(".js"))destination=destination.slice(0,-3)+".ts";}
    else destination=require.resolve(spec);
    edits.push({start:node.getStart(parsed),end:node.end,text:JSON.stringify(pathToFileURL(destination).href)});
   }
  }ts.forEachChild(node,visit);
 };visit(parsed);for(const edit of edits.sort((a,b)=>b.start-a.start))output=output.slice(0,edit.start)+edit.text+output.slice(edit.end);
 const directory=mkdtempSync(join(tmpdir(),"layover-dashboard-mutant-")),path=join(directory,"airport-mutant.mjs");writeFileSync(path,output);
 try{return {router:(await import(pathToFileURL(path).href)).default as express.Router,cleanup:()=>rmSync(directory,{recursive:true,force:true}),sourcePath,original};}catch(error){rmSync(directory,{recursive:true,force:true});throw error;}
}
describe("L175/L192 independent acceptance and falsifying controls",{skip:PRESSED_SKIP_REASON},()=>{
 before(async()=>{Date.now=()=>now;db=await openPressedLayoverDb();keepConstraintsUndeclared();await productionBaseFlags(db);await db.setFlags({layover_decision_persistence_enabled:true,layover_canonical_snapshot_enabled:true,layover_recommendation_snapshot_enabled:true,layover_recommendation_status_enabled:true});owner=await db.seedUser("dashboard_verify");other=await db.seedUser("dashboard_other");app=await startPressedLayoverApp(db);});
 after(async()=>{Date.now=realNow;await app?.close();await db?.close();});
 it("dashboard main HTTP route publishes one stored evaluation that safety reuses at a later instant",async t=>{
  const sid=(await startSession(app,owner)).id;const start=performance.now(),overview=await app.call("GET",`/api/airport/sessions/${sid}/overview`,owner),writeMs=performance.now()-start;
  const id=await certified(overview,sid);now+=100;const readStart=performance.now(),safety=await app.call("GET",`/api/airport/sessions/${sid}/safety`,owner);
  assert.equal(safety.status,200,safety.raw);assert.equal(safety.body.snapshotId,id);assert.equal(safety.body.persisted.state,"active_snapshot");await certified(await app.call("GET",`/api/airport/sessions/${sid}/overview`,owner),sid);
  assert.equal((await app.call("GET",`/api/airport/sessions/${sid}/overview`,other)).status,404);
  t.diagnostic(`local fixture dashboard ${writeMs.toFixed(1)}ms; safety+subsequent dashboard ${(performance.now()-readStart).toFixed(1)}ms; one stored row, no production latency claim`);
 });
 it("bypassing evaluate in an isolated copied dashboard is killed by the actual HTTP persistence invariant",async()=>{
  const mutant=await brokenDashboardRouter();let server:Server|undefined;
  try{
   const web=express();web.use(express.json());web.use("/api",mutant.router);server=await new Promise<Server>(resolve=>{const s=web.listen(0,"127.0.0.1",()=>resolve(s));});
   const address=server.address();assert.ok(address&&typeof address!=="string");const sid=(await startSession(app,owner)).id;
   const response=await fetch(`http://127.0.0.1:${address.port}/api/airport/sessions/${sid}/overview`,{headers:{authorization:`Bearer ${owner.token}`}}),raw=await response.text(),body=JSON.parse(raw);
   assert.equal(response.status,200,raw);assert.equal(body.persisted.state,"not_stored");assert.equal((await db.query(`SELECT id FROM public.layover_certified_computations WHERE session_id='${sid}'`)).length,0);
   await assert.rejects(certified({status:response.status,body,raw},sid),/dashboard must disclose a stored evaluation/);
   assert.equal(readFileSync(mutant.sourcePath,"utf8"),mutant.original,"shared router remains unchanged");
  }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));mutant.cleanup();}
 });
 it("every session vocabulary is exactly TEXT plus the spec CHECK set and rejects actual invalid writes",async()=>{
  const columns=await db.query<{column_name:string;data_type:string}>("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='layover_sessions'");
  const checks=await db.query<{definition:string}>("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.layover_sessions'::regclass AND contype='c'");
  for(const [column,values]of Object.entries(vocabulary)){
   assert.equal(columns.find(row=>row.column_name===column)?.data_type,"text",column);
   const found=[...new Set(checks.filter(row=>new RegExp(`\\b${column}\\b`).test(row.definition)).flatMap(row=>[...row.definition.matchAll(/'([^']+)'::text/g)].map(match=>match[1])))].sort();assert.deepEqual(found,[...values].sort(),column);
   await invalidVocabularyRejected(column);
  }
 });
 it("a removed vocabulary CHECK is killed by the invalid-write probe",{skip:PRESSED_SKIP_REASON},async()=>{
  const [{conname}]=await db.query<{conname:string}>("SELECT conname FROM pg_constraint WHERE conrelid='public.layover_sessions'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%flight_type%'");
  await db.exec(`BEGIN;ALTER TABLE public.layover_sessions DROP CONSTRAINT "${conname.replaceAll('"','""')}"`);
  try{await assert.rejects(invalidVocabularyRejected("flight_type"),/must reject an invented value/);}finally{await db.exec("ROLLBACK");}
  await invalidVocabularyRejected("flight_type");
 });
 it("owner-only session RLS rejects cross-user reads and both owner/foreign direct writes; an opened policy mutant is killed",async()=>{
  const sid=(await startSession(app,owner)).id;
  assert.equal((await db.query<{enabled:boolean}>("SELECT relrowsecurity AS enabled FROM pg_class WHERE oid='public.layover_sessions'::regclass"))[0]!.enabled,true);
  assert.equal((await db.asUser(owner.id,`SELECT id FROM public.layover_sessions WHERE id='${sid}'`)).length,1);
  const privateRead=async()=>assert.equal((await db.asUser(other.id,`SELECT id FROM public.layover_sessions WHERE id='${sid}'`)).length,0,"foreign session must remain private");await privateRead();
  for(const who of [owner,other])await assert.rejects(db.asUser(who.id,`UPDATE public.layover_sessions SET state='EXECUTING' WHERE id='${sid}' RETURNING id`),/permission denied|server|42501/i);
  { // Both engines own disposable isolated databases.
   const [{expression}]=await db.query<{expression:string}>("SELECT pg_get_expr(polqual,polrelid) AS expression FROM pg_policy WHERE polrelid='public.layover_sessions'::regclass AND polname='layover_sessions_owner'");
   // asUser owns its own transaction, so restore the exact policy expression explicitly.
   await db.exec('ALTER POLICY layover_sessions_owner ON public.layover_sessions USING(true)');
   try{await assert.rejects(privateRead(),/foreign session must remain private/);}finally{await db.exec(`ALTER POLICY layover_sessions_owner ON public.layover_sessions USING(${expression})`);}await privateRead();
  }
 });
});

import { keepConstraintsUndeclared } from "./pressedLayoverApp.js"; // census-layover §83: this suite owns its constraint declarations under PRESSED_BASE
