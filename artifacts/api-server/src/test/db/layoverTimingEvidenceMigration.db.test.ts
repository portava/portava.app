import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openPressedLayoverDb, PRESSED_SKIP_REASON } from './pressedLayoverDb.js';
import { migratedCatalogAndRows } from './migratedCatalogSnapshot.js';
const migration=(name:string)=>readFileSync(new URL(`../../migrations/${name}`,import.meta.url),'utf8');
const rollback=(name:string)=>readFileSync(new URL(`../../../../../db/rollback/${name}`,import.meta.url),'utf8');
const f1=migration('3881_airport_sourced_timing.sql'),f2=migration('3907_layover_activity_commitment.sql');
const b1=rollback('2026-10-19-3881-airport-sourced-timing-rollback.sql'),b2=rollback('2026-10-19-3907-layover-activity-commitment-rollback.sql');
for(const order of ['sorted-gap','after-3999'] as const)describe(`3881/3907 ${order}: entire catalog and all rows, repeat/reapply and changed-object refusals`,{skip:PRESSED_SKIP_REASON},()=>{it(`3881/3907 ${order}: entire catalog and all rows, repeat/reapply and changed-object refusals`,async()=>{
  const db=await openPressedLayoverDb({without:order==='after-3999'?['3881','3907']:[]});
  try{
    if(order==='sorted-gap'){await db.exec(b2);await db.exec(b1);}
    await db.seedUser('timing_rollback_owner');await db.exec("COMMENT ON TABLE public.layover_sessions IS 'Unrelated preexisting timing proof comment'; INSERT INTO public.airport_profiles(iata_code,name,city,country,country_code,timezone,lat,lng) VALUES('ZZT','Timing test fixture','Testville','Singapore','SG','UTC',1.3,103.9);");
    const baseline=await migratedCatalogAndRows(db);
    for(const setup of ["INSERT INTO public.feature_flags(flag,enabled) VALUES('layover_activity_commitment_enabled',false)","INSERT INTO public.feature_flags(flag,enabled) VALUES('layover_activity_commitment_enabled',false); INSERT INTO public.feature_flag_audit_log(flag,old_enabled,new_enabled) VALUES('layover_activity_commitment_enabled',false,true)"]){await db.exec(`BEGIN; ${setup}`);await assert.rejects(db.exec(f2),/unowned activity flag/);await db.exec('ROLLBACK');assert.deepEqual(await migratedCatalogAndRows(db),baseline,'unowned flag/history cannot be claimed');}
    for(const sequence of [[f1,f2],[f2,f1]]){
      for(const sql of sequence)await db.exec(sql);
      const installed=await migratedCatalogAndRows(db);
      const refuses=async(label:string,sql:string,setup:string)=>{
        await db.exec(`BEGIN; ${setup}`);let failure:unknown;try{await db.exec(sql);}catch(e){failure=e;}await db.exec('ROLLBACK');
        assert.ok(failure,label);assert.match(String(failure),/REFUSED|PRECONDITION|depend/i,label);assert.deepEqual(await migratedCatalogAndRows(db),installed,`${label}: catalog/all rows unchanged`);
      };
      await refuses('repeat timing forward',f1,'');await refuses('repeat activity forward',f2,'');
      for(const setup of [
        'ALTER FUNCTION public.airport_profiles_timing_evidence_guard() COST 101;',
        'ALTER FUNCTION public.airport_profiles_timing_evidence_guard() SECURITY DEFINER;',
        'GRANT EXECUTE ON FUNCTION public.airport_profiles_timing_evidence_guard() TO authenticated;',
        'CREATE ROLE timing_extra_grantee; GRANT EXECUTE ON FUNCTION public.airport_profiles_timing_evidence_guard() TO timing_extra_grantee;',
        'REVOKE ALL ON FUNCTION public.airport_profiles_timing_evidence_guard() FROM CURRENT_USER,service_role;',
        'ALTER TABLE public.airport_profiles DISABLE TRIGGER airport_profiles_timing_evidence_guard;',
        'DROP TRIGGER airport_profiles_timing_evidence_guard ON public.airport_profiles;',
        "ALTER TABLE public.airport_profiles ALTER COLUMN curated_timing_evidence SET DEFAULT '{}'::jsonb;",
        'GRANT SELECT(curated_timing_evidence) ON public.airport_profiles TO authenticated;',
        'ALTER TABLE public.airport_profiles ADD CONSTRAINT timing_extra_check CHECK(curated_timing_evidence IS NULL);',
        'CREATE INDEX timing_extra_index ON public.airport_profiles(curated_timing_evidence);',
        'CREATE VIEW public.timing_extra_view AS SELECT curated_timing_evidence FROM public.airport_profiles;',
        `INSERT INTO public.airport_curated_facts(airport_id,fact_kind,fact_class,version,value,source_kind,source_note,retrieved_at,expires_at,proposed_via) SELECT id,'timing_assumptions','STATIC_TOPOLOGY',10001,'{"timingEvidence":{}}','curator_judgment','Test evidence which rollback must preserve',now(),now()+interval '1 day','admin' FROM public.airport_profiles LIMIT 1;`,
      ])await refuses(`3881 drift or evidence: ${setup}`,b1,setup);
      for(const setup of [
        "UPDATE public.feature_flags SET enabled=true WHERE flag='layover_activity_commitment_enabled';",
        "INSERT INTO public.feature_flag_audit_log(flag,old_enabled,new_enabled) VALUES('layover_activity_commitment_enabled',false,true);",
        "UPDATE public.feature_flags SET metadata='{\"changed\":true}' WHERE flag='layover_activity_commitment_enabled';",
        "ALTER TABLE public.layover_objective_facts DROP CONSTRAINT layover_objective_facts_kind_check; ALTER TABLE public.layover_objective_facts ADD CONSTRAINT layover_objective_facts_kind_check CHECK(kind<>'something_else');",
        `WITH p AS (INSERT INTO public.discovery_places(city,name,place_type,status,lat,lng) VALUES('Testville','Rollback commitment evidence','cafe','active',1.3,103.9) RETURNING id) INSERT INTO public.layover_objective_facts(airport_id,place_id,kind,value,source_class,source_url,source_note,observed_at,expires_at) SELECT a.id,p.id,'activity_commitment','{"interruptibility":"committed","minimumCommitmentMinutes":60,"exitDelayMinutes":5}','venue_operator','https://example.test/actual-terms','Existing source evidence must be preserved',now(),now()+interval '1 day' FROM public.airport_profiles a CROSS JOIN p LIMIT 1;`,
      ])await refuses('3907 flag or constraint drift',b2,setup);
      await db.exec(b2);await db.exec(b1);assert.deepEqual(await migratedCatalogAndRows(db),baseline,'both orders restore complete predecessor');
      await db.exec(b1);await db.exec(b2);assert.deepEqual(await migratedCatalogAndRows(db),baseline,'repeat rollback inert');
    }
    // After3907 restores the original kind check,3899's full fingerprint accepts its predecessor again.
    await db.exec(rollback('2026-10-18-3899-layover-objective-evidence-rollback.sql'));assert.equal((await db.query<{name:string|null}>("SELECT to_regclass('public.layover_objective_facts')::text AS name"))[0]?.name,null);
  }finally{await db.close();}
});});
