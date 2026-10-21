/** Actual3899 schema: tombstone curator anonymization retains the fact and other curator. */
import { before,after,describe,it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openPressedLayoverDb,PRESSED_SKIP_REASON,type PressedDb } from './pressedLayoverDb.js';
import { anonymiseLayoverObjectiveSources } from '../../services/accountDeletion/AccountDeletionService.js';
let db:PressedDb;
describe('L78 actual account tombstone source erasure',{skip:PRESSED_SKIP_REASON},()=>{
 before(async()=>{db=await openPressedLayoverDb();});after(async()=>{await db?.close();});
 it('retains source evidence, nulls only its curator before tombstoning, and retries idempotently with rollout OFF',async()=>{
  const owner=await db.seedUser('objective_erasure'),other=await db.seedUser('objective_other');
  const airport=randomUUID(),place=randomUUID();
  await db.exec(`INSERT INTO public.airport_profiles(id,iata_code,name,city,country,country_code,lat,lng) VALUES('${airport}','ZZP','Erasure fixture','Fixture','Singapore','SG',1,1)`);
  await db.exec(`INSERT INTO public.discovery_places(id,name,city,place_type,status,lat,lng) VALUES('${place}','Fixture','Fixture','cafe','active',1,1)`);
  for(const actor of [owner,other])await db.exec(`INSERT INTO public.layover_objective_facts(airport_id,place_id,kind,value,source_class,source_url,source_note,observed_at,expires_at,stated_by) VALUES('${airport}','${place}','exertion','{"level":"light"}','venue_operator','https://example.test/source','Explicit erasure fixture',now(),now()+interval '1 hour','${actor.id}')`);
  assert.equal(await db.flag('layover_objective_evidence_enabled'),false);
  const before=await db.query<{id:string;stated_by:string|null;[key:string]:unknown}>(`SELECT * FROM public.layover_objective_facts WHERE airport_id='${airport}' ORDER BY id`);
  await anonymiseLayoverObjectiveSources(db.client,owner.id);
  const after=await db.query(`SELECT * FROM public.layover_objective_facts WHERE airport_id='${airport}' ORDER BY id`);
  assert.deepEqual(after,before.map(row=>({...row,stated_by:row.stated_by===owner.id?null:row.stated_by})));
  await anonymiseLayoverObjectiveSources(db.client,owner.id);
  assert.deepEqual(await db.query(`SELECT * FROM public.layover_objective_facts WHERE airport_id='${airport}' ORDER BY id`),after);
  assert.equal((await db.query(`SELECT id FROM public.profiles WHERE id='${owner.id}'`)).length,1,'tombstone semantics retain the profile row; FK deletion did not do this work');
 });
 it('absent migration is safe but an actual database permission fault is not swallowed',async()=>{
  await db.exec('ALTER TABLE public.layover_objective_facts RENAME TO objective_erasure_fault');
  try { await anonymiseLayoverObjectiveSources(db.client,randomUUID()); }
  finally { await db.exec('ALTER TABLE public.objective_erasure_fault RENAME TO layover_objective_facts'); }
  await db.exec('REVOKE UPDATE ON public.layover_objective_facts FROM service_role');
  try { await assert.rejects(anonymiseLayoverObjectiveSources(db.client,randomUUID()),/permission denied|anonymise layover objective curator/); }
  finally { await db.exec('GRANT UPDATE ON public.layover_objective_facts TO service_role'); }
 });
});
