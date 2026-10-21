import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from 'pg';
import { pressedPostgresServer, pressedPostgresConnection } from "./db/pressedPostgres.js";
import { pressedMigrationOmissions, executePressedMigrationChain } from './db/pressedLayoverDb.js';

test("destructive PostgreSQL proof harness refuses hosted and overridden destinations", () => {
  for (const url of [
    "postgresql://postgres@example.com/db", "postgresql://postgres@127.0.0.1.example.com/db",
    "https://127.0.0.1/db", "postgresql://postgres@127.0.0.1/db?host=example.com",
    "postgresql://postgres@127.0.0.1/db?hostaddr=10.0.0.1", "postgresql://postgres@localhost/db?service=production",
    "postgresql://postgres@localhost/db?servicefile=/tmp/pg_service.conf", "postgresql://postgres@localhost/db?dbname=production",
  ]) assert.throws(() => pressedPostgresServer(url));
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    assert.equal(pressedPostgresServer(`postgresql://postgres@${host}:54329/portava_local`).hostname, host);
  }
});
test('accepted IPv6 loopback reaches pg as an IPv6 literal, not a bracketed DNS name',()=>{
 const client=new Client({connectionString:pressedPostgresConnection('postgresql://postgres@[::1]:54339/original','postgres')});
 assert.equal((client as unknown as {connectionParameters:{host:string;database:string}}).connectionParameters.host,'::1');
 assert.equal((client as unknown as {connectionParameters:{database:string}}).connectionParameters.database,'postgres');
});
test('absent variants exclude only explicit causal dependencies, including transitive ones',()=>{
 const order=['2700_certified.sql','2992_ledger.sql','3620_boundary.sql','3621_erasure.sql','3622_retention.sql','3623_version.sql','3792_verdict.sql','3828_pointer.sql','3871_status.sql','3873_cas.sql','3895_routes.sql','3896_immutable.sql','3897_actions.sql','3898_plans.sql','3899_objective.sql','3907_activity.sql'];
 const plan=pressedMigrationOmissions(order,['2700']);
 assert.deepEqual([...plan.keys()].sort(),['2700_certified.sql','2992_ledger.sql','3623_version.sql','3792_verdict.sql','3828_pointer.sql','3871_status.sql','3873_cas.sql','3895_routes.sql','3896_immutable.sql','3897_actions.sql','3898_plans.sql'].sort());
 assert.deepEqual([...pressedMigrationOmissions(order,['3620']).keys()].sort(),['3620_boundary.sql','3621_erasure.sql','3622_retention.sql']);
 assert.deepEqual([...pressedMigrationOmissions(order,['3899']).keys()].sort(),['3899_objective.sql','3907_activity.sql']);
 assert.throws(()=>pressedMigrationOmissions(order,['9999']),/Unsupported absent migration/);
 for(const dependency of ['2860','2992','3623','3828','3871','3873','3895']){
  const variant=pressedMigrationOmissions([`${dependency}_dependency.sql`,'3908_route_fanout.sql'],[dependency]);
  assert.deepEqual(variant.get('3908_route_fanout.sql'),[`${dependency}_dependency.sql`]);
 }
});
test('an unrelated migration error aborts every absent replay instead of publishing a partial template',async()=>{
 for(const code of ['42601','42501','55P03']){
  let closed=false;const executed:string[]=[];
  const db={exec:async(sql:string)=>{executed.push(sql);if(sql==='3899_objective.sql')throw Object.assign(new Error('injected unrelated migration failure'),{code});},close:async()=>{closed=true;}};
  await assert.rejects(executePressedMigrationChain(db,['2700_certified.sql','2992_ledger.sql','3899_objective.sql','3907_activity.sql'],['2700'],new Set(),f=>f),new RegExp(`3899_objective.sql: ${code}`));
  assert.equal(closed,true);assert.ok(!executed.includes('3907_activity.sql'));assert.ok(!executed.includes('2992_ledger.sql'));
 }
});
