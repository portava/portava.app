import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { VideoSegmentNativeSession } from "./memoryVideoSegmentsPostgresFixture.js";
import { buildSensingContributionRow, deriveEpochSecret, revocationCommitment, rotationEpochFor } from '../lib/sensingAnonStore.js';

const binary = process.env.PORTAVA_TEST_POSTGRES_BIN;
let root = "";
let socket = "";
let environment: NodeJS.ProcessEnv;
let args: string[];
const sessions = new Set<VideoSegmentNativeSession>();
function literal(value: unknown): string { return value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`; }
function raw(script: string) {
  return spawnSync(join(binary!, "psql"), args, { input: `SET statement_timeout='7s'; ${script}`, env: environment, encoding: "utf8", timeout: 10000 });
}
function sql(script: string): string {
  const result = raw(script);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function session() {
  const connection = new VideoSegmentNativeSession(join(binary!, "psql"), socket, environment);
  sessions.add(connection);
  return connection;
}
async function blocked(name: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name=${literal(name)} AND wait_event_type='Lock'`) === "1") return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`No lock barrier for ${name}`);
}

function contribution(zone='zone-alpha', token='synthetic-device') {
  const now=Date.now(); const epoch=rotationEpochFor(now);
  const saved=process.env.SENSING_CONTRIBUTOR_PEPPER;
  process.env.SENSING_CONTRIBUTOR_PEPPER='p'.repeat(40);
  try {
    const result=buildSensingContributionRow({commitment:revocationCommitment(deriveEpochSecret(token,epoch)),rotationEpoch:epoch,zoneId:zone,observedAtMs:now,signalBucket:2},now);
    assert.ok(result.ok); return result.row;
  } finally {
    if(saved===undefined) delete process.env.SENSING_CONTRIBUTOR_PEPPER;
    else process.env.SENSING_CONTRIBUTOR_PEPPER=saved;
  }
}
function admit(row=contribution(), hash='credential-hash-123456', scopes=['collect','retain','aggregate']) {
  return `SELECT public.sensing_admit_contribution(${literal(hash)},1,ARRAY[${scopes.map(literal).join(',')}]::text[],${literal(JSON.stringify(row))}::jsonb);`;
}
function execute(row=contribution()) { return sql(`SET ROLE service_role; ${admit(row)}`); }

describe("Sensing atomic admission: real PostgreSQL 17", { skip: !binary ? "PORTAVA_TEST_POSTGRES_BIN missing; required native gate supplies PostgreSQL 17.11" : false }, () => {
  before(() => {
    if (typeof binary !== "string" || !isAbsolute(binary)) throw new Error("PORTAVA_TEST_POSTGRES_BIN must be an absolute PostgreSQL 17.11 bin directory");
    const version = spawnSync(join(binary, "postgres"), ["--version"], { encoding: "utf8" });
    assert.match(version.stdout, /\b17\.11\b/);
    root = realpathSync(mkdtempSync(join(tmpdir(), "sensing-admission-native-")));
    socket = join(root, "socket");
    mkdirSync(socket, { mode: 0o700 });
    environment = { PATH: "/usr/bin:/bin", HOME: root, LC_ALL: "C" };
    for (const [program, options] of [
      ["initdb", ["-D", join(root, "data"), "-U", "postgres", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8"]],
      ["pg_ctl", ["-D", join(root, "data"), "-l", join(root, "postgres.log"), "-w", "-t", "10", "-o",
        `-F -h '' -k '${socket}' -p 55433 -c unix_socket_permissions=0700 -c deadlock_timeout=100ms`, "start"]],
    ] as const) {
      const result: SpawnSyncReturns<string> = spawnSync(join(binary, program), [...options], { env: environment, encoding: "utf8", timeout: 20000 });
      assert.equal(result.status, 0, result.stderr);
    }
    args = ["-X", "--no-password", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-h", socket, "-p", "55433", "-U", "postgres", "-d", "postgres"];
    assert.equal(sql("SHOW listen_addresses"), "");
    assert.equal(sql("SELECT inet_server_addr() IS NULL"), "t");
    assert.equal(sql("SHOW server_version_num"), "170011");
    sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE TABLE feature_flags(flag text PRIMARY KEY,enabled boolean NOT NULL); GRANT USAGE ON SCHEMA public TO service_role");
    for (const filename of ['2315_sensing_anon_contributions.sql','2340_sensing_anon_replay_and_time_bounds.sql','2480_sensing_contribution_sessions.sql','3110_sensing_published_aggregates.sql','3312_sensing_anon_contribution_features.sql','3315_sensing_anon_surface_consent.sql','4006_sensing_atomic_admission.sql']) {
      sql(readFileSync(new URL(`../migrations/${filename}`,import.meta.url),'utf8'));
    }
  });
  beforeEach(() => {
    sql(`TRUNCATE sensing_anon_contributions,sensing_contribution_sessions,sensing_published_aggregates,feature_flags;
      INSERT INTO feature_flags VALUES ('sensing_consent_split_enabled',true),('sensing_publication_enabled',true);
      INSERT INTO sensing_contribution_sessions(credential_hash,policy_version,purpose_scopes,reduction_version,issuance_class,budget_cohorts_remaining,starts_at,expires_at)
      VALUES ('credential-hash-123456',1,ARRAY['collect','retain','aggregate'],1,'authenticated_profile',1,now()-interval '1 minute',now()+interval '1 hour');`);
  });
  afterEach(async () => { await Promise.all([...sessions].map(connection=>connection.close())); sessions.clear(); });
  after(() => {
    if (root && existsSync(join(root,'data','postmaster.pid'))) {
      const result=spawnSync(join(binary!,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','-t','10','stop'],{env:environment,encoding:'utf8',timeout:15000});
      assert.equal(result.status,0,result.stderr);
    }
    if(root) rmSync(root,{recursive:true,force:true});
  });

  test('one new row spends exactly one budget; retry at zero budget is free',()=>{
    const row=contribution(); assert.equal(execute(row),'stored');
    assert.equal(execute(row),'duplicate'); assert.equal(execute(contribution('zone-other')),'budget_exhausted');
    assert.equal(sql('SELECT count(*) FROM sensing_anon_contributions'),'1');
    assert.equal(sql('SELECT budget_cohorts_remaining FROM sensing_contribution_sessions'),'0');
  });
  test('different contributions racing for the last budget store only one',async()=>{
    const first=session(); const second=session();
    await first.query('BEGIN; SET ROLE service_role;'); assert.equal(await first.query(admit()),'stored');
    await second.query("SET application_name='sensing-budget-race'; SET ROLE service_role;");
    const pending=second.query(admit(contribution('zone-other'))); await blocked('sensing-budget-race');
    await first.query('COMMIT;'); assert.equal(await pending,'budget_exhausted');
    assert.equal(sql('SELECT count(*) FROM sensing_anon_contributions'),'1');
  });
  test('parallel retry waits for the original and consumes no second budget',async()=>{
    const first=session(); const second=session(); const row=contribution();
    await first.query('BEGIN; SET ROLE service_role;'); assert.equal(await first.query(admit(row)),'stored');
    await second.query("SET application_name='sensing-replay-race'; SET ROLE service_role;");
    const pending=second.query(admit(row)); await blocked('sensing-replay-race');
    await first.query('COMMIT;'); assert.equal(await pending,'duplicate');
    assert.equal(sql('SELECT budget_cohorts_remaining FROM sensing_contribution_sessions'),'0');
  });
  test('same contributor under separate credentials remains one row and one total charge',async()=>{
    sql("INSERT INTO sensing_contribution_sessions(credential_hash,policy_version,purpose_scopes,reduction_version,issuance_class,budget_cohorts_remaining,starts_at,expires_at) SELECT 'other-hash-123456',policy_version,purpose_scopes,reduction_version,issuance_class,1,starts_at,expires_at FROM sensing_contribution_sessions");
    const first=session(); const second=session(); const row=contribution();
    await first.query('BEGIN; SET ROLE service_role;'); assert.equal(await first.query(admit(row)),'stored');
    await second.query("SET application_name='sensing-cross-session'; SET ROLE service_role;");
    const pending=second.query(admit(row,'other-hash-123456')); await blocked('sensing-cross-session');
    await first.query('COMMIT;'); assert.equal(await pending,'duplicate');
    assert.equal(sql('SELECT sum(budget_cohorts_remaining) FROM sensing_contribution_sessions'),'1');
  });
  test('failed budget mutation rolls back the contribution',()=>{
    sql('ALTER TABLE sensing_contribution_sessions ADD CONSTRAINT synthetic_budget_failure CHECK (budget_cohorts_remaining > 0)');
    try { const result=raw(`SET ROLE service_role; ${admit()}`); assert.notEqual(result.status,0); assert.match(result.stderr,/synthetic_budget_failure/); }
    finally { sql('ALTER TABLE sensing_contribution_sessions DROP CONSTRAINT synthetic_budget_failure'); }
    assert.equal(sql('SELECT count(*) FROM sensing_anon_contributions'),'0');
    assert.equal(sql('SELECT budget_cohorts_remaining FROM sensing_contribution_sessions'),'1');
  });
  test('runtime switch turned off after credential issuance refuses storage',()=>{
    sql('UPDATE feature_flags SET enabled=false'); assert.equal(execute(),'disabled');
    assert.equal(sql('SELECT count(*) FROM sensing_anon_contributions'),'0');
  });
  test('queued admission reads the current off switch under lock',async()=>{
    const blocker=session(); const writer=session();
    await blocker.query('BEGIN; UPDATE feature_flags SET enabled=false;');
    await writer.query("SET application_name='sensing-flag-race'; SET ROLE service_role;");
    const pending=writer.query(admit()); await blocked('sensing-flag-race');
    await blocker.query('COMMIT;'); assert.equal(await pending,'disabled');
    assert.equal(sql('SELECT count(*) FROM sensing_anon_contributions'),'0');
  });
  test('revocation committed while queued is observed before writing',async()=>{
    const blocker=session(); const writer=session();
    await blocker.query("BEGIN; SELECT revoke_sensing_session('credential-hash-123456',clock_timestamp());");
    await writer.query("SET application_name='sensing-revoke-race'; SET ROLE service_role;");
    const pending=writer.query(admit()); await blocked('sensing-revoke-race');
    await blocker.query('COMMIT;'); assert.equal(await pending,'revoked');
    assert.equal(sql('SELECT count(*) FROM sensing_anon_contributions'),'0');
  });
  test('expired and unsupported scopes fail closed without spending budget',()=>{
    assert.equal(sql(`SET ROLE service_role; ${admit(contribution(),undefined,['collect','retain','aggregate','surface'])}`),'policy_changed');
    sql("UPDATE sensing_contribution_sessions SET expires_at=now()-interval '1 second'");
    assert.equal(execute(),'expired'); assert.equal(sql('SELECT budget_cohorts_remaining FROM sensing_contribution_sessions'),'1');
  });
  test('unprivileged roles cannot invoke the command or read pseudonyms',()=>{
    for(const role of ['anon','authenticated']) {
      const result=raw(`SET ROLE ${role}; ${admit()}`); assert.notEqual(result.status,0); assert.match(result.stderr,/permission denied/);
      assert.notEqual(raw(`SET ROLE ${role}; SELECT * FROM sensing_anon_contributions`).status,0);
    }
  });
  test('erasure removes proof-owned rows only and revokes the in-flight credential atomically',async()=>{
    const row=contribution(); const other=contribution('zone-alpha','other-device');
    sql(`INSERT INTO sensing_anon_contributions(contributor_token,rotation_epoch,group_token,zone_id,time_bucket,cohort_key,signal_bucket,reduction_version,created_at,expires_at)
      SELECT contributor_token,rotation_epoch,group_token,zone_id,time_bucket,cohort_key,signal_bucket,reduction_version,created_at,expires_at FROM jsonb_populate_record(NULL::sensing_anon_contributions,${literal(JSON.stringify(other))}::jsonb)`);
    const writer=session(); const eraser=session();
    await writer.query('BEGIN; SET ROLE service_role;'); assert.equal(await writer.query(admit(row)),'stored');
    await eraser.query("SET application_name='sensing-erasure'; SET ROLE service_role;");
    const proofs=JSON.stringify([{rotationEpoch:row.rotation_epoch,contributorToken:row.contributor_token}]);
    const command=`SELECT sensing_revoke_recent('credential-hash-123456',${literal(proofs)}::jsonb);`;
    const pending=eraser.query(command); await blocked('sensing-erasure'); await writer.query('COMMIT;');
    assert.equal(await pending,'t'); assert.equal(await eraser.query(command),'t');
    assert.equal(execute(row),'revoked');
    assert.equal(sql('SELECT contributor_token FROM sensing_anon_contributions'),other.contributor_token);
  });
  test('proof erasure works with ingest off and without an account or session',()=>{
    const row=contribution(); assert.equal(execute(row),'stored'); sql('UPDATE feature_flags SET enabled=false');
    const proof=JSON.stringify([{rotationEpoch:row.rotation_epoch,contributorToken:row.contributor_token}]);
    assert.equal(sql(`SET ROLE service_role; SELECT sensing_revoke_recent(NULL,${literal(proof)}::jsonb)`),'t');
    assert.equal(sql('SELECT count(*) FROM sensing_anon_contributions'),'0');
  });
  test('two publishers cannot publish adjacent counts against the same old history',async()=>{
    const row={cohort_key:'v1|zone-alpha|now',zone_id:'zone-alpha',time_bucket:new Date().toISOString(),reduction_version:1,distinct_contributors:20,distinct_groups:6,max_group_share:0.2,contribution_count:20,median_signal_bucket:2,observed_at:new Date().toISOString(),published_at:new Date().toISOString(),expires_at:new Date(Date.now()+3600000).toISOString()};
    const command=(value:any, expected:string|null=null)=>`SELECT sensing_publish_if_current(${literal(expected)},${literal(JSON.stringify(value))}::jsonb);`;
    const first=session(); const second=session();
    await first.query('BEGIN; SET ROLE service_role;'); assert.equal(await first.query(command(row)),'stored');
    await second.query("SET application_name='sensing-publication-race'; SET ROLE service_role;");
    const pending=second.query(command({...row,distinct_contributors:21,contribution_count:21}));
    await blocked('sensing-publication-race'); await first.query('COMMIT;'); assert.equal(await pending,'conflict');
    assert.equal(sql('SELECT count(*) FROM sensing_published_aggregates'),'1');
  });

});
