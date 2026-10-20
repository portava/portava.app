import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import { VideoSegmentNativeSession } from "./memoryVideoSegmentsPostgresFixture.js";

const binary = process.env.PORTAVA_TEST_POSTGRES_BIN;
const baseline = process.env.H146_BASELINE === "1";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const target = "11111111-1111-4111-8111-111111111111";
const foreign = "22222222-2222-4222-8222-222222222222";
const highlight = "33333333-3333-4333-8333-333333333333";
let scratch: string;
let args: string[];
let started = false;

function sql(script: string) {
  const result = spawnSync(join(binary!, "psql"), args, { input: script, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function command(over: Record<string, unknown> = {}, payload: Record<string, unknown> = {}): {
  command_id: string; actor_user_id: string; policy_owner_id: string; type: string; idempotency_key: string; payload: Record<string, unknown>;
} {
  return { command_id: randomUUID(), actor_user_id: owner, policy_owner_id: owner,
    type: "SET_RESURFACING_POLICY", idempotency_key: randomUUID(),
    payload: { target: { kind: "memory", id: target }, control: "DO_NOT_RESURFACE", on: true, ...payload }, ...over };
}
function call(value: ReturnType<typeof command>) {
  return `SELECT public.memory_resurfacing_policy_execute('${JSON.stringify(value).replaceAll("'", "''")}'::jsonb);`;
}
function execute(value: ReturnType<typeof command>) { return JSON.parse(sql(`SET ROLE service_role; ${call(value)}`)); }
function asyncSql(script: string) {
  const child = spawn(join(binary!, "psql"), args, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(script);
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}
async function sleeping(name: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${name}' AND wait_event='PgSleep'`) === "1") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("first transaction did not reach the lock barrier");
}

describe("H146 owner resurfacing policy native contract", { skip: !binary ? "PORTAVA_TEST_POSTGRES_BIN missing; required native gate must supply PostgreSQL 17.11" : false }, () => {
before(() => {
  assert.ok(binary, "PORTAVA_TEST_POSTGRES_BIN must point to the synthetic-local PostgreSQL 17.11 runtime");
  const version = spawnSync(join(binary, "postgres"), ["--version"], { encoding: "utf8" });
  assert.match(version.stdout, /17\.11/);
  scratch = mkdtempSync(join(tmpdir(), "h146-native-"));
  for (const [program, options] of [
    ["initdb", ["-D", join(scratch, "data"), "-U", "postgres", "-A", "trust", "--no-locale"]],
    ["pg_ctl", ["-D", join(scratch, "data"), "-l", join(scratch, "postgres.log"), "-o", `-h '' -k ${scratch} -p 55433`, "-w", "start"]],
  ] as const) {
    const result: SpawnSyncReturns<string> = spawnSync(join(binary, program), [...options], { encoding: "utf8", timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
  }
  started = true;
  args = ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", scratch, "-p", "55433", "-U", "postgres", "-d", "postgres"];
  const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE TABLE profiles(id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE);
    CREATE TABLE memories(id uuid PRIMARY KEY, owner_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
      state text DEFAULT 'published', visibility text DEFAULT 'only_me');
    CREATE TABLE highlights(id uuid PRIMARY KEY, owner_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
      deleted_at timestamptz, archived_at timestamptz, pinned_at timestamptz, expires_at timestamptz);
    CREATE TABLE feature_flags(flag text PRIMARY KEY, enabled boolean, description text);`);
  for (const name of ["2710_memory_command_kernel_tables.sql", "2993_highlight_command_boundary.sql",
    "2720_highlight_resurfacing_preferences.sql", "3671_memory_resurfacing_preferences.sql"]) sql(migration(name));
  const outbox = migration("2994_memory_relations_and_outbox_consumer.sql");
  sql(outbox.slice(outbox.indexOf("-- ── 4. The outbox"), outbox.indexOf("-- ── 5. Postconditions")));
  if (!baseline) {
    sql(`INSERT INTO auth.users VALUES ('${owner}'); INSERT INTO profiles VALUES ('${owner}');
      INSERT INTO memories(id,owner_id) VALUES ('${target}','${owner}');
      INSERT INTO memory_domain_events(event_id,memory_id,sequence,type,occurred_at) VALUES ('${highlight}','${target}',1,'memory.created',now());
      INSERT INTO memory_command_receipts(actor_user_id,idempotency_key,command_id,command_type,event_id,event_type,result_json)
        VALUES ('${owner}','legacy-zero','${target}','CREATE_MEMORY','${highlight}','memory.created','{}');`);
    sql(migration("3993_owner_resurfacing_policy.sql"));
    assert.equal(sql("SELECT count(*) FROM memory_command_receipts WHERE memory_id IS NULL AND highlight_id IS NULL AND policy_owner_id IS NULL"), "1");
    assert.equal(sql("SELECT convalidated FROM pg_constraint WHERE conname='memory_command_receipts_one_subject'"), "f");
    assert.equal(sql("SELECT enabled FROM feature_flags WHERE flag='memory_resurfacing_policy_enabled'"), "f");
    assert.equal(sql("SELECT count(*) FROM pg_policy WHERE polrelid='memory_resurfacing_policy_heads'::regclass"), "0");
    sql("UPDATE feature_flags SET enabled=true WHERE flag='memory_resurfacing_policy_enabled'");
  }
  sql(`GRANT USAGE ON SCHEMA auth, public TO service_role, authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
    UPDATE feature_flags SET enabled = true WHERE flag='memory_kernel_enabled';`);
});
beforeEach(() => {
  sql(`DELETE FROM auth.users; DELETE FROM memory_command_audit;
    INSERT INTO auth.users VALUES ('${owner}'), ('${other}');
    INSERT INTO profiles VALUES ('${owner}'), ('${other}');
    INSERT INTO memories(id,owner_id) VALUES ('${target}','${owner}'), ('${foreign}','${other}');
    INSERT INTO highlights(id,owner_id) VALUES ('${highlight}','${owner}');`);
});
after(() => {
  if (started) spawnSync(join(binary!, "pg_ctl"), ["-D", join(scratch, "data"), "-m", "immediate", "-w", "stop"], { encoding: "utf8" });
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("native RPC commits preference, owner event, receipt, outbox and audit together", () => {
  const result = execute(command());
  assert.equal(result.ok, true);
  assert.equal(result.policy_owner_id, owner);
  assert.equal(sql("SELECT count(*) FROM memory_resurfacing_preferences"), "1");
  assert.equal(sql("SELECT count(*) FROM memory_domain_events WHERE memory_id IS NULL AND highlight_id IS NULL AND policy_owner_id IS NOT NULL"), "1");
  for (const table of ["memory_event_outbox", "memory_command_receipts", "memory_command_audit"]) assert.equal(sql(`SELECT count(*) FROM ${table}`), "1");
  assert.equal(JSON.parse(sql("SELECT row_to_json(claimed) FROM memory_outbox_claim() claimed")).policy_owner_id, owner);
});

test("native normalized retry returns original result; target/control/on/key reuse refuses", () => {
  const first = command();
  const result = execute(first);
  const retry = execute({ ...first, command_id: randomUUID(), payload: { ...first.payload, confirmed: false } });
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.result, result.result);
  for (const change of [{ on: false }, { control: "RETAIN_BUT_DO_NOT_PERSONALIZE" }, { target: { kind: "memory", id: foreign } }]) {
    assert.equal(execute({ ...first, payload: { ...first.payload, ...change } }).reason, "MEMORY_IDEMPOTENCY_KEY_REUSED");
  }
  assert.equal(sql("SELECT command_sequence FROM memory_resurfacing_policy_heads"), "1");
});

test("native all legal scopes, confirmation, absent clear and ownership parity", () => {
  for (const kind of ["memory", "highlight"]) for (const control of ["DO_NOT_RESURFACE", "DO_NOT_INCLUDE_IN_RECAPS", "KEEP_PRIVATE_FOREVER", "RETAIN_BUT_DO_NOT_PERSONALIZE"]) {
    const payload = { target: { kind, id: kind === "memory" ? target : highlight }, control };
    assert.equal(execute(command({}, payload)).ok, true);
    if (kind === "highlight" && control === "KEEP_PRIVATE_FOREVER") assert.equal(execute(command({}, { ...payload, on: false })).reason, "MEMORY_COMMAND_MALFORMED");
    assert.equal(execute(command({}, { ...payload, on: false, confirmed: true })).result.cleared, true);
    assert.equal(execute(command({}, { ...payload, on: false, confirmed: true })).result.cleared, false);
  }
  for (const [kind, control] of [["person", "HIDE_PERSON_FROM_RESURFACING"], ["trip", "HIDE_TRIP"]]) {
    assert.equal(execute(command({}, { target: { kind, id: randomUUID() }, control })).ok, true);
  }
  assert.equal(execute(command({}, { target: { kind: "owner", id: owner } })).reason, "MEMORY_COMMAND_MALFORMED");
  assert.equal(execute(command({ policy_owner_id: other })).reason, "MEMORY_COMMAND_MALFORMED");
  assert.equal(execute(command({}, { target: { kind: "memory", id: foreign } })).reason, "MEMORY_NOT_FOUND");
  assert.equal(execute(command({}, { target: { kind: "highlight", id: randomUUID() }, on: false })).result.cleared, false);
});

for (const failureTable of ["memory_event_outbox", "memory_command_receipts", "memory_command_audit"]) test(`native ${failureTable} failure rolls everything back, identical retry then succeeds`, () => {
  const operation = command();
  sql(`CREATE FUNCTION fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture outbox failure'; END $$;
    CREATE TRIGGER fixture_fail BEFORE INSERT ON ${failureTable} FOR EACH ROW EXECUTE FUNCTION fixture_fail();`);
  assert.throws(() => execute(operation), /fixture outbox failure/);
  for (const table of ["memory_resurfacing_preferences", "memory_resurfacing_policy_heads", "memory_domain_events", "memory_event_outbox", "memory_command_receipts", "memory_command_audit"]) assert.equal(sql(`SELECT count(*) FROM ${table}`), "0");
  sql(`DROP TRIGGER fixture_fail ON ${failureTable}; DROP FUNCTION fixture_fail();`);
  assert.equal(execute(operation).ok, true);
});

test("native concurrent identical keys produce one command, concurrent distinct keys are ordered", async () => {
  const operation = command();
  const answers = await Promise.all([asyncSql(call(operation)), asyncSql(call({ ...operation, command_id: randomUUID() }))]);
  for (const answer of answers) assert.equal(answer.status, 0, answer.stderr);
  assert.equal(sql("SELECT count(*) FROM memory_domain_events"), "1");
  const distinct = await Promise.all([asyncSql(call(command())), asyncSql(call(command({}, { on: false })))]);
  for (const answer of distinct) assert.equal(answer.status, 0, answer.stderr);
  assert.equal(sql("SELECT string_agg(sequence::text, ',' ORDER BY sequence) FROM memory_domain_events"), "1,2,3");
});

for (const existingHead of [false, true]) for (const ancestor of ["auth.users", "public.profiles"]) {
  test(`native ${ancestor} erasure first, existing head=${existingHead}, refuses without holding caller locks`, async () => {
    if (existingHead) assert.equal(execute(command()).ok, true);
    const eraser = new VideoSegmentNativeSession(join(binary!, "psql"), scratch, process.env);
    const writer = new VideoSegmentNativeSession(join(binary!, "psql"), scratch, process.env);
    try {
      const beforeCounts = sql("SELECT (SELECT count(*) FROM memory_command_audit), (SELECT count(*) FROM memory_command_receipts), (SELECT count(*) FROM memory_domain_events), (SELECT count(*) FROM memory_event_outbox)");
      await eraser.query(`BEGIN; SELECT id FROM ${ancestor} WHERE id='${owner}' FOR UPDATE;`);
      const operation = command({}, { target: { kind: "person", id: other }, control: "HIDE_PERSON_FROM_RESURFACING" });
      const result = JSON.parse(await writer.query(`BEGIN; SET LOCAL statement_timeout='1500ms'; SET LOCAL ROLE service_role; ${call(operation)}`));
      assert.equal(result.reason, "MEMORY_KERNEL_UNAVAILABLE");
      assert.equal(sql("SELECT (SELECT count(*) FROM memory_command_audit), (SELECT count(*) FROM memory_command_receipts), (SELECT count(*) FROM memory_domain_events), (SELECT count(*) FROM memory_event_outbox)"), beforeCounts);
      await eraser.query(`SET LOCAL lock_timeout='500ms'; DELETE FROM auth.users WHERE id='${owner}'; COMMIT;`);
      assert.equal(sql(`SELECT count(*) FROM auth.users WHERE id='${owner}'`), "0");
      await writer.query("COMMIT;");
      for (const table of ["memory_resurfacing_policy_heads", "memory_resurfacing_preferences", "highlight_resurfacing_preferences", "memory_domain_events", "memory_command_receipts", "memory_event_outbox"]) {
        assert.equal(sql(`SELECT count(*) FROM ${table}`), "0");
      }
    } finally {
      await writer.close();
      await eraser.close();
    }
  });
}

test("native command-first owner locks release on commit and account erasure removes policy state", async () => {
  const writer = new VideoSegmentNativeSession(join(binary!, "psql"), scratch, process.env);
  try {
    assert.equal(JSON.parse(await writer.query(`BEGIN; SET LOCAL ROLE service_role; ${call(command())}`)).ok, true);
    assert.throws(() => sql(`SET lock_timeout='100ms'; DELETE FROM auth.users WHERE id='${owner}'`), /lock timeout/);
    await writer.query("COMMIT;");
    sql(`DELETE FROM auth.users WHERE id='${owner}'`);
    for (const table of ["memory_resurfacing_policy_heads", "memory_resurfacing_preferences", "memory_domain_events", "memory_command_receipts", "memory_event_outbox"]) {
      assert.equal(sql(`SELECT count(*) FROM ${table}`), "0");
    }
  } finally {
    await writer.close();
  }
});

for (const missing of ["auth.users", "public.profiles"]) test(`native missing ${missing} refuses with no retained owner lock or writes`, async () => {
  sql(`DELETE FROM ${missing} WHERE id='${owner}'`);
  const writer = new VideoSegmentNativeSession(join(binary!, "psql"), scratch, process.env);
  try {
    const operation = command({}, { target: { kind: "person", id: other }, control: "HIDE_PERSON_FROM_RESURFACING" });
    const result = JSON.parse(await writer.query(`BEGIN; SET LOCAL ROLE service_role; ${call(operation)}`));
    assert.equal(result.reason, "MEMORY_KERNEL_UNAVAILABLE");
    sql(`SET lock_timeout='500ms'; DELETE FROM auth.users WHERE id='${owner}'`);
    await writer.query("COMMIT;");
    for (const table of ["memory_resurfacing_policy_heads", "highlight_resurfacing_preferences", "memory_domain_events", "memory_command_receipts", "memory_event_outbox", "memory_command_audit"]) {
      assert.equal(sql(`SELECT count(*) FROM ${table}`), "0");
    }
  } finally {
    await writer.close();
  }
});

for (const privateFirst of [true, false]) test(`native KEEP_PRIVATE race, private first=${privateFirst}`, async () => {
  const protect = `INSERT INTO memory_resurfacing_preferences(memory_id,owner_id,control) VALUES('${target}','${owner}','KEEP_PRIVATE_FOREVER');`;
  const widen = `UPDATE memories SET visibility='public' WHERE id='${target}';`;
  const first = asyncSql(`SET application_name='h146-race'; BEGIN; ${privateFirst ? protect : widen} SELECT pg_sleep(0.5); COMMIT;`);
  await sleeping("h146-race");
  const second = asyncSql(privateFirst ? widen : protect);
  assert.equal((await first).status, 0);
  const refused = await second;
  assert.notEqual(refused.status, 0, "both conflicting writes committed");
  assert.match(refused.stderr, /memory_kept_private/);
  assert.equal(sql(`SELECT visibility FROM memories WHERE id='${target}'`), privateFirst ? "only_me" : "public");
  assert.equal(sql("SELECT count(*) FROM memory_resurfacing_preferences"), privateFirst ? "1" : "0");
});

test("native explicit false flag refuses RPC; client roles cannot execute or read owner heads", () => {
  sql("UPDATE feature_flags SET enabled=false WHERE flag='memory_kernel_enabled'");
  assert.equal(execute(command()).reason, "MEMORY_KERNEL_UNAVAILABLE");
  assert.equal(sql("SELECT has_function_privilege('authenticated','memory_resurfacing_policy_execute(jsonb)','EXECUTE')"), "f");
  assert.equal(sql("SELECT has_table_privilege('authenticated','memory_resurfacing_policy_heads','SELECT')"), "f");
  assert.equal(sql("SELECT has_table_privilege('service_role','auth.users','SELECT')"), "f");
  assert.equal(sql("SELECT has_table_privilege('service_role','auth.users','UPDATE')"), "f");
  for (const role of ["anon", "authenticated"]) {
    assert.equal(sql(`SELECT has_function_privilege('${role}','memory_resurfacing_policy_private.lock_owner(uuid)','EXECUTE')`), "f");
    assert.equal(sql(`SELECT has_schema_privilege('${role}','memory_resurfacing_policy_private','USAGE')`), "f");
  }
  assert.equal(sql("SELECT prosecdef FROM pg_proc WHERE oid='memory_resurfacing_policy_execute(jsonb)'::regprocedure"), "f");
  sql("UPDATE feature_flags SET enabled=true WHERE flag='memory_kernel_enabled'");
  sql("UPDATE feature_flags SET enabled=false WHERE flag='memory_resurfacing_policy_enabled'");
  assert.equal(execute(command()).reason, "MEMORY_KERNEL_UNAVAILABLE");
  sql("UPDATE feature_flags SET enabled=true WHERE flag='memory_resurfacing_policy_enabled'");
});

test("native new receipts reject zero or multiple subjects and refusals create no receipt", () => {
  const result = execute(command());
  assert.throws(() => sql("UPDATE memory_command_receipts SET policy_owner_id=null"), /memory_command_receipts_one_subject/);
  assert.throws(() => sql(`UPDATE memory_command_receipts SET memory_id='${target}'`), /memory_command_receipts_one_subject/);
  assert.equal(execute(command({}, { target: { kind: 'memory', id: foreign } })).ok, false);
  assert.equal(sql("SELECT count(*) FROM memory_command_receipts"), "1");
  assert.equal(sql(`SELECT event_id FROM memory_command_receipts`), result.event_id);
});

test("native unknown commit replay survives target deletion without inventing a Memory subject", () => {
  const operation = command();
  const original = execute(operation);
  sql(`DELETE FROM memories WHERE id='${target}'`);
  const retry = execute({ ...operation, command_id: randomUUID() });
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.result, original.result);
  assert.equal(retry.event_id, original.event_id);
  assert.equal(sql("SELECT count(*) FROM memory_event_outbox"), "1");
});

test("native policy events add no client history surface, including for the owner", () => {
  execute(command());
  assert.equal(sql("SELECT count(*) FROM memory_domain_events WHERE policy_owner_id IS NOT NULL"), "1");
  sql("GRANT SELECT ON memories, highlights TO authenticated");
  for (const actor of [owner, other]) {
    assert.equal(sql(`SET ROLE authenticated; SET request.jwt.claim.sub='${actor}'; SELECT count(*) FROM memory_domain_events`), "0");
  }
});
});
