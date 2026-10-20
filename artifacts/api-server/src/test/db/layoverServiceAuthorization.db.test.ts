/** Generated negative HTTP coverage: a newly added route is included without
 * adding a hand-picked fixture. Ownership/consent positive paths have their own
 * pressed suites; this file proves the outer authenticated boundary. */
import assert from 'node:assert/strict';
import { before,after,describe,it } from 'node:test';
import { generateLayoverRouteInventory } from '../helpers/layoverQueryInventory.js';
import { openPressedLayoverDb,PRESSED_SKIP_REASON,type PressedDb } from './pressedLayoverDb.js';
import { startPressedLayoverApp,productionBaseFlags,type PressedApp } from './pressedLayoverApp.js';
const routes=generateLayoverRouteInventory();let db:PressedDb,app:PressedApp;
const oldSecret=process.env.LAYOVER_EVENT_PRODUCER_SECRET;
describe('all generated Layover HTTP entry points require authorization',{skip:PRESSED_SKIP_REASON},()=>{
 before(async()=>{db=await openPressedLayoverDb();await productionBaseFlags(db);await db.setFlag('layover_service_write_audit_enabled',true);const [curation,connections]=await Promise.all([import('../../routes/airportCuration.js'),import('../../routes/layoverConnections.js')]);app=await startPressedLayoverApp(db,{extraRouters:[curation.default,connections.default]});process.env.LAYOVER_EVENT_PRODUCER_SECRET='isolated-audit-producer-test';});
 after(async()=>{if(oldSecret===undefined)delete process.env.LAYOVER_EVENT_PRODUCER_SECRET;else process.env.LAYOVER_EVENT_PRODUCER_SECRET=oldSecret;await app?.close();await db?.close();});
 it('every discovered route rejects unauthenticated callers before changing protected state',async()=>{
  assert.ok(routes.length>60,'route extraction collapsed');assert.deepEqual(routes.filter(r=>r.authorization.length===0),[],'route lacks an initial guarded authorization chain');const failures:string[]=[];
  for(const r of routes){const path='/api'+r.path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g,'00000000-0000-4000-8000-000000000001');const result=await app.call(r.method,path,null,r.method==='GET'?undefined:{});if(![401,403].includes(result.status))failures.push(`${r.file}:${r.line} ${r.method} ${r.path}: ${result.status} ${result.raw}`);}
  assert.deepEqual(failures,[]);assert.equal((await db.query('SELECT id FROM public.layover_service_write_audit')).length,0);
 });
});
