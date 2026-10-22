/** L6/L50: production consumer paths on the migrated schema, including the stored-card fallback. */
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb, type PressedUser } from './pressedLayoverDb.js';
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from './pressedLayoverApp.js';
import { certifiedLayoverSnapshot } from '../../services/airport/LayoverSnapshot.js';
import { layoverGemWindow, gemsUnderLayoverMode } from '../../lib/discoveryLayoverGems.js';
import { discoveryLayoverGate, serveUnderLayoverGate } from '../../lib/discoveryLayoverMode.js';
import { recommendationPairingFor, recommendationRowKey } from '../../services/airport/LayoverRecommendationService.js';
import { emitLayoverEvent } from '../../services/airport/LayoverSessionService.js';

let db: PressedDb, app: PressedApp, owner: PressedUser, outsider: PressedUser, sid: string;
const realNow = Date.now; let now = Math.floor(realNow()/60_000)*60_000+10_000;
let snapshotId: string, inputHash: string, blockedId: string;
const endpoint=(suffix:string)=>`/api/airport/sessions/${sid}/${suffix}`;
describe('L6/L50 migrated all-consumer consistency', { skip: PRESSED_SKIP_REASON },()=>{
 before(async()=>{
  Date.now=()=>now; db=await openPressedLayoverDb(); await productionBaseFlags(db);
  await db.setFlags({layover_decision_persistence_enabled:true,layover_canonical_snapshot_enabled:true,layover_recommendation_snapshot_enabled:true,layover_recommendation_status_enabled:true,layover_stable_recommendation_ids_enabled:true,layover_snapshot_consumers_enabled:true,layover_discovery_mode_enabled:true});
  owner=await db.seedUser('surface_owner'); outsider=await db.seedUser('surface_outsider'); app=await startPressedLayoverApp(db); sid=(await startSession(app,owner)).id;
 });
 after(async()=>{Date.now=realNow;await app?.close();await db?.close();});
 it('overview, safety, plan/map, Compass and generated experiences share one canonical identity across later requests',async()=>{
  const overview=await app.call('GET',endpoint('overview'),owner);assert.equal(overview.status,200,overview.raw);
  snapshotId=overview.body.snapshotId;inputHash=overview.body.certification.inputHash;assert.ok(snapshotId&&inputHash);assert.equal(overview.body.snapshotComparable,true,'a canonical overview says its id can be compared — the client keys routed-map refreshes on it');
  for(const [method,suffix,body] of [['GET','safety',undefined],['GET','stops',undefined],['POST','compass',{question:'Can I leave the airport?'}]] as const){
   now+=100;const r=await app.call(method,endpoint(suffix),owner,body);assert.equal(r.status,200,r.raw);assert.equal(r.body.certification.inputHash,inputHash,suffix);
   if(r.body.snapshotId)assert.equal(r.body.snapshotId,snapshotId,suffix);
  }
  for(const suffix of ['recommendations','experiences']){
   now+=100;const r=await app.call('GET',endpoint(suffix),owner);assert.equal(r.status,200,r.raw);assert.equal(r.body.snapshotId,snapshotId,suffix);
   assert.ok(r.body.recommendations.some((c:any)=>c.available));
   for(const c of r.body.recommendations)assert.equal(c.contract.snapshotId,snapshotId,`${suffix}:${c.title}`);
  }
  const rows=await db.query<{snapshot_id:string}>(`SELECT snapshot_id FROM public.layover_certified_computations WHERE session_id='${sid}'`);assert.deepEqual(rows.map(r=>r.snapshot_id),[snapshotId]);
 });
 it('Discovery and Hidden Gems cite that same snapshot and retain named unavailable public candidates',async()=>{
  const window=await layoverGemWindow(db.client,owner.id);assert.equal(window.kind,'certified');if(window.kind!=='certified')return;
  assert.equal(window.snapshotId,snapshotId);
  const candidates=[{id:'00000000-0000-4000-8000-000000000091',lat:1.36,lng:103.99}];
  const gate=await discoveryLayoverGate(db.client,owner.id,candidates,'GET /discovery');assert.ok(gate.ok&&gate.active,JSON.stringify(gate));if(!gate.ok||!gate.active)return;
  assert.equal(gate.summary.snapshotId,snapshotId);assert.deepEqual(serveUnderLayoverGate(gate,candidates),[]);
  assert.equal(gate.summary.excluded[0].id,candidates[0].id);assert.ok(gate.summary.excluded[0].state);
  const gems=await gemsUnderLayoverMode(db.client,owner.id,window,candidates,'GET /hidden-gems/layover-safe');assert.ok(gems.ok);if(!gems.ok)return;
  assert.equal(gems.summary?.snapshotId,snapshotId);assert.deepEqual(gems.gems,[]);assert.equal(gems.summary?.excluded[0].id,candidates[0].id);
 });
 it('BLOCKED airside card stays visible and unavailable in stored fallback and cannot be added or compiled',async()=>{
  const [chosen]=await db.query<{id:string}>(`SELECT id FROM public.layover_recommendations WHERE session_id='${sid}' AND inside_airport=true LIMIT 1`);assert.ok(chosen);blockedId=chosen.id;
  await db.exec(`UPDATE public.layover_recommendations SET recommendation_status='BLOCKED',risk_band='UNSAFE',status_reason='unsafe_return_risk' WHERE id='${blockedId}'`);
  await db.setFlag('layover_safety_engine_enabled',false);
  const listed=await app.call('GET',endpoint('recommendations'),owner);assert.equal(listed.status,200,listed.raw);assert.equal(listed.body.snapshotId,snapshotId);
  const blocked=listed.body.recommendations.find((r:any)=>r.id===blockedId);assert.ok(blocked,listed.raw);assert.equal(blocked.available,false);assert.equal(blocked.status,'BLOCKED');assert.ok(blocked.statusExplanation);
  const before=await db.query(`SELECT * FROM public.layover_plan_stops WHERE session_id='${sid}'`);
  const add=await app.call('POST',endpoint('stops/from-recommendation'),owner,{recommendationId:blockedId,snapshotId});assert.equal(add.status,409,add.raw);assert.equal(add.body.reason,'RECOMMENDATION_UNAVAILABLE');
  const compiled=await app.call('POST',endpoint('experiences/compile'),owner,{candidateIds:[blockedId]});assert.equal(compiled.status,409,compiled.raw);assert.equal(compiled.body.reason,'candidate_unavailable');
  assert.deepEqual(await db.query(`SELECT * FROM public.layover_plan_stops WHERE session_id='${sid}'`),before);
 });
 it('stored public landside blocked card remains unavailable rather than vanishing behind the fallback path',async()=>{
  await db.exec(`UPDATE public.layover_recommendations SET inside_airport=false WHERE id='${blockedId}'`);
  // Persist a coherent historical generation: changing a certified field without
  // updating its pairing would test tamper recovery, not blocked-card visibility.
  const rows=await db.query<Record<string,unknown>>(`SELECT * FROM public.layover_recommendations WHERE session_id='${sid}'`);
  now+=1000;await emitLayoverEvent(db.client,sid,owner.id,'recommendation_generated',{pairing:recommendationPairingFor(sid,inputHash,rows,rows.map(recommendationRowKey))});
  const listed=await app.call('GET',endpoint('recommendations'),owner);assert.equal(listed.status,200,listed.raw);
  const card=listed.body.recommendations.find((r:any)=>r.id===blockedId);assert.ok(card,'an already public BLOCKED card must remain explainable');assert.equal(card.available,false);assert.ok(card.statusExplanation);
  const add=await app.call('POST',endpoint('stops/from-recommendation'),owner,{recommendationId:blockedId,snapshotId});assert.equal(add.status,400,add.raw);assert.match(add.body.message,/no travel time/);
 });
 it('every owned consumer rejects another traveler without exposing the canonical identifier or recommendation',async()=>{
  await db.setFlag('layover_safety_engine_enabled',true);
  for(const suffix of ['overview','safety','stops','recommendations','experiences']){
   const r=await app.call('GET',endpoint(suffix),outsider);assert.equal(r.status,404,r.raw);assert.ok(!r.raw.includes(snapshotId)&&!r.raw.includes(blockedId));
  }
  const compass=await app.call('POST',endpoint('compass'),outsider,{question:'Show this plan'});assert.equal(compass.status,404,compass.raw);
  const direct=await certifiedLayoverSnapshot(db.client,outsider.id,{sessionId:sid,nowMs:now});assert.equal(direct.ok,false);
 });
 it('a changed departure advances every consumer and Safe Return without reusing the old recommendation authority',async()=>{
  const [oldCard]=await db.query<{id:string}>(`SELECT id FROM public.layover_recommendations WHERE session_id='${sid}' AND inside_airport=true AND recommendation_status='ELIGIBLE' LIMIT 1`);assert.ok(oldCard);
  now+=1000;const changed=await app.call('PATCH',`/api/airport/sessions/${sid}`,owner,{departureTime:new Date(now+5*3_600_000).toISOString()});assert.equal(changed.status,200,changed.raw);
  const overview=await app.call('GET',endpoint('overview'),owner);assert.equal(overview.status,200,overview.raw);assert.notEqual(overview.body.snapshotId,snapshotId);
  const nextId=overview.body.snapshotId,nextHash=overview.body.certification.inputHash;
  for(const suffix of ['safety','recommendations','experiences']){
   now+=100;const r=await app.call('GET',endpoint(suffix),owner);assert.equal(r.status,200,r.raw);assert.equal(r.body.snapshotId,nextId,suffix);
  }
  const stale=await app.call('POST',endpoint('stops/from-recommendation'),owner,{recommendationId:oldCard.id,snapshotId});assert.equal(stale.status,409,stale.raw);assert.equal(stale.body.reason,'RECOMMENDATION_EXPIRED');
  const gate=await discoveryLayoverGate(db.client,owner.id,[],'GET /discovery');assert.ok(gate.ok&&gate.active);if(gate.ok&&gate.active)assert.equal(gate.summary.snapshotId,nextId);
  await db.setFlag('layover_safe_return_status_enabled',true);
  const returned=await app.call('POST',endpoint('return-now'),owner,{tellCrew:false});assert.equal(returned.status,200,returned.raw);assert.equal(returned.body.returnContract.certification.inputHash,nextHash);assert.equal(returned.body.returnContract.hardReturnTime,overview.body.window.hardReturnTime);
  const history=await db.query(`SELECT id FROM public.layover_recommendation_supersessions WHERE session_id='${sid}' AND superseded_snapshot_id='${snapshotId}'`);assert.ok(history.length>0,'changed authority must retain historical evidence');
 });
});
