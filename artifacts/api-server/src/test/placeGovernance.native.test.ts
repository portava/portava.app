import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { VideoSegmentNativeSession } from "./memoryVideoSegmentsPostgresFixture.js";

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

const admin='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', place='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', target='cccccccc-cccc-4ccc-8ccc-cccccccccccc', report='dddddddd-dddd-4ddd-8ddd-dddddddddddd', operation='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
function context(action='withhold', reportId:string|null=report, intoId:string|null=null) {
 return JSON.parse(sql(`SET ROLE service_role; SELECT public.get_place_governance_context(${literal(admin)},${literal(place)},${literal(action)},${literal(reportId)},${literal(intoId)});`));
}
function command(c:any, op=operation, reason='Reviewed evidence') {return `SELECT public.apply_place_governance_action(${[admin,place,c.action,c.reportId,c.intoId,op,reason,c.contextToken].map(literal).join(',')});`;}
function execute(c:any, op=operation) {return JSON.parse(sql(`SET ROLE service_role; ${command(c,op)}`));}
function refuses(script:string, pattern:RegExp) {const r=raw(`SET ROLE service_role; ${script}`);assert.notEqual(r.status,0);assert.match(r.stderr,pattern);}
describe('canonical place governance: real PostgreSQL17',{skip:!binary?'PORTAVA_TEST_POSTGRES_BIN required':false},()=>{
  before(() => {
    if (typeof binary !== "string" || !isAbsolute(binary)) throw new Error("PORTAVA_TEST_POSTGRES_BIN must be an absolute PostgreSQL 17.11 bin directory");
    const version = spawnSync(join(binary, "postgres"), ["--version"], { encoding: "utf8" });
    assert.match(version.stdout, /\b17\.11\b/);
    root = realpathSync(mkdtempSync(join(tmpdir(), "place-governance-native-")));
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

    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
      CREATE TABLE profiles(id uuid PRIMARY KEY,role text NOT NULL);
      CREATE TABLE moderation_reports(id uuid PRIMARY KEY,subject_type text,subject_id text,subject_user_id uuid,status text,details text);
      CREATE TABLE canonical_locations(id uuid PRIMARY KEY);
      CREATE TABLE hidden_gems(id uuid PRIMARY KEY,canonical_place_id uuid);
      CREATE TABLE reviews(id uuid PRIMARY KEY,entity_type text,entity_id uuid,body text,rating integer,state text);
      CREATE TABLE place_votes(user_id uuid,entity_type text,entity_id text,vote text);
      CREATE TABLE memories(id uuid PRIMARY KEY,place_id text,place_display_name_at_occurrence text);
      CREATE TABLE feature_flags(flag text PRIMARY KEY,enabled boolean,description text);
      CREATE TABLE discovery_places(id uuid PRIMARY KEY,submitted_by uuid,city text,neighborhood text,lat double precision,lng double precision,created_at timestamptz,category text,place_type text,canonical_location_id uuid,osm_id text,status text NOT NULL DEFAULT 'active');
      ALTER TABLE discovery_places ENABLE ROW LEVEL SECURITY;
      CREATE POLICY discovery_places_public_read ON discovery_places FOR SELECT USING(status='active');
      CREATE POLICY discovery_places_owner_delete ON discovery_places FOR DELETE USING(auth.uid()=submitted_by);
      CREATE TABLE protected_zones(active boolean);
      CREATE FUNCTION public.discovery_trend_position_is_clear(double precision,double precision) RETURNS boolean LANGUAGE sql AS 'SELECT true';
      GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;`);
    sql(readFileSync(new URL('../migrations/2028_canonical_places.sql',import.meta.url),'utf8'));
    sql(readFileSync(new URL('../migrations/4009_canonical_place_governance.sql',import.meta.url),'utf8'));
    sql('CREATE TRIGGER memory_place_occurrence_name_fill BEFORE INSERT OR UPDATE OF place_id,place_display_name_at_occurrence ON memories FOR EACH ROW EXECUTE FUNCTION public.memory_place_occurrence_name_fill();');
    sql('GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role; GRANT SELECT ON places,external_place_references,discovery_places TO anon,authenticated; GRANT DELETE ON discovery_places TO authenticated;');
  });
  beforeEach(()=>{
    sql(`TRUNCATE reviews,place_votes,hidden_gems,memories,place_governance_actions,place_merge_log,external_place_references,places,moderation_reports,profiles,discovery_places CASCADE;
      INSERT INTO profiles VALUES('${admin}','admin');
      INSERT INTO places(id,name,normalized_name,status) VALUES('${place}','Closed cafe','closed cafe','temporarily_closed'),('${target}','Museum','museum','active');
      INSERT INTO moderation_reports VALUES('${report}','place','${place}',NULL,'open','Unsafe listing');
      INSERT INTO external_place_references(place_id,provider,provider_place_id) VALUES('${place}','synthetic','cafe');`);
  });
  afterEach(async () => { await Promise.all([...sessions].map(connection=>connection.close())); sessions.clear(); });
  after(() => {
    if (root && existsSync(join(root,'data','postmaster.pid'))) {
      const result=spawnSync(join(binary!,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','-t','10','stop'],{env:environment,encoding:'utf8',timeout:15000});
      assert.equal(result.status,0,result.stderr);
    }
    if(root) rmSync(root,{recursive:true,force:true});
  });


  test('withholding preserves lifecycle, report and ownerless audit; exact retry recovers receipt',()=>{
    const c=context(), first=execute(c), retry=execute(c);
    assert.equal(retry.auditId,first.auditId);assert.equal(retry.replayed,true);
    assert.equal(sql(`SELECT status||':'||moderation_status FROM places WHERE id='${place}'`),'temporarily_closed:withheld');
    assert.equal(sql('SELECT status FROM moderation_reports'),'open');
    assert.equal(sql('SELECT count(*) FROM place_governance_actions'),'1');
    refuses(command(c,operation,'Different reason'),/PT409/);
  });
  test('withheld ancestor suppresses clients and provider refs through multiple merge hops',()=>{
    execute(context('merge',report,target));
    sql(`UPDATE places SET moderation_status='withheld' WHERE id='${target}';`);
    assert.equal(sql(`SET ROLE anon; SELECT count(*) FROM places`),'0');
    assert.equal(sql(`SET ROLE authenticated; SELECT count(*) FROM external_place_references`),'0');
    assert.equal(sql(`SELECT canonical_place_is_visible('${place}')`),'f');
    assert.equal(sql(`SELECT count(*) FROM places WHERE governance_version=1`),'2');
  });
  test('restore is report-linked and preserves temporarily closed lifecycle',()=>{
    execute(context());sql("UPDATE moderation_reports SET status='actioned'");const restored=execute(context('restore'),randomUUID());assert.equal(restored.action,'restore');assert.equal(sql('SELECT status FROM moderation_reports'),'actioned');
    assert.equal(sql(`SELECT status||':'||moderation_status FROM places WHERE id='${place}'`),'temporarily_closed:visible');
  });
  test('merge/unmerge retain references and restore prior status; legacy unmerge stays unverified',()=>{
    execute(context('merge',null,target));execute(context('unmerge',null),randomUUID());
    assert.equal(sql(`SELECT status FROM places WHERE id='${place}'`),'temporarily_closed');
    assert.equal(sql('SELECT count(*) FROM external_place_references'),'1');assert.equal(sql('SELECT count(*) FROM place_merge_log'),'2');
    assert.equal(sql(`SELECT min(governance_version) FROM places`),'2');
    sql(`UPDATE places SET merged_into_place_id='${target}',status='duplicate',merge_previous_status=NULL WHERE id='${place}'`);
    execute(context('unmerge',null),randomUUID());assert.equal(sql(`SELECT status FROM places WHERE id='${place}'`),'unverified');
  });
  test('stale content, closed reports and namespace collisions cannot authorize action',()=>{
    const c=context();sql(`UPDATE places SET name='Changed' WHERE id='${place}'`);refuses(command(c),/PT409/);
    sql(`UPDATE moderation_reports SET status='dismissed'`);assert.throws(()=>context(),/PT409/);
    sql(`UPDATE moderation_reports SET status='open';INSERT INTO discovery_places(id) VALUES('${place}')`);assert.throws(()=>context(),/PT409/);
  });
  test('audit insert failure rolls back place mutation and merge log',()=>{
    const c=context('merge',null,target);
    sql(`CREATE FUNCTION refuse_place_audit() RETURNS trigger LANGUAGE plpgsql AS $x$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $x$;
      CREATE TRIGGER refuse_place_audit BEFORE INSERT ON place_governance_actions FOR EACH ROW EXECUTE FUNCTION refuse_place_audit();`);
    try{refuses(command(c),/synthetic audit failure/);assert.equal(sql(`SELECT status FROM places WHERE id='${place}'`),'temporarily_closed');assert.equal(sql('SELECT count(*) FROM place_merge_log'),'0');}
    finally{sql('DROP TRIGGER refuse_place_audit ON place_governance_actions; DROP FUNCTION refuse_place_audit();');}
  });
  test('revoked admin role and unprivileged SQL cannot mutate or inspect governance',()=>{
    const c=context();sql(`UPDATE profiles SET role='user' WHERE id='${admin}'`);refuses(command(c),/PT403/);
    for(const role of ['anon','authenticated']) {
      const result=raw(`SET ROLE ${role}; ${command(c)}`);assert.notEqual(result.status,0);assert.match(result.stderr,/permission denied/);
      assert.notEqual(raw(`SET ROLE ${role}; SELECT * FROM place_governance_actions`).status,0);
    }
  });
  test('canonical trend context cannot substitute a same-ID community row for a withheld canonical place',()=>{
    sql(`INSERT INTO discovery_places(id,city,category) VALUES('${place}','synthetic','cafe'); UPDATE places SET moderation_status='withheld' WHERE id='${place}'`);
    assert.equal(sql(`SET ROLE service_role; SELECT count(*) FROM discovery_trend_place_context_canonical() WHERE place_key='${place}'`),'0');
  });
  test('new catalog occurrence fills are withheld while existing owner history remains unchanged',()=>{
    sql(`INSERT INTO memories VALUES('${operation}','${place}',NULL)`);
    assert.equal(sql('SELECT place_display_name_at_occurrence FROM memories'),'Closed cafe');
    execute(context());
    sql(`UPDATE memories SET place_display_name_at_occurrence='replacement' WHERE id='${operation}'; INSERT INTO memories VALUES('${report}','${place}',NULL)`);
    assert.equal(sql(`SELECT place_display_name_at_occurrence FROM memories WHERE id='${operation}'`),'Closed cafe');
    assert.equal(sql(`SELECT place_display_name_at_occurrence IS NULL FROM memories WHERE id='${report}'`),'t');
  });
  test('held canonical or linked gem cannot receive positive reviews/votes/links; retraction remains allowed',()=>{
    sql(`INSERT INTO hidden_gems VALUES('${target}','${place}');INSERT INTO place_votes VALUES('${admin}','gem','${target}','worth_it');INSERT INTO reviews VALUES('${report}','place','${place}','Old review',4,'published');`);
    execute(context());
    refuses(`INSERT INTO reviews VALUES('${operation}','place','${place}','New review',5,'published')`,/PT409/);
    refuses(`INSERT INTO reviews VALUES('${operation}','place','${target}','New gem review',5,'published')`,/PT409/);
    refuses(`UPDATE place_votes SET vote='skip_it'`,/PT409/);
    refuses(`INSERT INTO hidden_gems VALUES('${operation}','${place}')`,/PT409/);
    sql(`SET ROLE service_role; UPDATE reviews SET state='removed',body=NULL WHERE id='${report}'; DELETE FROM place_votes`);assert.equal(sql('SELECT count(*) FROM place_votes'),'0');
    refuses(`UPDATE reviews SET state='published' WHERE id='${report}'`,/PT409/);
  });
  test('positive admission waits for a concurrent moderation transaction and then refuses the held place',async()=>{
    const owner=session();await owner.query("BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('CANONICAL_PLACE_GRAPH_V1',0));");
    const contender=session();await contender.query("SET application_name='place-link-contender'; SET ROLE service_role;");
    const pending=contender.query(`INSERT INTO place_votes VALUES('${admin}','place','${place}','worth_it');`);
    await blocked('place-link-contender');await owner.query(`UPDATE places SET moderation_status='withheld' WHERE id='${place}';COMMIT;`);
    await assert.rejects(pending,/canonical_place_unavailable/);assert.equal(sql('SELECT count(*) FROM place_votes'),'0');
  });

  test('community aliases cannot bypass held canonical admission or feed trend context',()=>{
    sql(`INSERT INTO discovery_places(id,canonical_location_id,city,category) VALUES('${operation}','${place}','synthetic','cafe')`);
    execute(context());
    refuses(`INSERT INTO reviews VALUES('${operation}','place','${operation}','Alias review',5,'published')`,/PT409/);
    refuses(`INSERT INTO place_votes VALUES('${admin}','place','${operation}','worth_it')`,/PT409/);
    refuses(`INSERT INTO discovery_places(id,canonical_location_id) VALUES('${report}','${place}')`,/PT409/);
    refuses(`INSERT INTO discovery_places(id) VALUES('${place}')`,/PT409/);
    assert.equal(sql(`SELECT count(*) FROM public.discovery_trend_place_context_canonical() WHERE place_key='${operation}'`),'0');
    sql(`SET ROLE service_role; DELETE FROM discovery_places WHERE id='${operation}'`);
    assert.equal(sql('SELECT count(*) FROM discovery_places'),'0');
  });
  test('public community reads withhold direct, linked and provider aliases while owner retraction remains possible',()=>{
    sql(`INSERT INTO discovery_places(id,submitted_by,canonical_location_id,osm_id) VALUES
      ('${place}','${admin}',NULL,NULL),('${operation}','${admin}','${place}',NULL),
      ('${report}','${admin}',NULL,'node/1'),('${target}',NULL,NULL,NULL);
      INSERT INTO external_place_references(place_id,provider,provider_place_id) VALUES('${place}','osm','node/1');
      UPDATE places SET moderation_status='withheld' WHERE id='${place}'`);
    for(const role of ['anon','authenticated']) {
      assert.equal(sql(`SET ROLE ${role}; SELECT string_agg(id::text,',') FROM discovery_places`),target);
    }
    assert.equal(sql(`SET ROLE authenticated; SET request.jwt.claim.sub='${admin}'; SELECT count(*) FROM discovery_places`),'4');
    assert.equal(sql(`SET ROLE authenticated; SET request.jwt.claim.sub='${target}'; DELETE FROM discovery_places WHERE id='${report}'; SELECT count(*) FROM discovery_places`),'1');
    assert.equal(sql(`SELECT count(*) FROM discovery_places WHERE id='${report}'`),'1');
    sql(`SET ROLE authenticated; SET request.jwt.claim.sub='${admin}'; DELETE FROM discovery_places WHERE id='${report}'`);
    assert.equal(sql(`SELECT count(*) FROM discovery_places WHERE id='${report}'`),'0');
    sql(`UPDATE places SET moderation_status='visible' WHERE id='${place}'`);
    assert.equal(sql(`SET ROLE anon; SELECT count(*) FROM discovery_places`),'3');
  });
  test('provider-only aliases cannot accept positive activity or revive trend context after withholding',()=>{
    sql(`INSERT INTO discovery_places(id,osm_id) VALUES('${operation}','node/1');
      INSERT INTO external_place_references(place_id,provider,provider_place_id) VALUES('${place}','osm','node/1');
      UPDATE places SET moderation_status='withheld' WHERE id='${place}'`);
    refuses(`INSERT INTO reviews(id,entity_type,entity_id,body,rating,state) VALUES('${report}','place','${operation}','Review',5,'published')`,/PT409/);
    refuses(`INSERT INTO place_votes(user_id,entity_type,entity_id,vote) VALUES('${admin}','place','${operation}','worth_it')`,/PT409/);
    refuses(`INSERT INTO discovery_places(id,osm_id) VALUES('${report}','node/1')`,/PT409/);
    sql(`INSERT INTO discovery_places(id) VALUES('${report}')`);
    refuses(`UPDATE discovery_places SET osm_id='node/1' WHERE id='${report}'`,/PT409/);
    assert.equal(sql(`SET ROLE service_role; SELECT count(*) FROM discovery_trend_place_context_canonical() WHERE place_key='${operation}'`),'0');
  });

  test('graph operations serialize and reject stale context after a concurrent edit',async()=>{
    const c=context(); const owner=session(); await owner.query("SET application_name='place-graph-holder'; BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('CANONICAL_PLACE_GRAPH_V1',0));");
    const contender=session();await contender.query("SET application_name='place-graph-contender'; SET ROLE service_role;");
    const pending=contender.query(command(c));await blocked('place-graph-contender');
    await owner.query(`UPDATE places SET name='Changed during review' WHERE id='${place}'; COMMIT;`);
    await assert.rejects(pending,/place_context_changed/);
    assert.equal(sql('SELECT count(*) FROM place_governance_actions'),'0');
  });
});
